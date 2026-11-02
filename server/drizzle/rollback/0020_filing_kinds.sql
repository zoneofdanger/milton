-- Offline rollback. Stop writers first. Lossy by design:
-- * Each card returns to one report, its latest version's ('cover' becomes NULL).
--   Earlier versions' reports (move history) are dropped; versions stay.
-- * Sample kinds return as each sample's kind label. Retirement reasons, the
--   retiring request IDs and replacement lineage are dropped; retired_at stays.
BEGIN;
LOCK TABLE instruction_cards, instruction_card_versions, samples, sample_kinds IN ACCESS EXCLUSIVE MODE;
ALTER TABLE instruction_cards ADD COLUMN report text;
ALTER TABLE instruction_cards DISABLE TRIGGER instruction_cards_guard;
UPDATE instruction_cards c SET report=nullif(v.report,'cover')
  FROM (SELECT DISTINCT ON (user_id,card_id) user_id,card_id,report FROM instruction_card_versions ORDER BY user_id,card_id,version DESC) v
  WHERE v.user_id=c.user_id AND v.card_id=c.id;
ALTER TABLE instruction_cards ENABLE TRIGGER instruction_cards_guard;
ALTER TABLE instruction_cards ADD CONSTRAINT instruction_cards_report CHECK (report IS NULL OR report IN ('email','chat','post','document','speech'));
CREATE OR REPLACE FUNCTION milton_legacy_card_append() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM instruction_cards WHERE user_id=NEW.user_id AND id=NEW.memo_id) THEN
    INSERT INTO instruction_cards(user_id,id) VALUES (NEW.user_id,NEW.memo_id);
  END IF;
  INSERT INTO memo_cards(user_id,card_id,memo_id) VALUES (NEW.user_id,NEW.memo_id,NEW.memo_id) ON CONFLICT DO NOTHING;
  IF NOT EXISTS (SELECT 1 FROM memo_cards WHERE user_id=NEW.user_id AND card_id=NEW.memo_id AND memo_id=NEW.memo_id AND version=1)
    OR (SELECT count(*) FROM memo_cards WHERE user_id=NEW.user_id AND memo_id=NEW.memo_id) <> 1
    OR EXISTS (SELECT 1 FROM instruction_card_versions WHERE user_id=NEW.user_id AND card_id=NEW.memo_id AND NOT legacy) THEN
    RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='card_legacy_conflict';
  END IF;
  INSERT INTO instruction_card_versions(user_id,card_id,version,description,body,archived,reason,actor_json,details_json,legacy,created_at)
    VALUES(NEW.user_id,NEW.memo_id,NEW.version,NEW.description,NEW.body,NEW.archived,NEW.reason,NEW.actor_json,NEW.details_json,true,NEW.created_at);
  RETURN NEW;
END $$;
ALTER TABLE instruction_card_versions DROP CONSTRAINT instruction_card_versions_report;
ALTER TABLE instruction_card_versions DROP COLUMN report;
ALTER TABLE samples ADD COLUMN kind text;
ALTER TABLE samples DISABLE TRIGGER samples_guard;
UPDATE samples s SET kind=k.label FROM sample_kinds k WHERE k.user_id=s.user_id AND k.id=s.kind_id;
ALTER TABLE samples ENABLE TRIGGER samples_guard;
ALTER TABLE samples ALTER COLUMN kind SET NOT NULL;
ALTER TABLE samples ADD CONSTRAINT samples_kind CHECK (char_length(kind) BETWEEN 1 AND 60 AND position(chr(10) in kind)=0 AND position(chr(13) in kind)=0 AND btrim(kind)=kind);
CREATE OR REPLACE FUNCTION milton_sample_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    IF EXISTS (SELECT 1 FROM users WHERE id=OLD.user_id) THEN
      RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='sample_is_append_only';
    END IF;
    RETURN OLD;
  END IF;
  IF TG_OP='UPDATE' THEN
    IF OLD.retired_at IS NOT NULL OR NEW.retired_at IS NULL
      OR (NEW.user_id,NEW.id,NEW.report,NEW.kind,NEW.context,NEW.body,NEW.client_json,NEW.created_at)
        IS DISTINCT FROM (OLD.user_id,OLD.id,OLD.report,OLD.kind,OLD.context,OLD.body,OLD.client_json,OLD.created_at) THEN
      RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='sample_is_append_only';
    END IF;
    RETURN NEW;
  END IF;
  PERFORM 1 FROM users WHERE id=NEW.user_id AND status='active' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='account_unavailable'; END IF;
  RETURN NEW;
END $$;
ALTER TABLE samples DROP CONSTRAINT samples_retirement;
ALTER TABLE samples DROP CONSTRAINT samples_replaces_fk;
ALTER TABLE samples DROP CONSTRAINT samples_kind_fk;
ALTER TABLE samples DROP CONSTRAINT samples_kind_key;
DROP INDEX samples_by_kind;
ALTER TABLE samples DROP COLUMN kind_id, DROP COLUMN replaces_id, DROP COLUMN retire_reason, DROP COLUMN retired_request_id;
DROP TRIGGER sample_kinds_guard ON sample_kinds;
DROP FUNCTION milton_sample_kind_guard();
DROP TABLE sample_kinds;
COMMIT;
