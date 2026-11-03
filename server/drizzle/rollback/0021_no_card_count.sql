-- Rollback of 0021: restores the 0008 card guard and the 0016 memo guard, count
-- limits included. Offline; stop writers first. Rows are untouched: an account
-- already above limits_json.memos keeps its cards and then cannot add more.
BEGIN;
CREATE OR REPLACE FUNCTION milton_card_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE lim jsonb;
BEGIN
  IF TG_OP='UPDATE' THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='card_identity_is_immutable'; END IF;
  PERFORM 1 FROM users WHERE id=NEW.user_id AND status='active' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='account_unavailable'; END IF;
  SELECT limits_json INTO lim FROM store_config WHERE singleton=1;
  IF (SELECT count(*) FROM instruction_cards c WHERE c.user_id=NEW.user_id
    AND NOT EXISTS (SELECT 1 FROM memos m WHERE m.user_id=c.user_id AND m.id=c.id AND m.name='vibes')) >= (lim->>'memos')::int
    AND NOT EXISTS (SELECT 1 FROM memos WHERE user_id=NEW.user_id AND id=NEW.id AND name='vibes') THEN
    RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='memo_count_limit';
  END IF;
  RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION milton_memo_guard() RETURNS trigger LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog, public AS $$
DECLARE lim jsonb;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF OLD.title IS NOT NULL OR NEW.title IS NULL
      OR (NEW.user_id, NEW.id, NEW.name, NEW.created_at) IS DISTINCT FROM (OLD.user_id, OLD.id, OLD.name, OLD.created_at) THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'memo_metadata_is_immutable';
    END IF;
    PERFORM 1 FROM users WHERE id = NEW.user_id AND status = 'active' FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'account_unavailable'; END IF;
    RETURN NEW;
  END IF;
  PERFORM 1 FROM users WHERE id = NEW.user_id AND status = 'active' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'account_unavailable'; END IF;
  SELECT limits_json INTO lim FROM store_config WHERE singleton = 1;
  IF octet_length(NEW.name) > COALESCE((lim->>'name_bytes')::integer, 0) THEN RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'memo_name_limit'; END IF;
  IF NEW.name <> 'vibes' AND (SELECT count(*) FROM memos WHERE user_id = NEW.user_id AND name <> 'vibes') >= COALESCE((lim->>'memos')::integer, 0) THEN RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'memo_count_limit'; END IF;
  RETURN NEW;
END $$;
COMMIT;
