-- OWNER REVIEWED PREPARATION. Apply after Drizzle 0008_usage_retention, before the
-- auth image whose maintenance job prunes usage rows. Grants only; rerunning
-- converges to exactly these privileges.
-- The auth maintenance job (Cloud Run job milton-auth-maint) runs as
-- milton_auth_owner: it may execute public.prune_usage_calls and nothing else in the
-- writing schema. USAGE on public only resolves the function's name; it grants no
-- table, and CREATE on public stays revoked from PUBLIC. No runtime may prune.
BEGIN;
REVOKE ALL ON FUNCTION public.prune_usage_calls(integer)
 FROM PUBLIC,milton_app_runtime,milton_mcp_runtime,milton_auth_owner;
GRANT USAGE ON SCHEMA public TO milton_auth_owner;
GRANT EXECUTE ON FUNCTION public.prune_usage_calls(integer) TO milton_auth_owner;
COMMIT;
