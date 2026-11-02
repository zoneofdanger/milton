-- Run only after compatible writers/workers are restored. This restores policy
-- readiness, never enables user-update enforcement or rewrites a receipt.
BEGIN;
SET LOCAL lock_timeout='10s';
SELECT singleton FROM store_config WHERE singleton=1 FOR UPDATE;
UPDATE store_config c SET foreground_accounting_ready=p.foreground_accounting_ready,
  memo_updates_daily_limit=p.memo_updates_daily_limit,global_spend_policy=p.global_spend_policy
FROM memo_update_policy_0014_rollback p WHERE c.singleton=1;
DROP TABLE memo_update_policy_0014_rollback;
COMMIT;
