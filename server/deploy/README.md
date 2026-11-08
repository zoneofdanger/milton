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

This runbook keeps only the latest release record. Earlier release records and applied
one-time procedures are in git history; the last full version is at commit 492b96a
(`git show 492b96a:server/deploy/README.md`).

## Release record: usage retention, admit once, owner password retired (2026-11-08, PRs #53 #54 #55)

- **#55 (Peter; milton-qa, Astra passed with two should-fixes fixed in `be24774`), `7211521`:**
  Drizzle 0008 dropped `usage_daily` (9 rows) and the stored `daily_calls` key, and added
  `usage_calls_by_at` and `prune_usage_calls` (90 days); owner file 010 lets only
  `milton_auth_owner` run it. Snapshot `snap-snowy-haze-b8dl4hvc` at 04:24Z; size gate 21
  rows; applied with `db:migrate` (journal 9, hash `eae2dd56…`) and `psql` for 010; checks:
  no `usage_daily`, no key, ACL owner + `milton_auth_owner`, index valid, runtime audits `ok`
  for app and MCP. Auth `milton-auth-00014-juv` at 04:26Z (image
  `sha256:e6d303ca038354afc45691d7f4f36daa9b6885a5a49b41e1a0dea0acfc7736d2`; mail and
  maintenance jobs too). A manual maintenance run succeeded ("Usage rows past retention
  removed: 0"); an MCP read appended a usage row. Checks on the merge: types, 139 tests,
  format, site, auth build, auth integration 20/20, rehearsal 14/14, all 0. In a 5-minute
  watch: no 5xx, 429, application, job or audit errors; mail runs succeeded. After 0008,
  app/MCP must not roll back past #40 without restoring the snapshot.

- **Owner credential retired (Peter, 2026-11-08):** `neondb_owner`'s password was reset
  through the Neon API at 03:36Z (the old one is rejected); the owner connection kept for
  migrations was updated in place and connects. `milton-app-env:1`, `milton-mcp-env:1` and
  `milton-mcp-env:2` are disabled. No service connected as the owner; the maintenance job's
  `milton-auth-owner-url` is `milton_auth_delegate` and kept running. Any tagged revision that
  mounts those versions can no longer start. In a 5-minute watch: no 5xx, no application,
  permission, `store_unavailable` or audit errors; health 200 ×3; an MCP read succeeded. The
  cutover rehearsal branch `rehearsal-auth-cutover-20261107` was deleted (Peter); the
  role-timeouts rehearsal branch was already gone.
- **#54 (Peter's decision, AGENTS.md rule):** deleted `005-app.down.sql` and
  `007-role-timeouts.down.sql`; rollback is the pre-migration snapshot. The auth integration
  now installs 005 through `migrate.ts --app-auth`. Checks: types, 137 tests, format,
  rehearsal 13/13, all 0. No deploy.
- **#53 (milton-qa; Astra passed the admit-once part), `06868cc`:** an OAuth flow is admitted
  once per authorize or consent request (keyed on every admission input, request-local); each
  ask still runs its own `bind_flow`. Harness: authorize 75.6 → 51.2 ms, consent accept
  134.0 → 105.4 ms. The admit wait stays 5 s (revisit when billing is turned on). Auth
  `milton-auth-00012-qod` at 03:44Z (image
  `sha256:0899b179ebf1a89896cfc2e1b04f6d505000ac7fdded3b9e31c67de9d7fef957`; mail and
  maintenance jobs too). Checks on the merge: types, 137 tests, format, auth build, auth
  integration 20/20, rehearsal 13/13, all 0. Live: health, OIDC metadata and JWKS 200; an MCP
  read with an auth-issued token succeeded. In a 5-minute watch: no 5xx, 429, application,
  job or audit errors; mail runs succeeded. Not verified live: a real browser sign-in.

Auth `milton-auth-00014-juv`, rollback `milton-auth-00012-qod` (its jobs run on either schema). App/MCP unchanged
(`milton-*-save-b85f428`, rollback `milton-*-rnd3-64435ee`). Earlier records: git history
(`git log -p server/deploy/README.md`).

## Runtime role timeouts (applied 2026-11-07, TODO #29)

Neon's proxy and pooler drop the `statement_timeout`/`lock_timeout` the pools pass at
connect (measured 2026-11-07: `SHOW` returned 0 for both through either host, while local
PostgreSQL 18 applied them), so production has no server statement or lock limit and
billing's waiter does not get its 10 s 503. One owner file sets them on the runtime logins,
in database `milton`: app and MCP 20 s statement / 10 s lock, auth 5 s statement, the values
the code already passes. Serving revisions need no change (only a statement or lock wait past
its limit now fails, as the code intends), so traffic stays open. Apply it before releasing
code whose `check-runtime-role.ts` requires it. Rehearse on a disposable Neon branch first,
then:

1. Snapshot.
2. As `neondb_owner` (ALTER ROLE needs CREATEROLE and ADMIN on each login, which the
   role that created them holds):
   `psql -X -v ON_ERROR_STOP=1 -f server/migrations/007-role-timeouts.up.sql`. One
   transaction; rerunning converges.
3. Check as the owner. This lists exactly `milton_app_runtime` and `milton_mcp_runtime`
   with `{statement_timeout=20s,lock_timeout=10s}` and `milton_auth_runtime` with
   `{statement_timeout=5s}`:

   ```sql
   SELECT r.rolname, s.setconfig FROM pg_db_role_setting s
   JOIN pg_roles r ON r.oid = s.setrole JOIN pg_database d ON d.oid = s.setdatabase
   WHERE d.datname = 'milton' ORDER BY 1;
   ```

   Then `check-runtime-role.ts` must print `ok` for app and MCP (it now requires these
   settings).

4. A role setting reaches only sessions that start after it, and Neon's pooler keeps its
   own server connections open, independent of ours, so new Cloud Run revisions do not
   pick it up. In the 2026-11-07 rehearsal on a disposable branch, `SHOW` through the
   pooler still read 0/0 after the file applied (the direct host read 20s/10s). Only
   after a compute restart did the pooler read the new values. Then a 7 s sleep as auth
   was cancelled at 5.8 s (57014) and an MCP read behind an owner's lock was refused at
   10.7 s (55P03). So restart the production compute
   (`restart_postgres_endpoint`) in a quiet moment: every open connection drops once,
   in-flight queries fail as `store_unavailable`, and the pools discard the broken
   connections. Then run `SHOW statement_timeout;` and `SHOW lock_timeout;` as each
   runtime login through the pooler host and expect 20s/10s (app, MCP) and 5s/0 (auth).

Rollback is the pre-migration Neon snapshot from step 1. There is no down script. Code whose
role audit requires these settings fails that audit after the restore, so roll such code back
first.

## Drop the unread trial tables (applied 2026-11-07: Drizzle 0005, owner file 008)

Applied 21:59Z after snapshot `snap-muddy-bonus-b8tjvsii` (Peter's go), while `*-fnt-d3ea1eb`
served. 0005 ran as `neondb_owner` exactly as the Drizzle migrator does (the file's SQL plus its
SHA-256 and journal `when` in one transaction, journal now 6); 008 ran as `milton_app_owner`.
Both `to_regclass` checks are null; `deleted_identities` was empty and `legacy_mapping` held
2 rows, now only in the snapshot.

Since PR #26 nothing reads or writes `public.deleted_identities` or
`milton_app.legacy_mapping`: keyed trial-eligibility fingerprints are the only second-trial
block. App/MCP code before #26 reads both, so apply only while code from #26 or later
(source `cb5199b` onward, such as `*-drt-c1af8c3`) serves. The recorded app/MCP rollback
targets `*-lca-9de3099` and `*-tmo-58a4a59` predate #26: after the drop, roll app/MCP back
no further than `*-dup-cb5199b` unless the snapshot below is restored first. Rehearse on a disposable
branch or database first, then:

1. Snapshot. It is the only copy of the dropped rows.
2. As `neondb_owner`: `bun run --cwd server db:migrate` applies
   `0005_drop_deleted_identities` (journal 6 entries).
3. As the `milton_app` owner, `milton_app_owner` (the role the cutover ran
   `migrate.ts --app-auth` as):
   `psql -X -v ON_ERROR_STOP=1 -f server/migrations/008-drop-legacy-mapping.up.sql`.
4. Check as the owner. Both columns must be null:
   `SELECT to_regclass('public.deleted_identities') AS d, to_regclass('milton_app.legacy_mapping') AS l;`
   Then `check-runtime-role.ts` must print `ok` for app and MCP.

Rollback, needed only before traffic returns to app/MCP code older than #26, is the
pre-migration Neon snapshot `snap-muddy-bonus-b8tjvsii`. There is no down script.
Comments inside the applied 0005, 0006, 0007 and 008 files still name rollback files deleted
on 2026-11-08 under the AGENTS.md rule; applied files are never edited, and the
pre-migration snapshot is the rollback.

## Drop the unread payload columns (applied 2026-11-08: Drizzle 0006)

Applied 00:20Z after snapshot `snap-winter-mountain-b8iphgdz`, while `*-rt3-59d1227` served, as
`neondb_owner` exactly as the Drizzle migrator does (the four statements plus the file's
SHA-256 and journal `when` in one transaction; journal now 7). No `payload_bytes` column
remains and `save_requests.source_hash` is nullable; 16 samples, 2 users and 46 receipts
unchanged. The new code was released after it.

Nothing reads `payload_bytes` (the generated sizes the retired history cap summed) on
`accepted_changes`, `instruction_card_versions` and `save_requests`, or
`save_requests.source_hash`. 0006 drops the three generated columns and `source_hash`'s NOT
NULL; each statement is a catalog change, no table rewrite. Every recorded app/MCP revision
writes `source_hash` and reads neither, so traffic stays open and rollback targets are
unchanged. App/MCP code released with 0006 stops writing `source_hash` and fails every save
without it, so apply 0006 first, then release that code. The column itself and its
`save_request_hashes` check go in a later migration (TODO.md). Rehearse on a disposable
branch or database first, then:

1. Snapshot.
2. As `neondb_owner`: `bun run --cwd server db:migrate` applies
   `0006_drop_unread_columns` (journal 7 entries).
3. Check as the owner. The first query returns no rows; the second returns `YES`:

   ```sql
   SELECT table_name FROM information_schema.columns
   WHERE table_schema='public' AND column_name='payload_bytes';
   SELECT is_nullable FROM information_schema.columns
   WHERE table_schema='public' AND table_name='save_requests' AND column_name='source_hash';
   ```

   Then `check-runtime-role.ts` must print `ok` for app and MCP.

Rollback, never needed to roll app/MCP back (older code runs on either schema), is the
pre-migration Neon snapshot `snap-winter-mountain-b8iphgdz`; roll app/MCP back to code that
writes `source_hash` before restoring it. There is no down script.

## Usage rows and the writer guards (applied 2026-11-08: Drizzle 0007, PR #40)

Applied 00:51Z after snapshot `snap-crimson-field-b87qk777`; see the release record above.

0007 adds the empty `usage_calls` table (account, time, tool; foreign key cascading from
`users`). It also re-creates the six writer guard triggers (cards, card versions, accepted
changes, sample kinds, samples, sample versions) with their account lock moved from
`FOR UPDATE` to `FOR NO KEY UPDATE`, each otherwise unchanged. Every recorded app/MCP
revision runs on either schema, so traffic stays open. Code from #40 writes the table;
before 0007 and 009 its appends fail, are logged by code and change no response. Apply
after 0006. Rehearse on a disposable branch or database first, then:

1. Snapshot.
2. As `neondb_owner`: `bun run --cwd server db:migrate` applies `0007_usage_calls`
   (journal 8 entries), then run `server/migrations/009-usage-calls-roles.sql` (MCP gets
   `INSERT` only; rerunning converges).
3. Check as the owner: `SELECT count(*) FROM pg_proc WHERE prosrc LIKE '%FOR UPDATE%' AND
pronamespace='public'::regnamespace` returns 0, and `check-runtime-role.ts` prints
   `ok` for app and MCP. Then release #40's code.

Rollback, never needed to roll app/MCP back (older code runs on either schema), is the
pre-migration Neon snapshot `snap-crimson-field-b87qk777`. There is no down script.

## Usage retention and the daily allowance's leftovers (applied 2026-11-08: Drizzle 0008, owner file 010, PR #55)

0008 drops `usage_daily`, removes the stored `daily_calls` key from the `store_config` row
(idempotent) and from the column default, adds the index `usage_calls_by_at`, and creates
`public.prune_usage_calls(batch)`: SECURITY DEFINER as the table owner, fixed search path,
EXECUTE revoked from PUBLIC. It deletes at most `batch` (1–10,000) usage rows older than 90
days, oldest first, skipping rows an erasure has locked. Owner file 010 lets only
`milton_auth_owner` execute it. The auth maintenance job (`milton-auth-maint`, every 15
minutes, as `milton_auth_owner` through `milton-auth-owner-url`'s `milton_auth_delegate`)
then runs it after its auth cleanup: 1,000 rows per batch, at most 20 batches per run, each
batch its own transaction whose `SET LOCAL` 10 s statement and 2 s lock limits are read back
before its one DELETE (Neon drops connect-time limits, and 007 sets none for the delegate).

Since PR #40 nothing reads or writes `usage_daily` or `daily_calls`. Serving app/MCP
`*-save-b85f428` and the recorded rollback `*-rnd3-64435ee` both contain #40 (`90af817`), so
traffic stays open. App/MCP code before #40 requires `daily_calls` and refuses every tool
call without it: after 0008, roll app/MCP back no further than #40 unless the snapshot is
restored first. Auth reads no writing table. 0008 sets, in its own transaction, a 5 s lock
and a 5 s statement limit (under the runtimes' 10 s lock limit): the drop briefly locks
`users`, and the plain index build blocks usage appends until commit (each reply still waits
at most 250 ms). On a disposable PostgreSQL 18 the whole migration took 49 ms with 25,500
usage rows, and the index build alone 205 ms on 1,000,000. Rehearse on a disposable branch
or database first, then:

1. Snapshot production. It is the only copy of the dropped rows and key.
2. Size gate, read-only as the owner: `SELECT count(*) FROM usage_calls;`. Expected today:
   a few thousand at most (one row per admitted call since 2026-11-08, two accounts).
   Proceed only below 1,000,000 rows, where the plain build stays well inside 0008's 5 s
   limit. At or above it, stop: with Peter's go, first run
   `CREATE INDEX CONCURRENTLY IF NOT EXISTS usage_calls_by_at ON usage_calls USING btree (at);`
   as the owner, outside a transaction (it blocks no appends), confirm
   `SELECT indisvalid FROM pg_index WHERE indexrelid='usage_calls_by_at'::regclass` is true
   (drop and rebuild an invalid one), then continue; 0008's `IF NOT EXISTS` keeps it.
3. As `neondb_owner`: `bun run --cwd server db:migrate` applies `0008_usage_retention`
   (journal 9 entries).
4. As `neondb_owner`: `psql -X -v ON_ERROR_STOP=1 -f server/migrations/010-usage-retention-roles.sql`
   (one transaction; rerunning converges).
5. Check as the owner. The first two columns are null and false; the ACL lists only
   `neondb_owner` and `milton_auth_owner`:

   ```sql
   SELECT to_regclass('public.usage_daily') AS daily,
     (SELECT limits_json ? 'daily_calls' FROM store_config) AS key,
     (SELECT proacl FROM pg_proc WHERE oid='public.prune_usage_calls(integer)'::regprocedure) AS acl;
   ```

   Then `check-runtime-role.ts` must print `ok` for app and MCP.

6. Release an auth image built from this source to `milton-auth-maint` (an auth release
   moves the service and both jobs). Before steps 3–4 its prune fails (the job exits 1 after
   its auth cleanup and `milton-auth-jobs-errors-log` alerts), so release it after them. Its
   log line `Usage rows past retention removed: N` reads 0 until about 2027-02-06, 90 days
   after the first usage row.

Rollback is the pre-migration Neon snapshot `snap-snowy-haze-b8dl4hvc`; there is no down
script. Older auth images run on either schema (they never prune). Before restoring the snapshot, move the auth jobs back
to an image without the prune, or each run fails on the missing function.

## Test accounts (pending: Drizzle 0009, owner file 011)

0009 adds `users.test_account boolean NOT NULL DEFAULT false`, the owner-only mark on the
fictional end-to-end check account (see [Test account and daily check](#test-account-and-daily-check)).
It is additive and needs no code release: one column with a constant default is a catalog
change with no rewrite, every existing account reads false, and serving app/MCP code never
names the column. 011 narrows app's INSERT on `users` to `id`, `status` and `created_at` (the
only columns it could insert before) so no runtime login can set the mark. 0009 sets a 5 s
lock limit in its own transaction: the ADD COLUMN briefly locks `users` exclusively. Rehearse
on a disposable branch or database first (`server/scripts/check-auth-integration.ts` applies
both), then:

1. Snapshot production.
2. As `neondb_owner`: `bun run --cwd server db:migrate` applies `0009_test_account`
   (journal 10 entries).
3. As `neondb_owner`, at once:
   `psql -X -v ON_ERROR_STOP=1 -f server/migrations/011-test-account-roles.sql` (one
   transaction; rerunning converges).
4. Check as the owner. The first row is `boolean`, `false`, `NO` and 0; the next two list
   `f` for every runtime login:

   ```sql
   SELECT data_type, column_default, is_nullable,
     (SELECT count(*) FROM users WHERE test_account) AS marked
   FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'users' AND column_name = 'test_account';
   SELECT r, has_column_privilege(r, 'public.users', 'test_account', 'INSERT') AS can_insert,
     has_column_privilege(r, 'public.users', 'test_account', 'UPDATE') AS can_update
   FROM unnest(ARRAY['milton_app_runtime','milton_mcp_runtime','milton_auth_runtime']) r;
   ```

   Then `check-runtime-role.ts` must print `ok` for app and MCP. Account creation's
   `INSERT INTO users (id)` under the narrowed grant is covered by the rehearsal; in
   production the next new sign-up exercises it, so watch `milton-app-errors-log` for a
   `permission denied` after applying 011.

Rollback is the pre-migration snapshot; there is no down script. Every recorded app/MCP
revision runs on either schema.

## Test account and daily check

`e2e@milton-test.invalid` is a fictional account that holds nothing but what the daily
end-to-end check writes and retires. `.invalid` is a reserved top-level domain no mail
system delivers to, and the account is created verified, so nothing is ever mailed for it
(no verification, welcome or reset message reaches the auth mail queue or Resend).
Usage and metric counts exclude it (`users.test_account`, server README).

It has no trial row, unlike a normal new account. With billing configured, a trial row with
no status gets a Stripe customer and a 30-day trial at the first sign-in
(`ensureSubscription`), which would put a fictional customer in live Stripe and lock the
account out when that trial ends without a card. So provisioning creates the Milton
account itself, marked, before the first sign-in: admission finds it, the gate reads it as
early access (the same working access), `/billing/checkout` answers 409 with no trial row,
and the backfill skips test accounts, so nothing calls Stripe for it.

### Provision the account (once, after 0009 and 011)

Owner-only, from a checkout of the released commit after `bun install --frozen-lockfile`,
in a shell that keeps no history (zsh: `HISTFILE=/dev/null zsh`), with the owner URLs read
into the environment, never typed on a command line:

```sh
umask 077 && mkdir -p ~/keys
# AUTH_OWNER_DATABASE_URL: milton_auth_delegate assuming milton_auth_owner, as for
#   native migrations (options=-c%20role%3Dmilton_auth_owner).
# MILTON_OWNER_DATABASE_URL: neondb_owner, as for db:migrate.
bun --no-env-file server/scripts/test-account.ts --apply ~/keys/milton.test-account.env
unset AUTH_OWNER_DATABASE_URL MILTON_OWNER_DATABASE_URL
```

Before any write it refuses an existing file, an email native already holds, an address
outside `.invalid`, a wrong owner role on either connection and a database without 0009.
Then, printing one JSON line per step (`step`, `ok`, `ms`; never a password, key, cookie
or URL): it writes `E2E_EMAIL` and a random `E2E_PASSWORD` to the new mode-0600 file;
creates the native user and its password credential in one owner transaction (native's
own id shape and scrypt hash); creates the marked Milton account and its identity in one
owner transaction; signs in over HTTPS exactly as a browser does (app `/login`, the auth
sign-in page and form, the app's code flow) and checks the app shows this account; mints a
read-and-save key expiring in 365 days through the app's key form; checks as the owner that
exactly this account is marked, active, without a trial row and holds that key; and
appends `E2E_CONNECTION_KEY`. Exit 0 only when every step passed.

If a step after `secrets_file` fails, the file holds the password, so nothing is stranded:
read the failing step, then either finish by hand (sign in at the app with the file's
password, create the key on Connected assistants, append it as `E2E_CONNECTION_KEY`) or,
with Peter's go, delete the half-made account as the owners (the native user by email,
which cascades its credential and sessions; the Milton account through its identity) and
the file, and run it again. A plain env file, not dotenvx: dotenvx would keep its private
key next to the file in the same 0600 directory and protect nothing more, and `~/keys`
already holds plain owner files.

### Run the check

From a checkout, with no owner or service credential in the environment:

```sh
bun --no-env-file server/scripts/e2e.ts ~/keys/milton.test-account.env
```

It uses only the file's three values and production's public HTTPS endpoints. Steps, each
one JSON line (`step`, `ok`, `ms`, `severity`; never a password, key, cookie or sample
body), each request bounded at 15 s:

1. `secrets`: the email must end `.invalid` and the key be well formed.
2. `sign_in`: app `/login`, the auth sign-in page and form, the code flow; the app must show
   "Signed in as" this email.
3. `key_owner`, before any MCP request: Connected assistants must show this email and list
   this key's public id, or the run stops with `key_not_on_account` and the key is never
   sent, so another account's key supplied by mistake is never authenticated or marked
   used. It reports `key_days_left` and, under 30, `warning: key_expires_within_30_days` at
   severity `WARNING` without failing.
4. `mcp_connect`: initialize with the key; `tools/list` must list exactly the four tools.
   `safety_gate`, before any write: the cover sheet must hold no rule, no report a rule,
   and every served sample must carry the check's marker (kind `e2e check`, summary
   `Milton e2e check, run …`), fewer than eight per report. Anything else stops the run
   with `account_holds_foreign_data`, having written nothing.
5. `retire_leftovers`: retires marked samples a crashed run left, reporting the count.
6. `baseline`: the account must now be empty; its version and reports are the baseline.
7. `save_sample`, `fresh_read`: `create_memo` files a fictional sample marked with this run;
   a new MCP session's `get_report` must serve exactly that text and context.
8. `revise_sample`, `fresh_read_revision`: a revision through `sample_id`; a new session
   must serve revision 2 and not the old text.
9. `retire_sample`, `cleanup`: `retire_samples` removes it; a new session must read an
   empty account with the baseline's version and reports.

Exit 0 only when every step passed; otherwise the last line names the failing step and a
fixed error code, and the exit is 1. Renew the key before it expires: sign in to the app as
the test account with the file's password, create a new 365-day read-and-save key, replace
`E2E_CONNECTION_KEY` and revoke the old one.

**Footprint per run**, measured on the rehearsal (`check-auth-integration.ts` asserts it).
Immutable rows that stay as long as the account: 1 `samples`, 3 `sample_versions` (save,
revision, retirement), 3 `save_requests` receipts and 3 `accepted_changes` records, about
10 small rows a day, some 3,700 a year; one `sample_kinds` row on the first run only; no
rule cards. A crashed run's retirement adds one more of each receipt and record. Pruned:
11 `usage_calls` rows (deleted after 90 days). Short-lived auth rows: one native session
(7 days), one app session (1 hour), one admission correlation (1 day), the app's code-flow
token and binding rows, all removed by expiry, later sign-ins and the maintenance job; at most about eight native sessions are live at once,
under the 64-per-user cap. The key's `last_used_at` is updated. Nothing is mailed and
nothing calls Stripe.

### Daily run (proposal, not built)

Follow the maintenance job's pattern (`milton-auth-maint`: a Cloud Run job, a Cloud Scheduler
trigger, numeric secret versions), with nothing shared with it:

- **Image.** The runtime image runs Node with bundled files and has no `bun` or
  `server/scripts`, so add `e2e.ts` as a Node bundle (`e2e.js`, the MCP SDK bundled) to
  `server/scripts/build.ts` and the image, as the auth image carries `deliver.js` and
  `maintain.js`. Pin the image digest like the services.
- **Job.** `milton-e2e` in `us-east4`, command `node e2e.js /run/milton-e2e/account.env`, one
  task, no platform retries (a failure is the signal; the next day's run retires any
  leftover), task timeout 300 s, service account `milton-e2e@` with no database, project
  or other secret access.
- **Secret.** `milton-e2e-account`, version 1 = the provisioned env file, added from the
  file (`gcloud secrets versions add milton-e2e-account --data-file=...`), mounted at a
  numeric version as `/run/milton-e2e/account.env`; only `milton-e2e@` may access it. A
  renewed key is a new version and a job update.
- **Schedule.** Once a day at a quiet hour (say 14:00 UTC), triggered as `milton-auth-cron@`
  or a dedicated invoker with `run.invoker` on this job only; check the trigger URL ends in
  `:run`.
- **Alerts.** The job prints `severity` in each JSON line, which Cloud Logging reads as the
  entry's severity, and the failing step's line is `ERROR`. `milton-auth-jobs-errors-log`
  matches only `milton-auth-*` jobs, so add `milton-e2e-errors-log` the same way (any ERROR
  from the `milton-e2e` job or its scheduler job, rate limit 10 minutes) to the same
  `milton-ops-email` channel, Peter's address; and a second log match on
  `jsonPayload.warning="key_expires_within_30_days"`, at most one notification a day,
  for the key renewal. A run that never starts (scheduler paused or deleted) raises
  nothing; a log-absence alert on the `done` line over 26 hours would cover it.
  **Alert delivery is unverified:** this runbook records the channel and policies but no
  test notification reaching Peter; send one when the policies are created.
- **Cost.** About a minute of one vCPU a day, inside Cloud Run's free tier; the writes above.

## Optional guide worker

The default-off private guide pilot has separate [operations and capability instructions](guides.md). No guide job, schedule, provider key or account enrollment is provisioned by its build.

## Cloud resources

Project `milton-510506`, Cloud Run/Artifact Registry region `us-east4`. **Warm instances (Peter, 2026-11-07):** `milton-auth`, `milton-app` and `milton-mcp` each keep
one instance warm through the service-level minimum (`gcloud run services update <svc> --min=1`;
`run.googleapis.com/minScale: 1` on the service, about $10/month each). It applies across
revisions, so deploys and rollbacks keep it; when replacing a service from a manifest, keep it.
Check: `gcloud run services describe <svc> --format='value(metadata.annotations."run.googleapis.com/minScale")'` prints 1. Service manifests in this directory pin an immutable image and
secret versions. They contain configuration and secret references, never values.
The tracked app and MCP manifests still pin the pre-cutover release: app
`milton-app-edit-00223ec` and MCP `milton-mcp-edit-00223ec`, both using image index
`sha256:2682542b…`, env 3, key 1. Production serves the revisions under "Now serving" in
[Release verification and rollback](#release-verification-and-rollback); derive a manifest
from the live service before replacing it. [auth.service.template.json](auth.service.template.json)
is deliberately non-deployable. Production's writing journal holds `0000_baseline` through
`0008_usage_retention` (9 entries), the native auth ledger 001–007, and the owner files
`000-app-owner.sql`, `005-app.up.sql`, `005-app-roles.sql`, `006-connection-keys-roles.sql`,
`007-role-timeouts.up.sql`, `008-drop-legacy-mapping.up.sql`, `009-usage-calls-roles.sql` and
`010-usage-retention-roles.sql` (see [runtime role timeouts](#runtime-role-timeouts-applied-2026-11-07-todo-29)). There is no memo-update
or daily call allowance (removed by PR #40, serving since 2026-11-08). Existing positive account safeguards remain
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
requires a valid access token for each tool request, and checks the canonical
host. Direct public `run.app` access is refused. Never trust an arbitrary
Authorization header inside the application.

Each runtime service account can read only its own `milton-<role>-env` and
`milton-<role>-key` secrets. Only the app receives its browser cookie secret.
IAM grants can take time to propagate; a new principal may initially be denied.
Do not weaken ingress or IAM to work around that delay.

Auth runs as Cloud Run `milton-auth` with service account `milton-auth@` and ingress
`internal-and-cloud-load-balancing`. Two Cloud Run jobs run on the auth image:
`milton-auth-mail` (every minute) and `milton-auth-maint` (every 15 minutes, service
account `milton-auth-maint@`, secret `milton-auth-owner-url` 1). Cloud Scheduler triggers
both as `milton-auth-cron@`. An auth release moves both jobs to the new image too. Check a
trigger's URL ends in `:run`: a shell expansion once turned it into `un`, and the jobs
silently got 404s. For mail throttling, use the
[owner-only throttle procedure](../../apps/auth/README.md#throttle-inspection-and-recovery-prepared-not-enabled).
The production Neon endpoint `ep-curly-cherry-b8l7hc8f` has autosuspend off
(`suspend_timeout_seconds: -1`, since 2026-11-07).

The shared edge retains the name `milton-mcp`: reserved IPv4, URL map, HTTPS proxy
and certificate map. App and MCP have separate serverless NEGs and backends named
`milton-app` and `milton-mcp`. The HTTPS forwarding rule is `milton-mcp-https`.
The certificate map has exact-host entries for app and MCP. Keep each current
certificate until its replacement is ACTIVE and verified. DNS authorization resources
are named `milton-app` and `milton-mcp`; their CNAME records must remain for renewals.
Use [https-routing.yaml](https-routing.yaml) for the two hostname backends.
Auth has a URL-map host rule `auth.meetmilton.com` → backend and serverless NEG
`milton-auth`; certificate `milton-auth` (DNS authorization `milton-auth`) in cert map
`milton-mcp`; and DNS `auth` A and `_acme-challenge.auth` CNAME in Cloudflare. Log exclusion
`milton-auth-credential-urls` on `_Default` keeps auth credential URLs out of logs.
Both backends set `Strict-Transport-Security: max-age=63072000` as a custom response
header. Keep that setting when replacing
backends; the source pages retain their own CSP, no-store and framing restrictions.
The HTTPS proxy uses SSL policy `milton-web`, minimum TLS 1.2 with the `RESTRICTED`
profile. Google's
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
CNAMEs for app, MCP and auth. Apex, www and mail records stay unchanged. Validate URL maps with
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
- Auth has its own pair, `milton-auth-env` and `milton-auth-key`. At the 2026-11-07
  cutover the services mounted `milton-app-env` 4 / `milton-app-key` 2, `milton-mcp-env` 4 /
  `milton-mcp-key` 2 and `milton-auth-env` 2 / `milton-auth-key` 1; later release records
  note no secret change. Record what the serving revisions mount before each release.
- `MILTON_TRIAL_FINGERPRINT_KEY` in app secret storage is permanent: back it up with
  recovery material, separately from rotating auth cookie and provider keys. Changing it
  requires a designed dual-key migration first; a fresh key would silently grant new trials.
- The static Vercel `milton-site` project has no runtime secrets. Do not copy
  app or MCP credentials into its build settings. The deleted combined
  Vercel project's environment is no longer a recovery source.
- The runtime fails closed on missing or invalid decryption. Platform variables
  take precedence, so audit duplicate names during rotation. Restart/redeploy after
  configuration changes; configuration is loaded once per process.
- `milton-app-env:1`, `milton-mcp-env:1` and `milton-mcp-env:2` held the owner connection
  (now a dead password) and are disabled (2026-11-08), not destroyed. The MCP payloads still
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
  Run job (mail delivery, maintenance), including a malformed trigger URL's 404s.

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

**Migrations.** Snapshot first (a Neon snapshot, plus a private `pg_dump` checkpoint
before each step), and rehearse on a throwaway Neon branch or disposable database. Run
one migrator at a time; no service migrates on startup. Keep the owner URL only in the
process environment (from `neonctl connection-string`, checked by role, database and host,
then unset), never in a service or job. When a migration drops something the running
code reads, release the code first.

- Writing (Drizzle): `bun run --cwd server db:migrate` as the owner.
- Native auth: as the delegated NOINHERIT login `milton_auth_delegate`, assuming
  `milton_auth_owner` (`AUTH_OWNER_DATABASE_URL` with `options=-c%20role%3Dmilton_auth_owner`),
  `node --experimental-strip-types apps/auth/scripts/migrate.ts up --apply` applies the
  pending files in order, each in one transaction with its ledger row.
- Owner grant files in `server/migrations/` run as the owner with
  `psql -X -v ON_ERROR_STOP=1 -f <file>`; for example `006-connection-keys-roles.sql`
  revokes before granting, so rerunning converges.
- Then run `server/scripts/check-runtime-role.ts` for app and MCP (see
  [Runtime role](#runtime-role)) before rolling out code that needs the change.

Revisions from before the 2026-11-07 schema and auth cutover (`*-edit-00223ec` and
older) cannot read the current schema. Fix forward, or restore Neon snapshot
`snap-fancy-hat-b8j5ls14` per the cutover runbook's rollback section (local, untracked:
`.agents/tmp/auth-cutover/runbook.md`). App/MCP revisions before connection keys
(`*-store2-b64ec6a` and older) can read the schema but serve no keys. For a
schema-compatible code release, first verify the selected
runtime supports the current database schema and accounting policy, then send traffic
to its recorded healthy Cloud Run revision. Do not restore a database snapshot to roll back application code. An
existing revision retains its image, runtime configuration and numeric secret
references. Inspect revision readiness before selecting a recorded revision:

```sh
gcloud run revisions list --service=milton-app --project=milton-510506 --region=us-east4
```

Now serving (2026-11-08): app `milton-app-save-b85f428` and MCP
`milton-mcp-save-b85f428` (source `b85f428`), and auth `milton-auth-00014-juv` (source `7211521`). The
release record above gives the image and rollback revisions.

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
table, disable a trigger or read the Drizzle journal. The migration runner
keeps the `neondb_owner` connection and refuses any other role.
`server/drizzle/0000_baseline.sql` is for empty installations and refuses a populated
older database; the legacy schema cleanup script for a known-0033 database
(`server/scripts/transition-baseline.sql`, applied 2026-11-04) is in git history.

Since the 2026-11-07 cutover the services connect as separate NOINHERIT logins:
`milton_auth_runtime`, `milton_app_runtime` and `milton_mcp_runtime`, never granted the
shared `milton_runtime` group. The owner delegate `milton_auth_delegate` is kept for
maintenance; `milton_guide_runtime` and `milton_app_delegate` are NOLOGIN. The legacy
`milton_app` login, a member of `milton_runtime`, is retained, unused. With
`MILTON_SERVICE=app` or `mcp`, `server/scripts/check-runtime-role.ts` audits that
service's own `milton_<service>_runtime` login (NOINHERIT, no memberships, ownership,
TEMP or CREATE, and only that service's guard functions) in one direct-TLS query. It
prints only `ok` or `fail`; a driver failure adds the usual one-line error log (class
and code, never the URL) on stderr.

The steps below created `milton_app`; follow the same pattern for any new login role.

**Create a login role with SQL, not the console or API.** Neon makes every role created
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
   own. The `grep` must print `1` (dotenvx quotes encrypted values).

5. Check the minted payload before any service uses it, with `DOTENV_PRIVATE_KEY`
   still exported:
   - Through the services' driver, against the exact host in the payload, from the
     repository checkout (`<dir>` is the temporary directory), with `MILTON_SERVICE` set
     for a per-service login (the script checks `milton_<service>_runtime`, not
     `milton_app`):

     ```sh
     dotenvx run -f <dir>/app-next.env -- bun --no-env-file server/scripts/check-runtime-role.ts
     ```

     It must print `ok`.

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
   authenticated `get_cover_sheet` returns 200 with an unchanged version (a read; it
   also appends one `usage_calls` row); and a save. With Peter's go, a
   `create_memo` that resends one existing cover rule verbatim returns `unchanged`: it
   claims and stores a receipt as `milton_app` and changes no memo. A save that changes
   memos runs only when Peter directs one. Check the logs for `store_unavailable` or
   `permission denied`.

**Owner credential retired (2026-11-08).** `neondb_owner`'s password was reset in Neon and
the payload versions that held it are disabled. Moving a service back to the owner
connection means minting a fresh owner payload first.

## Stripe billing

Trials and billing are live. No billing migration or trial flip is pending.
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
over active accounts other than test accounts (it reads `users.test_account`, so a checkout from
this change on needs Drizzle 0009 applied), and refuses without `trials_enabled` and a live key. `--allow-test-key` is for disposable
databases only. With `--apply` it exits nonzero if any account still has no status; rerun it, since
rows with a status are skipped. A returning deleted
identity's row is canceled and counted as skipped. A row left at NULL is free until a browser sign-in: an approval
Neon already holds refreshes without any Milton page. A customer it creates has no email
until its person first opens billing, when Milton copies their sign-in email to Stripe. Everyone
who can add a card or pay passes through there, so nobody is charged without one unless the copy
fails or sign-in supplied no address; until then Stripe sends that person nothing, including its
trial-ending reminder.
