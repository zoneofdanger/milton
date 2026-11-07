-- Reverses 007-role-timeouts.up.sql, as the same owner: psql -X -v ON_ERROR_STOP=1 -f.
-- Removes only these settings; new sessions fall back to the server defaults (0,
-- no limit through Neon). A role audit that requires them then fails, so roll the
-- code back first. Rerunning is harmless.
BEGIN;
ALTER ROLE milton_app_runtime IN DATABASE milton RESET statement_timeout;
ALTER ROLE milton_app_runtime IN DATABASE milton RESET lock_timeout;
ALTER ROLE milton_mcp_runtime IN DATABASE milton RESET statement_timeout;
ALTER ROLE milton_mcp_runtime IN DATABASE milton RESET lock_timeout;
ALTER ROLE milton_auth_runtime IN DATABASE milton RESET statement_timeout;
COMMIT;
