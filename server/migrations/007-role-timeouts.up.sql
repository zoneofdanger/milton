-- OWNER-APPLIED ROLE SETTINGS, as the privileged owner that created the runtime
-- logins (neondb_owner): psql -X -v ON_ERROR_STOP=1 -f this file. Apply before any
-- code whose role audit requires them; old code is unaffected. Rerunning converges.
-- Neon's proxy and pooler drop the statement_timeout/lock_timeout a client passes
-- at connect, so these role settings are the server limits. Values match the code:
-- app/MCP (server/src/store/database.ts) 20 s statement, 10 s lock; billing answers
-- 503 at that lock limit. Auth service and mail job (apps/auth/src/provider.ts,
-- scripts/deliver.ts) 5 s statement, no lock limit. Only runtime logins: never
-- neondb_owner, owner roles or the owner delegate, whose migrations and maintenance
-- may run long. A setting reaches only sessions that start after it.
BEGIN;
ALTER ROLE milton_app_runtime IN DATABASE milton SET statement_timeout = '20s';
ALTER ROLE milton_app_runtime IN DATABASE milton SET lock_timeout = '10s';
ALTER ROLE milton_mcp_runtime IN DATABASE milton SET statement_timeout = '20s';
ALTER ROLE milton_mcp_runtime IN DATABASE milton SET lock_timeout = '10s';
ALTER ROLE milton_auth_runtime IN DATABASE milton SET statement_timeout = '5s';
COMMIT;
