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
The manifests pin what is serving now: app `milton-app-dead-d03de23`
(`sha256:29489483…`, env 2, key 1) and MCP `milton-mcp-dead-d03de23`
(`sha256:29489483…`, env 3, key 1), both connecting as `milton_app`; see the current
release below. There is no worker service or scheduler job. There is no memo-update
allowance; the daily call cap bounds saves. Existing positive account safeguards remain
in effect. Trials and billing remain disabled.
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
database schema and accounting policy, then send traffic to its recorded healthy Cloud
Run revision. Do not restore a database snapshot to roll back application code. An
existing revision retains its image, runtime configuration and numeric secret
references. Inspect revision readiness before selecting a recorded revision:

```sh
gcloud run revisions list --service=milton-app --project=milton-510506 --region=us-east4
```

Now serving: MCP `milton-mcp-bill-fa7a2cb` (since 2026-11-04 04:52:19Z) and app
`milton-app-bill3-fa7a2cb` (since 05:10:17Z), one image and one commit, on Drizzle journal 28,
with trials on since about 05:19Z; recorded below. There is no worker service.

Current release bill-fa7a2cb: migration 0027, MCP and app, the app's Stripe settings, then the
data statement, the flip and the backfill, from main `fa7a2cb` (the merge of `agent/billing-1`:
Stripe owns the trial, the gate reads `subscription_status`, billing routes, the webhook ledger
and the backfill script). On 2026-11-04, by two release agents (snapshot, image, 0027, both
deploys and their checks), Lead (data statement, flip, backfill) and Peter (the Stripe Dashboard
gates and the `milton-app-env:3` mint). Before it, dead-d03de23 served both services on journal
27 with trials off and `trial_accounts` empty. Neon snapshot `before-0027-billing`
(`snap-restless-cloud-b83a3hem`, 04:47:53Z). The commit tree passed `check-types`, `bun test`
(109 pass) and `format:check`. Image
`sha256:f90ab52937e360181fe7ed64fb4eda5453b81d37d0c7f095fb3b55b582863db5` (amd64
`sha256:cc481ed017f7f605edb549431697f0067b4e3620eb61306a457c3c6f41fe37fc`; uid 1000, Node
26.13.0, no env, key, pem or `.dev.vars` files, build bases unchanged; with empty configuration
both services stop at startup). A throwaway branch from production (`rehearsal-0027-billing`)
rehearsed 0027 through the migration runner (journal 27 to 28; only `stripe_events`, the six
nullable `trial_accounts` columns, two unique constraints and their indexes, four checks and the
`milton_runtime` grants were added; 275 rows, every existing table identical; a rerun changed
nothing), then `rollback/0027` (schema identical to the pre-0027 capture) and a hand re-forward
(identical to the first forward); the branch was deleted. No scheduler job exists, so nothing was
paused. The release agent applied 0027 at 04:51:15Z to 04:51:17Z with `bun run --cwd server
db:migrate` from a checkout of `fa7a2cb` with no `server/.dev.vars`, the owner URL held only in
the process environment (captured from `neonctl connection-string` for `neondb_owner` on
`milton`, checked by role, database and host, then unset): `PASS`, journal 28, 18 tables and 275
rows before and after, the production change identical to the rehearsal, 0 rows marked canceled
(0 rows started before their user). MCP created 04:52:06Z to 04:52:11Z with `gcloud run services
update milton-mcp --image=<digest> --revision-suffix=bill-fa7a2cb` (keeps the startup CPU
boost), pinned with `update-traffic --to-revisions=milton-mcp-bill-fa7a2cb=100` at 04:52:19Z; app
`milton-app-bill-fa7a2cb` with `gcloud run services replace` from `app.release.json`, pinned by
name at 04:52:31Z. Each spec differed from dead-d03de23 only in the image (MCP
`milton-mcp-env:3`, the unmounted leftover `milton-mcp-env:2` volume, `milton-mcp-key:1`; app
`milton-app-env:2`, `milton-app-key:1`); neither carried a `STRIPE_*` setting. On the new code
with trials off the canonical checks matched the baseline, the probe printed `PASS`, a fresh
headless Claude Code client listed four tools, saw instructions of 4,094 characters identical to
the source and read `get_cover_sheet` with no error or notice (version `5bbb8ddf…` unchanged),
and `POST /billing/webhook` answered 503 JSON `billing_unavailable`. Peter minted
`milton-app-env:3` (05:08:25Z) with the step 5 keys; the release agent redeployed the app only as
`milton-app-bill3-fa7a2cb`, whose spec differs from `milton-app-bill-fa7a2cb` only in the env
version, Ready 05:10:08Z and pinned at 05:10:17Z; MCP was untouched. On `:3` the canonical
checks and probe matched, a bad or missing `Stripe-Signature` answered 400 `signature_invalid`
(the Stripe settings loaded), and a fresh client's cover-sheet read showed no notice. From
04:52:06Z to 05:15:28Z neither service logged a 5xx or an error other than the release agent's
own five 503 checks on `:2`. Lead reran the data statement at about 05:16Z (0 rows), Designer
published the site copy (`022c816`), and Lead set `trials_enabled` true at about 05:19Z. At
05:24Z Lead ran the backfill from the `fa7a2cb` checkout as in the Backfill recipe (`<env>` 3,
`<key>` 1, secrets only in the process environment): the dry run, then `--apply` with total 2,
created 2, failed 0, still NULL 0; a dry rerun skipped 2. Both `trial_accounts` rows are
`trialing` with `cus_` and `sub_` ids and trial end 2026-12-04. `stripe_events` holds 4 rows (2
`customer.subscription.created`, 2 `invoice.paid`, 05:24:22Z to 05:24:25Z), and each of Stripe's
four deliveries got a 200, so the installed webhook secret verifies live deliveries; the ledger
has no failure column (`id`, `type`, `received_at`, `payload_sha256`). Lead's cover-sheet read
through MCP at 05:24:41Z returned `read` with no notice. From 05:19:00Z to 05:25:37Z neither
service logged a 5xx or an error (MCP 1 x 200; app 4 x 200, all Stripe's deliveries), no older
revision logged a line, and no log line in the window held `sk_`, `rk_`, `whsec_`, `price_1`, a
Postgres URL, an `encrypted:` value or a secret's name. At 05:26:08Z `/health` answered 200 on
both and traffic was 100% `milton-mcp-bill-fa7a2cb` (generation 75) and
`milton-app-bill3-fa7a2cb` (generation 63). Not checked by an agent: Stripe's own list of live
customers and the Dashboard's delivery view, that no row holds a test id (the `cus_` and `sub_`
prefixes do not tell modes apart), and Peter opening billing on an account to see the live
portal. `milton-app-env:3` still carries the retired `MILTON_GEMINI_API_KEY`,
`MILTON_GEMINI_PROJECT_ID`, `MILTON_MODEL_ACCOUNT_BUDGET_USD` and
`MILTON_MODEL_GLOBAL_BUDGET_USD`, which no code reads; a later version drops them.

