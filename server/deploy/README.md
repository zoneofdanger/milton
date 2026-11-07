# Hosting and release operations

Milton uses Bun for installs, builds and tests, and Node 26 LTS in production.

| Surface                                | Runtime and hosting                                                   |
| -------------------------------------- | --------------------------------------------------------------------- |
| `meetmilton.com`, `www.meetmilton.com` | Static Astro, Vercel `milton-site`                                    |
| `app.meetmilton.com`                   | Hono JSX, Vite theme assets, Cloud Run `milton-app`                   |
| `mcp.meetmilton.com`                   | Hono MCP, Cloud Run `milton-mcp`, Google external HTTPS load balancer |
| `auth.meetmilton.com`                  | Self-hosted Better Auth, Cloud Run `milton-auth`, same load balancer  |

Neon PostgreSQL is the source of truth. Sign-in is the self-hosted auth service at
`https://auth.meetmilton.com/api/auth` (since 2026-11-07). Managed Neon Auth is disabled,
with its `neon_auth` schema and data retained.

The app and MCP are live on GCP. Vercel hosts only the static Astro site.
The retired combined Vercel `milton-mcp` project, deployments, aliases, project
secrets and firewall configuration were removed during the authorized hosting
decommission on 2026-11-01. Hosting rollback now uses Cloud Run revisions.

## Release record: schema + self-hosted auth cutover (2026-11-07)

Release agent milton-duo; Peter authorized each gate. Runbook and evidence (local,
untracked): `.agents/tmp/auth-cutover/` (`runbook.md`, `phase1-report.md`,
`linking-rehearsal.md`, `rehearsal-2.md`, `prod/README.md`).

- Closed app/MCP ingress at 06:58:52Z (`internal`), 180 s drain, Neon snapshot
  `snap-fancy-hat-b8j5ls14` (07:02:36Z), plus private `pg_dump` checkpoints before every
  migration. Reopened 07:25:27Z (UTC), about 26 minutes closed.
- Applied in order: writing `0002_sample_versions`, `0003_report_guides`; auth000; native
  001–006; app000, app005, `005-app-roles.sql`. Writing journal 4 entries, native ledger 6.
  Preservation equal to the pre-0002 baseline (2 accounts, 16 samples, 3 active, 13 retired,
  identical active reads and exports).
- Runtime logins: `milton_auth_runtime`, `milton_app_runtime`, `milton_mcp_runtime`;
  owner delegate `milton_auth_delegate` (kept for maintenance); `milton_guide_runtime` and
  `milton_app_delegate` set NOLOGIN after use. Legacy `milton_app` login retained, unused.
- Identity import: 2 legacy accounts mapped to native users by verified Google/GitHub
  subject (never email); eligibility key policy recorded (the trial fingerprint key is
  permanent; back it up with recovery material).
- Serving: `milton-app-cut-eaf898e`, `milton-mcp-cut-eaf898e` (server image
  `sha256:2c49e2a0772ab2ff407eaf75507b2eb933671189baa8814180ba99a9db955e95`, source
  `eaf898e`) with `milton-app-env` 4 / `milton-app-key` 2 and `milton-mcp-env` 4 /
  `milton-mcp-key` 2. `milton-auth-00002-jj7` (auth image
  `sha256:69910d8dd570fb5027cb10b60e61a7231062465c7f2b32f90b43d77e2fb1e1ef`, source
  `f2f4301`) with `milton-auth-env` 2 / `milton-auth-key` 1, SA `milton-auth@`.
- Jobs: `milton-auth-mail` (every minute) and `milton-auth-maint` (every 15 minutes, SA
  `milton-auth-maint@`, secret `milton-auth-owner-url` 1), triggered by
  `milton-auth-cron@`. Both on the auth image above.
- Edge: URL-map host rule `auth.meetmilton.com` → backend/serverless NEG `milton-auth`;
  certificate `milton-auth` (DNS authorization `milton-auth`) in cert map `milton-mcp`; DNS
  `auth` A and `_acme-challenge.auth` CNAME in Cloudflare. Log exclusion
  `milton-auth-credential-urls` on `_Default` (canaries excluded, positive control logged).
- Fix during the window: `f2f4301` accepts any https client-metadata URL (Claude Code
  was refused by the Muse-only allowlist). Claude Code connected and read the cover sheet
  afterwards.
- Checks: provider redirects; log canaries; controlled mail send (1 sent); maintenance
  pass (exit 0); forms probe PASS; health 200 on all three; 0 server errors in the first
  ~8 minutes; Peter verified both accounts in the app.
- Deferred (record): password sign-up and reset on a real address; Safari/mobile;
  disconnect and reconnect; refresh replay; sample revision, retirement and stale-write
  through create_memo; interrupted-deletion retry; one-hour session expiry; real Muse
  portal; sustained mail cadence and quota; full restore rehearsal; Codex, ChatGPT and
  Cursor connections. A mail-test native user (Resend sink address, random discarded
  password, no Milton account) remains; the guard trigger refuses a direct delete, so
  remove it through the lifecycle path.
- Rollback: the old `*-edit-00223ec` revisions are not compatible with this schema. Fix
  forward, or restore `snap-fancy-hat-b8j5ls14` per the runbook's rollback section.

## Release record: auth startup retry (2026-11-07)

`milton-auth-00003-ggx` at 09:15Z (auth image
`sha256:941bd4cd197b4f0d5b51e4241259e283d57bc7c4e396e1ee1185620beeb3c726`, source `f1656b5`,
same env 2 / key 1); the mail and maintenance jobs use the same image. Startup retries the
role check on connection failures for about 15 s; refusals still fail immediately. Checks:
health 200, Claude Code authorize 302, 5-minute watch clean. Rollback:
`milton-auth-00002-jj7`. The same check found both Scheduler triggers had malformed
URLs since the cutover (a shell expansion turned `:run` into `un`), so the mail and
maintenance jobs never ran on schedule (404). Fixed at 09:21Z; the first scheduled mail
run succeeded at 09:22Z. Nothing was lost: the only queued mail was the cutover test,
already sent by hand.

## Release record: store refactor, part 2 (2026-11-07)

App and MCP moved to `milton-app-store2-b64ec6a` / `milton-mcp-store2-b64ec6a` at 08:58:21Z
(server image `sha256:75f1cd73bccef7afa116bca4646446eca83e3ffc3f762c188ebd3db67dd60da1`,
source `b64ec6a`, same env 4 / key 2). Structure only: one active-account check and one
identity parser (`store/accounts.ts`), and the served tool contract moved beside `mcp.ts`
(`mcp-tools.ts`). Served output byte-identical before and after (instructions, tool lists,
envelopes, refusals). Checks: health 200, unauthenticated MCP 401, forms probe PASS,
production read version unchanged, 5-minute watch clean. Rollback: traffic back to
`*-store-95587e5`.

## Release record: store refactor (2026-11-07)

App and MCP moved to `milton-app-store-95587e5` / `milton-mcp-store-95587e5` at 08:30:41Z
(server image `sha256:e9e9d5922e3884c0fb17aad8bfdc0ab36b8e90a03021ead77e035c925787b0f8`,
source `95587e5`, same env 4 / key 2). Structure only: one save module, database errors
mapped where the database is chosen, no runtime import cycles. Checks: health 200,
unauthenticated MCP 401, forms probe PASS, production read version unchanged, 0 errors in
five minutes (low traffic). Rollback: traffic back to `*-cut-eaf898e`. An auth instance
failed startup at 08:30:47Z while the Neon compute was waking from autosuspend (it had been idle); the service recovered without
action. Autosuspend on the production endpoint `ep-curly-cherry-b8l7hc8f` is now off
(`suspend_timeout_seconds: -1`, 2026-11-07); TODO #28 adds a startup retry.

## Sample revision schema/API cutover (applied 2026-11-07, see above)

`0002_sample_versions` is a breaking forward migration.
A separately authorized coordinated cutover must close app/MCP ingress for both
reads and writes, drain old instances, take a database snapshot, apply the migration
as owner, then start compatible app/MCP images before reopening. Do not run old code
against this schema. Preserve existing resources under the normal release policy;
this task supplies no compatibility period or new rollback artifact.

The migration maps linear legacy replacement chains to root stable IDs, preserves
known exact snapshots and legacy provenance, and leaves accepted-change evidence
unchanged. It aborts transactionally on ambiguous lineage; investigate a refusal
without bypassing it. Earlier overwritten contexts/correction times are unknown and
are explicitly not reconstructed. Retired leaves with no successor stay retired,
including dedup-consolidated samples. Local fictional PGlite rehearsal is not a live
history inventory or authorization to migrate. Before release, review preservation
against the selected snapshot. Reconnect assistants after cutover: `sample.sample_id`
replaces `sample.replaces`, report metadata uses `revision`, and clients must reread
current IDs and the account version. Check exact active reads/exports and revision,
retirement, replay, stale-write and account-delete behavior before reopening.

