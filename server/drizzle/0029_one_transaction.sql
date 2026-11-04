-- Saves run in one transaction, so a receipt is written once, with its result.
-- Drop what only the two-phase save used: save_requests.completed, deadline and
-- claimed_at with save_request_claim_clock, the 0014 trigger save_claim_clock
-- with milton_claim_clock, and the result_json default. First delete the
-- receipts an earlier revision claimed and never completed: such a claim
-- changed nothing (that revision completed the receipt in the transaction that
-- applied a change), so a replay of one runs as a new save, still fenced by
-- expected_version. save_request_outcome then holds every receipt to an
-- outcome, and the save guard refuses every UPDATE. Apply the pre-step
-- pre/0029_one_transaction.sql, release the code that stops reading and writing
-- these columns to both services, then snapshot, then migrate; see
-- deploy/README.md "Saves in one transaction (0029)".
-- rollback/0029_one_transaction.sql re-adds the shape with every receipt
-- complete.
SET LOCAL lock_timeout = '10s';
--> statement-breakpoint
-- Lock in the save path's order (users through the account lock, save_requests
-- through the receipt lookup, then store_config through the trial gate, limits
-- and the save guard) so a live save cannot deadlock with the deletes below,
-- whose guard updates users.retained_bytes.
LOCK TABLE "users" IN EXCLUSIVE MODE;
--> statement-breakpoint
LOCK TABLE "save_requests", "store_config" IN ACCESS EXCLUSIVE MODE;
--> statement-breakpoint
DELETE FROM save_requests WHERE NOT completed;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION milton_save_request_guard() RETURNS trigger LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog, public AS $$
DECLARE retained bigint; ceiling bigint;
BEGIN
  IF TG_OP='UPDATE' THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='save_receipt_is_immutable';
  END IF;
  IF TG_OP='DELETE' THEN
    UPDATE users SET retained_bytes=retained_bytes-OLD.payload_bytes WHERE id=OLD.user_id;
    RETURN OLD;
  END IF;
  UPDATE users SET retained_bytes=retained_bytes+NEW.payload_bytes
    WHERE id=NEW.user_id AND status='active' RETURNING retained_bytes INTO retained;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='account_unavailable'; END IF;
  SELECT (limits_json->>'history_bytes')::bigint INTO ceiling FROM store_config WHERE singleton=1;
  IF retained > coalesce(ceiling,0) THEN RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='memo_history_limit'; END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
DROP TRIGGER save_claim_clock ON save_requests;
--> statement-breakpoint
DROP FUNCTION milton_claim_clock();
--> statement-breakpoint
ALTER TABLE "save_requests" DROP CONSTRAINT "save_request_claim_clock";--> statement-breakpoint
ALTER TABLE "save_requests" ALTER COLUMN "result_json" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "save_requests" DROP COLUMN "completed";--> statement-breakpoint
ALTER TABLE "save_requests" DROP COLUMN "deadline";--> statement-breakpoint
ALTER TABLE "save_requests" DROP COLUMN "claimed_at";--> statement-breakpoint
ALTER TABLE "save_requests" ADD CONSTRAINT "save_request_outcome" CHECK (("save_requests"."result_json"->>'status') IS NOT NULL);
