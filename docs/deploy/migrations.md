---
name: migrations
description: How a production schema change is snapshotted, run and checked, the Neon lessons behind each step, and how the database is restored
type: procedure
covers:
  - server/scripts/migrate.ts
  - server/scripts/check-runtime-role.ts
---

# Migrations

What each database role may do, and the schema itself, are product behaviour: see
[database](../database.md). This file is how the release coordinator changes the production
database. Each step needs Peter's go; the release coordinator runs it. The current heads
are in [serving](serving.md); applied one-time migrations are recorded in
[history](../history.md).

## Rules

- **Snapshot first** (a Neon snapshot, plus a private `pg_dump` checkpoint before each
  step), record its name, and rehearse on a throwaway Neon branch or disposable database
  (`server/scripts/check-auth-integration.ts` applies the migrations on PostgreSQL 18; PR
  CI runs it as `integration`).
- Run one migrator at a time, and open no other owner session while a migration runs (the
  migrator's advisory lock keeps a second migrator out, but not owner DDL in another
  session). No service migrates on startup.
- Keep the owner URL only in the process environment (from `neonctl connection-string`,
  checked by role, database and host, then unset), never typed on a command line, never in
  a service or job.
- **When a migration drops something the running code reads, release the code first.** The
  dropping file carries `-- code-stopped-by: #NN`, the change that stopped reading it (CI's
  migration guard checks the order). Apply it only once nothing at or above the rollback
  floor reads it; afterwards the floor is at least `#NN`, so record the new floor in
  [serving](serving.md).
- Applied files are never edited (CI locks released-migration hashes). There are no down
  scripts: a failed migration's rollback is the pre-migration snapshot, used only before
  code that needs the change serves. Comments inside the applied 0005, 0006, 0007 and 008
  files still name rollback files deleted on 2026-11-08; the snapshot is the rollback.