## Connection keys release (prepared, not applied)

Connection keys add one native status function, one additive writing table and one owner
grant file. Old app/MCP code never calls the function or reads the table, so traffic may
stay open under the additive procedure in
[Release verification and rollback](#release-verification-and-rollback). In order:

1. Snapshot.
2. Native `007-connection-key-status` as `milton_auth_delegate`, assuming
   `milton_auth_owner` (`AUTH_OWNER_DATABASE_URL` with `options=-c%20role%3Dmilton_auth_owner`,
   see below): `node --experimental-strip-types apps/auth/scripts/migrate.ts up --apply`
   applies only 007 when the ledger holds 001–006. It adds
   `milton_guard.connection_key_status(text,text,text)` (SECURITY DEFINER, fixed
   `pg_catalog, pg_temp` path, EXECUTE for `milton_mcp_runtime` and `milton_app_runtime`
   only, no table grants) and changes no auth runtime code, so `milton-auth` is not
   redeployed. Check: ledger has 7 entries; `has_function_privilege` is true for MCP and
   app and false for `milton_auth_runtime`, `milton_guide_runtime` and PUBLIC.
3. Writing Drizzle `0004_connection_keys` with `bun run --cwd server db:migrate`
   (creates `connection_keys` with its NOT NULL native binding columns, user and identity
   indexes and cascades, and revokes the legacy `milton_runtime` default grants on it).
4. As the owner, `server/migrations/006-connection-keys-roles.sql` (app: SELECT on every
   column except `secret_hash`, binding included; INSERT; UPDATE(`revoked_at`). MCP:
   SELECT, UPDATE(`last_used_at`). Nothing else). It revokes before granting, so
   rerunning converges.
5. `check-runtime-role.ts` for app and MCP (it now requires the 007 EXECUTE grant), then
   roll out app and MCP.

Order matters. New code without 007 refuses every key call (503) and every key creation;
without 006 it fails the Connected assistants page, key pages and key calls with
`store_unavailable`. OAuth calls are unchanged either way. Never apply 007 down while new
MCP code serves keys unless refusing every key is intended. Rollback is the previous
app/MCP revisions; the function, table and grants can stay in place, unused. Live key
creation needs a person's own fresh sign-in.

## Optional guide worker

The default-off private guide pilot has separate [operations and capability instructions](guides.md). No guide job, schedule, provider key or account enrollment is provisioned by its build.

## Cloud resources

Project `milton-510506`, Cloud Run/Artifact Registry region `us-east4`. Service manifests in this directory pin an immutable image and
secret versions. They contain configuration and secret references, never values.
The manifests pin what is serving now: app `milton-app-edit-00223ec` and MCP
`milton-mcp-edit-00223ec`, both using image index `sha256:2682542b…`,
env 3, key 1, connecting as `milton_app`;
see the current release below. Production has the
`0000_baseline` and `0001_sample_context` migrations. There is no worker service or scheduler job. There is no memo-update
allowance; the daily call cap bounds saves. Existing positive account safeguards remain
in effect. Trials and billing are live (since 2026-11-04).
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
- Payload versions still enabled but not mounted: `milton-app-env:1`, `milton-mcp-env:1`
  and `milton-mcp-env:2` (all three hold the owner connection; `milton-mcp-env:1` also
  holds the retired `MILTON_GEMINI_*` and `MILTON_MODEL_*` keys). The MCP payloads still
  carry the unread `MILTON_GARDENING_ENABLED`; drop it in a later version.
  `milton-worker-env` versions 1 to 4 and `milton-worker-key:1` are disabled, not
  destroyed.

Use the installed dotenvx CLI with an explicit `--env-keys-file` when encrypting
outside the working directory. Pass secret values to platform CLIs through stdin
or protected files, never `--value` or shell arguments. Preserve each rollback
revision's image and numeric secret versions together with its configuration.

## Alerts

Cloud Monitoring in `milton-510506` holds eight alert policies, four per service, created
2026-11-04. Every policy notifies one email channel, `milton-ops-email`
(`notificationChannels/9917162819460717518`, Peter's address), and closes an incident
30 minutes after its condition clears. Each condition reads `cloud_run_revision`
resources filtered to its service and sums across revisions.

| Policy                                             | Condition                                                                                                      |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `milton-app-5xx-ratio`, `milton-mcp-5xx-ratio`     | `run.googleapis.com/request_count` with `response_code_class = "5xx"` over all requests > 0.02 for 5 min       |
| `milton-app-latency-p95`, `milton-mcp-latency-p95` | `run.googleapis.com/request_latencies`, 95th percentile across revisions > 2000 ms for 10 min                  |
| `milton-app-instances`, `milton-mcp-instances`     | `run.googleapis.com/container/instance_count`, max per minute summed across revisions and states > 8 for 5 min |
| `milton-app-errors-log`, `milton-mcp-errors-log`   | Log match: the service's entries with `severity >= ERROR`; at most one notification per 10 min                 |

The instance alert is a traffic-spike signal, not a failure. The 5xx ratio fires only
when there are 5xx responses: with none there is no numerator series. Cloud Run's own
request log writes a 5xx at ERROR, so a burst of 5xx also triggers the log alert.

To change a policy, edit it in the console or `PATCH` it through the Monitoring API
(`https://monitoring.googleapis.com/v3/projects/milton-510506/alertPolicies/<id>`); list
them with `GET .../alertPolicies`. Stripe's webhook-failure emails and Neon's compute
alerts are Dashboard settings, not these policies.

Added 2026-11-07 for the self-hosted auth service, same channel, rate limit 10 minutes:

- `milton-auth-errors-log`: any `milton-auth` Cloud Run log entry with severity ERROR or higher.
- `milton-auth-jobs-errors-log`: any ERROR from a `milton-auth-*` Cloud Scheduler job or Cloud
  Run job (mail delivery, maintenance). Its filter matched the 25 scheduler 404s from the
  malformed-URL incident, which this alert would have caught.

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

For the current sample-context schema, old revisions are not a traffic-only
rollback: follow the closed-ingress, snapshot and guarded schema rollback boundary
recorded below. For a schema-compatible code release, first verify the selected
runtime supports the current database schema and accounting policy, then send traffic
to its recorded healthy Cloud Run revision. Do not restore a database snapshot to roll back application code. An
existing revision retains its image, runtime configuration and numeric secret
references. Inspect revision readiness before selecting a recorded revision:

```sh
gcloud run revisions list --service=milton-app --project=milton-510506 --region=us-east4
```

Now serving: MCP `milton-mcp-edit-00223ec` and app `milton-app-edit-00223ec`,
selected by exact revision name at 100% on 2026-11-06 (MCP 11:50:02Z,
app 11:50:15Z). Both use exact landed main
`00223ec298e07717d713cfe51b9f523b4e0de567`. Peter selected this app/MCP rollout
with “Land and deploy those now” in Lead on 2026-11-06; the temporary release
worker executed that pinned selection. The existing static deployment was preserved.

Current edit-mode release: image index
`sha256:2682542b3328c26de20846788798f68bc9efdc14cea2fc8233a920edcbc64e28`, Linux amd64
`sha256:03d78555b80e4c79001a99d4fa11020cd33d4ff5b2dcc12f7ec56b24fcf67069`.
Built once and pushed from a clean git archive of that exact landed commit with a
frozen Bun install, exit 0. Runtime inputs exactly match accepted `9e260abd`:
types, 109 tests/2,656 assertions, formatting and the server build passed, exit 0;
those unchanged checks were reused. A fresh server build also passed, exit 0.
The exact Linux amd64 image runs Node 26.13.0 as uid 1000, contains the bundled
runtime and browser assets, excludes private/env/key/research artifacts and refuses
empty configuration for both roles. The exact image bundle contains the accepted
4,047-character instructions, SHA-256
`352fd8a1fc71fea5dab93a609bd3cba1878dffc0f81898b3c263d37456f5f575`.

In that image under Node 26 with network disabled, isolated fictional PGlite and
SDK fixtures exercised scoped-edit instructions, display-before-offer retention
consent, the 880-character setup prompt, all five setup responses and the actual
empty, populated, paused and fallback pages. Ten of eleven R4 response bodies and
all headers match; the intentionally changed empty report and empty assistants
responses match their accepted browser-reviewed bytes. All 21 app/theme presentation
inputs and compiled CSS match accepted presentation evidence, so that browser
review carries by measured equality. The R4 complete-download check still shows
9 samples while exporting all 11 active samples: 4,436 bytes, SHA-256
`2d3187a9fcae2eb5ff3e625c220ff208f037c7e86ae2c236b98d2f492a10692a`.
These fictional checks do not establish assistant adherence or real-account saves.

Both full manifests were derived from the live resources, validated normally and
staged with zero traffic. Ready/Retired was treated only as staging evidence; after
selection both revisions became Ready, Active and ContainerHealthy. Only image,
revision/traffic and generated operation metadata changed. Full configuration and
IAM parity passed, preserving ingress, resources, startup settings, service accounts,
app `milton-app-env:3` / `milton-app-key:1`, and MCP
`milton-mcp-env:3` / `milton-mcp-key:1`, including its unmounted env-2 volume.
No migration, snapshot, database restore, secret, policy or static change ran.

Canonical trusted TLS 1.2/1.3, TLS 1.0/1.1 refusal, health, discovery,
unauthenticated 401/challenge, CORS, HTTP 308, direct run.app refusal, signed-out
restrictions, production CSS and invalid Stripe-signature refusal passed, exit 0.
The mandatory exact-source
`bun --no-env-file scripts/probe-forms.ts https://app.meetmilton.com` passed with
sign-in refusal 403, exit 0. Existing authenticated MCP cover-sheet reads succeeded
before and after selection with an unchanged version and five reports. A live empty
speech-report read returned the new 5,014-character setup guidance, including pasted
writing, edit approval distinct from retention, and display before the single offer.
No personal writing was retained in evidence. An existing signed-in Chrome page
reloaded at 1512 by 828 with no overflow or console errors; no visible browser was
opened, login created, provider activated, download triggered or memo saved.

Observation through 2026-11-06 11:56:02Z covered 347 seconds after the
last traffic selection. Repeated app/MCP health stayed 200. Filtered request/runtime
logs contained 30 app and 25 MCP entries, zero 5xx or ERROR and no
unexpected auth/schema/permission/lock failures; no entries were truncated.
Available request metrics through 2026-11-06T11:55:00Z (app) and
2026-11-06T11:55:00Z (MCP) showed zero 5xx. Available per-series/minute
p95 latency was at most 178.0 ms (app) and 357.0 ms (MCP); instance metrics
showed at most one per revision/state series. Metrics publish with lag: raw latency
and instance sample timestamps and measured lag are recorded in private release
evidence; aligned percentile endpoints are not freshness evidence. Queue age has
no instrument and remains unverified. Final full service/configuration/IAM and edge parity
checks passed.

Compatible rollback: retain Ready app `milton-app-mvp-8364a81`, index
`sha256:81d10f9e581a69be5ea27798687c1c2e9e7fb8525318f0d1d03a88abb2da8e99`, amd64
`sha256:dbc53d970f57e49b19d7741dcf22645eec401fb128355f926972c0f61520ab9c`,
app env 3/key 1; and MCP `milton-mcp-context-fec8802`, index
`sha256:fe7e226368b42d2ec047c26ac7cbb6d6181acb5157bda8d881b75af55ee8802b`, amd64
`sha256:f49a219aa7001219ec3ff75fa9ff770762bc0043fc4e226024fd181ba06e877b`,
MCP env 3/key 1. Their exact specs/imported digests remain, and images and enabled
numeric secrets are retained. Recheck readiness before selecting only an affected
service. Do not select a pre-context revision or restore the database for this
compatible code rollback. No rollback or cloud resource deletion ran.

Fresh authenticated production initialize instructions and fresh four-tool discovery
were not exposed by the existing connector, which offers only the four tool calls;
its instruction metadata is cached from before selection. Exact-image SDK initialize
verified all four tools and the new instruction hash, while the production reads above
verify authenticated service access and changed setup output. A fresh authorized client
initialization remains a separate verification gap. Actual adherence in Claude,
ChatGPT, Claude Code, Cursor and Codex remains untested. Live account download,
save/correction/retention, provider/clipboard flows, other viewport sizes, browsers and
assistive technology remain unverified in this rollout. Before claiming those behaviors
in a demo, observe them through separately authorized existing sessions.

Previous app release: app `milton-app-mvp-8364a81`, selected by name at 100% on
2026-11-06 06:01:11Z, from exact landed main source
`8364a81e8544dd07a7618baa8c555c309d9a1b60`. MCP remains unchanged at
`milton-mcp-context-fec8802`, 100%, from `fec88029f86cf6c71710fa78978c35269becb718`.

Previous app release mvp-8364a81: image index
`sha256:81d10f9e581a69be5ea27798687c1c2e9e7fb8525318f0d1d03a88abb2da8e99`, Linux amd64
`sha256:dbc53d970f57e49b19d7741dcf22645eec401fb128355f926972c0f61520ab9c`.
Built and pushed from a clean git archive of that exact commit with frozen Bun
install, exit 0. The accepted R4 source checks remain applicable: 86 of 87 frozen
inputs are identical; package.json only adds the static upload-check command.
Types, 108 tests/2,517 assertions, formatting and app/site builds passed, all exit 0;
the unchanged suite was reused. Node 26.13.0, uid 1000, bundled assets, absence of
private/env/key artifacts and both roles' empty-configuration refusal were checked
in this Linux amd64 image.

Under Node 26 in the exact image, isolated fictional PGlite store reads and actual
memoPages responses show nine samples (eight newest emails and one chat), while
the complete download retains all eleven active samples: 4,436 bytes, SHA-256
`2d3187a9fcae2eb5ff3e625c220ff208f037c7e86ae2c236b98d2f492a10692a`.
All eleven response bytes/headers match accepted fixtures, including original CSP,
paused/empty/fallback states and downloads. The image's CSS matches the accepted
asset. Headless Chromium rendered populated, paused and empty responses at
1440/390/320 pixels with no overflow or page errors, computed pretty wrapping,
and a keyboard download matching the complete file. These are isolated source
fixture checks under Node 26, not authenticated production browser evidence.

The app was validated and staged at zero traffic, inspected Ready with its expected
imported amd64 digest, then selected; it became Active and ContainerHealthy.
Only app image/revision and expected operation metadata changed. Ingress, IAM,
service account, resources, startup settings and numeric secret references match
the predecessor. App retains `milton-app-env:3` / `milton-app-key:1`; MCP retains
`milton-mcp-env:3` / `milton-mcp-key:1`, with its entire service record and IAM
unchanged. No migration, database operation, MCP deployment, secret change or
static deployment ran in this app rollout.

Canonical trusted TLS 1.2/1.3, TLS 1.0/1.1 refusal, health, discovery, unauthenticated
401/CORS, HTTP 308, direct run.app refusal, signed-out restrictions, production CSS
and invalid Stripe-signature refusal passed, exit 0. The mandatory exact-source
`bun --no-env-file scripts/probe-forms.ts https://app.meetmilton.com` passed with
sign-in refusal 403, exit 0. Existing authenticated MCP cover-sheet reads succeeded
before and after selection; no writing text was logged. Production signed-out login
rendered without overflow or browser errors at 1440/390/320 pixels; no provider was
activated or new login created.

Observation through 2026-11-06 06:06:28Z covered 317 seconds after selection.
Repeated app/MCP health stayed 200. Filtered request/runtime logs showed zero 5xx,
ERROR or unexpected auth/schema/permission/lock failures. Available request metrics
through 06:05:00Z contained traffic and zero 5xx; their publication lag is explicit.
Queue age has no instrument and remains unverified. Full configuration/IAM parity
and enabled numeric secret versions were verified. Live signed-in report layout,
account download and Node 26 real-account save/correction remain unverified; no
memo saves ran.

Compatible app rollback: preserve Ready `milton-app-context-fec8802`, image index
`sha256:fe7e226368b42d2ec047c26ac7cbb6d6181acb5157bda8d881b75af55ee8802b`, Linux amd64
`sha256:f49a219aa7001219ec3ff75fa9ff770762bc0043fc4e226024fd181ba06e877b`, app env 3/key 1.
Recheck readiness before selecting it; no database restore is part of this code
rollback. Older pre-context runtimes require the historical schema recovery gate
below and must not be selected as a simple app rollback. All old revisions, images
and numeric secrets remain preserved. Existing previews were untouched; the MVP
previews were already absent before landing. No rollback ran.

Previous joint release: app `milton-app-context-fec8802` and MCP
`milton-mcp-context-fec8802`, both selected by name at 100% while ingress was closed
on 2026-11-05 (MCP 16:51:08Z, app 16:51:19Z). Exact landed main source:
`fec88029f86cf6c71710fa78978c35269becb718`. Both ingress settings were restored
to `internal-and-cloud-load-balancing` by 2026-11-05 16:51:32Z.

Previous joint release context-fec8802: image index
`sha256:fe7e226368b42d2ec047c26ac7cbb6d6181acb5157bda8d881b75af55ee8802b`, Linux amd64
`sha256:f49a219aa7001219ec3ff75fa9ff770762bc0043fc4e226024fd181ba06e877b`. The clean git archive passed
frozen Bun install, types, 108 tests/2,517 assertions, formatting and the focused
five migration tests/83 assertions, all exit 0. Node 26.13.0, uid 1000, the
self-contained bundle, absence of private/env/key artifacts and both roles'
empty-configuration refusal were verified in the Linux amd64 image. Disposable
PGlite tests exercised fresh/repeated install, baseline-seeded upgrade, exact
preservation, guarded rollback/refusal, re-upgrade and narrow runtime privileges.
Accepted fictional component/browser evidence remains the layout evidence; it is
not a live-account or Node-runtime save/correction claim. This integrated source
also includes the approved onboarding and complete-export changes.

Both matching revisions were staged Ready without traffic. Only image/name and
generated operation metadata changed in runtime specs; IAM, ingress after reopening,
resources, service accounts, startup settings and numeric secret references match
the predecessors. App retains `milton-app-env:3` / `milton-app-key:1`; MCP retains
`milton-mcp-env:3` / `milton-mcp-key:1`, startup CPU boost and its unmounted env-2
volume. The minimal tracked manifests omit that dormant volume.

Both ingresses closed to `internal`; canonical health endpoints refused 404 at
2026-11-05 16:46:27Z. After more than 180 seconds, the owner capture showed no other
active transactions/writers. Native Neon snapshot `before-sample-context-fec8802`,
`snap-divine-rain-b864qz0l`, was created and independently retrieved at
2026-11-05 16:50:01Z immediately before the normal owner-only
migrator applied only `0001_sample_context` (2026-11-05 16:50:29Z to
2026-11-05 16:50:37Z). The journal is exactly baseline
`1793815543500` / `4167000e0d8550aa7f2852d648a176a841a5a6d7a01a763d7e73822fc7c48735`
and sample context `1793901943500` /
`2efc9cea1347716ce23abf560e943869409af23fb742966de1bb6556599c9c10`.
All 11 samples retained their exact immutable fields, approved summaries and legacy
label mappings; all 13 unrelated public tables matched their pre-migration counts
and hashes. Sample columns/constraints/indexes and guard functions match the migrated
fictional catalog; unrelated catalog, narrow grants, roles and sequence state match
the captured baseline. A repeated normal migration left data, catalog and journal
identical. Only hashes/counts/catalog metadata were retained. Representation changes
can change account version tokens; unchanged versions were not required.

Canonical trusted TLS 1.2/1.3 and TLS 1.0/1.1 refusal, health, discovery, unauthenticated
401/CORS, HTTP 308, direct run.app refusal, signed-out restrictions, invalid Stripe
signature refusal and the mandatory forms probe passed, exit 0. Through the existing
authorized MCP connection, cover/email reads succeeded at one matching new version:
five reports, eight selected email samples, four kinds, context objects at version 1
and context revisions, with no legacy top-level labels. No account sample/rule save,
new sign-in, credential rotation or client configuration change ran. The parsed served-contract and
SDK tests cover four tools, current schemas and 4,095 instruction characters in the
exact deployed source. Lead independently read the account and used a fresh native
connection to discover all four live tool schemas at 2026-11-05 16:55:49Z, including object sample context,
contextual intent and sample-context corrections with legacy label inputs absent.
The already-open Lead and release sessions still advertise cached metadata; refresh
in other clients remains unverified. Signed-in account download remains unverified.

The static site published separately from main
`50e6fc4682d091a6d2619eae7f3148d6ee23ac52`, which fixes the Vercel upload boundary by
moving the unchanged setup prompt to the existing shared theme package. Vercel
deployment `dpl_2wZG11uNAJLE7nD9giueneJXTqwy` was Ready in production with the canonical
domain aliases. Lead checked `/`, `/setup`, `/pricing`, `/notes`, `/privacy` and
`/terms` at HTTP 200 with footers, the approved homepage headline, and both setup
widgets plus their four assistant links against the exact canonical prompt.

Rollout gates completed at 2026-11-05 16:52:22Z.
Observation continued through 2026-11-05 16:57:51Z, more than five minutes after
rollout checks. Repeated canonical health probes stayed 200; filtered logs showed no
runtime ERROR, 5xx or unexpected auth/schema/permission/lock failures. Available
request metrics showed no 5xx. Final service/IAM/resource/startup/numeric-secret
parity passed; both predecessor revisions remain Ready and their images and enabled
secret versions are retained.
Live signed-in browser layout, complete account download, schema refresh in
already-open assistant sessions and Node 26 save/correction behavior remain unverified.

Conditional rollback: preserve Ready predecessors `milton-app-tps-c6a59b1` (image index
`sha256:5ac952e173f0e337211eecff605c470f63f8e2868742e96c792d455a10d5a35b`, amd64
`sha256:3485f0f3523808693dc7460f1b9c1a3158b3aa74012c244616c645ca507160d5`)
and `milton-mcp-ui-99b7209` (image index
`sha256:789939cfbca106b00fb9288a149ef1e12b4e49da87c77e4bb9d1ac8aa0d5f842`, amd64
`sha256:078a2e85ce824d598352803c2f18007ab988ce82b6079128cf44341a4e17b559`),
both env 3/key 1. These old runtimes cannot read the new schema. Rollback requires
closed/drained ingress, another immediate snapshot, the tested owner-only
`server/scripts/sample-context-rollback.sql`, successful schema/data verification and
both matching old runtimes selected before reopening. The script refuses revised or
unrepresentable context and reclassified lineage; never bypass that refusal. If it
would discard later writes, keep compatible code and seek a recovery decision. No
automatic snapshot restore, traffic-only rollback, resource deletion or tuning ran.

Previous app release: `milton-app-tps-c6a59b1` (selected 2026-11-04 23:58:58Z),
from exact landed main commit `c6a59b11d8aaf4636e52e374a962d9be62d26241`, at 100%.
MCP then remained `milton-mcp-ui-99b7209` at 100%, from
`99b720966443e3a3cde696be9f39360fc51e7b7e`; it was not redeployed.

Previous app release tps-c6a59b1: image index
`sha256:5ac952e173f0e337211eecff605c470f63f8e2868742e96c792d455a10d5a35b`, Linux amd64
`sha256:3485f0f3523808693dc7460f1b9c1a3158b3aa74012c244616c645ca507160d5`.
A clean archive of that exact commit passed frozen Bun install, types,
103 tests/2,170 assertions and formatting, all exit 0. The runtime is Node 26.13.0,
uid 1000, with a self-contained bundle, no env/key/pem/dev.vars/private artifacts,
and both roles refusing empty configuration. The accepted four-path TPS patch is
byte-identical to the reviewed source. Fictional evidence covers full-width sample
descriptions above metadata, native keyboard disclosures, the counted report index,
semantic headings and Filed by. No schema, auth, MCP, download or save code changed;
this release ran no migration, writer drain, snapshot or database administration.

Only the app image and expected revision metadata changed. The new revision was
staged without traffic, verified Ready with the expected imported amd64 digest,
then selected by name. Ingress, IAM, service account, resources, startup settings
and numeric references remain unchanged: app `milton-app-env:3` /
`milton-app-key:1`, MCP `milton-mcp-env:3` / `milton-mcp-key:1`.
Canonical trusted TLS 1.2/1.3 and 1.0/1.1 refusal, health, discovery,
unauthenticated 401, CORS, HTTP 308, direct-host refusal, signed-out restrictions,
invalid Stripe-signature refusal and the mandatory forms probe passed, exit 0.
Existing authenticated MCP cover/email reads succeeded before and after selection,
with unchanged versions, five report entries and two email samples; only version,
shape and count metadata was retained. No credentials or sessions changed.
Rollout checks completed at 2026-11-04 23:59:10Z. Observation continued through
2026-11-05 00:04:20Z, more than five minutes later. Repeated canonical health probes stayed
200; filtered logs showed no runtime ERROR, 5xx or unexpected auth/schema/permission/lock
failures, and no administrative errors. Available request metrics through
2026-11-05T00:03:00Z showed no 5xx. The app predecessor remains Ready and its
image is retained; MCP spec, metadata generation, traffic and IAM are unchanged.
Designer independently confirmed that the production stylesheet exactly matches the
accepted frozen CSS. Live signed-in TPS layout and keyboard verification remain
unverified because the existing browser window was unavailable; fictional browser
evidence is not a claim of live account behavior.

Historical TPS rollback: preserve `milton-app-ui-99b7209`, image index
`sha256:789939cfbca106b00fb9288a149ef1e12b4e49da87c77e4bb9d1ac8aa0d5f842`, amd64
`sha256:078a2e85ce824d598352803c2f18007ab988ce82b6079128cf44341a4e17b559`, env 3/key 1.
The predecessor is schema-compatible; recheck readiness before selecting it.
MCP retains its clean-c27869a rollback described below. Preserve older revisions,
images and numeric secret versions too. No production rollback ran.

Previous joint release: MCP `milton-mcp-ui-99b7209` (selected 2026-11-04 19:47:42Z)
and app `milton-app-ui-99b7209` (19:48:59Z), each pinned by revision at 100%.
Both use the exact landed main commit `99b720966443e3a3cde696be9f39360fc51e7b7e`.
Ingress is `internal-and-cloud-load-balancing`; IAM, limits, startup CPU boost and
numeric secrets are unchanged (app/MCP env 3, keys 1). There is no worker service.

Previous joint release ui-99b7209: image index
`sha256:789939cfbca106b00fb9288a149ef1e12b4e49da87c77e4bb9d1ac8aa0d5f842`, Linux amd64
`sha256:078a2e85ce824d598352803c2f18007ab988ce82b6079128cf44341a4e17b559` (uid 1000,
Node 26.13.0; no env/key/pem/dev.vars/private artifacts; both roles refuse empty
configuration). Frozen install, types, 103 tests/2,155 assertions and formatting passed
on a clean archive of that exact commit. Its six-file UI patch is byte-identical to
the independently accepted fictional browser implementation: mobile sample labels,
setup guide/copy, newcomer sign-in offer/links and native Account popover dismissal.
The landing demo remains deferred. There is no schema or migration delta from the
previous clean-c27869a runtime; this release ran no migration, transition, writer
drain, snapshot or database change. The cleanup evidence below remains historical.

Each new revision differs from its predecessor only in its image; runtime annotations,
ingress, IAM, limits and numeric secret references match. MCP retains its unmounted
env-2 volume with env 3 mounted; the minimal tracked manifests omit dormant volumes
and generated live metadata. Canonical TLS 1.2/1.3 trust and 1.0/1.1 refusal,
health/discovery/401/CORS/308/direct-host refusal, signed-out restrictions, forms,
invalid Stripe-signature refusal and both actual runtime-role probes passed.
Headless Chromium checked live plain and inert fictional assistant-flow sign-in at
320/390/1440px and 844x390: newcomer copy, both provider buttons, policy/pricing links,
no overflow or scripts, unchanged script-free CSP and no console errors. No provider
was activated. Signed-in sample/setup/Account behavior relies on the exact accepted
fictional production-component evidence; no live signed-in browser session was used.
Fresh authenticated MCP tool reads saw four tools, required intent, two email samples
and unchanged cover/email versions; missing intent was refused. The exact deployed
source instructions remain 4,066 characters; a new client initialization was not
captured. Observation continued through 19:54:25Z, more than five minutes after both
rollout checks completed at 19:49:11Z. Filtered logs showed no runtime ERROR, 5xx or
unexpected auth/schema/permission/lock failures; there were no administrative audit
errors. Available request metrics through 19:53Z had no 5xx. The immediate predecessors
and their image remain
available. No real-account saves, sign-ins or provider/billing actions ran.

Historical rollback for the previous joint release: preserve `milton-mcp-clean-c27869a` and
`milton-app-clean-c27869a` with image index
`sha256:32df4631750a32c35f52c263a10c61d6bb45ea64d807ebbe98771b499471ad7d`, amd64
`sha256:22acf1609b35b8c1aff20fbb0b705a1a96b03cce4a002c059a4e49d00919e712`, env 3/key 1.
These healthy predecessors served the same current baseline before this code-only
release. Recheck readiness before selecting them; preserve older revisions/images too.
No production rollback or database restore ran.

Previous release: MCP `milton-mcp-clean-c27869a` (selected 2026-11-04 18:49:58Z)
and app `milton-app-clean-c27869a` (18:50:18Z), from landed main commit
`c27869a421634c41cda438158531baaa138079f3`.

Previous release clean-c27869a: image index
`sha256:32df4631750a32c35f52c263a10c61d6bb45ea64d807ebbe98771b499471ad7d`, Linux amd64
`sha256:22acf1609b35b8c1aff20fbb0b705a1a96b03cce4a002c059a4e49d00919e712` (uid 1000,
Node 26.13.0; no env/key/pem/dev.vars artifacts; both roles refuse empty configuration).
The exact archive passed types, 102 tests/2,139 assertions and formatting. Separate
fictional PGlite and Neon fresh/0033 rehearsals passed catalog/grant parity,
row/settings/document/version preservation, save/replay, guards, account isolation and
deletion, atomic refusals and repeated migrations; future generation passed locally.
Both cleanup revisions served and passed authenticated reads on the old schema first.
Only the image differs in either predecessor/new revision spec; MCP retains its startup
CPU boost and its unmounted env-2 volume, with env 3 mounted.

Both ingresses closed at 18:51:24Z and refused canonical entry. After a 187-second
writer drain, Neon snapshot `before-legacy-cleanup-c27869a`
(`snap-purple-frog-b8orrux9`, 18:54:42Z) was verified immediately before the exact
owner-only `psql -X -v ON_ERROR_STOP=1 -f server/scripts/transition-baseline.sql`.
The transition ran 18:54:43Z–18:54:45Z, exit 0. Journal: exactly one baseline row at
`1793815543500`, SHA-256
`4167000e0d8550aa7f2852d648a176a841a5a6d7a01a763d7e73822fc7c48735`.
All 219 retained rows across 14 tables, retained settings, sequence state and both
accounts' document hashes/version tokens matched the drained capture; 14 catalog
sections matched rehearsal. The three retired tables, five functions/six attached
triggers, unused legacy flag and six obsolete limit keys are gone. The normal migration
runner ran twice with no changes, exit 0 both times. Ingress reopened at 18:55:17Z.
Canonical TLS 1.2/1.3 and 1.0/1.1 refusal, health/discovery/401/CORS/308/direct-host
refusal, signed-out restrictions, forms and invalid Stripe signature checks passed.
Both encrypted payloads passed the actual runtime-role probe. A fresh authenticated
client read the unchanged cover/email version, two email samples, four tools and
required intent; missing intent was refused. Its 4,066-character initialization
instructions hash matched the exact source. No real-account saves or sign-ins ran.
The post-reopen observation covered at least five minutes with no unexpected 5xx,
ERROR, relation/column, permission or lock failures in logs or request metrics.

Older rollback candidate: preserve `milton-mcp-rank-c63af7f` and
`milton-app-rank-c63af7f`, image
`sha256:420c469210565844d7b50d492b8faf253724d2a1ab6991a9124bf64ff94336dd` (amd64
`sha256:c1f2cd7cecc5afaba5ac1f646ad4ac1a51567159c2b175bb8ce42dcdfee3d9ee`), env 3/key 1.
The immutable c63af7f store source read, saved and replayed as `milton_runtime` against
the cleaned fictional Neon schema, with documents/version matching current code.
Production traffic was not rolled back; recheck revision readiness and canonical
behavior before selecting it. There is no reverse migration or automatic snapshot
restore. Schema recovery requires a separate decision with writers stopped.

Recorded prior release rank-c63af7f: migration 0033, then MCP and app, from main `c63af7f` (the merge
of `agent/ranking-b`: samples carry optional labels; `get_report` requires an intent and serves
eight samples ranked by labels, words and recency; the version covers every active sample;
`notifications/tools/list_changed` goes out on each assistant's first tool call per process and
on every missing-intent refusal). By a release agent on 2026-11-04; secrets unchanged. Before
it, simp-893d0ce served both services on journal 33. The commit tree (a `git archive` of
`c63af7f`) passed `check-types`, `bun test` (114 pass) and `format:check`. A throwaway branch
from production rehearsed 0033 before release, including preservation of existing
rows and a no-op repeated migration. The historical inverse rehearsal is no longer a
current recovery procedure. Image
`sha256:420c469210565844d7b50d492b8faf253724d2a1ab6991a9124bf64ff94336dd` (amd64
`sha256:c1f2cd7cecc5afaba5ac1f646ad4ac1a51567159c2b175bb8ce42dcdfee3d9ee`; uid 1000, Node
26.13.0, no env, key, pem or `.dev.vars` files, build bases unchanged; with empty configuration
both services stop at startup). Neon snapshot `before-0033-sample-labels`
(`snap-round-wind-b80bomdm`, 16:47:17Z). `bun run --cwd server db:migrate` from the checkout,
the owner URL only in the process environment (from `neonctl connection-string`, checked by
role, database and host, then unset), applied 0033 at 16:47:39Z to 16:47:41Z on the first
attempt: `PASS`, journal 34, `samples` 2, `unlabeled` 2, `unsearched` 0, the production change
identical to the rehearsal's. On the 0033 schema the simp revisions kept serving: the canonical
checks matched the baseline and a fresh headless Claude Code client read the cover sheet and
`email` at the unchanged version `c83d91a3…`. MCP created 16:48:23Z to 16:48:29Z with `gcloud
run services update milton-mcp --image=<digest> --revision-suffix=rank-c63af7f` (keeps the
startup CPU boost), pinned with `update-traffic --to-revisions=milton-mcp-rank-c63af7f=100` at
16:48:46Z (generation 79); the app with `gcloud run services replace` from `app.release.json`
(the manifest naming the revision) at 16:49:02Z to 16:49:11Z, pinned by name at 16:49:21Z
(generation 67). Each revision spec differs from its predecessor only in the image (MCP
`milton-mcp-env:3`, the unmounted leftover `milton-mcp-env:2` volume, `milton-mcp-key:1`; app
`milton-app-env:3`, `milton-app-key:1`). No log line from either simp revision after its switch.
On the new code a fresh headless client listed four tools, with `intent` required on
`get_report`; the served instructions in its transcript equal the source, 4,066 characters; it
read the cover sheet and `email` with an intent at `c83d91a3…` (the version did not change form
for this account: both active samples were already served), one sample and no label fields (it
has none); without an intent it was refused `invalid_input` with the reconnect hint, and with a
201-character situation `invalid_input` naming the 200-character limit, without the hint. A
client holding the pre-release schema was refused the same way. Through MCP as `milton_app`:
resending the cover rule "Use the Oxford comma." on `c83d91a3…` answered `unchanged`; on the
stale `5bbb8ddf…` `conflict`; the first request replayed `unchanged`. Two receipts were stored
and nothing else changed. The forms probe printed `PASS`, `POST /billing/webhook` with a bad or
missing signature answered 400 `signature_invalid`, signed-out `/tps-report` answered 403 and
`/health` 200 on both. From 16:48:23Z to 16:55:48Z neither service logged a 5xx, an ERROR,
`does not exist`, `42703`, `samples_labels`, `lock timeout` or a secret-shaped string (MCP 31 x
200, 4 x 401, and 2 x 202 and 2 x 405 from a Codex client's notification POST and GET stream
probe; app 9 x 200, 2 x 400 and 5 x 403), every request landed on the rank revisions, and the
only tool calls were the checks above. Step 6's labeled-sample save ran afterwards from Lead's
session on Peter's go: one fictional follow-up email sample with audience, purpose and register
on the email report answered `saved` with a new version, and a `get_report` read with a matching
intent served it first with its three labels in `samples`.

Older recorded revisions are `milton-mcp-simp-893d0ce` and
`milton-app-simp-893d0ce`, image
`sha256:622c2142c54b18ea5ec753ec6e473e97186ecb036d798e60c1fe832ff264fa6e`.
Keep their recorded numeric secret versions. Select a previous runtime only after
checking that it supports the current schema. Retired schema rollback chains and
pre-step commands are no longer part of this checkout; recover forward for schema
changes. Compatibility of these older simp revisions with the cleaned baseline was
not verified in this release; use the immediate clean-c27869a candidate recorded above.

Roll back only affected services, preserve ingress/IAM, then repeat the canonical
security checks. If a
revision is no longer available, restore its saved service manifest with its
pinned image and matching secret versions using the release procedure above.
**Do not restore or reset the database.** Do not restore the old Vercel CNAME:
the project and its deployments no longer exist.
See [Google's revision rollback guide](https://docs.cloud.google.com/run/docs/rollouts-rollbacks-traffic-migration).

The isolated Neon validation project `cold-recipe-45005130` remains intact and
auto-suspends; it contains no production copies. Recreate isolated hosting explicitly
for future validation. Do not delete validation or production resources as part of an
ordinary release.

## Runtime role

The baseline creates `milton_runtime`, a NOLOGIN group role with
only the statements the runtime runs on each table (DELETE only on `users` and
`assistant_disconnects`; `store_config` read-only), USAGE on the
`instruction_card_position` sequence and schema `public`, CONNECT on the database, and
SELECT, INSERT and UPDATE by default on tables later migrations create (see the server
README for the table list). It owns nothing, so it cannot alter, drop or truncate a
table, disable a trigger or read the Drizzle journal. App and MCP then connect as
`milton_app`, a login role whose only membership is `milton_runtime`. Membership
inherits; the runtime needs no `SET ROLE` and no code change. The migration runner
keeps the `neondb_owner` connection and refuses any other role.

**Create `milton_app` with SQL, not the console or API.** Neon makes every role created
in the console, CLI or API a member of `neon_superuser`, which brings
`pg_read_all_data`, `pg_write_all_data`, CREATEROLE, CREATEDB, BYPASSRLS and REPLICATION
and so defeats the runtime role's least privilege. A role created with SQL has only what is
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

For a fresh installation, apply the baseline as the owner before creating the login.
Existing services already use `milton_app`; the legacy cleanup changes no credentials.
Work in a shell that keeps no history (zsh: start it with `HISTFILE=/dev/null zsh`)
and inside a private temporary directory outside the repository (`umask 077`).

1. Rehearse the role and payload setup on a fictional disposable installation first.
2. Confirm the current baseline and `milton_runtime` grants with the owner connection.
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

4. Mint the next payload version for each service from the encrypted version it mounted
   then (`milton-app-env:3`, `milton-mcp-env:3`). For the app (repeat for MCP with its
   own secrets and key):

   ```sh
   gcloud secrets versions access 3 --secret=milton-app-env --project=milton-510506 > app-current.env
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
     reads `store_config` as requests do. It passes only as `milton_app`, a plain
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
service account can read every version of its own secret, so `milton-app-env:1`,
`milton-mcp-env:1` and `milton-mcp-env:2` still give the running services the owner connection. Once the new
role has served for a full day without `store_unavailable` or `permission denied` (no
sooner than 24 hours after step 8), reset `neondb_owner`'s password in Neon, update
the owner connection kept for migrations, and disable both old versions
(`gcloud secrets versions disable 1 --secret=milton-app-env --project=milton-510506`,
`gcloud secrets versions disable 2 --secret=milton-mcp-env --project=milton-510506`).
After that, moving a service back to the owner connection means minting a fresh owner
payload first.

## Stripe billing

Trials and billing are live. No billing migration or trial flip is pending in this cleanup.
Keep the app's current encrypted payload and numeric secret references; the MCP service
gets no Stripe setting. Owner changes to `store_config` and subscription backfills are
separate operations and need their own authorization.

**Stripe mode.** The live key, live webhook secret and live price go in before `trials_enabled`
is flipped. Test mode runs on a disposable database only, never on production rows: a test id
does not exist in live mode, so no live event ever names that row, it stays `trialing` for
free, and the portal fails for that person. If a production row ever holds a test id, clear it
before going live. A key from the wrong mode against real rows reads as a failed Stripe list:
webhooks answer 503 and Stripe retries, sign-ins stop with try again, nobody is marked
canceled, and account deletion refuses rather than leave a live subscription charging.

A row holding an id the key cannot see, such as a test id under a live key, refuses deletion every
time until an operator clears it, and that person's deletion request waits meanwhile. First confirm
the key is the right one: a wrong key is fixed, not worked around. Then clear the row's
`stripe_customer_id` and `stripe_subscription_id` and set `subscription_status` to `canceled`.

**Stripe Dashboard settings.** Failed payments must be set to "Cancel the subscription" in both
test and live mode; check it before `trials_enabled` is flipped. The gate reads `unpaid` as
expired and Checkout will not sell over it, and nothing confirms the portal can settle it, so
"Mark as unpaid" would lock out a paying person until support steps in.

Payment methods come from the Dashboard's default payment method configuration, which is
Peter's. No code sets payment method types.

Stripe's customer emails are Dashboard settings too, and no code sends them. In live mode, check
all three are on before `trials_enabled` is flipped:

- Trial-ending reminder: "Send a reminder email 7 days before a free trial ends", with the link
  to a Stripe-hosted page.
- Payment receipts: "Successful payments", under Customer emails.
- Failed-payment emails: "Send emails when card payments fail".

Stripe sends no trial reminders in a sandbox, so a test-mode run cannot confirm the first.

**Backfill.** The subscription backfill gives existing accounts their trial. It runs from a checkout of the released
commit, after `bun install --frozen-lockfile`. The runtime image cannot run it: it is Node with one
bundled file, no `bun` and no `server/scripts`. Set `MILTON_ENCRYPTED_ENV_FILE` to the app's
encrypted payload and `DOTENV_PRIVATE_KEY` to its key, at the numeric versions the app mounts
(`<env>` and `<key>` below). The script prints no value. First the dry run:

```sh
umask 077
dir="$(mktemp -d)"
gcloud secrets versions access <env> --secret=milton-app-env --project=milton-510506 > "$dir/app.env"
export MILTON_ENCRYPTED_ENV_FILE="$dir/app.env"
export DOTENV_PRIVATE_KEY="$(gcloud secrets versions access <key> --secret=milton-app-key --project=milton-510506)"
cd server
bun --no-env-file scripts/backfill-subscriptions.ts
```

Read the counts. Then, in the same shell:

```sh
bun --no-env-file scripts/backfill-subscriptions.ts --apply
cd ..
unset MILTON_ENCRYPTED_ENV_FILE DOTENV_PRIVATE_KEY
rm -rf "$dir"
```

It prints only counts (total, created, skipped, failed, still NULL), at about 5 accounts a second,
and refuses without `trials_enabled` and a live key. `--allow-test-key` is for disposable
databases only. With `--apply` it exits nonzero if any account still has no status; rerun it, since
rows with a status are skipped. A returning deleted
identity's row is canceled and counted as skipped. A row left at NULL is free until a browser sign-in: an approval
Neon already holds refreshes without any Milton page. A customer it creates has no email
until its person first opens billing, when Milton copies their sign-in email to Stripe. Everyone
who can add a card or pay passes through there, so nobody is charged without one unless the copy
fails or sign-in supplied no address; until then Stripe sends that person nothing, including its
trial-ending reminder.

## Legacy schema cleanup

**Applied to production on 2026-11-04 at 18:54:45Z.** The current release above records
the snapshot, exact transition and verified preservation. That cleanup left one baseline
journal entry at `1793815543500`; the sample-context release above adds `0001`. `server/drizzle/0000_baseline.sql` is for empty
installations; `server/scripts/transition-baseline.sql` supports the one known old 34-entry
0033 state (latest timestamp `1793779058436`). No earlier schema state or historical schema
rollback chain is supported.

The transition drops only the unused `memos`, `memo_versions`, `memo_cards`, their five
functions and six triggers, the card-version `legacy` flag, and six obsolete limits keys.
The rewritten card-version guard keeps sequential, immutable, account-scoped history.
All other fields and rows survive, including card history copied from the retired subsystem,
samples, accounts, billing and receipts. Current configured limits, including `reason_bytes`,
stay unchanged. No archive is required.

1. From the landed main commit, rehearse the fresh baseline on an empty disposable database or
   branch. Separately, build a disposable known-0033 rehearsal database using the historical
   migrations from immutable commit `b797f1b`, seed it with fictional rows, and rehearse the
   exact 0033 transition using landed main. Those historical files are rehearsal inputs only;
   do not restore them to main. Compare catalogs, grants/default privileges, every
   surviving row, configured limits and served report versions; exercise save/replay,
   immutability, account isolation, least privilege and account deletion. Repeat the transition
   and normal migrator. A wrong journal and an injected failure must refuse atomically.
2. Preserve the current Cloud Run revisions, image digests and numeric secret versions. Release
   the matching cleanup image to MCP and app from main; confirm both serve it. The cleanup code
   reads the same current fields on both schemas. No active read depends on a dropped field.
3. Close ingress and drain writers as above. Confirm the owner connection's database, role and
   branch without printing its URL. Take and record a Neon snapshot immediately before the
   transition. Capture current row hashes/counts and report versions privately for comparison;
   never put content, connection strings or key values in logs or the repository.
4. With the owner login held only in process `PG*` variables and shell/psql history disabled, run
   from the repository root:

   ```sh
   psql -X -v ON_ERROR_STOP=1 -f server/scripts/transition-baseline.sql
   ```

   The script requires `neondb_owner`, locks the journal and tables, and checks all 34 journal
   timestamps and hashes against the known 0033 fingerprint. Any other state visibly refuses;
   do not edit the journal to bypass it. The single statement commits DDL, limits pruning and
   journal replacement together. A repeat prints `baseline_transition_already_done` and changes
   nothing. On an uncertain connection outcome, inspect the schema and journal before retrying.

5. Set `MILTON_OWNER_DATABASE_URL` only in the process environment, run the regular
   `bun run --cwd server db:migrate` twice and unset it. Both runs must be no-ops. The journal
   now has one baseline entry at `1793815543500`; later generated migrations start at `0001`.
   Compare every surviving row (excluding only `legacy` and the six removed limit keys), the
   catalog and configured limits with the rehearsal, and confirm report versions are unchanged.
6. Restore ingress and repeat canonical TLS/health/discovery/auth/forms checks, a fresh-client
   report read, and the runtime-role check. Do save/replay and deletion checks in the isolated
   environment; a write to a real account still needs the person's exact approval. Inspect logs
   for `does not exist`, permission errors and lock timeouts. Record the release evidence and
   delete TODO #24 only after this gate passes.

There is no reverse migration that restores the retired memo layer. If schema recovery is
required, stop writers and use the pre-cleanup snapshot under a separate recovery decision.
Do not restore a database snapshot merely to change runtime traffic. Never point a fresh
baseline at a populated old database: it refuses and directs the operator to the transition.

## Self-hosted auth cutover preparation

This section prepares the selected three-service build. It records no deployment,
secret version, mapping approval, provider/mail readiness or live auth disable.
All pinned production descriptors, images and rollback revisions above remain the
managed deployment record. Only the selected release coordinator integrates/releases.

The new issuer is `https://auth.meetmilton.com/api/auth`. Native auth is a separate
service and cookie host, never mounted on app/MCP. Preserve app/MCP URLs and static-site
hosting. Core owns auth routing/service preparation; apply no DNS/IAM/provider/mail
change as part of a local build. Verify the actual LB transport identity before enabling
network limits; a public Host never makes arbitrary forwarding headers trusted.

Apply the following only in a separately authorized closed-ingress cutover, after a
snapshot and rollback check. Rehearse against disposable data first:

1. Audit retained source metadata/schema, role memberships, PUBLIC views/functions,
   defaults, object ownership and DDL/TEMP rights. Prepare separate NOINHERIT
   `milton_auth_runtime`, `milton_app_runtime`, `milton_mcp_runtime` and non-login
   migration owners. Never grant the shared legacy writing group to these runtimes.
   Preserve managed schema/data and existing writing/Stripe/trial IDs. Before running
   auth000, reconcile an explicit complete retained-login CONNECT/audited TEMP JSON
   inventory on the same privileged connection; missing or inconsistent inventory
   refuses transactionally before PUBLIC revocation. See the exact invocation and
   delegated NOINHERIT owner role/options in [auth operations](../../apps/auth/README.md#retained-login-bootstrap-and-delegated-owner).
   Never copy owner credentials into auth/app/MCP or the delivery job.
2. Apply existing writing migrations, then core native001–006 in order as its owner.
   Auth receives no writing/Stripe/app-credential access. App/MCP receive only narrow
   native guard EXECUTE privileges, never credential/recovery/provider/key reads.
3. Review `server/migrations/000-app-owner.sql` to prepare the non-login app migration owner and metadata-only privileges after the writing baseline. Apply `server/migrations/005-app.up.sql` as that owner, after native005 (recovery-proof invalidation).
   `migrate.ts --app-auth` requires explicit `MILTON_OWNER_DATABASE_URL` and refuses a
   missing native security-status function. It is separate from Drizzle's writing journal.
   Apply once; no service migrates on startup. The new schema has no writing-role default
   grants. Owner-review/apply `005-app-roles.sql` against actual writing ownership.
   Row locks get UPDATE(id) on the immutable-ID column, rather than account-state writes.
4. Use verified metadata, not email equality, to map each retained legacy subject to an
   exact native issuer/subject and retained internal m_* ID. Owner input for
   `server/scripts/auth-identity-import.ts --dry-run <private-metadata.json>` includes
   `legacySubject,issuer,subject,userId,verifiedEmail,verifiedIdentities`. Deleted records
   have `userId:null` and must match an existing hash of `neon:subject`; those hashes
   cannot be inverted, renamed or silently discarded. Resolve every missing/ambiguous
   record before cutover. `--apply` is a separate explicit owner action; neither mode
   scans private writing or accepts legacy tokens. Input and identity metadata stay private.
5. Provision the dedicated stable `MILTON_TRIAL_FINGERPRINT_KEY` in app secret storage.
   The verified import command (an empty batch for a genuinely fresh database) provisions
   its durable key check. Admission refuses a missing/mismatched policy. Back up this key
   separately from rotating auth cookies/provider encryption. Routine key rotation is not
   supported: changing it requires a designed dual-key migration before any change, not
   a fresh key that silently grants new trials. Keep minimal eligibility fingerprints and
   their first claimant after deletion; do not expose them in claims or use them as owners.
6. Owner-provision the fixed native confidential app client with exact callback/logout
   URLs, code/S256, identity-only scopes, no resource, no refresh and no offline scope.
   Distribute `AUTH_APP_CLIENT_ID/SECRET` only to app and native owner configuration;
   `AUTH_ADMISSION_SECRET` only to app/auth. App runtime additionally gets its stable
   eligibility key and Stripe settings. MCP gets issuer/resource/app URLs and its own
   database login, no app/native/billing secrets. Use separate dotenvx payloads and numeric
   platform secret versions; never export a secret through a product route.
7. Run the actual role checks for app/MCP using `MILTON_SERVICE` and each private URL,
   core's auth-role check, root types/tests/format, Node26 bundle/container checks and
   `bun --no-env-file server/scripts/check-auth-integration.ts`. The local rehearsal owns
   PG55623 and checks 20201–20204, uses fictional identities/real TLS login roles, dispatches
   canonical HTTPS requests in-process and refuses external requests. It is not browser,
   real Google/GitHub/mail, Muse portal, live mapping or production privilege acceptance.
8. Complete browser and client acceptance on selected staged services: host-only cookie
   separation, new-flow SSO renewal/absolute expiry, signed-out callback recovery, native
   freshness, account/security actions, read/write discovery/direct refusal, disconnect
   then reconnect/replay, offline logout/refresh then recovery, Stripe-first deletion retry,
   full writing/download behavior and mobile/desktop wrapping. Verify configured real
   provider/mail callbacks/sender and approved reviewer access through secure intake.
9. Release code/routing/secrets only within recorded authorization, preserving rollback
   images/revisions and snapshots. Reject old managed tokens and stale cookies. Verify
   mappings/roles/protocol/behavior before disabling managed Auth; retain its data/schema.
   No fallback to the old issuer exists in this build. Before reopening ingress, reconcile
   public privacy/password/mail/deletion/eligibility statements and Muse intake copy with
   parent/designer acceptance. No online submission is implied.

`005-app.down.sql` is an offline rollback: it refuses unfinished lifecycle operations,
removes ephemeral app sessions/flows, and preserves verified mappings, eligibility key
policy/fingerprints and original lifecycle progress. Reapply restores app credentials;
it does not roll native authority backward or make managed sessions usable. Do not
roll back to a managed runtime after destructive native lifecycle work without explicit
reconciliation and the corresponding data/secret snapshot. Keep native allocator fences.

A deletion's original UUID/subject/incarnation/internal account and progress survive lost
responses. App cleanup is at most four native calls of 16 rows per table per request;
unknown owned-client/unbound inventory refuses instead of taking unbounded FK cascades.
Retry the original operation from the original browser association. If that association
is unavailable, keep ingress/refusal intact and reconcile the exact persisted operation
privately as an owner; never select a current identity by email or reset its targets.
Writing erasure occurs only after Stripe cancellation has committed, and native deletion
is last. Record incomplete native cleanup honestly. Existing minute-based Stripe creation
can still have remote-success/local-timeout ambiguity across a minute boundary; this build
makes no universal exactly-once billing claim.

App login flows expire after ten minutes and app sessions after at most one hour; new logins reclaim at most16 expired rows per table. Deletion erases app-held credentials for the original issuer/subject/incarnation after Stripe succeeds, while the separate original operation remains retryable. Admission correlations expire after24 hours and subsequent admissions reclaim at most16 expired rows. Eligibility fingerprints/key policy, verified legacy mapping metadata and immutable lifecycle associations remain indefinitely for no-second-trial and safe-replay purposes; public disclosures must state that limited retention.

### Auth mail006 and operator recovery preparation

Mail006 adds owner-owned encrypted message/receipt storage and auth-only accept/claim/finish functions, with no runtime CRUD or native-user FK. Apply it under the selected closed-ingress snapshot/migration procedure before selecting a compatible **fixed** self-hosted writer. Native proof issuance and mail acceptance are separate commits; a503 is uncertain/retryable, not rollback/delivery proof. Old inline-send revisions still have PR-04: never select one as a safe public fallback or run mixed vulnerable writers with public signup enabled. Closed prelaunch storage preparation is not public security acceptance. After launch select a compatible fixed revision/forward fix preserving queue/keys/data, retained rollback revisions, pinned images and numeric secret versions.

[Mail job preparation](auth-mail-job.preparation.json) is disabled/nondeployable, has no apply argument and enables no scheduler. The auth image's `node deliver.js` defaults to a dry run with no environment/DB/provider access. Later explicit `node deliver.js --apply` uses only auth runtime credentials, AUTH_SECRET and the existing Resend key. Keep owner maintenance separately selected. Pool1, bounded connect/query timeouts, at most16 candidates per90-second delivery pass, one leased claim at a time,2-minute leases, five-second sends, at most5 claims and1/2/4/8-minute backoff limit work. Shared429 Retry-After pause stops the pass without claiming/burning later work; worker parsing and SQL storage cap it at24 hours while retaining valid3000-second pauses. Prepare a count-only alert for any `auth_mail_pass` with `throttled > 0` and an operator pause/backlog check; no alert is enabled here. The cap aligns with the documented daily reset window, does not prove this account's quota or provider recovery, and does not resolve monthly exhaustion. Use the [owner-only throttle inspection/reset procedure](../../apps/auth/README.md#throttle-inspection-and-recovery-prepared-not-enabled) only after verified recovery, through the separate delegated NOINHERIT login explicitly assuming NOLOGIN `milton_auth_owner`; never move owner credentials into delivery. Preserve job deadlines/attempts and re-inspect a changed pause. The prepared one-task job has no platform retries and180-second outer timeout for startup checks plus the pass. Its once/minute cadence is only a rehearsal candidate; choose actual cadence after verifying sender/effective quota, backlog, timeout/retry/lease behavior and bounded cleanup throughput. No enable/deploy command is selected here.

Matching protected auth key material is needed to read backed-up pending payloads. Native domain-separated version1 encryption binds exact original job/target/fences/proof expiry and complete provider message. Retired/missing keys make pending messages terminal unreadable, requiring new native links. Resend job-id idempotency has vendor limits; local timeout after remote success or a crash before finish remains ambiguous, with identical payload/key on retry. No universal exactly-once claim.

Delivery deadline is native proof expiry or15 minutes after acceptance, whichever is earlier. Terminal transition clears ciphertext. Bounded claim/owner `cleanup_expired(1..64)` clears expired/fenced payloads; delayed/disabled/backlogged maintenance can retain encrypted contents longer. No-op/terminal receipts become eligible after24 hours and also need bounded maintenance for physical removal. Native reset proofs retire immediately on security change/deletion; stateless verification expires at1 hour and remaining native verification rows become cleanup-eligible1 day after expiry. Document actual payload/receipt/backup/vendor retention before release. 006 down refuses any pending row; clear/drain bounded work first, without enabling a vulnerable writer or restoring retired proofs.

Owner migration/provision/maintenance commands refuse unless the exact apply arguments and separate AUTH_OWNER_DATABASE_URL are selected. A delegated NOINHERIT login must explicitly assume NOLOGIN milton_auth_owner (`SET ROLE` for SQL, URL-encoded `options=-c%20role%3Dmilton_auth_owner` for Node commands); the privileged administrator grants SET membership without inheritance and CONNECT separately. See auth README for exact commands. New runtime roles have no owner membership, CREATE or TEMP.

The existing native migrator commits each SQL file separately from its ledger write. A crash can leave actual schema ahead of or behind the ledger. Stop and fail closed: preserve the selected snapshot/image/numeric keys, compare actual qualified schema/functions/grants/data with the exact file and intended direction, then privately reconcile only a proven completed file or select compatible repair/snapshot recovery with stale-authority invalidation. Never blindly rerun/edit a migration, mark uncertain work applied, rewind allocator fences or resurrect retired proofs. This build does not close that engine crash gap.

Retain disabled managed Neon schema/data and backups until separately selected cleanup or backup expiry; new native deletion does not erase them. Accurate native-deletion/public privacy/Muse candidate wording includes that legacy retention now, without waiting for cleanup. Designer acceptance, same-reviewer delta review, actual provider/browser/client/hosted/role/restore tests and release-coordinator selection remain later gates.

Native reset links carry their proof in `/api/auth/reset-password/*`, not only a query. Before hosted use, verify full credential-path request-log exclusions at ingress/Cloud Run alongside verification/OAuth query exclusions; query-only redaction cannot protect that native path. Local code/bundle tests do not establish hosted logging behavior.
