-- Rollback of 0024_runtime_role. Revokes every privilege 0024 granted to
-- milton_runtime, its default privileges, and drops the role. No table or row
-- changes. Refuses while any login role other than the one running it is still a
-- member: first switch app and MCP back to their owner-connection secret
-- versions, then drop milton_app (deploy/README.md "Runtime role (0024)").
-- Run as neondb_owner. The 0024 journal row stays, so re-forwarding means
-- running 0024_runtime_role.sql by hand.
BEGIN;
SET LOCAL lock_timeout = '10s';
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_auth_members m JOIN pg_roles r ON r.oid = m.member
    WHERE m.roleid = 'milton_runtime'::regrole AND r.rolcanlogin AND r.rolname <> current_user
  ) THEN
    RAISE EXCEPTION 'milton_runtime_has_login_members';
  END IF;
END $$;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM milton_runtime;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM milton_runtime;
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM milton_runtime;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM milton_runtime;
REVOKE ALL ON SCHEMA public FROM milton_runtime;
DO $$
BEGIN
  EXECUTE format('REVOKE ALL ON DATABASE %I FROM milton_runtime', current_database());
END $$;
DROP ROLE milton_runtime;
COMMIT;