Rollback. Trials are on, so there is no traffic rollback: dead-d03de23 and every earlier
revision gate on the retired clock and refuse paying customers. `milton-app-bill-fa7a2cb` (same
image, `milton-app-env:2`) is no fallback either: without Stripe settings its webhook answers 503
and Stripe retries. Recover forward with a new image. To stop new charges and gating, Peter can
set `UPDATE store_config SET trials_enabled = false WHERE singleton = 1;` as `neondb_owner`,
which returns everyone to allowed; existing Stripe subscriptions keep running and charging, so
tell Peter before doing it. Do not run `rollback/0027_stripe_billing.sql`: it refuses once any
customer or event is recorded. Never restore `before-0027-billing` over rows written since it.

Release dead-d03de23: the 0026 pre-step, MCP and app, then migration 0026, from main
`d03de23` (dead-code batches A and B: the legacy sign-up seed no longer writes
`identities.profile_json`, old fonts are no longer served, retired route prefixes return 404,
and the code stops writing the dead columns). By a release agent on 2026-11-04, each serving until bill-fa7a2cb. Pre-step at
02:41:14Z as `neondb_owner`, in one statement string on the direct (unpooled) host:
`SET lock_timeout = '5s'; ALTER TABLE save_requests ALTER COLUMN reserved_micros SET DEFAULT 0;`
succeeded on the first attempt; the column then read `default=0`, NOT NULL. The commit tree
passed `check-types`, `bun test` (97 pass) and `format:check`. Image
`sha256:29489483e08b2175f0da512d4d1d0a3b6c0bace97c601030c866a91efa71aece` (amd64
`sha256:08259462355c9cc09e13320cef91eec9c0b82728599fa4b618df01d9d1ed3483`; uid 1000, Node
26.13.0, no env, key or pem files; the bundle has no `profile_json`, `reserved_micros`,
`templates_revision`, `daily_writes` or `needs_clarification`). MCP created 02:43:06Z to
02:43:12Z with `gcloud run services update milton-mcp --image=<digest>
--revision-suffix=dead-d03de23` (keeps the startup CPU boost the manifest lacks), pinned with
`update-traffic --to-revisions=milton-mcp-dead-d03de23=100` at 02:43:40Z; the app with
`gcloud run services replace` from `app.release.json` (a copy naming the revision), Ready
02:43:52Z, pinned by name at 02:44:06Z. Each revision spec differs from its predecessor only in
the image (MCP `milton-mcp-env:3`, the unmounted leftover `milton-mcp-env:2` volume,
`milton-mcp-key:1`; app `milton-app-env:2`, `milton-app-key:1`); no secret version changed. On
the new code and the 0025 schema the canonical checks matched the baseline and the forms probe
printed `PASS`. With both services at 100% and no log line from either open-13f2d93 revision
after its switch, a throwaway branch from production (`rehearsal-0026-dead-columns`) rehearsed
0026 through the migration runner (journal 26 to 27; only the six columns, their checks, NOT
NULLs and column grants, the two indexes and the `limits_json` default went, the save guard was
replaced and `usage_nonnegative` rewritten; 274 rows, every table identical with the dropped
columns left out), then `rollback/0026` (schema identical to the pre-0026 capture, including
`reserved_micros DEFAULT 0`), then the hand re-forward `psql -1 -v ON_ERROR_STOP=1 -f
server/drizzle/0026_dead_columns.sql` (identical to the first forward). On the branch only, a
rolled-back transaction inserted a receipt without `reserved_micros`, completed it, was refused
`save_receipt_is_immutable` on a later change, and deleted it, on both the 0026 and the
rolled-back shape. The branch was deleted. Then Neon snapshot `before-0026-dead-columns`
(`snap-quiet-brook-b84mpp38`, 02:46:53Z) and 0026 applied 02:47:04Z to 02:47:08Z as
`neondb_owner` (journal 26 to 27). The production change matched the rehearsal exactly; 17
tables and 274 rows before and after, every table identical with the dropped columns left out
(the stored `limits_json` row is unchanged), triggers, indexes other than the two, table grants
and roles unchanged, 0 unfinished saves. After the migration the canonical checks matched the
baseline, the probe printed `PASS`, and a fresh headless Claude Code client listed exactly four
tools and read `get_cover_sheet` with no error, version `5bbb8ddf…` unchanged, memo updates
0/100. From 02:43:06Z to 02:50:37Z neither service logged an error, `unexpected_error`, 5xx or a
missing-column error (MCP 30 x 200 and 8 x 401; app 19 x 200, 8 x 403 from the checks and 6 x
404 from Stripe's `POST /billing/webhook`, which has returned 404 since 01:48Z, before this
release); the only tool call was the fresh client's read. No save ran: the save check (resend
one existing cover rule, expect `unchanged`) waits for Peter's go.

