-- Preserving compatibility rollback. First disable new allowance claims and
-- drain mutating runtimes. Use an accounting/alerts-only-aware rollback runtime.
-- Keep the new ledger, constraints, event snapshots and aggregate triggers.
BEGIN;
SET LOCAL lock_timeout='10s';
SELECT singleton FROM store_config WHERE singleton=1 FOR UPDATE;
LOCK TABLE save_requests IN SHARE ROW EXCLUSIVE MODE;
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM store_config WHERE memo_updates_enabled) OR
     EXISTS(SELECT 1 FROM save_requests WHERE memo_update_state='held' AND NOT completed AND deadline>clock_timestamp()) THEN
    RAISE EXCEPTION 'memo_update_rollback_requires_disabled_and_drained';
  END IF;
END $$;
CREATE TABLE memo_update_policy_0014_rollback AS
  SELECT foreground_accounting_ready,memo_updates_daily_limit,global_spend_policy FROM store_config WHERE singleton=1;
UPDATE store_config SET foreground_accounting_ready=false WHERE singleton=1;
COMMIT;
