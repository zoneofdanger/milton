-- Rollback of 0032. Restores the three checks at their old caps (samples_body
-- 32768 bytes, accepted_change_shape 100 affected cards, save_request_result 2048
-- bytes) and the old limits_json default, and sets the stored row's daily_calls
-- and body_bytes to the old code defaults, 1000 and 32768. The values the row
-- held before 0032 are not recorded, so a row tuned by hand before 0032 needs
-- retuning after this. Refuses while any sample, accepted change or receipt is
-- past an old cap: the old checks cannot hold it. Rule bodies over 32768 bytes
-- stay; the cap applies only to new versions. Offline; stop writers first. Every
-- ADD fails if the constraint already exists, so a partial or repeated run rolls
-- back as a whole. Run as neondb_owner. The 0032 journal row stays, so
-- re-forwarding means running 0032_raise_limits.sql by hand.
BEGIN;
SET LOCAL lock_timeout = '10s';
LOCK TABLE "users" IN EXCLUSIVE MODE;
LOCK TABLE "store_config", "samples", "accepted_changes", "save_requests" IN ACCESS EXCLUSIVE MODE;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM samples WHERE octet_length(body) > 32768) THEN
    RAISE EXCEPTION 'raise_limits_rollback_requires_samples_within_32768_bytes';
  END IF;
  IF EXISTS (SELECT 1 FROM accepted_changes WHERE jsonb_array_length(affected_json) > 100) THEN
    RAISE EXCEPTION 'raise_limits_rollback_requires_changes_within_100_cards';
  END IF;
  IF EXISTS (SELECT 1 FROM save_requests WHERE octet_length(result_json::text) > 2048) THEN
    RAISE EXCEPTION 'raise_limits_rollback_requires_receipts_within_2048_bytes';
  END IF;
END $$;
ALTER TABLE "accepted_changes" DROP CONSTRAINT "accepted_change_shape";
ALTER TABLE "samples" DROP CONSTRAINT "samples_body";
ALTER TABLE "save_requests" DROP CONSTRAINT "save_request_result";
ALTER TABLE "store_config" ALTER COLUMN "limits_json" SET DEFAULT '{"body_bytes":32768,"name_bytes":64,"description_bytes":500,"reason_bytes":500,"report_body_bytes":262144,"daily_calls":1000}'::jsonb;
ALTER TABLE "accepted_changes" ADD CONSTRAINT "accepted_change_shape" CHECK (length("accepted_changes"."request_id")=36 AND "accepted_changes"."operation" IN ('save_memo','refinement_apply') AND jsonb_typeof("accepted_changes"."request_json")='object' AND jsonb_typeof("accepted_changes"."actor_json")='object' AND jsonb_typeof("accepted_changes"."transformation_json")='object' AND jsonb_typeof("accepted_changes"."affected_json")='array' AND jsonb_array_length("accepted_changes"."affected_json")<=100);
ALTER TABLE "samples" ADD CONSTRAINT "samples_body" CHECK (btrim("samples"."body") <> '' AND octet_length("samples"."body") <= 32768);
ALTER TABLE "save_requests" ADD CONSTRAINT "save_request_result" CHECK (jsonb_typeof("save_requests"."result_json") = 'object' AND octet_length("save_requests"."result_json"::text) <= 2048);
UPDATE "store_config" SET "limits_json" = jsonb_set(jsonb_set("limits_json", '{daily_calls}', '1000'), '{body_bytes}', '32768') WHERE "singleton" = 1;
COMMIT;
