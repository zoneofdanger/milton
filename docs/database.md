---
name: database
description: The one shared Postgres: tenancy, runtime roles and their grants and timeouts, what the schema enforces, migrations and backups
type: behaviour
covers:
  - server/drizzle/**
  - server/drizzle.config.ts
  - server/migrations/**
  - apps/auth/migrations/**
  - server/src/store/schema.ts
  - server/src/store/database.ts
  - server/src/store/errors.ts
  - server/scripts/migrate.ts
  - server/scripts/check-runtime-role.ts
  - apps/auth/scripts/migrate.ts
  - scripts/check-migrations.ts
---

# Database

How to run migrations locally is in [server/README.md](../server/README.md); the
production order and snapshots are in [the hosting runbook](../server/deploy/README.md).

## One shared database

- One shared Postgres database on Neon, named `milton`, holds every account, with the
  user id on every row behind a mandatory tenant access layer. The store opens only a
  database named `milton`, over TLS.
- The services use distinct auth, app and MCP login roles that own nothing, so the
  triggers that guard the data hold against them; only migrations run as the owner.
- Neon's point-in-time history for the whole branch is the backup (the retention is a
  project setting). Product rehearsals use a disposable PostgreSQL database and
  fictional identities; build work does not read private writing. Verified production
  source-schema and metadata reconciliation remains a separate owner gate.
- The managed `neon_auth` schema and its data are retained, disabled, and never dropped
  or migrated.

## Runtime roles

- App and MCP have explicit writing grants, no inherited owner, group, DDL or TEMP
  privileges and no native secret reads; app-only session, flow, lifecycle and
  eligibility storage (`milton_app`) is denied to MCP and auth. App cannot read native
  credentials or keys; MCP cannot read native secrets or app credentials. Auth cannot read
  writing, billing or app storage.
- The immutable user-id column permits the UPDATE privilege PostgreSQL requires for row
  locks without permitting ownership changes. User IDs cannot change.
- The baseline's legacy `milton_runtime` group grants remain; its `milton_app` login is
  unused. `migrations/005-app-roles.sql` is owner-reviewed preparation, not a blanket
  production revocation.
- Owner role files, each rerunnable to the same privileges:
  - `006-connection-keys-roles.sql` (after 005): app may read every `connection_keys`
    column except `secret_hash`, insert, and set `revoked_at`; MCP may read and set
    `last_used_at` only. No runtime can change a key's binding columns.
  - `009-usage-calls-roles.sql` (after `0007`): MCP may only insert `usage_calls`; app
    gets nothing.
  - `010-usage-retention-roles.sql` (after `0008`): only `milton_auth_owner`, the auth
    maintenance job's role, may execute `public.prune_usage_calls`, with USAGE on
    `public` to resolve its name and no privilege on any writing table. No runtime may
    run it.
  - `011-test-account-roles.sql` (right after `0009`): app's INSERT on `users` covers
    only `id`, `status` and `created_at`, so with app and MCP UPDATE on `id` only (005)
    and nothing for auth, no runtime login can set `test_account`; the owner alone marks
    an account. Rerun 011 after any rerun of 005, which restores table-wide INSERT.
  - `014-memos-roles.sql` (after `0012` and 005): MCP may insert, read and delete memos
    and update only their context columns; insert and read kinds, served reports and
    cover sheet versions; insert, read and delete tweaks; insert and read citations; and
    read the Keep memos switch. App may read and delete memos and kinds, read citations,
    read, delete and reword tweaks, read and append cover sheet versions, and read and
    set the switch. Neither runtime can change a memo's words, and neither deletes
    citations itself: forgetting a memo, deleting a tweak and account erasure remove
    them through the foreign keys' cascades, which run as the table owner.
  - `015-drop-guide-roles.sql` dropped the guide roles; none exists.
- `trial_accounts.stripe_revision` (Drizzle `0011`) needs no grant file: app's
  table-wide grant on `trial_accounts` (005) covers it, and MCP's column list leaves it
  out.
- Native `007-connection-key-status` adds only `milton_guard.connection_key_status`:
  SECURITY DEFINER, fixed `pg_catalog, pg_temp` path, false on NULL or any mismatch, no
  PUBLIC or auth EXECUTE and no table grants; MCP and app may execute it. Without it,
  every key is refused.
- `public.prune_usage_calls(batch)` (Drizzle `0008`) is SECURITY DEFINER, owned by the
  table owner, with a fixed `pg_catalog, pg_temp` search path and EXECUTE revoked from
  PUBLIC.

## Timeouts and pools

- Server timeouts live on the runtime logins, because Neon's proxy and pooler drop the
  `statement_timeout` and `lock_timeout` a client passes at connect (the pools still
  pass them, which plain PostgreSQL applies). Owner file `007-role-timeouts.up.sql` sets,
  in database `milton` only, 20 s statement and 10 s lock limits for
  `milton_app_runtime` and `milton_mcp_runtime` and a 5 s statement limit for
  `milton_auth_runtime` (no lock limit). Owner, delegate and legacy roles get none. A
  setting reaches only sessions that start after it; `check-runtime-role.ts` requires
  the app and MCP settings.
- Runtime queries borrow bounded direct PostgreSQL TLS connections from one process pool
  per URL (at most 40, waiting at most 5 s for one). A connection idle over 30 s by the
  wall clock, whose last command, BEGIN, COMMIT or ROLLBACK failed, or with a query or
  transaction unfinished when its operation ends, is closed instead of reused, and that
  operation's later calls refuse. Transactions keep one connection. App and MCP close
  the pools on SIGTERM after in-flight requests.
- A signed-in page runs its independent reads at once, each borrowing its own
  connection (at most 4 per request, on `/assistants`); no operation borrows while
  holding one, so a full pool makes reads wait, never deadlock.
- PostgreSQL connection, query, transaction-control and close failures become store
  errors: known triggers and constraints get clean coded responses, unknown failures log
  only class and code, and callback errors survive rollback and close unchanged.

## What the schema enforces

- The memo tables (`0012`) check each column's shape: medium, one-line summary,
  audience and purpose; the first-draft state matching the first draft and mode;
  non-blank words up to 256 KiB; rounds 0 to 1000; change 0 to 1; the tier; and at most
  10 served tweaks, only with a report id. Kind labels are 1 to 60 characters and unique
  per account in any letter case, tweak forms unique per account, and cover sheet
  versions positive and at most 1,500 characters.
- A memo's search vector (summary, purpose, audience and final, English) is a generated
  column ([reports](reports.md)).
- Account erasure cascades every memo, kind, tweak, citation, served report, cover sheet
  version and switch row ([deletion](deletion.md)).
- A receipt is written once with its outcome and cannot change; `save_request_hashes`
  checks the input hash's form ([saves](saves.md)).
- `users.test_account` (`0009`, default false) marks the fictional end-to-end check
  account ([billing](billing.md)).
- `trial_accounts.stripe_revision` (`0011`, bigint, default 0) advances on every write of
  the Stripe state columns by Milton's code.
- `connection_keys` (`0004`) cascades from users and from its (issuer, subject)
  identity, requires the native binding (issuer, subject, incarnation, generation),
  checks id, hash, name, scope, binding lengths and dates, and grants nothing to the
  legacy writing group.
- `usage_calls` (`0007`) cascades from users. `0007` also moved the six writer guard
  triggers' account lock from `FOR UPDATE` to `FOR NO KEY UPDATE`, so no save waits on a
  usage row's foreign-key check.
- The native auth migrator applies each migration file and its ledger row in one
  transaction under an advisory lock, so a crash leaves both or neither; a file that
  commits or rolls back the transaction itself fails after running and gets no ledger
  row.

## Migrations

- There are three tracks: Drizzle (`server/drizzle/`, `0000` to `0014`), owner files
  (`server/migrations/`, numbered up to `015`) and native auth (`apps/auth/migrations/`,
  `000` to `008`).
- Fresh installs use one Drizzle baseline (`0000_baseline.sql`: the original 14 tables,
  seven guard functions and triggers, the `milton_runtime` role and its grants, and the
  singleton `store_config` seed); a populated older database refuses it. Older revisions
  are unsupported.
- Fresh installs apply every migration in `drizzle/` in order, with the owner files
  through 015 between `0012` and `0013` (005 grants on tables 0013 drops; 015 runs
  first, as in the release). After `0013`, `005-app-roles.sql` is never rerun.
- `0012_memos` adds the memo, kind, tweak, citation, served-report, cover sheet and Keep
  memos tables. `0013_drop_old_writing` dropped the writing tables memos replaced
  (cards, card versions, accepted changes, sample kinds, samples, sample versions and the
  guide tables), their guards, sequence and the eight functions only they used, and
  deleted the old store's save receipts; every receipt the memo code wrote stays, so a
  replay still returns its stored outcome. `0014_drop_source_hash` dropped
  `save_requests.source_hash`.
- The unread `deleted_identities` table (`0005`), the legacy mapping tables (owner file
  `008`), the generated `payload_bytes` columns (`0006`), the daily allowance's
  `usage_daily` table and `daily_calls` key (`0008`) and the app session's stored native
  access token (owner file `013`) are gone. Saves reserve nothing and no runtime reads
  model or spend settings.
- Every change is a new migration: never edit, rename or remove one on main. Use
  `bun run db:generate` for schema changes and add any required guard SQL to the
  generated migration. The guards CI runs on them are in [checks](checks.md).
- Snapshot before every migration; the snapshot is the rollback, with no down scripts or
  reverse SQL. When a migration drops something the running code reads, release the
  code first: a drop names the merged PR that stopped the code (`code-stopped-by`). Until
  Milton officially launches, there are no compatibility shims or rollback scripts.
- Run one migrator at a time. DDL and journal writes commit together; for an uncertain
  command outcome inspect the actual schema and journal before retrying.
- Migrations that lock a busy table set their own short lock limits inside the
  migration's transaction (a lock not free within 5 s fails the migration instead of
  queueing requests), because Neon drops the limits a client passes at connect.
