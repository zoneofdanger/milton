-- code-stopped-by: #76
-- OWNER-APPLIED ROLE REMOVAL, as the privileged owner that created the guide roles
-- (neondb_owner): psql -X -v ON_ERROR_STOP=1 -f this file. Apply BEFORE Drizzle
-- 0013_drop_old_writing, so that if it fails, nothing destructive has run yet. #76
-- removed the parked guide pilot's worker, and no guide job was ever provisioned in
-- production. The NOLOGIN capability milton_guide_worker (made by Drizzle 0003) holds
-- USAGE on public and SELECT or more on users, trial_accounts and the sample and guide
-- tables 0013 then drops; the guide job's role milton_guide_runtime (made with SQL at the
-- 2026-11-07 cutover, NOLOGIN since) holds CONNECT and its membership. Roles are
-- cluster-wide, which is why this is an owner file and not a Drizzle migration.
-- For each role that exists, this revokes everything on public's tables, on public
-- and on this database, then drops the role with its memberships and role settings.
-- No DROP OWNED and no CASCADE: anything else either role still holds or owns, in this
-- or another database, fails DROP ROLE and rolls this file back whole. A role that
-- does not exist is skipped (a fresh install never made milton_guide_runtime), so
-- rerunning converges. On Neon the extension forwards DROP ROLE to the control plane
-- at commit and aborts the transaction if that fails, so the branch's role list stays
-- in step (pgxn/neon/neon_ddl_handler.c). Rollback is the pre-migration snapshot;
-- there is no down script.
BEGIN;
DO $$
DECLARE role text;
BEGIN
 FOREACH role IN ARRAY ARRAY['milton_guide_runtime','milton_guide_worker'] LOOP
  IF to_regrole(role) IS NOT NULL THEN
   EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA public FROM %I', role);
   EXECUTE format('REVOKE ALL ON SCHEMA public FROM %I', role);
   EXECUTE format('REVOKE ALL ON DATABASE %I FROM %I', current_database(), role);
   EXECUTE format('DROP ROLE %I', role);
  END IF;
 END LOOP;
END $$;
COMMIT;
