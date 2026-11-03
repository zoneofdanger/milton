-- A least-privilege group role for the app and MCP runtime. milton_runtime is
-- NOLOGIN: services connect as a separate login role that is a member of it
-- (milton_app, created in Neon by the operator, never in the repository; see
-- deploy/README.md "Runtime role (0024)"). Membership inherits, so the runtime
-- needs no SET ROLE. The role may read and write rows in the seventeen tables
-- the runtime or its triggers touch, and draw from the card position sequence.
-- It owns nothing, so it cannot ALTER, DROP, TRUNCATE or disable a trigger: the
-- append-only, immutability, accounting and size triggers hold against it. It
-- has no access to the drizzle schema (the migration journal). Migrations and
-- operator scripts keep connecting as neondb_owner. Default privileges cover
-- tables and sequences that later migrations create; ALTER DEFAULT PRIVILEGES
-- without FOR ROLE applies to the migrating role, which the runner pins to
-- neondb_owner. Trigger functions run as the caller and need no EXECUTE grant;
-- the runtime calls no function directly. rollback/0024_runtime_role.sql
-- revokes everything and drops the role.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'milton_runtime') THEN
    CREATE ROLE milton_runtime NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  ELSIF EXISTS (
    SELECT 1 FROM pg_roles r
    WHERE r.rolname = 'milton_runtime'
      AND (r.rolcanlogin OR r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication OR r.rolbypassrls
        OR EXISTS (SELECT 1 FROM pg_auth_members m WHERE m.member = r.oid))
  ) THEN
    RAISE EXCEPTION 'milton_runtime_is_not_a_plain_group_role';
  END IF;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO milton_runtime', current_database());
END $$;
--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO milton_runtime;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
  accepted_changes,
  assistant_disconnects,
  deleted_identities,
  identities,
  instruction_card_versions,
  instruction_cards,
  memo_cards,
  memo_versions,
  memos,
  sample_kinds,
  samples,
  save_requests,
  store_config,
  tps_reports,
  trial_accounts,
  usage_daily,
  users
TO milton_runtime;
--> statement-breakpoint
GRANT USAGE ON SEQUENCE instruction_card_position TO milton_runtime;
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO milton_runtime;
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE ON SEQUENCES TO milton_runtime;
