# Hosting and release operations

Milton uses Bun for installs, builds and tests, and Node 26 LTS in production.

| Surface                                | Runtime and hosting                                                   |
| -------------------------------------- | --------------------------------------------------------------------- |
| `meetmilton.com`, `www.meetmilton.com` | Static Astro, Vercel `milton-site`                                    |
| `app.meetmilton.com`                   | Hono JSX, Vite theme assets, Cloud Run `milton-app`                   |
| `mcp.meetmilton.com`                   | Hono MCP, Cloud Run `milton-mcp`, Google external HTTPS load balancer |
| Spend-alert worker                     | Private Cloud Run `milton-worker`, Cloud Scheduler `milton-gardening` |

Neon PostgreSQL and Neon Auth remain the source of truth.

The app, MCP and worker are live on GCP. Vercel hosts only the static Astro site.
The retired combined Vercel `milton-mcp` project, deployments, aliases, project
secrets and firewall configuration were removed during the authorized hosting
decommission on 2026-11-01. Hosting rollback now uses Cloud Run revisions.

## Cloud resources

Project `milton-510506`, Cloud Run/Artifact Registry region `us-east4`, Scheduler
region `us-east1`. Service manifests in this directory pin an immutable image and
secret versions. They contain configuration and secret references, never values.
The manifests pin what is serving now: app `milton-app-cleanup3-ba2c49b`
(`sha256:065c387f…`, env 1, key 1), MCP `milton-mcp-cleanup3-ba2c49b`
(`sha256:065c387f…`, env 2, key 1) and worker `milton-worker-filing-f505745`
(`sha256:a370b7c3…`, env 4, key 1); see the release records below. The app and MCP
manifests still set `MILTON_GLOBAL_SPEND_POLICY=alerts_only`, which the runtime no
longer reads; the SQL policy in `store_config` controls admission. Existing positive account safeguards
remain in effect. Trials and billing remain disabled.
Each image includes all roles and browser assets. Validate manifests before applying:

```sh
gcloud run services replace server/deploy/mcp.service.json --dry-run --project=milton-510506 --region=us-east4
gcloud run services replace server/deploy/worker.service.json --dry-run --project=milton-510506 --region=us-east4
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
host. Direct public `run.app` access is refused. The worker uses internal ingress
and grants `roles/run.invoker` only to
`milton-scheduler@milton-510506.iam.gserviceaccount.com`. Never make it public or
trust an arbitrary Authorization header inside the application.

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

Use separate dotenvx keypairs for app, MCP and worker. Store encrypted payloads in
private, versioned release storage and the corresponding private keys in platform
secret stores. Keep `.env*` and `.env.keys` out of git, images, command arguments
and logs. Never add an application endpoint to extract nonexportable secrets.

- Cloud Run mounts `milton-<role>-env:<version>` at `/run/milton/.env`, sets
  `MILTON_ENCRYPTED_ENV_FILE` to that path, and receives `DOTENV_PRIVATE_KEY` from
  its own key secret. Pin numeric secret versions; changing `latest` would make
  rollback ambiguous.
- The static Vercel `milton-site` project has no runtime secrets. Do not copy
  app, MCP or worker credentials into its build settings. The deleted combined
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

## Scheduler operations

The production job is
`projects/milton-510506/locations/us-east1/jobs/milton-gardening`. It invokes
`https://milton-worker-419545871671.us-east4.run.app/api/garden` with method GET,
OIDC audience `https://milton-worker-419545871671.us-east4.run.app`, and the dedicated
scheduler service account. Use a 180-second attempt deadline, a UTC schedule of
`* * * * *`, and zero retries. The worker has concurrency 1 and maximum 1 instance;
the database remains the correctness boundary.

Verify actual scheduled 200 responses in Cloud Logging and public worker refusal.
Only one production scheduler should be enabled. Before replacing a scheduler,
prepare the new job paused, pause the old job, and wait for its 180-second
execution/lease window to drain before enabling the replacement.

## Release verification and rollback

