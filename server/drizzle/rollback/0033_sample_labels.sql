-- Rollback of 0033. Restores the append-only guard without the labels, then
-- drops the samples_labels check and the search, register, purpose and audience
-- columns. Labels saved since 0033 leave the table; each save's request_json in
-- accepted_changes and save_requests still records the labels it sent. Run
-- after traffic is back on a revision that does not read the labels: the 0033
-- code fails every read and sample save without them. Offline; stop writers
-- first. Run as neondb_owner. The 0033 journal row stays, so re-forwarding means
-- running 0033_sample_labels.sql by hand.
BEGIN;
SET LOCAL lock_timeout = '10s';
LOCK TABLE "samples" IN ACCESS EXCLUSIVE MODE;
CREATE OR REPLACE FUNCTION milton_sample_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    IF EXISTS (SELECT 1 FROM users WHERE id=OLD.user_id) THEN
      RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='sample_is_append_only';
    END IF;
    RETURN OLD;
  END IF;
  IF TG_OP='UPDATE' THEN
    IF OLD.retired_at IS NOT NULL OR NEW.retired_at IS NULL OR NEW.retire_reason IS NULL
      OR (NEW.user_id,NEW.id,NEW.report,NEW.kind_id,NEW.context,NEW.body,NEW.client_json,NEW.replaces_id,NEW.created_at)
        IS DISTINCT FROM (OLD.user_id,OLD.id,OLD.report,OLD.kind_id,OLD.context,OLD.body,OLD.client_json,OLD.replaces_id,OLD.created_at) THEN
      RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='sample_is_append_only';
    END IF;
    RETURN NEW;
  END IF;
  PERFORM 1 FROM users WHERE id=NEW.user_id AND status='active' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='account_unavailable'; END IF;
  RETURN NEW;
END $$;
ALTER TABLE "samples" DROP CONSTRAINT "samples_labels";
ALTER TABLE "samples" DROP COLUMN "search";
ALTER TABLE "samples" DROP COLUMN "register";
ALTER TABLE "samples" DROP COLUMN "purpose";
ALTER TABLE "samples" DROP COLUMN "audience";
COMMIT;
