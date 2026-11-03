-- Rollback of 0022: re-adds global_spend_policy and foreground_accounting_ready
-- with their 0014 defaults ('capped', false) and restores both 0014 checks.
-- Offline; stop writers first, and roll back to pre-0022 code with it. The row
-- takes the only state pre-0022 code serves with memo updates on (alerts_only,
-- ready), as production held before 0022; memo_updates_enabled and the daily
-- limit are untouched.
BEGIN;
ALTER TABLE "store_config" DROP CONSTRAINT "config_memo_updates";
ALTER TABLE "store_config" ADD COLUMN "global_spend_policy" text DEFAULT 'capped' NOT NULL;
ALTER TABLE "store_config" ADD COLUMN "foreground_accounting_ready" boolean DEFAULT false NOT NULL;
UPDATE "store_config" SET "global_spend_policy"='alerts_only',"foreground_accounting_ready"=true WHERE "singleton"=1;
ALTER TABLE "store_config" ADD CONSTRAINT "config_global_spend_policy" CHECK ("store_config"."global_spend_policy" IN ('capped','alerts_only'));
ALTER TABLE "store_config" ADD CONSTRAINT "config_memo_updates" CHECK ("store_config"."memo_updates_daily_limit">0 AND (NOT "store_config"."memo_updates_enabled" OR ("store_config"."foreground_accounting_ready" AND "store_config"."global_spend_policy"='alerts_only')));
COMMIT;
