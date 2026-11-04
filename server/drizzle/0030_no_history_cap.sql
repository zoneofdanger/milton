-- Remove the lifetime history cap (Peter, 2026-11-04). History rows never shrink
-- short of account deletion, so an account at limits_json.history_bytes could
-- not free space and every later save failed with memo_history_limit. Drop what
-- only the cap used: the byte triggers memo_versions_bytes,
-- instruction_card_versions_bytes and accepted_changes_bytes with their
-- functions milton_memo_version_bytes, milton_card_version_bytes and
-- milton_accepted_change_bytes; the counting and the refusal in the save guard,
-- which keeps refusing receipt updates and saves to an account that is not
-- active; users.retained_bytes with users_bytes (nothing else reads it); and
-- history_bytes from the limits_json default. The stored limits row keeps the
-- key, unread, so an earlier revision still reads its limits and runs on this
-- schema. Release the code that stops reading the key first; see
-- deploy/README.md "No history cap (0030)". rollback/0030_no_history_cap.sql
-- re-adds the cap, the counter recomputed from the rows it counted.
SET LOCAL lock_timeout = '10s';
--> statement-breakpoint
-- Lock in the save path's order (users through the account lock, then
-- store_config, then the history tables a save appends to) so a live save
-- cannot deadlock with this transaction.
LOCK TABLE "users" IN ACCESS EXCLUSIVE MODE;
--> statement-breakpoint
LOCK TABLE "store_config", "instruction_card_versions", "accepted_changes", "memo_versions" IN ACCESS EXCLUSIVE MODE;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION milton_save_request_guard() RETURNS trigger LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP='UPDATE' THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='save_receipt_is_immutable';
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  PERFORM 1 FROM users WHERE id=NEW.user_id AND status='active';
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='account_unavailable'; END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
DROP TRIGGER memo_versions_bytes ON memo_versions;
--> statement-breakpoint
DROP TRIGGER instruction_card_versions_bytes ON instruction_card_versions;
--> statement-breakpoint
DROP TRIGGER accepted_changes_bytes ON accepted_changes;
--> statement-breakpoint
DROP FUNCTION milton_memo_version_bytes();
--> statement-breakpoint
DROP FUNCTION milton_card_version_bytes();
--> statement-breakpoint
DROP FUNCTION milton_accepted_change_bytes();
--> statement-breakpoint
ALTER TABLE "users" DROP CONSTRAINT "users_bytes";--> statement-breakpoint
ALTER TABLE "store_config" ALTER COLUMN "limits_json" SET DEFAULT '{"body_bytes":32768,"name_bytes":64,"description_bytes":500,"reason_bytes":500,"report_body_bytes":262144,"daily_calls":1000}'::jsonb;--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN "retained_bytes";
