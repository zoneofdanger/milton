-- Rollback of 0026. RESTORES SHAPE, NOT DATA. Re-adds, at their defaults:
-- users.templates_revision (0) and profile_json ({}), identities.profile_json
-- ({}), usage_daily.writes (0), store_config.updated_at (now()) and
-- save_requests.reserved_micros (0), with their checks; recreates
-- save_requests_by_day and save_requests_by_account_day; restores the previous
-- limits_json default and the 0006 save guard. reserved_micros keeps DEFAULT 0
-- (the deploy pre-step's state), so both the pre-0026 code, which writes it,
-- and the current code, which omits it, can save. Offline; stop writers first.
-- Every ADD fails if the object already exists, so a partial or repeated run
-- rolls back as a whole.
BEGIN;
SET LOCAL lock_timeout = '10s';
ALTER TABLE "users" ADD COLUMN "templates_revision" integer DEFAULT 0 NOT NULL;
ALTER TABLE "users" ADD COLUMN "profile_json" jsonb DEFAULT '{}'::jsonb NOT NULL;
ALTER TABLE "users" ADD CONSTRAINT "users_revision" CHECK ("users"."templates_revision" >= 0);
ALTER TABLE "users" ADD CONSTRAINT "users_profile_object" CHECK (jsonb_typeof("users"."profile_json") = 'object');
ALTER TABLE "identities" ADD COLUMN "profile_json" jsonb DEFAULT '{}'::jsonb NOT NULL;
ALTER TABLE "identities" ADD CONSTRAINT "identities_profile_object" CHECK (jsonb_typeof("identities"."profile_json") = 'object');
ALTER TABLE "usage_daily" ADD COLUMN "writes" integer DEFAULT 0 NOT NULL;
ALTER TABLE "usage_daily" DROP CONSTRAINT "usage_nonnegative";
ALTER TABLE "usage_daily" ADD CONSTRAINT "usage_nonnegative" CHECK ("usage_daily"."tool_calls" >= 0 AND "usage_daily"."writes" >= 0);
ALTER TABLE "store_config" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;
ALTER TABLE "store_config" ALTER COLUMN "limits_json" SET DEFAULT '{"memos":100,"body_bytes":32768,"name_bytes":64,"description_bytes":500,"reason_bytes":500,"history_bytes":67108864,"report_body_bytes":262144,"daily_calls":1000,"daily_writes":200,"request_bytes":65536,"page_size":50}'::jsonb;
ALTER TABLE "save_requests" ADD COLUMN "reserved_micros" integer DEFAULT 0 NOT NULL;
ALTER TABLE "save_requests" ADD CONSTRAINT "save_request_cost" CHECK ("save_requests"."reserved_micros" >= 0);
CREATE INDEX "save_requests_by_day" ON "save_requests" USING btree ("created_at");
CREATE INDEX "save_requests_by_account_day" ON "save_requests" USING btree ("user_id","created_at");
CREATE OR REPLACE FUNCTION milton_save_request_guard() RETURNS trigger LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog, public AS $$
DECLARE retained bigint; ceiling bigint;
BEGIN
  IF TG_OP='UPDATE' AND (OLD.completed OR
    (NEW.user_id,NEW.request_id,NEW.input_hash,NEW.source_hash,NEW.reserved_micros,NEW.deadline,NEW.created_at)
    IS DISTINCT FROM (OLD.user_id,OLD.request_id,OLD.input_hash,OLD.source_hash,OLD.reserved_micros,OLD.deadline,OLD.created_at)) THEN
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
COMMIT;