Rollback (since trials went on, unreachable: see bill-fa7a2cb). Since 0026 is applied, open-13f2d93 cannot sign up an account or save (it writes
`identities.profile_json` and `reserved_micros`). Stop writers, run
`server/drizzle/rollback/0026_dead_columns.sql` offline as `neondb_owner` (rehearsed; it restores
shape, not data), then shift traffic and, in the same step, set the manifests' images back to
`sha256:8f205685dafc34e2a7f3375d0301ac4a4a224c13779db38af29f6d8772bf3b7d`. The 0026 journal row
stays, so re-forwarding means the hand re-forward above. The dead-d03de23 code runs on either
schema, so after the rollback script its revisions stay valid. Never restore the
`before-0026-dead-columns` snapshot to roll back code.

```sh
gcloud run services update-traffic milton-mcp --to-revisions=milton-mcp-open-13f2d93=100 --project=milton-510506 --region=us-east4
gcloud run services update-traffic milton-app --to-revisions=milton-app-open-13f2d93=100 --project=milton-510506 --region=us-east4
```

Release open-13f2d93: MCP and app, then migration 0025, from main `13f2d93` (the merge of
`agent/open-signup`). Revisions `milton-mcp-open-13f2d93` and `milton-app-open-13f2d93`, switched
directly at 100% (no users yet) by a release agent on 2026-11-04, each serving until dead-d03de23: MCP created 01:15:24Z to
01:15:30Z with `gcloud run services update milton-mcp --image=<digest>
--revision-suffix=open-13f2d93` (the live MCP template carries the startup CPU boost, which the
manifest lacks), then `update-traffic --to-revisions=milton-mcp-open-13f2d93=100` at 01:15:46Z; the
app with `gcloud run services replace` from `app.release.json` (a copy naming the revision) at
01:15:54Z, Ready 01:16:01Z, pinned by name with `update-traffic` at 01:16:06Z. Both run image
`sha256:8f205685dafc34e2a7f3375d0301ac4a4a224c13779db38af29f6d8772bf3b7d` (amd64
`sha256:6648c10392312cd67ad81573ed1d748db593abfb252522eccaafa9705eb1fa0e`; uid 1000, Node
26.13.0, no env, key or pem files; build stage `oven/bun:1.4.4`; the bundle has no
`signup_mode`, `allowed_identities` or `admission_refused`). Each revision spec differs from its
predecessor only in the image (MCP keeps the startup CPU boost, the mount `milton-mcp-env:3`, the
unmounted leftover `milton-mcp-env:2` volume and `milton-mcp-key:1`; app `milton-app-env:2`,
`milton-app-key:1`); no secret version changed. Change: the admission gate is gone; every
successful sign-in creates or finds its account. Release order: code first, because
stick-4272d1d reads both dropped columns on a first sign-in. Before the release the commit tree
passed `check-types`, `bun test` (100 pass) and `format:check`. First, a throwaway branch from
production (`rehearsal-0025-open-signup-2`) rehearsed 0025 through `migrateStore` (journal 25 to
26; only the two columns, their two checks and NOT NULLs, and the column grants that went with
them were gone; 274 rows, every other table and every function, trigger, index and grant
unchanged), then `rollback/0025` (the schema matched the pre-0025 capture exactly, row `open`),
then a hand re-forward with `0025_open_signup.sql` (identical to the first forward); the branch
was deleted. An earlier attempt on a first throwaway branch failed in the helper before
migrating and was discarded with its branch. On the new code and the 0024 schema the canonical
checks matched the baseline and `bun scripts/probe-forms.ts` printed `PASS`. Then Neon snapshot
`before-0025-open-signup` (`snap-shiny-dream-b8j4jq7z`, 01:16:20Z) and 0025 applied at 01:16:32Z
to 01:16:33Z through `migrateStore` as `neondb_owner` (Drizzle journal 25 to 26). `store_config`
lost `signup_mode` and `allowed_identities_json` with `config_signup_mode` and
`config_allowlist_array`; its other fields are unchanged (`memo_updates_enabled` true,
`memo_updates_daily_limit` 100), 17 tables and 274 rows before and after, the other 16 tables
kept identical hashes, and functions, triggers, indexes and table grants are unchanged. Before
the drop the row was `open` and held one allow-list identity, now kept only in the snapshot.
After the migration the canonical checks again matched the baseline (MCP and app `/health` 200,
discovery 200, unauthenticated `/mcp` 401 with resource metadata, app `/` and `/login` 200 with
its CSRF field, signed-out `/assistants`, `/account/delete` and `/download` 403, HTTP 308,
`run.app` 404), the probe printed `PASS`, and a fresh headless Claude Code client listed exactly
four tools and read `get_cover_sheet` with no error, version `5bbb8ddf…` unchanged and memo
updates 0/100. From 01:15:24Z to 01:20:35Z neither service logged an error, `unexpected_error`,
`does not exist` or 5xx (MCP 21 x 200 and 8 x 401; app 17 x 200 and 8 x 403, all from the
checks), and the only tool call was the fresh client's `get_cover_sheet` read. No account was
created and no save ran, so a first sign-in on the new code was not observed in production.

