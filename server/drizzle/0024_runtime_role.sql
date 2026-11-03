-- A least-privilege group role for the app and MCP runtime. milton_runtime is
-- NOLOGIN: services connect as a separate login role that is a member of it
-- (milton_app, created with SQL by the operator, never in the repository; see
-- deploy/README.md "Runtime role (0024)"). Membership inherits, so the runtime
-- needs no SET ROLE. Each table gets only the statements the runtime or the
-- triggers it fires run on it. DELETE is granted only on users (account
-- deletion; the cascades run as the table owner) and assistant_disconnects
-- (reconnect): no trigger stops a DELETE on save_requests (memo-update
-- accounting), deleted_identities or trial_accounts (trial eligibility) or
-- usage_daily (the daily call count), so the role cannot run one. store_config
-- is read and locked FOR UPDATE, which needs an UPDATE grant on one column, so
-- the role may UPDATE only its singleton key. The role owns nothing, so it
-- cannot ALTER, DROP, TRUNCATE or disable a trigger, and it has no access to the
-- drizzle schema (the migration journal). Default privileges give tables that
-- later migrations create SELECT, INSERT and UPDATE, and sequences USAGE; a
-- migration that needs the runtime to DELETE from its table grants it there.
-- ALTER DEFAULT PRIVILEGES without FOR ROLE applies to the migrating role, which
-- the runner pins to neondb_owner. Trigger functions run as the caller and need
-- no EXECUTE grant; the runtime calls no function directly. Migrations and
-- operator scripts keep connecting as neondb_owner.
-- rollback/0024_runtime_role.sql revokes everything and drops the role.
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
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE users TO milton_runtime;
--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON TABLE assistant_disconnects TO milton_runtime;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON TABLE save_requests, samples, tps_reports, trial_accounts, usage_daily TO milton_runtime;
--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE deleted_identities, identities, instruction_card_versions, instruction_cards, memo_cards, memo_versions, memos, sample_kinds TO milton_runtime;
--> statement-breakpoint
GRANT INSERT ON TABLE accepted_changes TO milton_runtime;
--> statement-breakpoint
GRANT SELECT, UPDATE (singleton) ON TABLE store_config TO milton_runtime;
--> statement-breakpoint
GRANT USAGE ON SEQUENCE instruction_card_position TO milton_runtime;
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE ON TABLES TO milton_runtime;
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE ON SEQUENCES TO milton_runtime;