- After 0013, `server/migrations/005-app-roles.sql` names dropped tables and fails, so it is
  never rerun; its other grants stay in place. A fresh install applies the owner files
  through 015 before 0013 ([database](../database.md#migrations)).

## Additive and incompatible changes

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

A replaced check is additive only if every stored row passes the new one. Where the new
check refuses a value the old one took, run a read-only preflight on production first:
any row it finds stops the migration for Peter's decision. Drizzle `0016` is such a
migration, run ahead of its code with traffic open: a 36-character `request_id` holding
a character such as `/` passes its old checks and fails its new ones. Its preflight must
return 0 and 0:

```sql
BEGIN TRANSACTION READ ONLY;
SELECT (SELECT count(*) FROM memos WHERE request_id !~ '^[A-Za-z0-9._:-]{1,64}$') AS memos, (SELECT count(*) FROM save_requests WHERE request_id !~ '^[A-Za-z0-9._:-]{1,64}$') AS save_requests;
ROLLBACK;
```

Before `0016`, also record both tables' row counts and sizes, and compare the applied
journal with the checkout to prove exactly `0016` pending
(`SELECT count(*), max(created_at) FROM drizzle.__drizzle_migrations;` returns 16 and
`0015`'s `when`, 1794423465584). It holds `ACCESS EXCLUSIVE`
on `memos` and then `save_requests` until it commits, scanning each once; rehearsed on
PostgreSQL 18 with 50,000 rows in each (80 MB and 26 MB), the locks were held for about
0.66 s. A lock not free within 5 s fails it whole, with the old checks and journal kept;
rerun it. While it holds `memos` and waits for `save_requests`, a save that has already
read its receipt deadlocks with it when it reaches `memos`; in the rehearsal PostgreSQL
aborted the save-shaped session after its 1 s deadlock check and `0016` committed (a
save rolls back whole on that failure, so its retry can succeed).

## The runners

- **Writing (Drizzle):** as `neondb_owner` (`MILTON_OWNER_DATABASE_URL`),
  `bun run --cwd server db:migrate`. Check the journal count afterwards
  (`SELECT count(*) FROM drizzle.__drizzle_migrations;`).
- **Native auth:** as the delegated NOINHERIT login `milton_auth_delegate`, assuming
  `milton_auth_owner` (`AUTH_OWNER_DATABASE_URL` with `options=-c%20role%3Dmilton_auth_owner`),
  `node --experimental-strip-types apps/auth/scripts/migrate.ts up --apply` applies the
  pending files in order, each in one transaction with its ledger row.
- **Owner grant files** in `server/migrations/` run with
  `psql -X -v ON_ERROR_STOP=1 -f <file>`, as `neondb_owner`, or as the `milton_app` owner
  `milton_app_owner` for files that change the `milton_app` schema. Each is one transaction,
  and most revoke before granting, so rerunning converges. As `milton_app_owner`, go
  **through the direct host**: Neon's pooler refuses the `role` startup option.
- **Then the role audit:** `server/scripts/check-runtime-role.ts` must print `ok` for app and
  MCP before rolling out code that needs the change. With `MILTON_SERVICE=app` or `mcp` it
  audits that service's own `milton_<service>_runtime` login (NOINHERIT, no memberships,
  ownership, TEMP or CREATE, and only that service's guard functions, plus the role settings
  from owner file 007) in one direct-TLS query. It prints only `ok` or `fail`; a driver
  failure adds the usual one-line error log (class and code, never the URL) on stderr. Run
  it through a service payload, from the repository checkout (`<dir>` is a private temporary
  directory holding the encrypted payload, `DOTENV_PRIVATE_KEY` exported):

  ```sh
  dotenvx run -f <dir>/app-next.env -- bun --no-env-file server/scripts/check-runtime-role.ts
  ```

  Admission uses the app's login, so its audit runs as the app's
  (`MILTON_SERVICE=app` with the admit payload).

## Neon lessons

- **Neon drops connect-time limits.** Its proxy and pooler drop the
  `statement_timeout`/`lock_timeout` a client passes at connect (measured 2026-11-07: `SHOW`
  returned 0 for both through either host). So a migration sets its own limits with
  `SET LOCAL lock_timeout` (and `statement_timeout` where it needs one) inside its
  transaction, and a job reads them back before its work; the runtime logins get theirs as
  role settings (owner file 007).
- **A lock timeout rolls the migration back whole;** simply rerun it. A lock limit bounds the
  wait for each lock, not the statements' run time. While a migration waits for a lock,
  every request behind it waits too, so keep the work under the lock to catalog changes and
  small scans.
- **A migration that must not wait** locks every table it writes in its first statement
  with `NOWAIT` (native 008 does): if anything is writing them it fails at once with `55P03`
  (lock not available), applies nothing and records no ledger row: run it again.
- **An index on a large table:** check the row count first (read-only). Above about a
  million rows, a plain build inside the migration can exceed its lock limit: with Peter's
  go, first run `CREATE INDEX CONCURRENTLY IF NOT EXISTS …` as the owner, outside a
  transaction (it blocks no writes), confirm `indisvalid` in `pg_index` (drop and rebuild an
  invalid one), then run the migration, whose `IF NOT EXISTS` keeps it.
- **Role settings need a compute restart.** A role setting reaches only sessions that start
  after it, and Neon's pooler keeps its own server connections open, so new Cloud Run
  revisions do not pick it up. In the 2026-11-07 rehearsal, `SHOW` through the pooler still
  read 0/0 after the file applied (the direct host read 20s/10s) until a compute restart.
  So after changing a role setting, restart the production compute
  (`restart_postgres_endpoint`) in a quiet moment: every open connection drops once,
  in-flight queries fail as `store_unavailable`, and the pools discard the broken
  connections. Then run `SHOW statement_timeout;` and `SHOW lock_timeout;` as each runtime
  login through the pooler host and expect 20s/10s (app, MCP) and 5s/0 (auth).
- **Neon forwards role DDL.** Its `neon` extension forwards `CREATE ROLE` and `DROP ROLE`
  run in SQL (also from inside a `DO` block) to the control plane when the transaction
  commits, and fails the transaction if the control plane refuses
  ([`pgxn/neon/neon_ddl_handler.c`](https://github.com/neondatabase/neon/blob/main/pgxn/neon/neon_ddl_handler.c)),
  so the API's branch role list stays in step and no API call is needed. The gap: it
  forwards before PostgreSQL commits, so a commit that fails (or whose outcome is uncertain)
  after the forward can leave the control plane without roles PostgreSQL kept, and a compute
  start recreates every role the control plane still lists, as a `neon_superuser` member
  ([`compute_tools/src/spec_apply.rs`](https://github.com/neondatabase/neon/blob/main/compute_tools/src/spec_apply.rs)).
  So after every role DDL attempt, failed, uncertain or successful, compare `pg_roles` with
  the branch's role list in the Neon console or API
  (`GET /projects/{project_id}/branches/{branch_id}/roles`) before anything else; if they
  disagree, stop, resolve it with Neon, and do not restart the compute meanwhile.
- **Create a login role with SQL, not the console or API.** Neon makes every role created
  in the console, CLI or API a member of `neon_superuser`, which brings
  `pg_read_all_data`, `pg_write_all_data`, CREATEROLE, CREATEDB, BYPASSRLS and REPLICATION
  and so defeats the runtime roles' least privilege. A role created with SQL has only what
  is granted. Confirm afterwards, as the owner, that it is plain and a member of nothing
  unexpected (`rolsuper`, `rolcreaterole`, `rolcreatedb`, `rolbypassrls`,
  `rolreplication` false; `pg_auth_members` lists only what it was granted); stop if
  `neon_superuser` appears.
- **A new login's password touches no file and no command argument.** Work in a shell that
  keeps no history (zsh: `HISTFILE=/dev/null zsh`) inside a private temporary directory
  outside the repository (`umask 077`). Generate it into a shell variable
  (`openssl rand -base64 33 | tr '+/' '-_'`: 44 URL-safe characters, above Neon's 60-bit
  minimum, no escaping in a connection string) and send the `CREATE ROLE` to `psql` through
  a pipe from the `printf` builtin (zsh writes a heredoc to a temporary file). It reaches
  `psql`, `dotenvx` and the audit only through the environment, and is written to disk only
  inside the encrypted payload. Statement logging on the production project was checked on
  2026-11-03 (`log_statement` `none`, `log_min_duration_statement` `-1`,
  `log_min_error_statement` `panic`), so the server log does not record it, but
  `pg_stat_statements` is preloaded with `track_utility` on and may keep the `CREATE ROLE`
  text: find it (`query ~ 'PASSWORD '''`) and clear it with
  `SELECT pg_stat_statements_reset(0, 0, <queryid>);`. A new payload version keeps the
  service's keypair when it is decrypted and re-encrypted in place (the public key comes
  across in the decrypted header); add it as the next numeric version, keep the old versions
  enabled, and before any service uses it run the audit through it (above) and check its
  refusals with `psql` (for example `UPDATE memos SET final = final WHERE false;` fails with
  `permission denied`).

## Database recovery

**Post-launch rule: fix forward by default; restore only for a disaster** (data destroyed or
corrupted beyond repair by a forward fix). A restore returns the whole database to an earlier
moment and loses every write made after it: saves, accounts, sign-ins, keys, Stripe state
and usage. Before launch the pre-migration snapshot was each migration's rollback; after
launch, a bad migration or release is fixed with a new migration or a code rollback, and a
restore needs Peter's go.

**Restore window (measured 2026-11-08, Neon Scale).**

- Point in time: the project's history retention is 24 hours
  (`history_retention_seconds: 86400`), so any moment in the last 24 hours can be branched
  from. Longer retention is a project setting with a storage cost; changing it is Peter's
  call.
- Scheduled snapshots (Peter, 2026-11-08): production is snapshotted daily at 11:00 UTC
  (3–4 a.m. Pacific) and each scheduled snapshot is deleted after 14 days
  (`retention_seconds: 1209600`; `get_snapshot_schedule` on `br-muddy-mode-b88xfprl`). Neon
  bills snapshots at $0.09/GB-month; with a database of about 39 MB, 14 full copies would be
  about 0.55 GB, under $0.05 a month.
- Manual snapshots (the pre-migration ones from 2026-11-01 onward) are kept until deleted and
  don't count against the scheduled ones (`list_snapshots`). The ones that must be kept, and
  why, are in [serving](serving.md).

**Procedure** (Neon MCP or console; never the owner URL in a command line):

1. Choose the point: a snapshot (`list_snapshots`) or a timestamp inside the last 24 hours.
2. Restore to a **new** branch, not finalized: `restore_snapshot` with `finalize: false` and a
   name such as `restore-<date>`. ⚠ `restore_snapshot` finalizes by default when it creates a
   branch, which moves production's compute onto it: always pass `finalize: false` until
   step 4.
3. Verify the new branch (it gets a read-write compute): row counts of `users`, `memos`,
   `cover_sheets`, `connection_keys`, `usage_calls`, `trial_accounts`,
   `milton_auth."user"` and the Drizzle journal, and `compare_database_schema` against
   production (expect an empty diff unless a migration ran since). Writes made after the
   restore point are what the restore will lose; list them for Peter.
4. With Peter's go: `finalize_branch_restore` on the new branch. It moves production's
   compute and connection hosts onto it (restarting the compute: seconds of dropped
   connections) and renames the old branch, which is kept. The services reconnect on their
   own; run the release checks and the alert gate ([releases](releases.md#verify)).
5. Keep the old branch until the restored data is confirmed, then delete it.

Restoring a snapshot from before a drop also requires code that runs on the restored schema:
roll services and jobs back to such code first (for example, move the auth jobs back to an
image without the usage prune before restoring a snapshot from before 0008).

**Rehearsal (2026-11-08, steps 1–3 only, production untouched).** Restored
`snap-dawn-grass-b8zqz03n` (07:11:54Z) to `restore-rehearsal-2026-11-08`: the restore call
took 5.4 s, the branch answered queries at once, and counts plus the schema diff were done
44 s after the start. The schema diff was empty. Counts differed from production only by the
writes made after the snapshot (two reviewer accounts and their keys, the first end-to-end
run's sample and versions, 11 usage rows), which is exactly what a restore would lose. The
branch was deleted afterwards. Step 4 was not rehearsed: it would act on production.

**The pre-cutover snapshot.** The pre-cutover Neon snapshot `snap-fancy-hat-b8j5ls14` is
excluded from the procedure above: restoring it would discard every change since
2026-11-07, including all memos, and that is Peter's decision. If he makes it, first stop
every app, MCP and auth writer, pause the schedulers and drain their executions, snapshot
the current state, then restore, reconcile Stripe, invalidate issued sessions and tokens,
and serve only a runtime and secret versions that match the restored schema.
