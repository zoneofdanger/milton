# Hosting and release operations

Milton uses Bun for installs, builds and tests, and Node 26 LTS in production.

| Surface                                | Runtime and hosting                                                   |
| -------------------------------------- | --------------------------------------------------------------------- |
| `meetmilton.com`, `www.meetmilton.com` | Static Astro, Vercel `milton-site`                                    |
| `app.meetmilton.com`                   | Hono JSX, Vite theme assets, Cloud Run `milton-app`                   |
| `mcp.meetmilton.com`                   | Hono MCP, Cloud Run `milton-mcp`, Google external HTTPS load balancer |

Neon PostgreSQL and Neon Auth remain the source of truth.

The app and MCP are live on GCP. Vercel hosts only the static Astro site.
The retired combined Vercel `milton-mcp` project, deployments, aliases, project
secrets and firewall configuration were removed during the authorized hosting
decommission on 2026-11-01. Hosting rollback now uses Cloud Run revisions.

## Cloud resources

Project `milton-510506`, Cloud Run/Artifact Registry region `us-east4`. Service manifests in this directory pin an immutable image and
secret versions. They contain configuration and secret references, never values.
The manifests pin what is serving now: app `milton-app-nospend-41de4f6`
(`sha256:2eb49f6e…`, env 1, key 1) and MCP `milton-mcp-nospend-41de4f6`
(`sha256:2eb49f6e…`, env 2, key 1); see the release records below. The spend worker,
its scheduler job, service accounts and manifest were removed with 0023 (see
[spend subsystem removal](#spend-subsystem-removal-0023)). `memo_updates_enabled` and
`memo_updates_daily_limit` in `store_config` control admission. Existing positive
account safeguards remain in effect. Trials and billing remain disabled.
Each image includes both roles and browser assets. Validate manifests before applying:

```sh
gcloud run services replace server/deploy/mcp.service.json --dry-run --project=milton-510506 --region=us-east4
gcloud run services replace server/deploy/app.service.json --dry-run --project=milton-510506 --region=us-east4
```

For a release, build `server/Dockerfile` from the repository root for Linux amd64,
push the image to `us-east4-docker.pkg.dev/milton-510506/milton/runtime`, record its
digest, update the manifests, validate, and replace the services. Run the usual
Bun type/tests first and verify the built artifact under Node 26. The container
runs as the unprivileged `node` user and contains a self-contained runtime bundle.
Do not copy local dependencies, environment files or private keys into the image.

The app and MCP services accept ingress only from internal sources and Google's load
balancer. Its platform invoker policy permits external MCP clients; Milton still
requires a valid Neon access JWT for each tool request, and checks the canonical
host. Direct public `run.app` access is refused. Never trust an arbitrary
Authorization header inside the application.

Each runtime service account can read only its own `milton-<role>-env` and
`milton-<role>-key` secrets. Only the app receives its browser cookie secret.
IAM grants can take time to propagate; a new principal may initially be denied.
Do not weaken ingress or IAM to work around that delay.

The shared edge retains the name `milton-mcp`: reserved IPv4, URL map, HTTPS proxy
and certificate map. App and MCP have separate serverless NEGs and backends named
`milton-app` and `milton-mcp`. The HTTPS forwarding rule is `milton-mcp-https`.
The certificate map has exact-host entries for app and MCP. Keep each current
certificate until its replacement is ACTIVE and verified. DNS authorization resources
are named `milton-app` and `milton-mcp`; their CNAME records must remain for renewals.
Use [https-routing.yaml](https-routing.yaml) for the two hostname backends.
Both backends set `Strict-Transport-Security: max-age=63072000` as a custom response
header, preserving the prior Vercel HTTPS policy. Keep that setting when replacing
backends; the source pages retain their own CSP, no-store and framing restrictions.
The HTTPS proxy uses SSL policy `milton-web`, minimum TLS 1.2 with the `RESTRICTED`
profile. This retains Vercel's TLS 1.2/1.3 and modern cipher boundary; Google's
unconfigured default also accepts TLS 1.0. Preserve the policy when replacing the proxy.

For a new edge, create the policy and attach it explicitly (the CLI version value is
`1.2`; the API reports `TLS_1_2`):

```sh
gcloud compute ssl-policies create milton-web --global --profile=RESTRICTED --min-tls-version=1.2 --project=milton-510506
gcloud compute target-https-proxies update milton-mcp --global --ssl-policy=milton-web --project=milton-510506
```

After propagation, verify TLS 1.0/1.1 refusal and trusted TLS 1.2/1.3 connections.
`milton-mcp-http` provides only a method-preserving 308 HTTPS redirect using
[http-redirect.yaml](http-redirect.yaml). Preserve the certificate DNS authorization
CNAMEs for both hostnames; update only `app` and `mcp` traffic records during cutover.
Apex, www and mail records stay unchanged. Validate URL maps with
`gcloud compute url-maps validate --global --load-balancing-scheme=EXTERNAL_MANAGED --source=<file>`
before importing them.

## Secrets

Use separate dotenvx keypairs for app and MCP. Store encrypted payloads in
private, versioned release storage and the corresponding private keys in platform
secret stores. Keep `.env*` and `.env.keys` out of git, images, command arguments
and logs. Never add an application endpoint to extract nonexportable secrets.

- Cloud Run mounts `milton-<role>-env:<version>` at `/run/milton/.env`, sets
  `MILTON_ENCRYPTED_ENV_FILE` to that path, and receives `DOTENV_PRIVATE_KEY` from
  its own key secret. Pin numeric secret versions; changing `latest` would make
  rollback ambiguous.
- The static Vercel `milton-site` project has no runtime secrets. Do not copy
  app or MCP credentials into its build settings. The deleted combined
  Vercel project's environment is no longer a recovery source.
- Cloud Run's app payload has a fresh cookie cache-signing key. Milton filters out
  the SDK's session-data cache and asks Neon to validate the existing session token;
  the upstream token and canonical app hostname remain unchanged. The auth fixture
  verifies session continuity across the key change. The old Vercel key was never
  exported. Do not change Neon's signing keys as part of a hosting release.
- The runtime fails closed on missing or invalid decryption. Platform variables
  take precedence, so audit duplicate names during rotation. Restart/redeploy after
  configuration changes; configuration is loaded once per process.

Use the installed dotenvx CLI with an explicit `--env-keys-file` when encrypting
outside the working directory. Pass secret values to platform CLIs through stdin
or protected files, never `--value` or shell arguments. Preserve each rollback
revision's image and numeric secret versions together with its configuration.

## Release verification and rollback

For an incompatible coordinated schema release, stage the image with `gcloud run deploy --no-traffic`
and temporarily set app/MCP ingress to `internal`. Confirm the
canonical endpoints refuse traffic, then drain the longest request/lease window
(at least 180 seconds for this configuration). Take a Neon snapshot and record exact
table hashes before using the normal migration runner. Keep traffic closed until
parity checks pass and both matching runtime revisions are ready and selected.
Restore app/MCP ingress to `internal-and-cloud-load-balancing` and verify canonical
reads. This stops saves by closing their entry
points without changing the pinned encrypted settings.
For an additive, backward-compatible migration, foreground traffic may stay open when
source publication remains atomic and version-fenced. Take a
backup, check source parity, and verify the old runtime can still serve the resulting
source schema before selecting the new revisions.

Zero-traffic revisions may report `Ready=True` with `Retired`; inspect the specific
revision and its imported image, then verify startup again when assigning traffic.

1. Validate the app and MCP with fictional data in an explicitly
   isolated environment. Never copy personal memos into staging.
2. Record the current revision IDs, image digests and numeric secret versions
   before a release. Preserve those resources for rollback.
3. Verify canonical app/MCP TLS and health, MCP discovery and unauthenticated 401,
   CORS, HTTP 308 redirects and direct `run.app` refusal.
   Keep both canonical DNS A records at `35.227.244.36`, DNS-only, TTL 60, and
   preserve the certificate authorization CNAMEs. Never bypass TLS verification.
4. Verify an authenticated MCP read and the affected browser behavior when
   releasing application changes, then inspect 5xx/auth/queue-age metrics. Avoid
   synthetic writes to a real user's account.
5. After an app release, run `bun scripts/probe-forms.ts https://app.meetmilton.com`
   from `server/`. It posts a signed-out form the way Chrome does (`Origin: null`).
   `PASS` (exit 0) means the form reached the sign-in check; `FAIL` means
   `csrf_refused`, so roll back the app.

To roll back a release, first verify the selected runtime supports the current
database schema, accounting policy and job payloads, then send traffic to its recorded
healthy Cloud Run revision. Migration 0021 is compatible with every 0020 revision, so rolling
back code needs no database step; roll the code back before running the 0021 rollback script
(see [no count limit](#no-count-limit-0021)). Once 0022 is applied, no earlier revision
can save until its rollback script runs (see
[no model-era gate](#no-model-era-gate-0022)). Since migration 0020 no earlier app or MCP revision can serve
reads or saves, so every release before `filing-f505745` is reachable only after the
offline 0020 rollback script; see the 0020, 0019 and 0018 boundaries below. Do not
restore a database snapshot to roll back application code. An existing revision retains
its image, runtime configuration and numeric secret references. Inspect revision
readiness before selecting a recorded revision:

```sh
gcloud run revisions list --service=milton-app --project=milton-510506 --region=us-east4
```

Accounts release: revisions `milton-app-accounts-0db5baa`, `milton-mcp-accounts-0db5baa`,
and `milton-worker-accounts-0db5baa`. The agent switched traffic to them at Peter's
explicit request on 2026-11-02 (app 21:15:22Z, MCP 21:15:31Z, worker 21:15:39Z); each
served 100% until the filing-f505745 release. They run image
`sha256:56ff6f744d0d45cf3a3f558670bb6bdb7f8532a50b0803ec807875e1e5d76c35` (amd64
`sha256:6d163f7b…`; uid 1000, Node 26, no env, key or pem files), built from main
`0db5baa`, which adds assistant disconnects and account deletion. Configuration is
identical to the derived-cba4f6c (app, MCP) and env4-cba4f6c (worker) revisions apart from
the image; secret versions are unchanged (app/MCP env 1, key 1; worker env 4, key 1).
Migration 0019 was applied at 2026-11-02 20:42Z (Drizzle journal 20) after Neon snapshot
`before-0019-accounts` (`snap-weathered-night-b8sgxftt`, 20:41:48Z). It is additive, so
the scheduler kept running. It created `assistant_disconnects` and `deleted_identities`
empty; 18 of the 19 existing tables were unchanged and `usage_daily` moved by one read
counter only. From 21:15Z to 21:26Z the app, MCP health and discovery returned 200,
unauthenticated `/mcp` returned 401, HTTP redirected with 308, TLS 1.2 and 1.3 were
accepted and TLS 1.0 and 1.1 refused (SSL policy `milton-web`, minimum TLS 1.2), the
`run.app` URL returned 404, an authenticated `get_cover_sheet` returned 200 with an
unchanged version, ten scheduled worker ticks returned 200 on the new worker, and logs
showed no errors or 5xx. The disconnect and deletion paths were not exercised in
production.

Rollback after 0019 (image `sha256:6b9efbf7…`; no migration step; since 0020, reachable only
after the 0020 rollback below). The pre-0019 runtime
ignores the refusal table, so disconnected assistants regain access until traffic moves
forward again. Keep both tables. Never restore the `before-0019-accounts` snapshot to roll
back code.

```sh
gcloud run services update-traffic milton-app --to-revisions=milton-app-derived-cba4f6c=100 --project=milton-510506 --region=us-east4
gcloud run services update-traffic milton-mcp --to-revisions=milton-mcp-derived-cba4f6c=100 --project=milton-510506 --region=us-east4
gcloud run services update-traffic milton-worker --to-revisions=milton-worker-env4-cba4f6c=100 --project=milton-510506 --region=us-east4
```

Now serving (since 2026-11-03 07:13:55Z): MCP `milton-mcp-nospend-41de4f6`, app
`milton-app-nospend-41de4f6`; each is recorded below. There is no worker service.

Current release nospend-41de4f6: MCP and app, then migration 0023, then the worker
removal. Revisions `milton-mcp-nospend-41de4f6` and `milton-app-nospend-41de4f6`, deployed
without a zero-traffic soak at Peter's word (no users yet); a release agent switched MCP at
2026-11-03 07:13:11Z and the app at 07:13:55Z, and each serves 100%. Both run image
`sha256:2eb49f6eb9ef107fac21bcc2298ddade458a4b28350ff536ffa0102c3fbae395` (amd64
`sha256:b941afc9bef44b52e64dd08c2ce913efe59724919f2bd2cd0765217c406b2054`; uid 1000, Node 26,
no env, key or pem files; build stage `oven/bun:1.4.4`), built from main `41de4f6`, the merge
of `agent/no-spend`; it also carries the hook context ceiling from `6ab3221`. Configuration is
identical to the savelock-712c7c1 revisions apart from the image and the removed
`MILTON_GLOBAL_SPEND_POLICY` variable (app `milton-app-env:1`, `milton-app-key:1`; MCP
`milton-mcp-env:2`, `milton-mcp-key:1`). Before the release, `spend_alert_emails` was exported
to Peter's archive outside the repository; it held 0 rows. On the 0022 schema the new revisions
answered the canonical checks (unauthenticated `/mcp` 401 with resource metadata, discovery
and health 200, app `/` and `/login` 200 with its CSRF field, signed-out `/assistants`,
`/account/delete` and `/download` 403, HTTP 308, `run.app` 404), an authenticated
`get_cover_sheet` returned 200 with an unchanged version, a `SessionStart` hook read returned
the full cover sheet, and `bun scripts/probe-forms.ts` printed `PASS`. The scheduler was
paused at 07:14:29Z (last tick 07:14:02Z) and drained 180 seconds; then Neon snapshot
`before-0023-no-spend` (`snap-hidden-bread-b8hh2t6u`, 07:17:48Z) and 0023 applied at 07:18:00Z
to 07:18:03Z through `migrateStore` from the `41de4f6` tree (Drizzle journal 23 to 24). The
five spend tables (4 rows: `foreground_usage` 3, `derivation_usage` 1), both trigger
functions with their triggers, and `store_config.spend_feed_key_hash` (it was set) with its
check are gone; 16 of 17 retained tables kept identical hashes, and `store_config` changed only
by losing that column, keeping `memo_updates_enabled` true and `memo_updates_daily_limit` 100.
After the migration `get_cover_sheet` and `list_reports` returned 200 with an unchanged
version, the canonical checks and the probe passed again, and from 07:12Z to 07:21:14Z the new
revisions logged no error, no `unexpected_error` and no 5xx. Then the release agent deleted
Cloud Scheduler job `milton-gardening`, service `milton-worker` with its 19 revisions, the
scheduler's invoker binding, the worker's secret accessor grants, and service accounts
`milton-scheduler` and `milton-worker` (neither had other bindings), and disabled, not
destroyed, `milton-worker-env` versions 1 to 4 and `milton-worker-key` version 1. The Resend
sending key was left alone. No save ran in production.

Rollback: app and MCP roll back by traffic alone on either schema (savelock-712c7c1 reads no
dropped object; its feed route fails closed with 503). To restore the dropped objects, run
`server/drizzle/rollback/0023_no_spend.sql` offline; it recreates them empty, and the 0023
journal row stays. The worker cannot be restored from Cloud Run: it needs the rollback script,
re-enabled secret versions, recreated service accounts (or `gcloud iam service-accounts
undelete` within 30 days), and a fresh deploy from the pre-`41de4f6` worker manifest in git
history. Never restore the `before-0023-no-spend` snapshot to roll back code.

```sh
gcloud run services update-traffic milton-mcp --to-revisions=milton-mcp-savelock-712c7c1=100 --project=milton-510506 --region=us-east4
gcloud run services update-traffic milton-app --to-revisions=milton-app-savelock-712c7c1=100 --project=milton-510506 --region=us-east4
```

Release savelock-712c7c1: MCP, app and worker, then migration 0022. Revisions
`milton-mcp-savelock-712c7c1`, `milton-app-savelock-712c7c1` and
`milton-worker-savelock-712c7c1`, deployed without a zero-traffic soak at Peter's word (no
users yet); a release agent switched MCP at 2026-11-03 06:30:51Z, the app at 06:31:33Z and the
worker at 06:31:58Z; app and MCP served 100% until nospend-41de4f6, and the worker until
its deletion in that release. All three run image
`sha256:e879f531ee6033d4364e3575b2cd8b8462a7875e55cdb1d767ea7a4e6a84622e` (amd64
`sha256:6d91c008e0749a1a58d7a860c23a62d736da74617ef39d794a8505a62bd5b1a3`; uid 1000, Node 26,
no env, key or pem files; build stage `oven/bun:1.4.4`), built from main `712c7c1`, the merge
of `agent/save-lock`. Configuration is identical to the quiz-4644a5f revisions (app, MCP) and
`milton-worker-filing-f505745` apart from the image (app `milton-app-env:1`, `milton-app-key:1`;
MCP `milton-mcp-env:2`, `milton-mcp-key:1`; worker `milton-worker-env:4`, `milton-worker-key:1`).
Change: a save takes only the account lock and reads `memo_updates_enabled` and
`memo_updates_daily_limit` without locking `store_config`; the worker observes spend alerts
without the global spend policy; `memo-updates policy` sets only the daily limit. Release order:
code first, because every earlier revision locks and reads the two columns 0022 drops. On the
pre-0022 schema the new revisions answered the canonical checks (unauthenticated `/mcp` 401,
discovery and health 200, app `/` and `/login` 200 with its CSRF field, signed-out
`/assistants`, `/account/delete` and `/download` 403, HTTP 308, `run.app` 404), an authenticated
`get_cover_sheet` 200 with an unchanged version, `bun scripts/probe-forms.ts` printed `PASS`,
and a worker tick returned 200 at 06:32:02Z. Then Neon snapshot `before-0022-save-lock`
(`snap-hidden-rain-b8ca7adt`, 06:32:59Z) and 0022 applied at 06:33:11Z to 06:33:13Z through
`migrateStore` from the `712c7c1` tree (Drizzle journal 22 to 23); the scheduler kept running.
All 22 tables kept their counts (269 rows) and 21 their hashes; `store_config` lost
`global_spend_policy`, `foreground_accounting_ready`, `config_global_spend_policy` and the old
`config_memo_updates`, gained `config_memo_updates` as `memo_updates_daily_limit > 0`, and kept
`memo_updates_enabled` true and `memo_updates_daily_limit` 100; functions, triggers and indexes
are unchanged. After the migration an authenticated `get_cover_sheet` returned 200 with an
unchanged version and memo updates at limit 100. From 06:30Z to 06:36:39Z the three new
revisions logged no error, no `unexpected_error`, no ReferenceError or TypeError and no 5xx
(app 4 x 200 and 4 x 403, the checks and the probe; MCP 8 x 200 and 6 x 401 from the checks;
worker 5 ticks x 200, three after the migration), and the previous revisions logged none.
No save ran in production, so the lock change was not exercised there.

Rollback (image `sha256:a497749e…` for app and MCP, `sha256:a370b7c3…` for the worker). Since
0022 is applied, no earlier revision can save or tick: a traffic shift alone breaks saves and
the worker. Stop writers (pause the scheduler), run
`server/drizzle/rollback/0022_no_model_gate.sql` offline, then shift traffic; the 0022 journal
row stays, so re-forwarding means running `0022_no_model_gate.sql` by hand. Never restore the
`before-0022-save-lock` snapshot to roll back code.

```sh
gcloud run services update-traffic milton-mcp --to-revisions=milton-mcp-quiz-4644a5f=100 --project=milton-510506 --region=us-east4
gcloud run services update-traffic milton-app --to-revisions=milton-app-quiz-4644a5f=100 --project=milton-510506 --region=us-east4
gcloud run services update-traffic milton-worker --to-revisions=milton-worker-filing-f505745=100 --project=milton-510506 --region=us-east4
```

Release quiz-4644a5f: app and MCP. Revisions `milton-mcp-quiz-4644a5f` and
`milton-app-quiz-4644a5f`, staged with `--no-traffic`; at milton-lead's assignment, a release
agent switched MCP at 2026-11-03 05:49:41Z and the app at 05:50:01Z, and each served 100% until
savelock-712c7c1. The worker stayed on `milton-worker-filing-f505745`. Both run image
`sha256:a497749ea9543648eb431dc2d136247a067b94428bf23b0014c17ccca908a431` (amd64
`sha256:5a2100b24fd3cc36e1e38c9b68023b24be30ea6fdd2e5b45f9f750988cb6b01b`; uid 1000, Node 26,
no env, key or pem files; build stage `oven/bun:1.4.4`), built from main `4644a5f`, the merge
of `agent/quiz`. Configuration is identical to the audit4-4623c9d revisions apart from the image
(app `milton-app-env:1`, `milton-app-key:1`; MCP `milton-mcp-env:2`, `milton-mcp-key:1`). No
migration and no schema change (Drizzle journal unchanged at 22, ending at 0021). Change: the
paste-first setup quiz is served per report while it has no rules (get_report serves the block,
list_reports and hook reads a one-line pointer), tool descriptions say to run the setup as
written, a save refuses a `Baseline: ` rule outside its report's catalog with `baseline_unknown`
(charging nothing), a save takes up to 25 rules, and the memo page asks for approval before
saving any rules and lists reports not set up yet. Server instructions are unchanged. After the
switch, unauthenticated `/mcp` returned 401, discovery and health 200, an authenticated
`get_cover_sheet` 200 with an unchanged version, and `list_reports` 200 with the new one-line
setup pointer on the two reports without rules; a fresh Claude Code client listed exactly four
tools from the new revision. The app and `/login` returned 200 with its CSRF field,
`bun scripts/probe-forms.ts` printed `PASS`, and signed-out `/assistants`, `/account/delete` and
`/download` returned the 403 sign-in refusal. From 05:49Z to 06:00Z the two new revisions logged no `unexpected_error`, no ReferenceError or TypeError, no error logs and no 5xx across 24 requests (app 4 x 200 and 4 x 403, the checks' signed-out refusals and the probe; MCP 13 x 200 and 3 x 401 from the checks), the previous revisions logged no errors or 5xx, and 12 worker ticks returned 200 on `milton-worker-filing-f505745`.
No save ran in production, so the setup script, the baseline check and the 25-rule limit were
not exercised there.

Rollback (image `sha256:537f8078…`; since 0022, reachable only after the 0022 rollback above;
restores the previous setup text and save checks):

```sh
gcloud run services update-traffic milton-mcp --to-revisions=milton-mcp-audit4-4623c9d=100 --project=milton-510506 --region=us-east4
gcloud run services update-traffic milton-app --to-revisions=milton-app-audit4-4623c9d=100 --project=milton-510506 --region=us-east4
```

Release audit4-4623c9d: migration 0021, then app and MCP. Revisions
`milton-mcp-audit4-4623c9d` and `milton-app-audit4-4623c9d`, staged with `--no-traffic`; at
milton-lead's assignment under Peter's approval of audit batch 4, a release agent applied 0021
and then switched MCP at 2026-11-03 02:04:19Z and the app at 02:04:43Z, and each served 100%
until quiz-4644a5f. The worker stays on `milton-worker-filing-f505745`. Both run image
`sha256:537f8078fe4a371722ec9496e8580c0f9c35ed7ad7968cea177fbe0016193ab8` (amd64
`sha256:2fb5a14df3641a5324f397c47433fc32261b90fb4063efea6b8716637ed58ce6`; uid 1000, Node 26,
no env, key or pem files; build stage `oven/bun:1.4.4`), built from main `4623c9d`, the merge
of `agent/audit-4`. Configuration is identical to `milton-app-design-9a3da59` and
`milton-mcp-served-c0ccaab` apart from the image (app `milton-app-env:1`, `milton-app-key:1`;
MCP `milton-mcp-env:2`, `milton-mcp-key:1`). Change: no count limit on cards or legacy memos,
claim-phase outcomes completing a receipt in either phase, one-line `unexpected_error` logs
(class and code only; the startup failure line is now
`{"event":"unexpected_error","where":"startup",…}` instead of "runtime configuration
unavailable"), the memo cue moved to the server instructions with one-line pointers, and copy
updates. The bundle keeps `memo_count_limit` only in the logged-outcome list, for stored
receipts. Release order: 0021 first, because this runtime on the old guard would turn the old
lifetime count into `store_unavailable`; the previous runtime runs on either guard. Migration
0021 was applied at 02:01:33Z (Drizzle journal 21 to 22) through `migrateStore` from the
`4623c9d` tree, after Neon snapshot `before-0021-audit4` (`snap-nameless-mouse-b807avlu`,
02:01:22Z). It is additive and changes no rows, so the scheduler kept running. All 22 tables
kept identical counts and hashes (269 rows); columns, constraints, triggers and indexes are
unchanged; `pg_get_functiondef` shows only the count blocks removed from `milton_card_guard`
(with its `lim` declaration) and `milton_memo_guard`. A read on the old MCP revision after the
migration returned an unchanged version. After the switch, unauthenticated `/mcp` returned 401,
discovery 200, an authenticated `get_cover_sheet` 200 with an unchanged version and bulleted
rules, and `get_report("email")` 200 unchanged; the app and `/login` returned 200, the login form
carried its CSRF field, `bun scripts/probe-forms.ts` printed `PASS`, and signed-out
`/assistants`, `/account/delete` and `/download` returned the 403 sign-in refusal. From 02:04Z to 02:15Z the two new revisions logged no "runtime configuration unavailable", no `unexpected_error`, no ReferenceError or TypeError, no error logs and no 5xx across 17 requests (app 4 x 200 and 4 x 403, the checks' signed-out refusals and the probe; MCP 7 x 200, 1 x 401 from the check and 1 x 308 from an outside scanner), the previous revisions logged no errors or 5xx, and 12 worker ticks returned 200 on `milton-worker-filing-f505745`.
No save ran in production, so the lifted count, the replay rule and the new logs were not
exercised there.

Rollback (image `sha256:663ff9ed…` for the app, `sha256:13b8951b…` for MCP). The database stays
on 0021, which the previous runtimes serve; it keeps its own active-count check of 100. Only
after the code is back, and only if the old guard is wanted, run
`server/drizzle/rollback/0021_no_card_count.sql` (no row changes). Never restore the
`before-0021-audit4` snapshot to roll back code.

```sh
gcloud run services update-traffic milton-mcp --to-revisions=milton-mcp-served-c0ccaab=100 --project=milton-510506 --region=us-east4
gcloud run services update-traffic milton-app --to-revisions=milton-app-design-9a3da59=100 --project=milton-510506 --region=us-east4
```

Release served-c0ccaab: MCP only. Revision `milton-mcp-served-c0ccaab`, staged with
`--no-traffic`; at milton-lead's assignment under Peter's decision, a release agent switched MCP
at 2026-11-03 01:22:03Z, and it served 100% until audit4-4623c9d. The app stayed on
`milton-app-design-9a3da59` and the worker on `milton-worker-filing-f505745`. It runs image
`sha256:13b8951b7328bdce997bc1b658a4a61a280b0105fadd0ed60ed7a25ce9ea6262` (amd64
`sha256:ea6981de9c0e2839d2a5878dfcc3690673c18c68153c33c006eac04d2617f2eb`; uid 1000, Node 26,
no env, key or pem files; build stage `oven/bun:1.4.4`), built from main `c0ccaab`, the merge
of `agent/served-promise`. Configuration is identical to `milton-mcp-splits-31f39cc` apart from
the image (`milton-mcp-env:2`, `milton-mcp-key:1`). No migration and no schema change. Change:
served text only. The server instructions add "Before showing a draft, check it against the
cover sheet rules and the matching report's samples (opening, length, sign-off, any phrase the
rules forbid); fix what fails." and are tightened to 4,094 characters; first setup opens with the
word-for-word promise ("Milton keeps the writing you approve, word for word. It never rewrites a
rule or a sample, and it never reads your inbox."). The image also carries the site and app
commits already live. After the switch, unauthenticated `/mcp` returned 401, discovery 200, an
authenticated `get_cover_sheet` 200 with an unchanged version and bulleted rules, and
`get_report("email")` 200 unchanged. Both new sentences are in the image bundle; no MCP client
read the new instructions from production. From 01:21Z to 01:32Z the new revision logged no
"runtime configuration unavailable", no ReferenceError or TypeError, no error logs and no 5xx
across 6 requests, and 12 worker ticks returned 200.

Rollback (image `sha256:c41e1651…`; no schema change; restores the previous served text):

```sh
gcloud run services update-traffic milton-mcp --to-revisions=milton-mcp-splits-31f39cc=100 --project=milton-510506 --region=us-east4
```

Release design-9a3da59: app only. Revision `milton-app-design-9a3da59`, staged with
`--no-traffic`; at milton-lead's assignment under Peter's go, a release agent switched the app
at 2026-11-03 00:34:06Z, and it served 100% until audit4-4623c9d. MCP stayed on `milton-mcp-splits-31f39cc` and the
worker on `milton-worker-filing-f505745`. It runs image
`sha256:663ff9edb3744dfaeff38093896e072750bfaea7824057b7d7e468de8d511d9f` (amd64
`sha256:d4ebee2c30a56d1ac6540a9ecdda494f442e5423d64994add9b11e497ab7f039`; uid 1000, Node 26,
no env, key or pem files; build stage `oven/bun:1.4.4`), built from main `9a3da59`, the merge
of `agent/app-design`. Configuration is identical to `milton-app-splits-31f39cc` apart from the
image (`milton-app-env:1`, `milton-app-key:1`). No migration and no schema change; no store,
MCP or download change. Change: the signed-in web app's pages share one page shell with an
account menu (email, switch account, sign out, delete account), setup steps move to Connected
assistants, and the cover sheet renders as a T.P.S. report form; the theme gains
`--font-form` and `--text-form-title`. The sign-in and public pages use the same shell. After
the switch, the app and `/login` returned 200, the login page rendered its sign-in form with a
CSRF field, `bun scripts/probe-forms.ts` printed `PASS`, signed-out `/assistants`,
`/account/delete` and `/download` returned the 403 sign-in refusal, and the served
`milton.css` carried both new tokens. Headless Chromium loaded `/login` at 1440, 390 and 320
px in light and dark with no horizontal overflow, Geist and JetBrains Mono loaded, and no
console errors. An authenticated `get_cover_sheet` returned 200 with an unchanged version.
From 00:33Z to 00:44Z the new revision logged no "runtime configuration unavailable", no
ReferenceError or TypeError, no error logs and no 5xx across 57 requests (53 x 200; 4 x 403,
the checks' signed-out refusals), MCP and the worker kept their revisions, and 12 worker ticks
returned 200. Signed-in pages were not viewed in production.

Rollback (image `sha256:c41e1651…`; no schema change; restores the previous page layout):

```sh
gcloud run services update-traffic milton-app --to-revisions=milton-app-splits-31f39cc=100 --project=milton-510506 --region=us-east4
```

Release splits-31f39cc: app and MCP. Revisions `milton-app-splits-31f39cc` and
`milton-mcp-splits-31f39cc`, staged with `--no-traffic`; at milton-lead's assignment under
Peter's go, a release agent switched MCP at 2026-11-03 00:11:14Z and the app at 00:12:13Z.
MCP served 100% until served-c0ccaab; the app served 100% until design-9a3da59. The worker stays on `milton-worker-filing-f505745`. Both run image
`sha256:c41e165167fc1b21eed977157cd185394e2cc08b3ac6b83dc454966bc9291ca3` (amd64
`sha256:45588511e32dec36b5e8580275014bf361658a2fc8437bb1e0a2c44bd703436e`; uid 1000, Node 26,
no env, key or pem files; build stage `oven/bun:1.4.4`), built from main `31f39cc`, whose
tree is the merge `d52e7b3` plus a `TODO.md` line. Configuration is identical to the previous
serving revisions apart from the image (app `milton-app-env:1`, `milton-app-key:1`; MCP
`milton-mcp-env:2`, `milton-mcp-key:1`). No migration and no schema change. Change: a pure
refactor with no behavior change; `saveMemo` is split into `save-context`, `save-claim`,
`save-apply` and `save-publish`, and the browser auth routes into `auth-session`,
`auth-assistants`, `auth-account` and `auth-login`. Under Node 26 in the image, both roles
load every module and stop at the expected configuration error when given an empty
environment. After the switch, unauthenticated `/mcp` returned 401, discovery 200, an
authenticated `get_cover_sheet` 200 with an unchanged version and bulleted rules, and
`get_report("email")` 200 unchanged; the app and `/login` returned 200, the login page
rendered its sign-in form with a CSRF field, `bun scripts/probe-forms.ts` printed `PASS`,
and signed-out `/assistants` and `/account/delete` returned the 403 sign-in refusal. From
00:10Z to 00:22Z the two new revisions logged no "runtime configuration unavailable", no
ReferenceError or TypeError, no error logs and no 5xx across 13 requests, and 13 worker
ticks returned 200.

Rollback (image `sha256:065c387f…`; no schema change; same behavior):

```sh
gcloud run services update-traffic milton-mcp --to-revisions=milton-mcp-cleanup3-ba2c49b=100 --project=milton-510506 --region=us-east4
gcloud run services update-traffic milton-app --to-revisions=milton-app-cleanup3-ba2c49b=100 --project=milton-510506 --region=us-east4
```

Release cleanup3-ba2c49b: app and MCP. Revisions `milton-app-cleanup3-ba2c49b` and
`milton-mcp-cleanup3-ba2c49b`, staged with `--no-traffic`; at milton-lead's assignment under
Peter's go, a release agent switched MCP at 2026-11-02 23:48:44Z and the app at 23:49:18Z,
and each served 100% until splits-31f39cc. The worker stays on `milton-worker-filing-f505745`. Both run image
`sha256:065c387ffb38b2d52b3058781d7f145ec3fa35b9010f7f8dc4854127df2ae205` (amd64
`sha256:fa80aa9bbce10bb1a98e0fe513b70b61de5e8a6e93e8d5adc8fbcdd0fd4a2bce`; uid 1000, Node 26,
no env, key or pem files; build stage `oven/bun:1.4.4`), built from main `ba2c49b`.
Configuration is identical to the previous serving revisions apart from the image (app
`milton-app-env:1`, `milton-app-key:1`; MCP `milton-mcp-env:2`, `milton-mcp-key:1`); both
services set only `MILTON_ENCRYPTED_ENV_FILE` and `DOTENV_PRIVATE_KEY` for the payload. No
migration and no schema change. Change: the 200-a-day technical write cap is gone, leaving
the memo-update cap and the tool-call rate limit; the trial banner and notices link to
nothing (the bundle has no `/billing` or `subscription_url`); the server instructions say
`subscription_required` carries no link (4,095 characters); `templates/` is deleted; and the
runtime reads only the mounted payload file, refusing a non-empty inline
`MILTON_ENCRYPTED_ENV`. After the switch, unauthenticated `/mcp` returned 401, discovery 200,
an authenticated `get_cover_sheet` 200 with an unchanged version and bulleted rules, and
`get_report("email")` 200 unchanged; the app and `/login` returned 200 and
`bun scripts/probe-forms.ts` printed `PASS`. From 23:47Z to 23:59Z the two new revisions
logged no "runtime configuration unavailable", no error logs and no 5xx across 17 requests,
and 13 worker ticks returned 200.

Rollback (image `sha256:28d5118f…`; no schema change; the old runtime restores the 200-a-day
write cap and the `/billing` trial link):

```sh
gcloud run services update-traffic milton-mcp --to-revisions=milton-mcp-cleanup2-dc47f47=100 --project=milton-510506 --region=us-east4
gcloud run services update-traffic milton-app --to-revisions=milton-app-cleanup2-dc47f47=100 --project=milton-510506 --region=us-east4
```

Release cleanup2-dc47f47: app and MCP. Revisions `milton-app-cleanup2-dc47f47` and
`milton-mcp-cleanup2-dc47f47`, staged with `--no-traffic`; at milton-lead's assignment under
Peter's go, a release agent switched MCP at 2026-11-02 23:27:55Z and the app at 23:29:06Z,
and each served 100% until cleanup3-ba2c49b. The worker stays on `milton-worker-filing-f505745`. Both run image
`sha256:28d5118ffbb9f09f080b0ff35a597c2422a9cfe376d077c92c61fa73d70803e7` (amd64
`sha256:ba74baeded2931564800fdd7b8a2d3a00db8381f5493bd66edf190771e635cdb`; uid 1000, Node 26,
no env, key or pem files; build stage `oven/bun:1.4.4`), built from main `dc47f47`.
Configuration is identical to the previous serving revisions apart from the image (app
`milton-app-env:1`, `milton-app-key:1`; MCP `milton-mcp-env:2`, `milton-mcp-key:1`). No
migration and no schema change. Change: the legacy memo store, the bundled no-store MCP path
and the memo importer are deleted (the bundle has no `guardStoreRequest`, `generate-memos`,
`import-memos` or `fflate`), and served strings say cover sheet and reports instead of TPS;
the four tools are otherwise unchanged. After the switch, unauthenticated `/mcp` returned 401,
discovery 200, an authenticated `get_cover_sheet` 200 with an unchanged version and bulleted
rules, and `get_report("email")` 200 unchanged; the app and `/login` returned 200,
`bun scripts/probe-forms.ts` printed `PASS`, and a signed-out `/download` returned the 403
sign-in refusal. From 23:27Z to 23:39Z the two new revisions served 85 requests with no 5xx
and no error logs, and 12 worker ticks returned 200.

Rollback (image `sha256:832ec9d2…`; no schema change):

```sh
gcloud run services update-traffic milton-mcp --to-revisions=milton-mcp-cleanup1-c260d0f=100 --project=milton-510506 --region=us-east4
gcloud run services update-traffic milton-app --to-revisions=milton-app-cleanup1-c260d0f=100 --project=milton-510506 --region=us-east4
```

Release cleanup1-c260d0f: app and MCP. Revisions `milton-app-cleanup1-c260d0f` and
`milton-mcp-cleanup1-c260d0f`, staged with `--no-traffic`; at milton-lead's assignment under
Peter's go, a release agent switched MCP at 2026-11-02 23:10:48Z and the app at 23:11:09Z,
and each served 100% until cleanup2-dc47f47. The worker stays on `milton-worker-filing-f505745`. Both run image
`sha256:832ec9d28e90f511bd9acc55f27e53f46896806d559a3f1bf6bd2d7b50c32b68` (amd64
`sha256:48b38305c682b149893611d8110760f094c75bbd7d9fd654ce1d66b99d1a45d0`; uid 1000, Node 26,
no env, key or pem files; build stage `oven/bun:1.4.4`), built from main `c260d0f`.
Configuration is identical to the previous serving revisions apart from the image (app
`milton-app-env:1`, `milton-app-key:1`; MCP `milton-mcp-env:2`, `milton-mcp-key:1`). No
migration. Change: every rule prints as one `- ` bullet (stored cards and the version are
unchanged), `exact_edits` and `moves` anchors resolve against that printed form, one 64 KiB
request bound replaces the store-level request guard, dead code is removed, and the web page
shows rules the same way. After the switch, unauthenticated `/mcp` returned 401, discovery
200, an authenticated `get_cover_sheet` 200 with an unchanged version and every rule line
starting with `- `, and `get_report("email")` 200 with its sample unchanged and rules bulleted;
the app and `/login` returned 200, `bun scripts/probe-forms.ts` printed `PASS`, and a
70,000-byte unauthenticated `/mcp` POST returned 413. From 23:10Z to 23:21Z the two new
revisions served 20 requests with no 5xx and no error logs, and 11 worker ticks returned 200.

Rollback (image `sha256:8dc1a5a8…` for the app, `sha256:14147524…` for MCP; no schema change).
Rules print without the added bullet again on the old runtime, and an anchor quoted with the
printed `- ` may then fail to match:

```sh
gcloud run services update-traffic milton-mcp --to-revisions=milton-mcp-rules-env2-e3f2f67=100 --project=milton-510506 --region=us-east4
gcloud run services update-traffic milton-app --to-revisions=milton-app-forms-92975ff=100 --project=milton-510506 --region=us-east4
```

Filing release: revisions `milton-app-filing-f505745`, `milton-mcp-filing-f505745`, and
`milton-worker-filing-f505745`. The worker served them until savelock-712c7c1 (06:31:58Z on 2026-11-03); the app moved to the forms-92975ff hotfix at 22:00:35Z and
MCP to rules-env2-e3f2f67 at 22:29:13Z, both below, and both to cleanup1-c260d0f above. They run image
`sha256:a370b7c3f414560141d345e31ca84c329c5ad51c692eb526af6d16329feddd62` (amd64
`sha256:169ab9e4383e3c7a27b67e6da6b6e5ef2c3de75949f7e73fffba3a9a98b0b005`; uid 1000, Node 26,
no env, key or pem files; build stage `oven/bun:1.4.4`), built from main `f505745`, which
moves each card's report onto its versions and gives samples stable kinds. Configuration is
identical to the accounts-0db5baa revisions apart from the image; secret versions are
unchanged (app/MCP env 1, key 1; worker env 4, key 1). The runtime requires migration 0020,
so the window on 2026-11-02, with Peter's go, ran: scheduler paused 21:30:32Z; Neon snapshot
`before-0020-filing-kinds` (`snap-sparkling-hall-b8lhiunz`); 0020 applied at 21:30:43Z
through `migrateStore` from the `f505745` tree (Drizzle journal 20 to 21); traffic switched
to MCP at 21:30:56Z (about six seconds after the migration committed), app at 21:31:06Z and
worker at 21:31:15Z; scheduler resumed 21:31:16Z. Each then served 100%. All 18 tables 0020 does
not touch kept identical counts and hashes. All 94 card versions carry a report (heads cover
22, email 14, chat 3; no card mixes reports) and `instruction_cards.report` is gone. Both
active samples have kinds (chat "connection request", email "follow-up email"),
`sample_kinds` holds 2 rows and `samples.kind` is gone. After the switch, unauthenticated
`/mcp` returned 401, discovery and the app returned 200, an authenticated `get_cover_sheet`
returned 200 with an unchanged version, and `get_report("email")` returned the sample with
its `kind_id` and kind. From 21:30Z to 21:42Z ten scheduled worker ticks returned 200 on the
new worker and logs showed no errors or 5xx; the accounts-0db5baa revisions returned no 5xx
during the gap.

Rollback after 0020 (image `sha256:56ff6f74…`). No pre-0020 app or MCP revision can serve
reads or saves. To return to the accounts-0db5baa revisions, stop writers (pause the
scheduler), run `server/drizzle/rollback/0020_filing_kinds.sql`, then shift traffic. The
rollback is lossy: each card keeps only its latest report, and retirement reasons and
replacement links are dropped (none exist yet). The 0020 journal row stays, so re-forwarding
means running `0020_filing_kinds.sql` by hand. Never restore the `before-0020-filing-kinds`
snapshot to roll back code. See [filing moves and sample kinds](#filing-moves-and-sample-kinds-0020).

```sh
gcloud run services update-traffic milton-app --to-revisions=milton-app-accounts-0db5baa=100 --project=milton-510506 --region=us-east4
gcloud run services update-traffic milton-mcp --to-revisions=milton-mcp-accounts-0db5baa=100 --project=milton-510506 --region=us-east4
gcloud run services update-traffic milton-worker --to-revisions=milton-worker-accounts-0db5baa=100 --project=milton-510506 --region=us-east4
```

App hotfix forms-92975ff: app only. Revision `milton-app-forms-92975ff`; milton-product
switched app traffic to it at 2026-11-02 22:00:35Z at milton-lead's relay of Peter's go,
and it served 100% until cleanup1-c260d0f. The worker stays on the filing-f505745 revision. It runs image
`sha256:8dc1a5a818f099021e0ba1ff84f2ada4340cc138013782a880d4d0e35bbb33ef` (amd64
`sha256:1c6d4ea5396b9f20e6b7a3c371ff6f6c7035311b6ece5bf5b40e810021beb6ae`; uid 1000, Node 26,
no env, key or pem files), built from main `92975ff`, with configuration identical to
`milton-app-filing-f505745` apart from the image (`milton-app-env:1`, `milton-app-key:1`).
No migration. Defect and fix: behind Cloud Run the server saw its own URL as `http://`, so
every browser form POST was refused with `csrf_refused` from 2026-11-01; `cloud-app.ts` now
rebuilds the request at the configured app origin after the canonical-host check. Before the
switch, `bun scripts/probe-forms.ts https://app.meetmilton.com` printed `FAIL` with
`csrf_refused` (the defect reproduced); after it, the probe printed "PASS: form post reached
the sign-in check (403)" with exit 0, and the app and `/login` returned 200. From 22:00Z to
22:11Z the new revision served 37 requests with no 5xx and no error logs.

Rollback to the filing app revision (image `sha256:a370b7c3…`; no schema change involved;
restores the form defect):

```sh
gcloud run services update-traffic milton-app --to-revisions=milton-app-filing-f505745=100 --project=milton-510506 --region=us-east4
```

MCP release rules-e3f2f67 (model-free saves): MCP only. Revision `milton-mcp-rules-e3f2f67`,
staged with `--no-traffic`; milton-product switched MCP traffic to it at 2026-11-02
22:14:43Z at milton-lead's relay of Peter's go, and it served 100% until the env2 follow-up below. App stays on
`milton-app-forms-92975ff`, worker on `milton-worker-filing-f505745`. It runs image
`sha256:14147524680a2ce6aa4967345b8606859af1ea9845c6f84c2d379b545356da57` (amd64
`sha256:7737acde73b39b6a0dc99d025cc2d64d32f535c2632a2f8ad920dd5068ec87b7`; uid 1000, Node 26,
no env, key or pem files; the bundle has no `compiler.ts`, `generativelanguage` or
`MILTON_GEMINI` strings), built from main `e3f2f67`, with configuration identical to
`milton-mcp-filing-f505745` apart from the image (`milton-mcp-env:1`, `milton-mcp-key:1`;
env variables unchanged, including `MILTON_GEMINI_PROJECT_ID` and
`MILTON_GLOBAL_SPEND_POLICY`). No migration. Change: `create_memo` stores the assistant's
`rules` (`{report, text}`) and refuses a text-only save with `invalid_input`; the Gemini
compiler and model budgets are gone from the runtime. After the switch, unauthenticated
`/mcp` returned 401 and discovery 200; an authenticated `get_cover_sheet` returned 200 with
an unchanged version; `get_report("email")` was byte-identical to the pre-switch read; a
text-only `create_memo` was refused with `invalid_input` ("Name the report and send the
rule's text in rules.") with no receipt row and no charge. From 22:14Z to 22:25Z the new
revision served 33 requests with no 5xx and no error logs, and worker ticks returned 200.

Rollback to the filing MCP revision (image `sha256:a370b7c3…`; no schema change involved). A
save that sent `rules` cannot replay on that older runtime:

```sh
gcloud run services update-traffic milton-mcp --to-revisions=milton-mcp-filing-f505745=100 --project=milton-510506 --region=us-east4
```

MCP secret follow-up rules-env2-e3f2f67: from 2026-11-02 22:29:13Z until cleanup1-c260d0f MCP served
`milton-mcp-rules-env2-e3f2f67` at 100% (same image as `milton-mcp-rules-e3f2f67`), switched
by milton-product at milton-lead's word. It mounts `milton-mcp-env:2`, which is version 1
without `MILTON_GEMINI_API_KEY`, `MILTON_GEMINI_PROJECT_ID`, `MILTON_MODEL_ACCOUNT_BUDGET_USD`
and `MILTON_MODEL_GLOBAL_BUDGET_USD`, and drops the plain `MILTON_GEMINI_PROJECT_ID` variable;
`milton-mcp-key:1` is unchanged. The unread `MILTON_GARDENING_ENABLED` stays in the payload
until a later version, and the revision carries an unmounted leftover volume referencing
version 1, as gcloud leaves it. After the switch, unauthenticated `/mcp` returned 401,
discovery 200 and an authenticated `get_cover_sheet` 200; no `miltonModelPredict` binding
remains on any service account. Rollback of the secret change returns to
`milton-mcp-rules-e3f2f67` (version 1 stays enabled); rollback of the code change returns to
`milton-mcp-filing-f505745` as above, where a save that sent `rules` cannot replay.

```sh
gcloud run services update-traffic milton-mcp --to-revisions=milton-mcp-rules-e3f2f67=100 --project=milton-510506 --region=us-east4
```

Roll back only affected services, preserve ingress/IAM, then repeat the canonical
security checks. If a
revision is no longer available, restore its saved service manifest with its
pinned image and matching secret versions using the release procedure above.
**Do not restore or reset the database.** Do not restore the old Vercel CNAME:
the project and its deployments no longer exist.
See [Google's revision rollback guide](https://docs.cloud.google.com/run/docs/rollouts-rollbacks-traffic-migration).

The one-off migration validation services `milton-mcp-validation` and
`milton-worker-validation`, paused scheduler `milton-gardening-validation`, and
their dedicated validation secrets/service accounts were also decommissioned.
Their image and private evidence remain available. The isolated Neon validation
project `cold-recipe-45005130` remains intact and auto-suspends; it contains no
production copies. Recreate isolated hosting explicitly for future validation,
with any new validation scheduler paused outside checks. Do not delete validation
or production resources as part of an ordinary release.

## Memo-update activation (0014)

Apply the additive migration with enforcement disabled, after a database snapshot
and a quiescent worker/source baseline. Verify exact source, history, report snapshot and
receipt preservation and the initial foreground reservation aggregate. Deploy all
three compatible runtimes before selecting `policy --compatible-writers` (retired
in 0022; `policy --daily-limit COUNT` now sets the limit only) and
enabling the prospective 100 successful updates/account/UTCday allowance. The
existing observer publishes aggregate threshold events independently of model work;
its failure cannot stop service. Global thresholds are alerts-only, with existing
per-account safeguards retained. No new retrieval enrollment or trial activation
is part of this release. See the operator commands in [server README](../README.md).

The observer, the capability feed and its `spend-feed` command were removed in 0023.

## Spend-alert email activation (0015)

The 0015 release moved the worker to `milton-worker-email-db37798`, from source `db37798a5a349b1dee14cedffd440237a617becd`, pinned to image
`sha256:4e29c0a745bd0bd7d9a449804624e1aeaa0fb45bf3811f78326e53036231aaef`.
It uses `milton-worker-env:3` and `milton-worker-key:1`. The encrypted payload
preserves the prior settings and adds the three Resend email settings described
in [server README](../README.md). This release changes only the worker; it does
not activate trials or change account limits, source instructions or enrollment.

Migration 0015 adds the durable email ledger after database snapshot
`snap-patient-bread-b8rnidyc`; all 23 preexisting tables and store configuration
were preserved exactly. The sending domain is verified. A labeled test email
was delivered, and an identical retry returned the same provider email ID.
Scheduled requests on the new worker returned 200; canonical production checks
passed. A genuine spending-threshold crossing was not manufactured for this test.

Removed in 0023: the worker, the alert email and its ledger are gone (see
[spend subsystem removal](#spend-subsystem-removal-0023)).

## Derived-systems removal (0018)

Code released; migration 0018 applied. The code removes embeddings, advisory graphs, task-aware retrieval
and gardening review; the worker and scheduler `milton-gardening` (GET `/api/garden`)
stay for spend-alert publication and email. The four MCP tools and model-free reads
are unchanged. Migration 0018 refuses an unexpired gardening lease, deletes remaining
`gardening_jobs` rows (reconciling `users.retained_bytes`), and drops that table,
`card_links`, `card_graphs`, `card_retrieval_embeddings`, `retrieval_enrollments`,
`card_embeddings`, their two trigger functions, the four `store_config` derivation
columns with their checks, and the `vector` extension. `gardening_usage` and
`derivation_usage` stay as frozen ledgers because spend totals read them.

1. Rehearse 0018 on a disposable Neon branch of production before any production change.
2. Release the new image to app, MCP and worker together, staged with `--no-traffic`.
   Manifests drop `MILTON_TASK_RETRIEVAL_ENABLED`, `MILTON_GARDENING_ENABLED`,
   `MILTON_DERIVATIONS_ENABLED` and the worker's `MILTON_GLOBAL_SPEND_POLICY`. The new
   code references no removed object, so it runs on the pre-0018 schema.
3. Soak: scheduled worker 200s, spend-alert observation, an authenticated read, and one
   save only if Peter authorizes it.
4. Pause the scheduler and wait 180 seconds, take a Neon snapshot, record table hashes,
   apply 0018 with the normal runner, confirm every retained table is unchanged, then
   resume the scheduler and verify a scheduled 200.

**Rollback boundary.** Since 0020 this applies only after the 0020 and 0019 rollbacks.
Before 0018, any service may return to its kitcap, mcpinstr or
whenlines revision. After 0018, app and MCP may still return to those revisions, which
run with gardening disabled. A worker returned to kitcap keeps publishing alerts and
email, because the two ledgers remain, but fails on the missing `gardening_jobs` and
returns 503 to every scheduled call; prefer a forward fix. Older worker revisions,
including `milton-worker-email-db37798` and `milton-worker-allowance-552396e`, are not
rollback targets after 0018. The 0018 rollback script recreates the dropped objects
empty, extension included; the enrollment row, graph and link text, and caches are
recoverable only from the pre-0018 snapshot. Do not restore the database to roll back code.

Migration 0023 drops both ledgers with the rest of the spend subsystem.

Done: the `miltonModelPredict` grant was removed from the worker and MCP service accounts
on 2026-11-02 at 20:18Z (role definition kept), and `milton-worker-env:4`, without the
Gemini and derived budget keys, has served the worker since 2026-11-02 20:22Z. Versions 1
to 3 remain enabled. The unread `MILTON_GARDENING_ENABLED` and
`MILTON_DERIVATIONS_ENABLED` keys stay in the payload until a later version.

Status: Applied 2026-11-02 20:10Z (journal 19, snapshot `before-0018-derived`).

## Filing moves and sample kinds (0020)

Applied 2026-11-02 21:30:43Z (journal 21, snapshot `snap-sparkling-hall-b8lhiunz`).
Migration 0020 moves each card's report onto its versions and gives
samples stable kinds, dropping `instruction_cards.report` and `samples.kind` in the
same step. Every production revision before 0020 reads both columns, so release in
this order: stop writers, apply 0020, then shift traffic to the 0020 code.

**Rollback boundary.** After 0020, no pre-0020 app or MCP revision can serve reads or
saves. To roll Cloud Run back to one, first run `server/drizzle/rollback/0020_filing_kinds.sql`
offline with writers stopped, then shift traffic. The rollback is lossy: each card
keeps only its latest version's report, and retirement reasons, retiring request IDs
and replacement lineage are dropped (see the server README). It leaves the 0020
journal row in place, so re-forwarding means running `0020_filing_kinds.sql` by hand,
not the normal runner.

## No count limit (0021)

Applied 2026-11-03 02:01:33Z (journal 22, snapshot `before-0021-audit4`,
`snap-nameless-mouse-b807avlu`). Migration 0021 replaces `milton_card_guard` and
`milton_memo_guard` without their count checks and changes no rows (see the server README).
Release order: apply 0021, then the code; the scheduler may keep running.

**Rollback boundary.** Every 0020 revision runs on 0021, so code rolls back by traffic alone.
To restore the old guard, first move the code back, then run
`server/drizzle/rollback/0021_no_card_count.sql`; the 0021 journal row stays, so re-forwarding
means running `0021_no_card_count.sql` by hand. An account already past the old limit keeps its
cards and cannot add more until it is back under it.

## No model-era gate (0022)

Applied 2026-11-03 06:33:11Z (journal 23, snapshot `before-0022-save-lock`,
`snap-hidden-rain-b8ca7adt`), after the savelock-712c7c1 code served all three services.
Migration 0022 drops `store_config.global_spend_policy` and
`foreground_accounting_ready` and narrows `config_memo_updates` to a positive daily
limit (see the server README). Every revision before this release locks and reads
those columns on each save and worker tick; this release reads neither and runs on
either schema. Release order: take a snapshot, ship MCP, app and worker from the same
image, then apply 0022; the scheduler may keep running.

**Rollback boundary.** Before 0022 is applied, code rolls back by traffic alone. After
it, no earlier revision can save or observe: first run
`server/drizzle/rollback/0022_no_model_gate.sql` offline with writers stopped, then shift
traffic. The rollback re-adds both columns (defaults `'capped'`, `false`), sets the row to
`alerts_only` and ready, and restores both checks; the 0022 journal row stays, so
re-forwarding means running `0022_no_model_gate.sql` by hand.

## Model-free saves

Released to MCP as `milton-mcp-rules-e3f2f67` on 2026-11-02 at 22:14:43Z (see the release
records). This code release removes the model from the write path: `create_memo`
stores the assistant's exact `rules`, `exact_edits`, `moves` and samples, and refuses a
save with only `text`. MCP is the only service whose behavior changes; there is no
migration. The runtime no longer reads `MILTON_GEMINI_API_KEY`,
`MILTON_GEMINI_PROJECT_ID`, `MILTON_MODEL_ACCOUNT_BUDGET_USD`,
`MILTON_MODEL_GLOBAL_BUDGET_USD` or `MILTON_GLOBAL_SPEND_POLICY`. Since 22:29:13Z it
runs with `milton-mcp-env:2`, version 1 without those four `MILTON_GEMINI_*` and
`MILTON_MODEL_*` keys, and without the plain `MILTON_GEMINI_PROJECT_ID` variable; version 1
stays enabled for rollback, and the unread `MILTON_GARDENING_ENABLED` stays in the payload.
No `miltonModelPredict` binding remains on any service account. Rollback is a traffic shift to the
previous 0020 MCP revision; no pre-0020 revision is a target. Receipts from that
revision replay on this one, but a save that sent `rules` cannot replay there, because
its input schema refuses the field.

The worker, scheduler, spend alerts and their email, the spend ledgers and the unread
`MILTON_GLOBAL_SPEND_POLICY` manifest variables are removed in 0023.

## Spend subsystem removal (0023)

Applied 2026-11-03 07:18:00Z (journal 24, snapshot `before-0023-no-spend`,
`snap-hidden-bread-b8hh2t6u`), after the nospend-41de4f6 code served app and MCP; the worker
resources below were deleted at 07:23Z and its secret versions disabled (see the release
records). This release deletes the spend-alert worker role, alert email, the
`/operator/spend-alerts/` feed and `scripts/spend-feed.ts`, and drops the
`MILTON_GLOBAL_SPEND_POLICY` variable from the app and MCP manifests. Migration 0023
drops `foreground_usage`, `gardening_usage`, `derivation_usage`, `spend_alerts`,
`spend_alert_emails`, the `save_foreground_reservation` trigger with
`milton_foreground_reservation`, `guard_spend_alert_email`, and
`store_config.spend_feed_key_hash` with its check (see the server README). Memo-update
accounting, the daily call limit, replay, fences and trials are unchanged.

Release order: the new image references no dropped object and runs on either schema.

1. Export `spend_alert_emails` only, as the record Peter keeps, to
   `~/code/milton-archive/` on his machine (owner: Peter; it holds the operator
   recipient address and alert envelopes, no account rows). The usage ledgers are
   keyed by account identifier, including deleted accounts, so they are not
   exported; the pre-0023 snapshot is their only copy and expires with Neon's
   retention.
2. Release the image to MCP and app from the manifests in this directory.
3. Pause `projects/milton-510506/locations/us-east1/jobs/milton-gardening` and wait
   180 seconds.
4. Take a Neon snapshot, record table hashes, apply 0023 with the normal runner, and
   confirm every retained table is unchanged.
5. Delete the production resources that existed only for the worker:
   - Cloud Scheduler job `milton-gardening` (us-east1).
   - Cloud Run service `milton-worker` (us-east4), with its revisions.
   - The `roles/run.invoker` binding for
     `milton-scheduler@milton-510506.iam.gserviceaccount.com` goes with the service;
     delete that service account if nothing else uses it.
   - Service account `milton-worker@milton-510506.iam.gserviceaccount.com` and its
     project and secret IAM bindings (its secret accessor grants on
     `milton-worker-env` and `milton-worker-key`).
   - Secrets `milton-worker-env` (versions 1 to 4) and `milton-worker-key`, after the
     final export in step 1.
   - Optionally, revoke the Resend sending key; nothing else uses Resend.

**Rollback boundary.** App and MCP roll back by traffic alone, before or after 0023:
savelock-712c7c1 reads no dropped object except its feed route, which fails closed
with 503. To restore the shape, run `server/drizzle/rollback/0023_no_spend.sql` offline
with writers stopped; it recreates every object empty, and rows come back only from
the pre-0023 snapshot or the export. The 0023 journal row stays, so re-forwarding
means running `0023_no_spend.sql` by hand. Once its service is deleted, the worker
returns only by recreating it from a saved manifest, which needs the rollback script
first.

## Runtime role (0024)

Not yet released. Migration 0024 creates `milton_runtime`, a NOLOGIN group role with
only the statements the runtime runs on each table (DELETE only on `users` and
`assistant_disconnects`; `store_config` read-only apart from the lock), USAGE on the
`instruction_card_position` sequence and schema `public`, CONNECT on the database, and
SELECT, INSERT and UPDATE by default on tables later migrations create (see the server
README for the table list). It owns nothing, so it cannot alter, drop or truncate a
table, disable a trigger or read the Drizzle journal. App and MCP then connect as
`milton_app`, a login role whose only membership is `milton_runtime`. Membership
inherits; the runtime needs no `SET ROLE` and no code change. The migration runner and
`scripts/memo-updates.ts` keep the `neondb_owner` connection and refuse any other role.

**Create `milton_app` with SQL, not the console or API.** Neon makes every role created
in the console, CLI or API a member of `neon_superuser`, which brings
`pg_read_all_data`, `pg_write_all_data`, CREATEROLE, CREATEDB, BYPASSRLS and REPLICATION
and so undoes most of what 0024 removes. A role created with SQL has only what is
granted.

**The password touches no file and no command argument.** It is generated into a shell
variable and reaches `psql` through a pipe from the `printf` builtin (zsh writes a
heredoc to a temporary file). It reaches `psql`, `dotenvx` and the check script only
through the environment, and it is written to disk only inside the encrypted payload.
Neon receives it in plaintext over TLS, as Neon requires, and stores only the
verifier. Statement logging on the production project was checked on 2026-11-03:
`log_statement` is `none`, `log_min_duration_statement` is `-1` and
`log_min_error_statement` is `panic`, so the server log does not record the statement,
even if it fails. `pg_stat_statements` is preloaded with `track_utility` on, so it may
keep the `CREATE ROLE` text; step 3 checks for it and clears the entry.

Release order: 0024 is additive and the current image runs on either schema, so
traffic may stay open. Work in a shell that keeps no history (zsh: start it with
`HISTFILE=/dev/null zsh`) and inside a private temporary directory outside the
repository (`umask 077; cd "$(mktemp -d)"`).

1. Rehearse steps 2 to 5 on a throwaway Neon branch made from production, with that
   branch's owner connection and a throwaway password, then delete the branch. On the
   branch, note whether `pg_stat_statements` shows the password in step 3.
2. Take a Neon snapshot, then apply 0024 with the normal runner (`bun run db:migrate`,
   owner connection in `server/.dev.vars`). It changes no table or row.
3. Create `milton_app`. Export the owner connection as `PGHOST` (the host the service
   payloads use), `PGUSER=neondb_owner`, `PGDATABASE=milton`, `PGSSLMODE=require` and
   `PGPASSWORD` (read with `read -rs PGPASSWORD`), then:

   ```sh
   MILTON_APP_PASSWORD="$(openssl rand -base64 33 | tr '+/' '-_')"
   SQL="CREATE ROLE milton_app LOGIN INHERIT IN ROLE milton_runtime PASSWORD '$MILTON_APP_PASSWORD';"
   printf '%s' "$SQL" | psql -v ON_ERROR_STOP=1 -f -
   unset SQL
   ```

   The password is 44 URL-safe characters (264 bits), above Neon's 60-bit minimum, and
   needs no escaping in a connection string. Confirm the role, still as the owner. The
   four columns must read `t`, `t`, `t` and `{milton_runtime}`; stop if
   `neon_superuser` or any other role appears:

   ```sql
   SELECT r.rolcanlogin, r.rolinherit,
     NOT (r.rolsuper OR r.rolcreaterole OR r.rolcreatedb OR r.rolbypassrls OR r.rolreplication) AS plain,
     ARRAY(SELECT g.rolname FROM pg_auth_members m JOIN pg_roles g ON g.oid = m.roleid
           WHERE m.member = r.oid ORDER BY 1) AS member_of
   FROM pg_roles r WHERE r.rolname = 'milton_app';
   ```

   Then check the statement statistics in whichever database has the extension
   (`milton` or `postgres`):

   ```sql
   SELECT queryid, query ~ 'PASSWORD ''' AS has_text
   FROM pg_stat_statements WHERE query ILIKE 'CREATE ROLE milton_app%';
   ```

   If `has_text` is true, clear that entry with
   `SELECT pg_stat_statements_reset(0, 0, <queryid>);`. If Neon refuses the reset,
   record that the text is readable only by roles with `pg_read_all_stats`, which
   already hold the owner's rights, and go on.

4. Mint the next payload version for each service from the encrypted version it mounts
   now (`milton-app-env:1`, `milton-mcp-env:2`). For the app (repeat for MCP with its
   own secrets and key):

   ```sh
   gcloud secrets versions access 1 --secret=milton-app-env --project=milton-510506 > app-current.env
   export DOTENV_PRIVATE_KEY="$(gcloud secrets versions access 1 --secret=milton-app-key --project=milton-510506)"
   dotenvx decrypt -f app-current.env --stdout \
     | awk '/^DATABASE_URL=/ { sub(/:\/\/[^@]*@/, "://milton_app:" ENVIRON["MILTON_APP_PASSWORD"] "@") } { print }' \
     > app-next.env
   dotenvx encrypt -f app-next.env
   grep -c '^DATABASE_URL="encrypted:' app-next.env
   ```

   `app-next.env` is mode 600 because of the `umask`, and it holds plaintext only
   between the `awk` and the `encrypt`. It keeps the same keypair, because the public
   key comes across in the decrypted header, so `milton-app-key:1` stays valid. Only
   the user and password change; the host, `/milton` and `sslmode` are the service's
   own. The `grep` must print `1` (dotenvx quotes encrypted values). A local rehearsal
   with fake values kept the public key and changed only `DATABASE_URL`.

5. Check the minted payload before any service uses it, with `DOTENV_PRIVATE_KEY`
   still exported:
   - Through the services' driver, against the exact host in the payload, from the
     repository checkout (`<dir>` is the temporary directory):

     ```sh
     dotenvx run -f <dir>/app-next.env -- bun --no-env-file server/scripts/check-runtime-role.ts
     ```

     It must print `ok`. It runs one HTTP query and one WebSocket transaction that
     locks `store_config` as a sign-in does. It passes only as `milton_app`, a plain
     member of `milton_runtime`, and prints only `ok` or `fail`; a driver failure adds
     the usual one-line error log (class and code, never the URL) on stderr.

   - Refusals with `psql`, with the login in the environment and never a URL on the
     command line: in `PGUSER=milton_app PGPASSWORD="$MILTON_APP_PASSWORD" psql`,
     `BEGIN; ALTER TABLE samples DISABLE TRIGGER samples_guard; ROLLBACK;` fails with
     `must be owner of table samples`, `DELETE FROM save_requests WHERE false;` fails
     with `permission denied for table save_requests`, and
     `SELECT 1 FROM drizzle.__drizzle_migrations;` fails with
     `permission denied for schema drizzle`.
6. Add each payload as the next numeric version with
   `gcloud secrets versions add milton-app-env --data-file=app-next.env` (and the same
   for `milton-mcp-env`). Keep the old versions enabled; the key secrets are unchanged.
   Copy the encrypted payloads to private release storage, delete the temporary
   directory and `unset MILTON_APP_PASSWORD PGPASSWORD DOTENV_PRIVATE_KEY`.
7. Point the volume `items[0].key` in `app.service.json` and `mcp.service.json` at the
   new versions, validate with `--dry-run`, replace MCP, then app, and record the
   revisions and versions.
8. Verify as the new role: canonical health, MCP discovery and unauthenticated 401; an
   authenticated `get_cover_sheet` returns 200 with an unchanged version (a read,
   which also writes the daily call count); and a save. With Peter's go, a
   `create_memo` that resends one existing cover rule verbatim returns `unchanged`: it
   claims and stores a receipt as `milton_app` and changes no memo. A save that changes
   memos runs only when Peter directs one. Check the logs for `store_unavailable` or
   `permission denied`.

**Later, not in this release: retire the owner credential from the services.** Each
service account can read every version of its own secret, so `milton-app-env:1` and
`milton-mcp-env:2` still give the running services the owner connection. Once the new
role has served for a full day without `store_unavailable` or `permission denied` (no
sooner than 24 hours after step 8), reset `neondb_owner`'s password in Neon, update
the owner connection kept for migrations, and disable both old versions
(`gcloud secrets versions disable 1 --secret=milton-app-env --project=milton-510506`,
`gcloud secrets versions disable 2 --secret=milton-mcp-env --project=milton-510506`).
After that the traffic rollback below no longer works: rolling back means minting a
fresh owner payload first.

**Rollback.** Shift app and MCP traffic back to the previous revisions, which mount the
owner payload versions (`milton-app-env:1`, `milton-mcp-env:2`). In the same step, set
`items[0].key` in `app.service.json` and `mcp.service.json` back to `1` and `2`, so no
later `replace` deploys the new versions again. No schema change is needed, because
0024 removes nothing the owner uses. To remove the role as well, after traffic has
moved: `DROP ROLE milton_app;` as the owner, then run
`server/drizzle/rollback/0024_runtime_role.sql`, which refuses while a login role other
than the caller is still a member of `milton_runtime`. The 0024 journal row stays, so
re-forwarding means running `0024_runtime_role.sql` by hand. Restoring the branch to a
point before 0024 also removes both roles, so switch the services back to the owner
payloads first.
