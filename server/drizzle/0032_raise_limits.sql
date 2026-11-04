-- Raise the limits (Peter, 2026-11-04). Milton charges now, so the metered caps
-- go up. Widen three checks the raised save limits would otherwise hit:
-- samples_body to 131072 bytes (rule and sample text, was 32768),
-- accepted_change_shape to 1100 affected cards (100 rules, 500 edits and 500
-- moves per save; was 100) and save_request_result to 65536 bytes (a receipt
-- listing up to 500 retired samples; was 2048). Set the limits_json default to
-- the new values and apply them to the stored row: daily_calls 10000 (was 1000)
-- and body_bytes 131072 (was 32768). description_bytes (500) and
-- report_body_bytes (262144) stay. Widening never fails on existing rows, and an
-- earlier revision runs on this schema under its own code caps. Released with
-- 0028-0031 in the same run; see deploy/README.md "Limits (0032)".
-- rollback/0032_raise_limits.sql restores the old checks and code defaults.
SET LOCAL lock_timeout = '10s';
--> statement-breakpoint
-- Lock in the save path's order (users through the account lock, then
-- store_config, then the tables a save writes) so a live save cannot deadlock
-- with this transaction. EXCLUSIVE on users lets reads continue while account
-- locks wait.
LOCK TABLE "users" IN EXCLUSIVE MODE;
--> statement-breakpoint
LOCK TABLE "store_config", "samples", "accepted_changes", "save_requests" IN ACCESS EXCLUSIVE MODE;
--> statement-breakpoint
ALTER TABLE "accepted_changes" DROP CONSTRAINT "accepted_change_shape";--> statement-breakpoint
ALTER TABLE "samples" DROP CONSTRAINT "samples_body";--> statement-breakpoint
ALTER TABLE "save_requests" DROP CONSTRAINT "save_request_result";--> statement-breakpoint
ALTER TABLE "store_config" ALTER COLUMN "limits_json" SET DEFAULT '{"body_bytes":131072,"name_bytes":64,"description_bytes":500,"reason_bytes":500,"report_body_bytes":262144,"daily_calls":10000}'::jsonb;--> statement-breakpoint
ALTER TABLE "accepted_changes" ADD CONSTRAINT "accepted_change_shape" CHECK (length("accepted_changes"."request_id")=36 AND "accepted_changes"."operation" IN ('save_memo','refinement_apply') AND jsonb_typeof("accepted_changes"."request_json")='object' AND jsonb_typeof("accepted_changes"."actor_json")='object' AND jsonb_typeof("accepted_changes"."transformation_json")='object' AND jsonb_typeof("accepted_changes"."affected_json")='array' AND jsonb_array_length("accepted_changes"."affected_json")<=1100);--> statement-breakpoint
ALTER TABLE "samples" ADD CONSTRAINT "samples_body" CHECK (btrim("samples"."body") <> '' AND octet_length("samples"."body") <= 131072);--> statement-breakpoint
ALTER TABLE "save_requests" ADD CONSTRAINT "save_request_result" CHECK (jsonb_typeof("save_requests"."result_json") = 'object' AND octet_length("save_requests"."result_json"::text) <= 65536);--> statement-breakpoint
UPDATE "store_config" SET "limits_json" = jsonb_set(jsonb_set("limits_json", '{daily_calls}', '10000'), '{body_bytes}', '131072') WHERE "singleton" = 1;
