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
The manifests pin what is serving now: app `milton-app-open-13f2d93`
(`sha256:8f205685…`, env 2, key 1) and MCP `milton-mcp-open-13f2d93`
(`sha256:8f205685…`, env 3, key 1), both connecting as `milton_app`; see the current
release below. There is no worker service or scheduler job. `memo_updates_enabled` and
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

Now serving: MCP `milton-mcp-open-13f2d93` (since 2026-11-04 01:15:46Z) and app
`milton-app-open-13f2d93` (since 01:16:01Z), one image and one commit, on Drizzle journal 26;
recorded below. There is no worker service.

Current release open-13f2d93: MCP and app, then migration 0025, from main `13f2d93` (the merge of
`agent/open-signup`). Revisions `milton-mcp-open-13f2d93` and `milton-app-open-13f2d93`, switched
directly at 100% (no users yet) by a release agent on 2026-11-04: MCP created 01:15:24Z to
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

Rollback. Since 0025 is applied, stick-4272d1d cannot create an account: a traffic shift alone
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

## Stripe billing (0026)

Migration 0026 adds the Stripe webhook ledger and the subscription columns on
`trial_accounts`, and marks returning deleted identities canceled. Stripe owns the trial; the
gate reads `subscription_status`.

**Release order.** Take a snapshot, apply 0026, then ship MCP and app from the same image. This
code reads the new columns on every gated read, so on the older schema every assistant read
fails with a 503. Both services must move: an older MCP revision keeps gating on the retired
clock. The three `STRIPE_*` settings go on the app service only; all three or none, since a
partial or malformed set stops the app at startup.

**Rollback boundary.** Before trials are on, code rolls back by traffic alone. Once trials are
on there is no traffic rollback to a pre-billing image: it gates on the retired clock and
refuses paying customers. Recover forward. `server/drizzle/rollback/0026_stripe_billing.sql`
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

**Data statement.** An older image still serving after 0026 can write a returning deleted
identity's row with no status. Once the new image has all traffic, and before the backfill,
rerun 0026's statement. It only touches rows with no status, so it never changes one Stripe has
answered for:

    UPDATE trial_accounts t SET subscription_status = 'canceled'
    FROM users u WHERE u.id = t.user_id AND t.started_at < u.created_at
    AND t.subscription_status IS NULL;

**Backfill.** After `trials_enabled` is flipped, give every existing account its trial. Peter or
the release agent runs it from a checkout of the released commit, in `server/` after
`bun install --frozen-lockfile`. The runtime image cannot run it: it is Node with one bundled
file, no `bun` and no `server/scripts`. Settings arrive as for `scripts/memo-updates.ts`: the app's
dotenvx payload in `MILTON_ENCRYPTED_ENV_FILE` with `DOTENV_PRIVATE_KEY`, or explicit environment
variables, never as command arguments. The script prints no value.

    bun --no-env-file scripts/backfill-subscriptions.ts          # dry run
    bun --no-env-file scripts/backfill-subscriptions.ts --apply

It prints only counts (total, created, skipped, failed, still NULL), at about 5 accounts a second,
and refuses without `trials_enabled` and a live key. `--allow-test-key` is for disposable
databases only. With `--apply` it exits nonzero if any account still has no status; rerun it, since
rows with a status are skipped. It also applies the data statement's rule, so a returning deleted
identity's row is canceled and counted as skipped, but the rerun above still comes first. A row left at NULL is free until a browser sign-in: an approval
Neon already holds refreshes without any Milton page. A customer it creates has no email
until its person first opens billing, when Milton copies their sign-in email to Stripe. Everyone
who can add a card or pay passes through there, so nobody is charged without one, but until then
Stripe sends that person nothing, including its trial-ending reminder.
