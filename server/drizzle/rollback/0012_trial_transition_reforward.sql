-- Restore the original access records, with enforcement still disabled.
-- Verify compatible runtimes, subscription integration and entitlement state
-- before a separately authorized re-enable. Never restart a person's trial.
BEGIN;
SET LOCAL lock_timeout='10s';
LOCK TABLE store_config,trial_accounts_0012_rollback IN ACCESS EXCLUSIVE MODE;
ALTER TABLE trial_accounts_0012_rollback RENAME TO trial_accounts;
UPDATE store_config SET trials_enabled=false WHERE singleton=1;
COMMIT;
