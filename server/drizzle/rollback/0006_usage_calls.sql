-- Rollback of 0006. Drops usage_calls and every row in it (usage collected
-- since 0006; recoverable only from a snapshot). Run only once no serving code
-- writes it, or accept that its appends fail (logged by code, responses
-- unchanged). Run as neondb_owner: psql -X -v ON_ERROR_STOP=1 -f this file.
-- The 0006 journal row stays, so re-forwarding means running
-- 0006_usage_calls.sql by hand, as one transaction:
-- psql -1 -X -v ON_ERROR_STOP=1 -f server/drizzle/0006_usage_calls.sql
-- and then migrations/009-usage-calls-roles.sql.
BEGIN;
DROP TABLE "usage_calls";
COMMIT;
