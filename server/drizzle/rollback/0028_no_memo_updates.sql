-- Rollback of 0028. RESTORES SHAPE, NOT DATA. Re-adds, at their 0014 defaults:
-- store_config.memo_updates_enabled (false) and memo_updates_daily_limit (100)
-- with config_memo_updates (the 0022 form); save_requests.memo_update_day (NULL)
-- and memo_update_state ('none') with save_request_memo_update, so every
-- receipt reads as never charged; the partial index save_requests_memo_updates;
-- milton_memo_update_guard with its trigger save_memo_update_guard; the 0026
-- save guard; and the runtime role's UPDATE (singleton) on store_config. The
-- allowance comes back off; a production setting that was on before 0028 must
-- be set again by the owner. Offline; stop writers first. Every ADD and CREATE
-- fails if the object already exists, so a partial or repeated run rolls back
-- as a whole. Run as neondb_owner. The 0028 journal row stays, so re-forwarding
-- means running 0028_no_memo_updates.sql by hand.
BEGIN;
SET LOCAL lock_timeout = '10s';
LOCK TABLE "save_requests", "store_config" IN ACCESS EXCLUSIVE MODE;
ALTER TABLE "store_config" ADD COLUMN "memo_updates_enabled" boolean DEFAULT false NOT NULL;
ALTER TABLE "store_config" ADD COLUMN "memo_updates_daily_limit" integer DEFAULT 100 NOT NULL;
ALTER TABLE "store_config" ADD CONSTRAINT "config_memo_updates" CHECK ("store_config"."memo_updates_daily_limit">0);
ALTER TABLE "save_requests" ADD COLUMN "memo_update_day" date;
ALTER TABLE "save_requests" ADD COLUMN "memo_update_state" text DEFAULT 'none' NOT NULL;
ALTER TABLE "save_requests" ADD CONSTRAINT "save_request_memo_update" CHECK (("save_requests"."memo_update_state"='none' AND "save_requests"."memo_update_day" IS NULL) OR ("save_requests"."memo_update_day" IS NOT NULL AND isfinite("save_requests"."memo_update_day") AND (("save_requests"."memo_update_state"='held' AND NOT "save_requests"."completed") OR ("save_requests"."memo_update_state" IN ('charged','released') AND "save_requests"."completed"))));
CREATE INDEX "save_requests_memo_updates" ON "save_requests" USING btree ("user_id","memo_update_day") WHERE "save_requests"."memo_update_state" IN ('held','charged');
CREATE FUNCTION milton_memo_update_guard() RETURNS trigger LANGUAGE plpgsql VOLATILE SET search_path=pg_catalog,public AS $$
BEGIN
  IF NEW.claimed_at IS DISTINCT FROM OLD.claimed_at OR
    (OLD.memo_update_state<>'none' AND (NEW.memo_update_day IS DISTINCT FROM OLD.memo_update_day OR NEW.memo_update_state='none')) THEN
    RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='memo_update_is_immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER save_memo_update_guard BEFORE UPDATE ON save_requests FOR EACH ROW EXECUTE FUNCTION milton_memo_update_guard();
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
GRANT UPDATE (singleton) ON TABLE store_config TO milton_runtime;
COMMIT;
