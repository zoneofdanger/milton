-- Drop the memo-update allowance: store_config.memo_updates_enabled and
-- memo_updates_daily_limit with config_memo_updates, and save_requests.
-- memo_update_day and memo_update_state with save_request_memo_update, the
-- partial index save_requests_memo_updates, and the 0014 trigger
-- save_memo_update_guard with milton_memo_update_guard. That guard also kept
-- claimed_at immutable; the save guard takes claimed_at into its immutable tuple
-- first, so a receipt's claim time still cannot change. Revokes the runtime
-- role's UPDATE (singleton) on store_config: it existed only for the sign-in
-- FOR UPDATE lock, which no code takes now, so the role keeps SELECT only.
-- Release the code that stops reading and writing these columns to both
-- services first, then snapshot, then migrate; see deploy/README.md "No memo
-- updates (0028)". rollback/0028_no_memo_updates.sql re-adds the shape and the
-- grant, with every receipt at 'none'.
SET LOCAL lock_timeout = '10s';
--> statement-breakpoint
-- Lock in the save path's order (users through the account lock, save_requests
-- through the receipt lookup, then store_config through the trial gate, limits
-- and the save guard) so a live save cannot deadlock with this transaction, or
-- with 0029 when one runner pass applies both. EXCLUSIVE on users lets reads
-- continue while account locks wait.
LOCK TABLE "users" IN EXCLUSIVE MODE;
--> statement-breakpoint
LOCK TABLE "save_requests", "store_config" IN ACCESS EXCLUSIVE MODE;
--> statement-breakpoint
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
--> statement-breakpoint
DROP TRIGGER save_memo_update_guard ON save_requests;
--> statement-breakpoint
DROP FUNCTION milton_memo_update_guard();
--> statement-breakpoint
ALTER TABLE "save_requests" DROP CONSTRAINT "save_request_memo_update";--> statement-breakpoint
ALTER TABLE "store_config" DROP CONSTRAINT "config_memo_updates";--> statement-breakpoint
DROP INDEX "save_requests_memo_updates";--> statement-breakpoint
ALTER TABLE "save_requests" DROP COLUMN "memo_update_day";--> statement-breakpoint
ALTER TABLE "save_requests" DROP COLUMN "memo_update_state";--> statement-breakpoint
ALTER TABLE "store_config" DROP COLUMN "memo_updates_enabled";--> statement-breakpoint
ALTER TABLE "store_config" DROP COLUMN "memo_updates_daily_limit";--> statement-breakpoint
REVOKE UPDATE (singleton) ON TABLE store_config FROM milton_runtime;
