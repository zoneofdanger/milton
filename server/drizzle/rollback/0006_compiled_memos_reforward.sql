-- Re-forward after the journal-retaining 0006 rollback. All parked data survives.
BEGIN;
SET LOCAL lock_timeout = '10s';
LOCK TABLE milton_rollback.save_requests, milton_rollback.tps_reports IN ACCESS EXCLUSIVE MODE;
ALTER TABLE milton_rollback.save_requests SET SCHEMA public;
ALTER TABLE milton_rollback.tps_reports SET SCHEMA public;
ALTER FUNCTION milton_rollback.milton_save_request_guard() SET SCHEMA public;
COMMIT;
