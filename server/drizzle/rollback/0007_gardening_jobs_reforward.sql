BEGIN;
SET LOCAL lock_timeout = '10s';
LOCK TABLE milton_rollback.gardening_jobs, milton_rollback.gardening_usage IN ACCESS EXCLUSIVE MODE;
ALTER TABLE milton_rollback.gardening_jobs SET SCHEMA public;
ALTER TABLE milton_rollback.gardening_usage SET SCHEMA public;
ALTER FUNCTION milton_rollback.milton_gardening_guard() SET SCHEMA public;
COMMIT;
