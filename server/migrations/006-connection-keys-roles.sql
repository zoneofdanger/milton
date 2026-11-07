-- OWNER REVIEWED PREPARATION. Apply after Drizzle 0004_connection_keys,
-- 005-app-roles.sql and native 007-connection-key-status, before app/MCP code
-- that reads connection keys. Grants only; rerunning converges to exactly these
-- privileges.
-- App: creates, lists and revokes. It reads a key's native binding to mark and
-- retire keys a security change stopped, never a stored hash, and never records
-- use. MCP: reads keys to check one and records last use, nothing else. No
-- runtime can change a key's binding (issuer, subject, incarnation, generation).
BEGIN;
REVOKE ALL ON public.connection_keys FROM milton_app_runtime,milton_mcp_runtime;
GRANT SELECT(id,user_id,issuer,subject,incarnation,generation,name,scope,created_at,expires_at,last_used_at,revoked_at),
 INSERT,UPDATE(revoked_at) ON public.connection_keys TO milton_app_runtime;
GRANT SELECT,UPDATE(last_used_at) ON public.connection_keys TO milton_mcp_runtime;
COMMIT;
