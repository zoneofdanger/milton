-- Stop workers and disable capture before this offline rollback. Keep all jobs,
-- findings and their retained-byte accounting; do not discard unresolved evidence.
BEGIN;
SET LOCAL lock_timeout = '10s';
CREATE SCHEMA IF NOT EXISTS milton_rollback;
LOCK TABLE gardening_jobs, gardening_usage IN ACCESS EXCLUSIVE MODE;
ALTER TABLE gardening_jobs SET SCHEMA milton_rollback;
ALTER TABLE gardening_usage SET SCHEMA milton_rollback;
ALTER FUNCTION milton_gardening_guard() SET SCHEMA milton_rollback;
COMMIT;
