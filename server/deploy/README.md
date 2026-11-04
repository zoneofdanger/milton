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
The manifests pin what is serving now: app `milton-app-rank-c63af7f`
(`sha256:420c4692…`, env 3, key 1) and MCP `milton-mcp-rank-c63af7f`
(`sha256:420c4692…`, env 3, key 1), both connecting as `milton_app`; see the current
release below. There is no worker service or scheduler job. There is no memo-update
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

Now serving: MCP `milton-mcp-rank-c63af7f` (since 2026-11-04 16:48:46Z) and app
`milton-app-rank-c63af7f` (since 16:49:21Z), one image and one commit, on Drizzle journal 34,
with trials on since about 05:19Z; recorded below. There is no worker service.

Current release rank-c63af7f: migration 0033, then MCP and app, from main `c63af7f` (the merge
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

The compatible previous runtime revisions are `milton-mcp-simp-893d0ce` and
`milton-app-simp-893d0ce`, image
`sha256:622c2142c54b18ea5ec753ec6e473e97186ecb036d798e60c1fe832ff264fa6e`.
Keep their recorded numeric secret versions. Select a previous runtime only after
checking that it supports the current schema. Retired schema rollback chains and
pre-step commands are no longer part of this checkout; recover forward for schema
changes. The pending cleanup procedure below does not authorize a release.

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

**Pending; not applied to production.** The services and pins recorded above are still the
current release, on the 34-entry 0033 journal (latest timestamp `1793779058436`). This
checkout replaces the old migration files with `server/drizzle/0000_baseline.sql` for empty
installations and `server/scripts/transition-baseline.sql` for that one known old state.
No older revision or historical schema rollback chain is supported.

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
