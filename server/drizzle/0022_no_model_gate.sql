-- No model-era gate on memo updates. global_spend_policy and
-- foreground_accounting_ready have had one valid value (alerts_only, true) since
-- saves went model-free, and no runtime reads them: saves read only
-- memo_updates_enabled and memo_updates_daily_limit, and the spend worker
-- observes unconditionally. config_memo_updates keeps only the positive daily
-- limit; enabling memo updates no longer needs the readiness flag.
ALTER TABLE "store_config" DROP CONSTRAINT "config_global_spend_policy";--> statement-breakpoint
ALTER TABLE "store_config" DROP CONSTRAINT "config_memo_updates";--> statement-breakpoint
ALTER TABLE "store_config" DROP COLUMN "global_spend_policy";--> statement-breakpoint
ALTER TABLE "store_config" DROP COLUMN "foreground_accounting_ready";--> statement-breakpoint
ALTER TABLE "store_config" ADD CONSTRAINT "config_memo_updates" CHECK ("store_config"."memo_updates_daily_limit">0);