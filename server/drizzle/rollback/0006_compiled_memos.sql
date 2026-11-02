-- Offline rollback: park new records intact; do not discard receipts or memo history.
-- The migration journal stays. To re-forward, restore these objects explicitly.
BEGIN;
SET LOCAL lock_timeout = '10s';
CREATE SCHEMA IF NOT EXISTS milton_rollback;
LOCK TABLE save_requests, tps_reports IN ACCESS EXCLUSIVE MODE;
ALTER TABLE save_requests SET SCHEMA milton_rollback;
ALTER TABLE tps_reports SET SCHEMA milton_rollback;
ALTER FUNCTION milton_save_request_guard() SET SCHEMA milton_rollback;
COMMIT;
