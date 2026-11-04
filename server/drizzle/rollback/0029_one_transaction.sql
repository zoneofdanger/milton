-- Rollback of 0029. RESTORES SHAPE, NOT DATA. Re-adds save_requests.completed,
-- every receipt true (each holds its result; the default is false again, as an
-- earlier revision's claim expects), deadline (NOT NULL without a default,
-- every receipt '-infinity': a completed receipt's deadline is never read) and
-- claimed_at (NULL) with save_request_claim_clock; the result_json default
-- '{}'; milton_claim_clock in its pre-step form (pre/0029_one_transaction.sql)
-- with its trigger save_claim_clock; and the 0028 save guard. It drops
-- save_request_outcome. Receipts 0029 deleted, open claims that changed
-- nothing, do not come back. Either revision saves on the result, provided 0030 was rolled back
-- first (its schema has no users.retained_bytes). Offline; stop writers first. Every ADD and CREATE fails if the object already exists, so a
-- partial or repeated run rolls back as a whole. Run as neondb_owner. The 0029
-- journal row stays, so re-forwarding means running 0029_one_transaction.sql by
-- hand.
BEGIN;
SET LOCAL lock_timeout = '10s';
LOCK TABLE "save_requests", "store_config" IN ACCESS EXCLUSIVE MODE;
-- Refuses on the 0030 schema: the guard this file restores updates users.retained_bytes,
-- so roll back 0030 first.
SELECT retained_bytes FROM users LIMIT 0;
ALTER TABLE "save_requests" DROP CONSTRAINT "save_request_outcome";
ALTER TABLE "save_requests" ALTER COLUMN "result_json" SET DEFAULT '{}'::jsonb;
ALTER TABLE "save_requests" ADD COLUMN "completed" boolean DEFAULT true NOT NULL;
ALTER TABLE "save_requests" ALTER COLUMN "completed" SET DEFAULT false;
ALTER TABLE "save_requests" ADD COLUMN "deadline" timestamp with time zone DEFAULT '-infinity' NOT NULL;
ALTER TABLE "save_requests" ALTER COLUMN "deadline" DROP DEFAULT;
ALTER TABLE "save_requests" ADD COLUMN "claimed_at" timestamp with time zone;
ALTER TABLE "save_requests" ADD CONSTRAINT "save_request_claim_clock" CHECK ("save_requests"."claimed_at" IS NULL OR (isfinite("save_requests"."claimed_at") AND "save_requests"."claimed_at"="save_requests"."created_at"));
CREATE FUNCTION milton_claim_clock() RETURNS trigger LANGUAGE plpgsql VOLATILE SET search_path=pg_catalog,public AS $$
BEGIN
  NEW.claimed_at := coalesce(NEW.claimed_at,clock_timestamp());
  NEW.created_at := NEW.claimed_at;
  IF NEW.result_json->>'status' IS NOT NULL THEN
    NEW.completed := true;
    NEW.deadline := coalesce(NEW.deadline,NEW.created_at);
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER save_claim_clock BEFORE INSERT ON save_requests FOR EACH ROW EXECUTE FUNCTION milton_claim_clock();
CREATE OR REPLACE FUNCTION milton_save_request_guard() RETURNS trigger LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog, public AS $$
DECLARE retained bigint; ceiling bigint;
BEGIN
  IF TG_OP='UPDATE' AND (OLD.completed OR
    (NEW.user_id,NEW.request_id,NEW.input_hash,NEW.source_hash,NEW.deadline,NEW.created_at,NEW.claimed_at)
    IS DISTINCT FROM (OLD.user_id,OLD.request_id,OLD.input_hash,OLD.source_hash,OLD.deadline,OLD.created_at,OLD.claimed_at)) THEN
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
