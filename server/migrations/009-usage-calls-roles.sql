-- OWNER REVIEWED PREPARATION. Apply after Drizzle 0006_usage_calls and
-- 005-app-roles.sql, before app/MCP code that records usage. Grants only;
-- rerunning converges to exactly these privileges.
-- MCP: appends usage rows and nothing else (no read back, update or delete).
-- App: erases an account's rows on account deletion; it reads only user_id,
-- which its DELETE ... WHERE needs.
BEGIN;
REVOKE ALL ON public.usage_calls FROM milton_app_runtime,milton_mcp_runtime;
GRANT INSERT ON public.usage_calls TO milton_mcp_runtime;
GRANT SELECT(user_id),DELETE ON public.usage_calls TO milton_app_runtime;
COMMIT;
