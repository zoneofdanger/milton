-- Drop columns, checks and indexes nothing reads: users.profile_json and
-- templates_revision, identities.profile_json, usage_daily.writes,
-- store_config.updated_at, save_requests.reserved_micros, the indexes
-- save_requests_by_day and save_requests_by_account_day, and the four unread
-- keys (memos, daily_writes, request_bytes, page_size) from the limits_json
-- default. The stored limits row is unchanged. The save guard is replaced first
-- without reserved_micros in its immutable tuple. Release the code that stops
-- writing profile_json and reserved_micros first; see deploy/README.md "Dead
-- columns (0026)". rollback/0026_dead_columns.sql re-adds the shape, empty.
SET LOCAL lock_timeout = '10s';
--> statement-breakpoint
-- Lock in the order sign-in, call counting and saves first touch these tables
-- so a live request cannot deadlock with this transaction.
LOCK TABLE "identities", "users", "store_config", "save_requests", "usage_daily" IN ACCESS EXCLUSIVE MODE;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION milton_save_request_guard() RETURNS trigger LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog, public AS $$
DECLARE retained bigint; ceiling bigint;
BEGIN
  IF TG_OP='UPDATE' AND (OLD.completed OR
    (NEW.user_id,NEW.request_id,NEW.input_hash,NEW.source_hash,NEW.deadline,NEW.created_at)
    IS DISTINCT FROM (OLD.user_id,OLD.request_id,OLD.input_hash,OLD.source_hash,OLD.deadline,OLD.created_at)) THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='save_receipt_is_immutable';
  END IF;
  IF TG_OP='DELETE' THEN
    UPDATE users SET retained_bytes=retained_bytes-OLD.payload_bytes WHERE id=OLD.user_id;
    RETURN OLD;
  END IF;
  UPDATE users SET retained_bytes=retained_bytes+NEW.payload_bytes-CASE WHEN TG_OP='UPDATE' THEN OLD.payload_bytes ELSE 0 END
    WHERE id=NEW.user_id AND status='active' RETURNING retained_bytes INTO retained;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='account_unavailable'; END IF;
  SELECT (limits_json->>'history_bytes')::bigint INTO ceiling FROM store_config WHERE singleton=1;
  IF TG_OP='INSERT' AND retained > coalesce(ceiling,0) THEN RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='memo_history_limit'; END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
ALTER TABLE "identities" DROP CONSTRAINT "identities_profile_object";--> statement-breakpoint
ALTER TABLE "save_requests" DROP CONSTRAINT "save_request_cost";--> statement-breakpoint
ALTER TABLE "usage_daily" DROP CONSTRAINT "usage_nonnegative";--> statement-breakpoint
ALTER TABLE "users" DROP CONSTRAINT "users_revision";--> statement-breakpoint
ALTER TABLE "users" DROP CONSTRAINT "users_profile_object";--> statement-breakpoint
DROP INDEX "save_requests_by_day";--> statement-breakpoint
DROP INDEX "save_requests_by_account_day";--> statement-breakpoint
ALTER TABLE "store_config" ALTER COLUMN "limits_json" SET DEFAULT '{"body_bytes":32768,"name_bytes":64,"description_bytes":500,"reason_bytes":500,"history_bytes":67108864,"report_body_bytes":262144,"daily_calls":1000}'::jsonb;--> statement-breakpoint
ALTER TABLE "identities" DROP COLUMN "profile_json";--> statement-breakpoint
ALTER TABLE "save_requests" DROP COLUMN "reserved_micros";--> statement-breakpoint
ALTER TABLE "store_config" DROP COLUMN "updated_at";--> statement-breakpoint
ALTER TABLE "usage_daily" DROP COLUMN "writes";--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN "templates_revision";--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN "profile_json";--> statement-breakpoint
ALTER TABLE "usage_daily" ADD CONSTRAINT "usage_nonnegative" CHECK ("usage_daily"."tool_calls" >= 0);
