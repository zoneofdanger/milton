-- Remove the spend subsystem: the foreground, gardening and derivation spend
-- ledgers, spend alerts and their emails, the save trigger that fed the
-- foreground ledger, and the spend feed's key hash. Nothing reads them since the
-- worker, alert email and feed were deleted; saves reserve nothing. Memo-update
-- accounting lives in save_requests and store_config and is unchanged. Rows are
-- not kept: the pre-0023 snapshot and the release export are the only copies.
-- rollback/0023_no_spend.sql restores the empty shape.
SET LOCAL lock_timeout = '10s';
--> statement-breakpoint
DROP TRIGGER save_foreground_reservation ON save_requests;
--> statement-breakpoint
DROP FUNCTION milton_foreground_reservation();
--> statement-breakpoint
DROP TRIGGER spend_alert_email_guard ON spend_alert_emails;
--> statement-breakpoint
DROP FUNCTION guard_spend_alert_email();
--> statement-breakpoint
DROP TABLE "spend_alert_emails";
--> statement-breakpoint
DROP TABLE "spend_alerts";
--> statement-breakpoint
DROP TABLE "foreground_usage";
--> statement-breakpoint
DROP TABLE "gardening_usage";
--> statement-breakpoint
DROP TABLE "derivation_usage";
--> statement-breakpoint
ALTER TABLE "store_config" DROP CONSTRAINT "config_spend_feed_key";
--> statement-breakpoint
ALTER TABLE "store_config" DROP COLUMN "spend_feed_key_hash";