Rollback (since 0026, reachable only after the 0026 rollback above). Since 0025 is applied, stick-4272d1d cannot create an account: a traffic shift alone
breaks first sign-ins (only a first sign-in reads the dropped columns). Stop writers, run
`server/drizzle/rollback/0025_open_signup.sql` offline as `neondb_owner` (it re-adds both
columns, sets the row to `open` with an empty list and restores both checks; rehearsed), then
shift traffic and, in the same step, set the manifests' images back to
`sha256:ce6fc19c5fb4ab4007cad1c6aa7f9bc1437f31461a787e2073522f07cabf9e4a`. The
0025 journal row stays, so re-forwarding means running `0025_open_signup.sql` by hand. The new
code runs on either schema, so after the rollback script the open-13f2d93 revisions stay valid.
Never restore the `before-0025-open-signup` snapshot to roll back code.

```sh
gcloud run services update-traffic milton-mcp --to-revisions=milton-mcp-stick-4272d1d=100 --project=milton-510506 --region=us-east4
gcloud run services update-traffic milton-app --to-revisions=milton-app-stick-4272d1d=100 --project=milton-510506 --region=us-east4
```

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

## Runtime role (0024)

Applied 2026-11-03 07:41:10Z (journal 25, snapshot `before-0024-runtime-role`,
`snap-green-smoke-b8z8gpou`); app and MCP connect as `milton_app` since the role-0851a8c
release. Migration 0024 creates `milton_runtime`, a NOLOGIN group role with
only the statements the runtime runs on each table (DELETE only on `users` and
`assistant_disconnects`; `store_config` read-only, its lock grant revoked by 0028), USAGE on the
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

