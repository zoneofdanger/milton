-- Offline rollback, only while no group has a title. After titles are set, the
-- previous runtime would assemble TPS without them: use a forward fix instead.
-- Stop writers first. Card order returns to card ID order, which matches the
-- backfill but not cards created after 0016; refuse in that case as well.
BEGIN;
LOCK TABLE memos, instruction_cards, memo_cards IN ACCESS EXCLUSIVE MODE;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM memos WHERE title IS NOT NULL) THEN
    RAISE EXCEPTION 'readable_tps_rollback_requires_untitled_groups';
  END IF;
  IF EXISTS (SELECT 1 FROM (
    SELECT position, row_number() OVER (PARTITION BY user_id ORDER BY id) AS by_id,
      row_number() OVER (PARTITION BY user_id ORDER BY position) AS by_position
    FROM instruction_cards) o WHERE o.by_id<>o.by_position) THEN
    RAISE EXCEPTION 'readable_tps_rollback_requires_id_order';
  END IF;
END $$;
CREATE OR REPLACE FUNCTION milton_memo_guard() RETURNS trigger LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog, public AS $$
DECLARE lim jsonb;
BEGIN
  IF TG_OP = 'UPDATE' THEN RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'memo_metadata_is_immutable'; END IF;
  PERFORM 1 FROM users WHERE id = NEW.user_id AND status = 'active' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'account_unavailable'; END IF;
  SELECT limits_json INTO lim FROM store_config WHERE singleton = 1;
  IF octet_length(NEW.name) > COALESCE((lim->>'name_bytes')::integer, 0) THEN RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'memo_name_limit'; END IF;
  IF NEW.name <> 'vibes' AND (SELECT count(*) FROM memos WHERE user_id = NEW.user_id AND name <> 'vibes') >= COALESCE((lim->>'memos')::integer, 0) THEN RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'memo_count_limit'; END IF;
  RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION milton_card_group_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
  PERFORM 1 FROM users WHERE id=NEW.user_id AND status='active' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='account_unavailable'; END IF;
  IF (TG_OP='INSERT' AND NEW.version<>1) OR (TG_OP='UPDATE' AND
    ((NEW.user_id,NEW.card_id) IS DISTINCT FROM (OLD.user_id,OLD.card_id) OR NEW.version<>OLD.version+1 OR NEW.memo_id=OLD.memo_id)) THEN
    RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='card_group_conflict';
  END IF;
  RETURN NEW;
END $$;
ALTER TABLE memos DROP CONSTRAINT memos_title;
ALTER TABLE memos DROP COLUMN title;
ALTER TABLE instruction_cards DROP CONSTRAINT instruction_cards_position;
ALTER TABLE instruction_cards DROP COLUMN position;
COMMIT;
