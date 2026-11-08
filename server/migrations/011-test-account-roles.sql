-- OWNER REVIEWED PREPARATION. Apply after Drizzle 0009_test_account and
-- 005-app-roles.sql. Grants only; rerunning converges to exactly these privileges.
-- Only the owner marks a test account. The app runtime's table-wide INSERT on users
-- (005) would also let it insert test_account, so it becomes INSERT on every other
-- column (id, status, created_at), exactly what it could insert before 0009. Its
-- UPDATE stays id only (005), MCP's too, and auth and the guide have none, so no
-- runtime login can set the column. Rerunning 005-app-roles.sql widens app INSERT
-- again: rerun this file after it.
BEGIN;
REVOKE INSERT ON public.users FROM milton_app_runtime;
GRANT INSERT (id, status, created_at) ON public.users TO milton_app_runtime;
COMMIT;
