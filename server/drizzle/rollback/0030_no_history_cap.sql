-- Rollback of 0030. Re-adds users.retained_bytes with users_bytes, each
-- account's value recomputed as the sum of payload_bytes over the rows the
-- triggers counted (memo_versions, instruction_card_versions, accepted_changes
-- and save_requests); the three byte functions and their triggers; the 0029
-- save guard; and history_bytes in the limits_json default. The stored limits
-- row kept the key, so the cap applies again at its stored value: an account
-- that grew past it since 0030 keeps every row and cannot save until it is
-- under it. Either revision runs on the result. Offline; stop writers first.
-- Every ADD and CREATE fails if the object already exists, so a partial or
-- repeated run rolls back as a whole. Run as neondb_owner. The 0030 journal row
-- stays, so re-forwarding means running 0030_no_history_cap.sql by hand.
BEGIN;
SET LOCAL lock_timeout = '10s';
LOCK TABLE "users" IN ACCESS EXCLUSIVE MODE;
LOCK TABLE "store_config", "save_requests", "instruction_card_versions", "accepted_changes", "memo_versions" IN ACCESS EXCLUSIVE MODE;
ALTER TABLE "users" ADD COLUMN "retained_bytes" bigint DEFAULT 0 NOT NULL;
UPDATE users u SET retained_bytes=
  (SELECT coalesce(sum(payload_bytes),0) FROM memo_versions WHERE user_id=u.id)
  + (SELECT coalesce(sum(payload_bytes),0) FROM instruction_card_versions WHERE user_id=u.id)
  + (SELECT coalesce(sum(payload_bytes),0) FROM accepted_changes WHERE user_id=u.id)
  + (SELECT coalesce(sum(payload_bytes),0) FROM save_requests WHERE user_id=u.id);
ALTER TABLE "users" ADD CONSTRAINT "users_bytes" CHECK ("users"."retained_bytes" >= 0);
ALTER TABLE "store_config" ALTER COLUMN "limits_json" SET DEFAULT '{"body_bytes":32768,"name_bytes":64,"description_bytes":500,"reason_bytes":500,"history_bytes":67108864,"report_body_bytes":262144,"daily_calls":1000}'::jsonb;
CREATE FUNCTION milton_memo_version_bytes() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE retained bigint; lim jsonb;
BEGIN
  IF TG_OP = 'DELETE' THEN
    UPDATE users SET retained_bytes = retained_bytes - OLD.payload_bytes WHERE id = OLD.user_id;
    RETURN OLD;
  END IF;
  UPDATE users SET retained_bytes = retained_bytes + NEW.payload_bytes WHERE id = NEW.user_id RETURNING retained_bytes INTO retained;
  SELECT limits_json INTO lim FROM store_config WHERE singleton = 1;
  IF COALESCE(NEW.details_json::jsonb->>'kind', '') NOT IN ('revert','restore')
    AND retained > COALESCE((lim->>'history_bytes')::bigint, 0)
    AND NOT (
      NEW.version = 1 AND NEW.body = ''
      AND NEW.actor_json::jsonb->>'kind' IS NOT DISTINCT FROM 'system'
      AND NEW.details_json::jsonb->>'kind' IS NOT DISTINCT FROM 'create'
      AND EXISTS (SELECT 1 FROM memos WHERE user_id = NEW.user_id AND id = NEW.memo_id AND name = 'vibes')
    ) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'memo_history_limit';
  END IF;
  RETURN NEW;
END $$;
CREATE FUNCTION milton_card_version_bytes() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE retained bigint; lim jsonb;
BEGIN
  IF TG_OP='DELETE' THEN
    UPDATE users SET retained_bytes=retained_bytes-OLD.payload_bytes WHERE id=OLD.user_id;
    RETURN OLD;
  END IF;
  UPDATE users SET retained_bytes=retained_bytes+NEW.payload_bytes WHERE id=NEW.user_id RETURNING retained_bytes INTO retained;
  SELECT limits_json INTO lim FROM store_config WHERE singleton=1;
  IF retained > (lim->>'history_bytes')::bigint
    AND NOT coalesce((NEW.legacy AND (NEW.details_json::jsonb->>'kind' IN ('revert','restore') OR
      (NEW.version=1 AND NEW.body='' AND NEW.actor_json::jsonb->>'kind'='system' AND NEW.details_json::jsonb->>'kind'='create'
      AND EXISTS (SELECT 1 FROM memos WHERE user_id=NEW.user_id AND id=NEW.card_id AND name='vibes')))),false) THEN
    RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='memo_history_limit';
  END IF;
  RETURN NEW;
END $$;
CREATE FUNCTION milton_accepted_change_bytes() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE retained bigint; lim jsonb;
BEGIN
 IF TG_OP='DELETE' THEN
  UPDATE users SET retained_bytes=retained_bytes-OLD.payload_bytes WHERE id=OLD.user_id;
  RETURN OLD;
 END IF;
 UPDATE users SET retained_bytes=retained_bytes+NEW.payload_bytes WHERE id=NEW.user_id RETURNING retained_bytes INTO retained;
 SELECT limits_json INTO lim FROM store_config WHERE singleton=1;
 IF retained>(lim->>'history_bytes')::bigint THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='memo_history_limit'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER memo_versions_bytes AFTER INSERT OR DELETE ON memo_versions FOR EACH ROW EXECUTE FUNCTION milton_memo_version_bytes();
CREATE TRIGGER instruction_card_versions_bytes AFTER INSERT OR DELETE ON instruction_card_versions FOR EACH ROW EXECUTE FUNCTION milton_card_version_bytes();
CREATE TRIGGER accepted_changes_bytes AFTER INSERT OR DELETE ON accepted_changes FOR EACH ROW EXECUTE FUNCTION milton_accepted_change_bytes();
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
COMMIT;
