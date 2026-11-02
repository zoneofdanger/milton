-- Stop all trial-aware runtimes first. This parks access evidence; it does not
-- erase clocks, reminder claims or trusted paid-through projections. Older
-- runtimes cannot enforce trials. Do not serve paid traffic with them.
BEGIN;
SET LOCAL lock_timeout='10s';
LOCK TABLE store_config,trial_accounts IN ACCESS EXCLUSIVE MODE;
UPDATE store_config SET trials_enabled=false WHERE singleton=1;
ALTER TABLE trial_accounts RENAME TO trial_accounts_0012_rollback;
-- Keep the disabled additive config column; old binaries ignore it.
COMMIT;
