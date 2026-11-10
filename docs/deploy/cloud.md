---
name: cloud
description: Milton's hosting as operated: the services, cloud resources and edge, the admission service, secrets and the database logins
type: reference
covers:
  - server/deploy/auth.service.template.json
  - server/deploy/auth-mail-job.preparation.json
  - server/deploy/http-redirect.yaml
  - server/deploy/https-routing.yaml
---

# Cloud

Milton uses Bun for installs, builds and tests, and Node 26 LTS in production. How to
release onto this is in [releases](releases.md); which revisions serve now is in
[serving](serving.md).

| Surface                                | Runtime and hosting                                                   |
| -------------------------------------- | --------------------------------------------------------------------- |
| `meetmilton.com`, `www.meetmilton.com` | Static Astro, Vercel `milton-site`                                    |
| `app.meetmilton.com`                   | Hono JSX, Vite theme assets, Cloud Run `milton-app`                   |
| `mcp.meetmilton.com`                   | Hono MCP, Cloud Run `milton-mcp`, Google external HTTPS load balancer |
| `auth.meetmilton.com`                  | Self-hosted Better Auth, Cloud Run `milton-auth`, same load balancer  |
| none (`run.app`, invoker-only)         | Auth's admission calls, Cloud Run `milton-admit`, no load balancer    |

Neon PostgreSQL is the source of truth. Sign-in is the self-hosted auth service at
`https://auth.meetmilton.com/api/auth` (since 2026-11-07). Managed Neon Auth is disabled,
with its `neon_auth` schema and data retained.

The app and MCP are live on GCP. Vercel hosts only the static Astro site. The retired
combined Vercel `milton-mcp` project, deployments, aliases, project secrets and firewall
configuration were removed during the authorized hosting decommission on 2026-11-01.
Hosting rollback uses Cloud Run revisions.

## Cloud resources

Project `milton-510506`, Cloud Run/Artifact Registry region `us-east4`.

**Warm instances (Peter, 2026-11-07; `milton-admit` since 2026-11-08):** `milton-auth`,
`milton-app`, `milton-mcp` and `milton-admit` each keep one instance warm through the
service-level minimum (`gcloud run services update <svc> --min=1`;
`run.googleapis.com/minScale: 1` on the service, about $10/month each). It applies across
revisions, so deploys and rollbacks keep it; when replacing a service from a manifest, keep
it. Check:
`gcloud run services describe <svc> --format='value(metadata.annotations."run.googleapis.com/minScale")'`
prints 1.