For an incompatible coordinated schema release, stage the image with `gcloud run deploy --no-traffic`,
pause the scheduler, and temporarily set app/MCP ingress to `internal`. Confirm the
canonical endpoints refuse traffic, then drain the longest request/lease window
(at least 180 seconds for this configuration). Take a Neon snapshot and record exact
table hashes before using the normal migration runner. Keep traffic closed until
parity checks pass and all three matching runtime revisions are ready and selected.
Restore app/MCP ingress to `internal-and-cloud-load-balancing`, verify canonical
reads, then resume and verify the scheduler. This stops saves by closing their entry
points without changing the pinned encrypted settings.
For an additive, backward-compatible migration, foreground traffic may stay open when
source publication remains atomic and version-fenced. Pause background dispatch, take a
backup, check source parity, and verify the old runtime can still serve the resulting
source schema before selecting the new revisions.

Zero-traffic revisions may report `Ready=True` with `Retired`; inspect the specific
revision and its imported image, then verify startup again when assigning traffic.

1. Validate the app and private worker with fictional data in an explicitly
   isolated environment. Never copy personal memos into staging.
2. Record the current revision IDs, image digests and numeric secret versions
   before a release. Preserve those resources for rollback.
3. Verify canonical app/MCP TLS and health, MCP discovery and unauthenticated 401,
   CORS, HTTP 308 redirects, direct `run.app` refusal, and worker scheduling.
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
healthy Cloud Run revision. Since migration 0020 no earlier app or MCP revision can serve
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

Now serving (since 2026-11-02 23:49:18Z): MCP `milton-mcp-cleanup3-ba2c49b`, app
`milton-app-cleanup3-ba2c49b`, worker `milton-worker-filing-f505745`; each is recorded below.

Current release cleanup3-ba2c49b: app and MCP. Revisions `milton-app-cleanup3-ba2c49b` and
`milton-mcp-cleanup3-ba2c49b`, staged with `--no-traffic`; at milton-lead's assignment under
Peter's go, a release agent switched MCP at 2026-11-02 23:48:44Z and the app at 23:49:18Z,
and each serves 100%. The worker stays on `milton-worker-filing-f505745`. Both run image
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
`milton-worker-filing-f505745`. The worker still serves them; the app moved to the forms-92975ff hotfix at 22:00:35Z and
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

Roll back only affected services, preserve ingress/IAM and the enabled production
scheduler, then repeat the canonical security and scheduled worker checks. If a
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
three compatible runtimes before selecting `policy --compatible-writers` and
enabling the prospective 100 successful updates/account/UTCday allowance. The
existing observer publishes aggregate threshold events independently of model work;
its failure cannot stop service. Global thresholds are alerts-only, with existing
per-account safeguards retained. No new retrieval enrollment or trial activation
is part of this release. See the operator commands in [server README](../README.md).

The capability feed remains unprovisioned until applicable platform, ingress and
inherited logging routes are verified not to persist its bearer URL. An accepted
local route or project-only log exclusion does not establish that condition.
Do not run `spend-feed rotate --logging-verified` without that evidence. Stored
alert publication does not prove Duet polling, notification or delivery.

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

To stop new email dispatch, publish a worker secret version without the three Resend
variables (see [server README](../README.md)); neither `milton-worker-email-db37798`
nor `milton-worker-allowance-552396e` is a rollback target after 0018. Keep the additive email ledger, frozen payloads,
provider account, numeric secret versions and alert history. Do not restore the
database or delete delivery rows to retry an alert. The down migration refuses a
populated ledger; uncertain sends past the bounded retry window require manual
reconciliation rather than a fresh idempotency key.

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

A later release removes the spend-total branch that reads `gardening_usage` and
`derivation_usage`, and a migration then drops both, no earlier than 31 days after
their newest row. That ledger drop is the remaining follow-up.

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

The worker, scheduler, spend alerts and their email, `foreground_usage`, the global
spend policy column and the now unread `MILTON_GLOBAL_SPEND_POLICY` manifest variables
stay until the cleanup release timed with the 0018 ledger drop.