4. Mint the next payload version for each service from the encrypted version it mounted
   then (`milton-app-env:1`, `milton-mcp-env:2`). For the app (repeat for MCP with its
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
service account can read every version of its own secret, so `milton-app-env:1`,
`milton-mcp-env:1` and `milton-mcp-env:2` still give the running services the owner connection. Once the new
role has served for a full day without `store_unavailable` or `permission denied` (no
sooner than 24 hours after step 8), reset `neondb_owner`'s password in Neon, update
the owner connection kept for migrations, and disable both old versions
(`gcloud secrets versions disable 1 --secret=milton-app-env --project=milton-510506`,
`gcloud secrets versions disable 2 --secret=milton-mcp-env --project=milton-510506`).
After that, moving a service back to the owner connection means minting a fresh owner
payload first.

## Open sign-ups (0025)

Applied 2026-11-04 01:16:32Z (journal 26, snapshot `before-0025-open-signup`,
`snap-shiny-dream-b8j4jq7z`), after the open-13f2d93 code served MCP and app (see the release
records).

Migration 0025 drops `store_config.signup_mode` and `allowed_identities_json` with their
checks: every successful sign-in creates or finds its account (see the server README).
Every revision before this release locks and reads both columns on a first sign-in; this
release reads neither and runs on either schema. Release order: ship MCP and app from the
same image, take a snapshot, then apply 0025.

**Rollback boundary.** Before 0025 is applied, code rolls back by traffic alone. After it,
no earlier revision can create an account: first run
`server/drizzle/rollback/0025_open_signup.sql` offline with writers stopped, then shift
traffic. The rollback re-adds both columns (defaults `'closed'`, `[]`), sets the row to
`open`, and restores both checks; the 0025 journal row stays, so re-forwarding means
running `0025_open_signup.sql` by hand.

## Dead columns (0026)

Applied 2026-11-04 02:47:04Z (journal 27, snapshot `before-0026-dead-columns`,
`snap-quiet-brook-b84mpp38`), after the pre-step (02:41:14Z) and after the dead-d03de23 code
served MCP and app (see the release records).

Migration 0026 drops columns nothing reads: `users.profile_json` and `templates_revision`,
`identities.profile_json`, `usage_daily.writes`, `store_config.updated_at` and
`save_requests.reserved_micros`, with their checks; the indexes `save_requests_by_day` and
`save_requests_by_account_day`; and the keys `memos`, `daily_writes`, `request_bytes` and
`page_size` from the `limits_json` default (the stored row keeps them, unread). It replaces
the save guard without `reserved_micros`. The runtime role needs no grant change: a dropped
column takes its privileges with it. Every revision before this release writes
`identities.profile_json` on a first sign-in and `reserved_micros` on every save claim;
this release writes neither.

Release order:

1. As the owner, give `reserved_micros` a default so this release can claim before 0026,
   with a lock timeout so a stuck transaction cannot stall every save:
   `SET lock_timeout = '5s'; ALTER TABLE save_requests ALTER COLUMN reserved_micros SET DEFAULT 0;`
   Retry on a timeout. The running revision names the column and is unaffected; 0026 drops
   the column and its default.
2. Ship MCP and app from the same image.
3. Only once both services are fully on the new revision (traffic at 100% and the old
   revision idle), take a Neon snapshot, then apply 0026 with the normal runner.

**Rollback boundary.** Before 0026 is applied, code rolls back by traffic alone. After it,
an earlier revision cannot sign up an account or save: first run
`server/drizzle/rollback/0026_dead_columns.sql` offline with writers stopped, then shift
traffic. The rollback re-adds the columns at their defaults (`reserved_micros` keeps
`DEFAULT 0`, so either revision saves), their checks, both indexes (built over current
rows), the previous `limits_json` default and the 0006 save guard; it restores shape, not
data (`templates_revision` comes back 0). The 0026 journal row stays, so re-forwarding
means running `0026_dead_columns.sql` by hand, as one transaction that stops on the first
error: `psql -1 -v ON_ERROR_STOP=1 -f server/drizzle/0026_dead_columns.sql`.

## Stripe billing (0027)

Applied 2026-11-04 04:51:15Z (journal 28, snapshot `before-0027-billing`,
`snap-restless-cloud-b83a3hem`); trials on since about 05:19Z (see the release records).

Migration 0027 adds the Stripe webhook ledger and the subscription columns on
`trial_accounts`, and marks returning deleted identities canceled. Stripe owns the trial; the
gate reads `subscription_status`.

**Release order.** Dead columns (0026) is already released, so only 0027 is pending. Peter runs the
Stripe Dashboard steps and mints secret versions. A release agent takes the snapshot, applies
0027 and ships the images. The owner connection and `DOTENV_PRIVATE_KEY` live only in a process
environment, never on a command line, in a file or in a log. Run these in order:

1. **Peter, in the Stripe Dashboard.** Roll both webhook signing secrets, test and live, expiring
   the old ones immediately, and create the live restricted key (Write on Customers, Subscriptions,
   Checkout Sessions and Customer portal). Install only a rolled secret, never one that has
   appeared in a transcript.
2. **Peter, in the Stripe Dashboard, live mode.** Confirm the settings below on the day: failed
   payments cancel the subscription, and the three customer emails are on.
3. **Release agent.** Take a Neon snapshot, then apply 0027 from an owner URL held in the
   environment and confirm the journal, as below. This code reads the new columns on every gated read, so on the
   older schema every assistant read fails with a 503.
4. **Release agent.** Ship MCP and app from the same image. Both must move: an older MCP revision
   keeps gating on the retired clock.
5. **Peter, then the release agent.** Peter mints the next numeric version of `milton-app-env`, as in
   the mint steps of [Runtime role (0024)](#runtime-role-0024), with these keys and no others:
   `APP_ORIGIN`, `MCP_RESOURCE`, `NEON_AUTH_BASE_URL`, `NEON_AUTH_COOKIE_SECRET`, `DATABASE_URL`,
   `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` and `STRIPE_PRICE_ID`, plus `MILTON_SUPPORT_EMAIL` if
   it is set. Drop the unread `MILTON_GARDENING_ENABLED` and `MILTON_DERIVATIONS_ENABLED`. dotenvx's
   own `DOTENV_PUBLIC_KEY` stays. The Stripe values are the live key from step 1, the rolled live
   secret and the live price. `grep -E '^[A-Z_]+=' <file> | cut -d= -f1 | sort` lists the names with
   no values. The release agent then redeploys the app only, pinned to that version, and
   confirms it starts: all three `STRIPE_*` or none, since a partial or malformed set stops it. The
   MCP service gets no Stripe setting. (Release bill-fa7a2cb's `milton-app-env:3` also kept the
   retired `MILTON_GEMINI_*` and `MILTON_MODEL_*` keys, which no code reads; a later version
   drops them.)
6. **Peter, with the owner connection.** Rerun the data statement below, before the flip: after it, a
   returning identity's row with no status could start a second trial at sign-in.
7. **Peter, with the owner connection.** Once the site and privacy copy are published, flip trials
   on. `milton_runtime` cannot change this setting:

   ```sql
   UPDATE store_config SET trials_enabled = true WHERE singleton = 1;
   ```

8. **Peter.** Run the backfill below: the dry run, read its counts, then `--apply`.

Run the SQL in steps 3, 6 and 7 in `psql` as `neondb_owner`, with the login in the environment and
never a URL on the command line, as in [Runtime role (0024)](#runtime-role-0024).

Before the first natural trial end, 30 days after step 7, run a test clock with the same
subscription params: the test-mode run forced every trial end.

To apply 0027 in step 3, from a checkout of the released commit that has no `server/.dev.vars`,
the release agent puts the owner URL straight into the process environment from the Neon CLI,
checks its role, database and host without printing it, then migrates:

```sh
export MILTON_OWNER_DATABASE_URL="$(bunx neonctl@8.18.0 connection-string br-muddy-mode-b88xfprl --project-id gentle-flower-39594008 --database-name milton --role-name neondb_owner)"
bun run --cwd server db:migrate
unset MILTON_OWNER_DATABASE_URL
```

A URL pasted by hand works the same way through `read -rs MILTON_OWNER_DATABASE_URL` and `export`.

It refuses any database but `milton` and any role but `neondb_owner`, and prints no URL, so its PASS
does not say which branch it ran on. Confirm the target: `SELECT count(*) FROM
drizzle.__drizzle_migrations;` must answer 28. If the command hangs, suspect the connection.

**Rollback boundary.** Before trials are on, code rolls back by traffic alone. Once trials are
on there is no traffic rollback to a pre-billing image: it gates on the retired clock and
refuses paying customers. Recover forward. `server/drizzle/rollback/0027_stripe_billing.sql`
refuses while any customer id or event is recorded, and its header says what else it loses.

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

**Data statement.** An older image still serving after 0027 can write a returning deleted
identity's row with no status. Once the new image has all traffic, before the flip, rerun 0027's
statement. It only touches rows with no status, so it never changes one Stripe has answered for:

    UPDATE trial_accounts t SET subscription_status = 'canceled'
    FROM users u WHERE u.id = t.user_id AND t.started_at < u.created_at
    AND t.subscription_status IS NULL;

**Backfill.** Step 8 gives every existing account its trial. It runs from a checkout of the released
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
rows with a status are skipped. It also applies the data statement's rule, so a returning deleted
identity's row is canceled and counted as skipped, but the rerun above still comes first. A row left at NULL is free until a browser sign-in: an approval
Neon already holds refreshes without any Milton page. A customer it creates has no email
until its person first opens billing, when Milton copies their sign-in email to Stripe. Everyone
who can add a card or pay passes through there, so nobody is charged without one unless the copy
fails or sign-in supplied no address; until then Stripe sends that person nothing, including its
trial-ending reminder.

## No memo updates (0028)

Migration 0028 drops the memo-update allowance: `store_config.memo_updates_enabled` and
`memo_updates_daily_limit` with `config_memo_updates`; `save_requests.memo_update_day` and
`memo_update_state` with `save_request_memo_update` and the partial index
`save_requests_memo_updates`; and the 0014 trigger `save_memo_update_guard` with
`milton_memo_update_guard`. The save guard takes `claimed_at` into its immutable tuple first,
so a receipt's claim time still cannot change. It also revokes `milton_runtime`'s
`UPDATE (singleton)` on `store_config`, which only the retired sign-in `FOR UPDATE` lock
used; the role keeps SELECT, and `check-runtime-role` now reads the row without locking it.
Every revision before this release reads and writes the receipt columns on each save and
reads the config columns on each tool call; this release touches none of them.

Release order:

1. Ship MCP and app from the same image.
2. Wait until both services, not one, serve 100% on the new image and the old revisions
   are idle. An older revision writes the dropped columns on every save and, before the
   sign-in lock removal, locks `store_config` at a first sign-in, which 0028's revoke refuses.
3. Take a Neon snapshot.
4. With the owner connection, run the check below. Expect `functions` to be
   `milton_memo_update_guard` only, `views` 0 and `runtime_update` `singleton`. Record
   `enabled` and `daily_limit`: the rollback restores neither. `held` may be nonzero: claims
   that expired while held keep that state, and 0028 drops it with the column.

   ```sql
   SELECT
     (SELECT string_agg(proname, ',') FROM pg_proc
       WHERE pronamespace = 'public'::regnamespace AND prosrc ~ 'memo_update') AS functions,
     (SELECT count(*) FROM pg_views
       WHERE schemaname = 'public' AND definition ~ 'memo_update')::int AS views,
     (SELECT string_agg(t.attname, ',') FROM pg_attribute t
       CROSS JOIN LATERAL aclexplode(t.attacl) a
       WHERE t.attrelid = 'store_config'::regclass AND a.grantee = 'milton_runtime'::regrole
         AND a.privilege_type = 'UPDATE') AS runtime_update,
     (SELECT count(*) FROM save_requests WHERE memo_update_state = 'held')::int AS held,
     (SELECT memo_updates_enabled FROM store_config WHERE singleton = 1) AS enabled,
     (SELECT memo_updates_daily_limit FROM store_config WHERE singleton = 1) AS daily_limit;
   ```

5. Apply 0028 with the normal runner, promptly. Between the deploy and 0028, a replay of a
   claim an old revision left `held` and that has since expired gets a 422 `check_violation`
   instead of `request_expired`: the new code completes the receipt without moving it out of
   `held`, which the 0014 check refuses. Nothing is written, and 0028 ends it by dropping the
   check. If 0028 fails on a deadlock, rerun it; it rolls back as a whole. The
   one-transaction image (0029) completes no old claim: there the replay answers
   `save_outcome_unknown` and writes nothing until 0029 deletes the claim.
6. Smoke test through MCP as `milton_app`: a save, a replay of that save (same request ID
   and input, same outcome), and a first sign-in of a new identity.

**Rollback order across 0028, 0029 and 0030.** Newest first: `rollback/0030_no_history_cap.sql`, then `rollback/0029_one_transaction.sql`, then `rollback/0028_no_memo_updates.sql`. The 0028 and 0029 rollbacks restore save guards that update `users.retained_bytes`, so each refuses while 0030 is still applied; running them out of order makes every save fail with `store_unavailable`.

**Rollback boundary.** Before 0028 is applied, code rolls back by traffic alone. After it,
an earlier revision cannot save or read through MCP: first run
`server/drizzle/rollback/0028_no_memo_updates.sql` offline with writers stopped, then shift
traffic. The rollback re-adds both config columns at their 0014 defaults (the allowance comes
back **off** at a limit of 100; set `memo_updates_enabled` and `memo_updates_daily_limit`
to the recorded values as the owner if that revision should enforce it), both receipt
columns with every receipt at `none`, the check, the index, the 0014 guard, the 0026 save
guard and the runtime's `UPDATE (singleton)` grant, which a revision from before
the sign-in lock removal needs. It restores shape, not data. The 0028 journal row stays, so
re-forwarding means running `0028_no_memo_updates.sql` by hand, as one transaction that stops
on the first error: `psql -1 -v ON_ERROR_STOP=1 -f server/drizzle/0028_no_memo_updates.sql`.

## Saves in one transaction (0029)

Migration 0029 removes what only the two-phase save used. It deletes the claims earlier
revisions left open (`NOT completed`): an earlier revision completed the receipt in the
transaction that applied a change, so an open claim changed nothing, and a replay of one
runs as a new save, fenced by its `expected_version`. It drops `save_requests.completed`,
`deadline` and `claimed_at` with `save_request_claim_clock`, the 0014 trigger
`save_claim_clock` with `milton_claim_clock`, and the `result_json` default; adds
`save_request_outcome` (every receipt holds a `status`); and replaces the save guard so it
refuses every UPDATE. Every revision before this release inserts a claim with a deadline
and completes it later; this release writes each receipt once, with its result, and names
none of the three columns. `deadline` is NOT NULL without a default, so this release
cannot save on the old schema without the pre-step. The image also carries 0028's code,
so 0028 and 0029 release together.

Release order (it replaces 0028's: 0028's check runs at step 5 and one runner pass applies
both):

1. As the owner, while the current revision serves, apply the pre-step:
   `psql "$MILTON_OWNER_DATABASE_URL" -v ON_ERROR_STOP=1 -f server/drizzle/pre/0029_one_transaction.sql`.
   It replaces `milton_claim_clock` so a receipt inserted with its result is filled in as
   complete, its deadline its claim time. Every earlier revision inserts claims without a
   result and is unaffected, and either revision replays the other's receipts, so code
   rolls back by traffic alone until 0029. Retry on a lock timeout. Then verify it:

   ```sql
   SELECT prosrc ~ 'result_json' AS pre_step FROM pg_proc
     WHERE pronamespace = 'public'::regnamespace AND proname = 'milton_claim_clock';
   ```

   Do not ship the image until this returns true. Without the pre-step every save on the
   new image fails: its receipt insert omits the NOT NULL `deadline`, so each save answers
   `store_unavailable` and writes nothing until traffic moves back to the old revision.

2. Ship MCP and app from the same image.
3. Wait until both services, not one, serve 100% on the new image and the old revisions
   are idle, then 40 seconds more: an older revision's claim stays open up to its deadline.
4. Take a Neon snapshot.
5. With the owner connection, run both checks before migrating, and record their values.
   If 0028 is not applied yet, run its check first ("No memo updates (0028)" step 4) and
   record `enabled` and `daily_limit`. Then run the 0029 check below. Expect `pre_step`
   true and `live_open` and `outcomeless` 0; if `live_open` is nonzero, wait 40 seconds and
   rerun. `open` is the number of claims 0029 deletes.

   ```sql
   SELECT
     (SELECT prosrc ~ 'result_json' FROM pg_proc
       WHERE pronamespace = 'public'::regnamespace AND proname = 'milton_claim_clock') AS pre_step,
     (SELECT count(*) FROM save_requests WHERE NOT completed)::int AS open,
     (SELECT count(*) FROM save_requests
       WHERE NOT completed AND deadline > clock_timestamp())::int AS live_open,
     (SELECT count(*) FROM save_requests
       WHERE completed AND result_json->>'status' IS NULL)::int AS outcomeless;
   ```

6. Run the normal runner once, promptly: `bun run --cwd server db:migrate`. It applies
   every pending migration in one transaction, so with 0028 pending one run applies 0028
   and 0029 together; there is no point between them to check. Both lock `users` in
   EXCLUSIVE mode first (reads continue; account locks wait), then `save_requests` and
   `store_config`, the order a save takes them. On a deadlock or lock timeout, rerun it; it
   rolls back as a whole. Between the deploy and this step, a replay of a claim an older
   revision left open answers `save_outcome_unknown` and writes nothing; afterwards the
   same request runs as a new save.
7. Smoke test through MCP as `milton_app`: a save, a replay of that save (same request ID
   and input, same outcome), a save on a stale version (`conflict`), and a first sign-in of
   a new identity.

**Rollback order across 0028, 0029 and 0030.** Newest first: `rollback/0030_no_history_cap.sql`, then `rollback/0029_one_transaction.sql`, then `rollback/0028_no_memo_updates.sql`. The 0028 and 0029 rollbacks restore save guards that update `users.retained_bytes`, so each refuses while 0030 is still applied; running them out of order makes every save fail with `store_unavailable`.

**Rollback boundary.** Before 0029 is applied, code rolls back by traffic alone; the
pre-step stays and is harmless to every revision. After it, an earlier revision cannot
save: first run `server/drizzle/rollback/0029_one_transaction.sql` offline with writers
stopped, then shift traffic. The rollback re-adds `completed` (every receipt true, default
false), `deadline` (`-infinity` on every receipt, no default) and `claimed_at` (NULL) with
`save_request_claim_clock`, the `result_json` default, `milton_claim_clock` in its
pre-step form with `save_claim_clock`, and the 0028 save guard, and drops
`save_request_outcome`. Either revision saves on the result, provided 0030 was rolled back first: the restored guard updates `users.retained_bytes`, which 0030 drops, and the rollback file refuses on the 0030 schema. It restores shape, not data:
the claims 0029 deleted do not come back. The 0029 journal row stays, so re-forwarding
means running `0029_one_transaction.sql` by hand, as one transaction that stops on the
first error: `psql -1 -v ON_ERROR_STOP=1 -f server/drizzle/0029_one_transaction.sql`.

## No history cap (0030)

Migration 0030 removes the lifetime history cap: an account that reached
`limits_json.history_bytes` (64 MiB) could not save again and had no way to free space. It
drops the byte triggers `memo_versions_bytes`, `instruction_card_versions_bytes` and
`accepted_changes_bytes` with `milton_memo_version_bytes`, `milton_card_version_bytes` and
`milton_accepted_change_bytes`; replaces the save guard so it still refuses every receipt
UPDATE and a save to an account that is not active, without counting bytes or refusing
`memo_history_limit`; drops `users.retained_bytes` with `users_bytes`; and drops
`history_bytes` from the `limits_json` default. The stored row keeps the key, unread. The
runtime role needs no grant change: the account lock still needs UPDATE on `users`. This
release reads neither the key nor the column. Every earlier revision reads its limits from
the stored row and names no dropped object, so it runs on either schema.

Release order (it rides the pending 0028 and 0029 release; follow "Saves in one
transaction (0029)" and add the steps below):

1. Ship MCP and app from the same image, after 0029's pre-step.
2. Wait until both services, not one, serve 100% on the new image and the old revisions
   are idle.
3. Take a Neon snapshot.
4. With the owner connection, run the check below with the 0028 and 0029 checks, and
   record its values. Expect `functions` to be
   `milton_accepted_change_bytes,milton_card_version_bytes,milton_memo_version_bytes,milton_save_request_guard`.
   `largest` above `cap` means an account is already refused; 0030 lets it save again.

   ```sql
   SELECT
     (SELECT string_agg(proname, ',' ORDER BY proname) FROM pg_proc
       WHERE pronamespace = 'public'::regnamespace AND prosrc ~ 'history_bytes') AS functions,
     (SELECT limits_json->>'history_bytes' FROM store_config WHERE singleton = 1) AS cap,
     (SELECT max(retained_bytes) FROM users) AS largest;
   ```

5. Run the normal runner once: `bun run --cwd server db:migrate`. With 0028 and 0029
   pending, one run applies all three in one transaction. 0030 locks `users` in ACCESS
   EXCLUSIVE mode first (sign-ins, reads and saves wait), then `store_config` and the
   three history tables, the order a save takes them. On a deadlock or lock timeout, rerun
   it; it rolls back as a whole. Between the deploy and this step, a save past the cap
   answers `store_unavailable` instead of `memo_history_limit` and writes nothing.
6. Smoke test through MCP as `milton_app`: a save, a replay of that save, and a read.

**Rollback order across 0028, 0029 and 0030.** Newest first: `rollback/0030_no_history_cap.sql`, then `rollback/0029_one_transaction.sql`, then `rollback/0028_no_memo_updates.sql`. The 0028 and 0029 rollbacks restore save guards that update `users.retained_bytes`, so each refuses while 0030 is still applied; running them out of order makes every save fail with `store_unavailable`.

**Rollback boundary.** Code rolls back by traffic alone before and after 0030. To restore
the cap, run `server/drizzle/rollback/0030_no_history_cap.sql` offline with writers
stopped. It re-adds `users.retained_bytes` with `users_bytes`, each account's value
recomputed from the rows the triggers counted, the three byte functions and triggers, the
0029 save guard and the previous `limits_json` default; the cap applies again at the
stored value, so an account that grew past it keeps its rows and cannot save. The 0030
journal row stays, so re-forwarding means running `0030_no_history_cap.sql` by hand, as
one transaction that stops on the first error:
`psql -1 -v ON_ERROR_STOP=1 -f server/drizzle/0030_no_history_cap.sql`.
