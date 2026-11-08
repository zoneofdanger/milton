-- OWNER REVIEWED PREPARATION. Apply after Drizzle 0007_usage_calls and
-- 005-app-roles.sql, before app/MCP code that records usage. Grants only;
-- rerunning converges to exactly these privileges.
-- MCP: appends usage rows and nothing else (no read back, update or delete).
-- App: nothing. Account erasure removes rows through the foreign key's
-- cascade, which runs as the table owner.
BEGIN;
REVOKE ALL ON public.usage_calls FROM milton_app_runtime,milton_mcp_runtime;
GRANT INSERT ON public.usage_calls TO milton_mcp_runtime;
COMMIT;