Service manifests in `server/deploy/` pin an immutable image and secret versions. They
contain configuration and secret references, never values.
[admit.service.json](../../server/deploy/admit.service.json) is kept at the serving image;
`app.service.json` and `mcp.service.json` are not kept current and are never applied (see
[releases](releases.md#server-image-app-mcp-admission-and-the-daily-check)).
[auth.service.template.json](../../server/deploy/auth.service.template.json) and
[auth-mail-job.preparation.json](../../server/deploy/auth-mail-job.preparation.json) are
deliberately non-deployable.

The app and MCP services accept ingress only from internal sources and Google's load
balancer. Its platform invoker policy permits external MCP clients; Milton still requires a
valid access token for each tool request, and checks the canonical host. Direct public
`run.app` access is refused. Never trust an arbitrary Authorization header inside the
application.

Each runtime service account can read only its own `milton-<role>-env` and
`milton-<role>-key` secrets. Only the app receives its browser cookie secret. IAM grants can
take time to propagate; a new principal may initially be denied. Do not weaken ingress or
IAM to work around that delay.

Auth runs as Cloud Run `milton-auth` with service account `milton-auth@` and ingress
`internal-and-cloud-load-balancing`. Two Cloud Run jobs run on the auth image:
`milton-auth-mail` (every minute) and `milton-auth-maint` (every 15 minutes, service account
`milton-auth-maint@`, secret `milton-auth-owner-url` 1, which also prunes usage rows older
than 90 days). Cloud Scheduler triggers both as `milton-auth-cron@`. An auth release moves
both jobs to the new image too. Check a trigger's URL ends in `:run`: a shell expansion once
turned it into `un`, and the jobs silently got 404s. For mail throttling, use the
[owner-only throttle procedure](../../apps/auth/README.md#throttle-inspection-and-recovery-prepared-not-enabled).
The daily end-to-end check is its own job, `milton-e2e-daily` ([e2e](e2e.md)).

**Database.** The production Neon endpoint `ep-curly-cherry-b8l7hc8f` has autosuspend off
(`suspend_timeout_seconds: -1`, since 2026-11-07) and autoscales from 1 to 4 CU (Peter,
2026-11-08; it was pinned at 1). Neon sets `max_connections` from the max size: 1802 at 4 CU
(450 at 1), and the change restarted the compute once, with no 5xx or errors. The pools fit
with room to spare: app and MCP hold at most 40 connections per instance and auth 8 per
instance (3 instances max), all through the pooler (10,000 client connections). On Neon
Scale at $0.222 per CU-hour, the 1 CU floor is about $162 a month; each hour at 4 CU adds up
to $0.67, so the ceiling is about $648 a month. Snapshots and restores:
[migrations](migrations.md#database-recovery).

**Budget.** `milton-monthly-500` (billing account `019BCA-9D6FC9-B3E1DC`, project
`milton-510506` only): $500 a month of actual spend, emailing only `milton-ops-email` at 50%
and 100%, so at most two emails a month. Default emails to billing admins are off. It alerts
and never stops anything. It covers Google Cloud only; Neon bills separately.

The isolated Neon validation project `cold-recipe-45005130` remains intact and
auto-suspends; it contains no production copies. Recreate isolated hosting explicitly for
future validation.

## Edge

The shared edge retains the name `milton-mcp`: reserved IPv4, URL map, HTTPS proxy and
certificate map. App and MCP have separate serverless NEGs and backends named `milton-app`
and `milton-mcp`. The HTTPS forwarding rule is `milton-mcp-https`. The certificate map has
exact-host entries for app and MCP. Keep each current certificate until its replacement is
ACTIVE and verified. DNS authorization resources are named `milton-app` and `milton-mcp`;
their CNAME records must remain for renewals. Use
[https-routing.yaml](../../server/deploy/https-routing.yaml) for the two hostname backends.
Auth has a URL-map host rule `auth.meetmilton.com` → backend and serverless NEG
`milton-auth`; certificate `milton-auth` (DNS authorization `milton-auth`) in cert map
`milton-mcp`; and DNS `auth` A and `_acme-challenge.auth` CNAME in Cloudflare. Log exclusion
`milton-auth-credential-urls` on `_Default` keeps auth credential URLs out of logs. Both
backends set `Strict-Transport-Security: max-age=63072000` as a custom response header. Keep
that setting when replacing backends; the source pages retain their own CSP, no-store and
framing restrictions. The HTTPS proxy uses SSL policy `milton-web`, minimum TLS 1.2 with the
`RESTRICTED` profile. Google's unconfigured default also accepts TLS 1.0. Preserve the
policy when replacing the proxy.

For a new edge, create the policy and attach it explicitly (the CLI version value is
`1.2`; the API reports `TLS_1_2`):

```sh
gcloud compute ssl-policies create milton-web --global --profile=RESTRICTED --min-tls-version=1.2 --project=milton-510506
gcloud compute target-https-proxies update milton-mcp --global --ssl-policy=milton-web --project=milton-510506
```

After propagation, verify TLS 1.0/1.1 refusal and trusted TLS 1.2/1.3 connections.
`milton-mcp-http` provides only a method-preserving 308 HTTPS redirect using
[http-redirect.yaml](../../server/deploy/http-redirect.yaml). Preserve the certificate DNS
authorization CNAMEs for app, MCP and auth. Apex, www and mail records stay unchanged.
Validate URL maps with
`gcloud compute url-maps validate --global --load-balancing-scheme=EXTERNAL_MANAGED --source=<file>`
before importing them.

**DMARC (Peter's go, 2026-11-09):** Cloudflare DMARC Management is enabled for
meetmilton.com, at `p=none` with reports in the Cloudflare dashboard (`notifications.`
inherits it). Move to `p=quarantine` only after about two weeks of clean reports and once
nothing else sends as @meetmilton.com.

## Admission service (`milton-admit`)

Auth's two internal calls, `POST /internal/auth/admit` (every authorize and consent accept)
and `POST /internal/auth/preserve-eligibility` (unlink), go to their own Cloud Run service,
`milton-admit`, running the runtime image with `MILTON_SERVICE=admit`. It serves those two
paths and answers 404 to everything else; app and MCP answer 404 on `/internal/*`. Before
this (PR #63, 2026-11-08), the routes were on the app, reachable by anyone through the load
balancer, and the admission bearer was the only check (critique finding 8).

- **Reachability.** Not attached to the load balancer or URL map. Ingress `all`, because
  auth has no VPC egress and reaches `run.app` over Google's network; Cloud Run's invoker
  check is on and only `milton-auth@` holds `roles/run.invoker` on the service (no
  `allUsers`). Google's front end refuses a request without a Google-signed ID token from a
  principal holding `run.routes.invoke` (403, "The request was not authenticated"), before
  the container sees it.
- **Two checks.** Auth gets an ID token for the audience `AUTH_ADMISSION_URL` from the
  metadata server (`…/instance/service-accounts/default/identity?audience=…`,
  `Metadata-Flavor: Google`), caches it until five minutes before its `exp` (Google's
  tokens last about an hour), and sends it as `X-Serverless-Authorization: Bearer <token>`.
  [Google's service-to-service guide](https://docs.cloud.google.com/run/docs/authenticating/service-to-service):
  that header exists for applications that already use `Authorization` for their own
  check; with both present "only the `X-Serverless-Authorization` header is checked", and
  Cloud Run "removes the signature before passing the token to the user container". The
  audience must be the service URL (custom domains are not supported). So
  `Authorization: Bearer <AUTH_ADMISSION_SECRET>` reaches the container unchanged, and the
  container checks it as before. A failed or malformed token fetch sends nothing and fails
  sign-in with `admission_retry_required`, like a refused admission, and logs
  `auth_admission_identity` (class and code only).
- **Configuration.** Auth reads `AUTH_ADMISSION_URL`, a plain environment variable (not a
  secret) on `milton-auth` and on the `milton-auth-mail` job, which reads the same config:
  `https://milton-admit-419545871671.us-east4.run.app` (the deterministic URL; token
  audience and target are the same string; check it with
  `--format='value(metadata.annotations."run.googleapis.com/urls")'`). Auth refuses to
  start in production with anything but an `https://…run.app` origin; a loopback origin (no
  token) is for development and the integration checks only.
- **Identity and secrets (least privilege).** Its own service account `milton-admit@`
  with `secretAccessor` on `milton-admit-env` and `milton-admit-key` only, and its own
  dotenvx keypair. The payload holds exactly what admission reads: `DATABASE_URL` (the
  app's `milton_app_runtime` login, which already holds the admission grants), `AUTH_ISSUER`,
  `AUTH_ADMISSION_SECRET`, `MILTON_TRIAL_FINGERPRINT_KEY`, `STRIPE_SECRET_KEY` and
  `STRIPE_PRICE_ID`; never the app's cookie or OIDC client secrets, nor the Stripe webhook
  secret (`admitRuntimeConfig` does not read it). Reusing `milton-app@` would have meant no
  new secrets but would give a second, differently exposed service everything the app
  holds. A separate database login was not created: it would need a new owner grant file
  and role audit for the same privileges; the audit runs as the app's
  (`MILTON_SERVICE=app server/scripts/check-runtime-role.ts` with the admit payload). The
  trade-off: a change to any of those six values (the database password, the Stripe key)
  is minted into both payloads.
- **Settings** ([admit.service.json](../../server/deploy/admit.service.json)): concurrency 40
  (the database pool's maximum, so each request can hold a connection; auth can have at most
  24 calls in flight, 3 instances × 8); timeout 30 s (auth gives up at 5 s, but an admission
  with Stripe can take about 15 s, and finishing lets auth's retry find it done); max 3
  instances, as app and MCP; minimum 1 (one warm instance, Peter's go with #63); startup CPU
  boost on.
- **Cold start.** The built bundle (`server/dist/cloud-run.js`, 3.3 MB) answered its first
  request 143–151 ms after `node` started (median 145 ms over 10 runs, Node 26.13.0, Apple
  silicon laptop; app 163 ms, MCP 150 ms), so the code adds little to auth's 5 s wait; Cloud
  Run's own instance start and the first Neon TLS connection are not measured. The warm
  instance keeps most admissions off a cold start; `httpRequest.latency` in milton-admit's
  request log shows it.
- **Auth's floor.** Auth images from before #63 call
  `https://app.meetmilton.com/internal/auth/admit`, which answers 404, so every authorize and
  consent accept fails with `admission_retry_required` and unlink with
  `eligibility_preservation_retry_required`. Never roll auth back past that release; the
  floor is in [serving](serving.md).

The one-time steps that created it are recorded in
[history](../history.md#2026-11-08-admission-service-release-order-pr-63).

## Secrets

Use separate dotenvx keypairs for each service. Store encrypted payloads in private,
versioned release storage and the corresponding private keys in platform secret stores.
Keep `.env*` and `.env.keys` out of git, images, command arguments and logs. Never add an
application endpoint to extract nonexportable secrets.

- Cloud Run mounts `milton-<role>-env:<version>` at `/run/milton/.env`, sets
  `MILTON_ENCRYPTED_ENV_FILE` to that path, and receives `DOTENV_PRIVATE_KEY` from its own
  key secret. Pin numeric secret versions; changing `latest` would make rollback ambiguous.
  The versions each service mounts now are in [serving](serving.md); record what the
  serving revisions mount before each release.
- Auth has its own pair, `milton-auth-env` and `milton-auth-key`; admission has
  `milton-admit-env` and `milton-admit-key`. At the 2026-11-07 cutover the services mounted
  `milton-app-env` 4 / `milton-app-key` 2, `milton-mcp-env` 4 / `milton-mcp-key` 2 and
  `milton-auth-env` 2 / `milton-auth-key` 1.
- dotenvx names a keypair after the file it encrypts (`admit.env` gave
  `DOTENV_*_KEY_ADMITDEVELOPMENT`), and the services read plain `DOTENV_PRIVATE_KEY`, so
  encrypt a payload as `.env` and rename it afterwards. Store a key secret with `printf '%s'`
  so it has no trailing newline. (`milton-admit-env:1` and `milton-admit-key:1` were
  disabled for exactly these two mistakes.)
- `MILTON_TRIAL_FINGERPRINT_KEY` in app secret storage is permanent: back it up with
  recovery material, separately from rotating auth cookie and provider keys. Changing it
  requires a designed dual-key migration first; a fresh key would silently grant new trials.
- The static Vercel `milton-site` project has no runtime secrets. Do not copy app or MCP
  credentials into its build settings. The deleted combined Vercel project's environment is
  no longer a recovery source.
- The runtime fails closed on missing or invalid decryption. Platform variables take
  precedence, so audit duplicate names during rotation. Restart/redeploy after
  configuration changes; configuration is loaded once per process.
- **Owner credential retired (2026-11-08).** `neondb_owner`'s password was reset in Neon and
  the payload versions that held it are disabled. Moving a service back to the owner
  connection means minting a fresh owner payload first.
- `milton-app-env:1`, `milton-mcp-env:1` and `milton-mcp-env:2` held the owner connection
  (now a dead password) and are disabled (2026-11-08), not destroyed. The MCP payloads still
  carry the unread `MILTON_GARDENING_ENABLED`; drop it in a later version.
  `milton-worker-env` versions 1 to 4 and `milton-worker-key:1` are disabled, not destroyed.
- Optional, recommended, and not recorded as done: mint the next `milton-app-env` version
  without `AUTH_ADMISSION_SECRET`, which the app no longer reads since #63, so the app's
  account no longer holds it. Older app revisions keep their pinned version.

Use the installed dotenvx CLI with an explicit `--env-keys-file` when encrypting outside the
working directory. Pass secret values to platform CLIs through stdin or protected files,
never `--value` or shell arguments. Preserve each rollback revision's image and numeric
secret versions together with its configuration.

## Database logins as operated

What each role may read and write is in [database](../database.md#runtime-roles); this is
what exists and how it is used.

- The services connect as separate NOINHERIT logins, `milton_auth_runtime`,
  `milton_app_runtime` (app and admission) and `milton_mcp_runtime`, never granted the
  shared `milton_runtime` group (since the 2026-11-07 cutover).
- The baseline's `milton_runtime` is a NOLOGIN group role. The legacy `milton_app` login, a
  member of `milton_runtime`, is retained, unused.
- The owner delegate `milton_auth_delegate` is kept for maintenance and native migrations
  (assuming `milton_auth_owner`); `milton_app_delegate` is NOLOGIN. The guide roles
  (`milton_guide_worker`, `milton_guide_runtime`) were dropped by owner file 015 on
  2026-11-10.
- The migration runner keeps the `neondb_owner` connection and refuses any other role.
  `server/drizzle/0000_baseline.sql` is for empty installations and refuses a populated
  older database; the legacy schema cleanup script for a known-0033 database
  (`server/scripts/transition-baseline.sql`, applied 2026-11-04) is in git history.
- The runtime logins carry role-level statement and lock limits (owner file 007: app and
  MCP 20 s statement / 10 s lock, auth 5 s statement), because Neon drops the limits the
  pools pass at connect ([migrations](migrations.md#neon-lessons)).
