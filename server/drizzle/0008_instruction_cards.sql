-- Offline expand/backfill: drain writers and observers before applying.
-- Keep the original memo history and every TPS/receipt/job byte unchanged.
SET LOCAL lock_timeout = '10s';
--> statement-breakpoint
LOCK TABLE store_config, users, memos, memo_versions, tps_reports, save_requests, gardening_jobs IN ACCESS EXCLUSIVE MODE;
--> statement-breakpoint
CREATE TABLE instruction_cards (
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(user_id,id),
  CONSTRAINT card_id_nonempty CHECK (id <> '')
);
--> statement-breakpoint
CREATE TABLE instruction_card_versions (
  user_id text NOT NULL,
  card_id text NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  description text NOT NULL CHECK (description <> '' AND position(chr(10) in description)=0 AND position(chr(13) in description)=0),
  body text NOT NULL,
  archived boolean NOT NULL DEFAULT false,
  reason text NOT NULL,
  actor_json text NOT NULL CHECK (jsonb_typeof(actor_json::jsonb)='object'),
  details_json text NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(details_json::jsonb)='object'),
  legacy boolean NOT NULL DEFAULT false,
  payload_bytes bigint GENERATED ALWAYS AS (octet_length(description)::bigint + octet_length(body) + octet_length(reason) + octet_length(actor_json) + octet_length(details_json)) STORED NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(user_id,card_id,version),
  FOREIGN KEY(user_id,card_id) REFERENCES instruction_cards(user_id,id) ON DELETE CASCADE
);
--> statement-breakpoint
-- Group membership is independent from card text/version and report order.
-- Changing it never changes TPS bytes or a card's content history.
CREATE TABLE memo_cards (
  user_id text NOT NULL,
  card_id text NOT NULL,
  memo_id text NOT NULL,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  PRIMARY KEY(user_id,card_id),
  FOREIGN KEY(user_id,card_id) REFERENCES instruction_cards(user_id,id) ON DELETE CASCADE,
  FOREIGN KEY(user_id,memo_id) REFERENCES memos(user_id,id) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX memo_cards_by_memo ON memo_cards(user_id,memo_id);
--> statement-breakpoint
INSERT INTO instruction_cards(user_id,id,created_at) SELECT user_id,id,created_at FROM memos;
--> statement-breakpoint
INSERT INTO memo_cards(user_id,card_id,memo_id) SELECT user_id,id,id FROM memos;
--> statement-breakpoint
INSERT INTO instruction_card_versions(user_id,card_id,version,description,body,archived,reason,actor_json,details_json,legacy,created_at)
SELECT user_id,memo_id,version,description,body,archived,reason,actor_json,details_json,true,created_at FROM memo_versions;
--> statement-breakpoint
-- Count the retained copy honestly; backfill may put an account above its ceiling.
-- It never discards history to fit. Subsequent ordinary writes then fail closed.
UPDATE users u SET retained_bytes=retained_bytes + (SELECT coalesce(sum(payload_bytes),0) FROM instruction_card_versions WHERE user_id=u.id);
--> statement-breakpoint
CREATE FUNCTION milton_card_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
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
--> statement-breakpoint
CREATE TRIGGER instruction_cards_guard BEFORE INSERT OR UPDATE ON instruction_cards FOR EACH ROW EXECUTE FUNCTION milton_card_guard();
--> statement-breakpoint
CREATE FUNCTION milton_card_version_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE head integer; lim jsonb;
BEGIN
  IF TG_OP='UPDATE' THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='card_version_is_immutable'; END IF;
  IF TG_OP='DELETE' THEN
    IF EXISTS (SELECT 1 FROM instruction_cards WHERE user_id=OLD.user_id AND id=OLD.card_id)
      AND (NOT OLD.legacy OR EXISTS (SELECT 1 FROM memo_versions WHERE user_id=OLD.user_id AND memo_id=OLD.card_id AND version=OLD.version)) THEN
      RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='card_version_is_immutable';
    END IF;
    RETURN OLD;
  END IF;
  PERFORM 1 FROM users WHERE id=NEW.user_id AND status='active' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='account_unavailable'; END IF;
  SELECT max(version) INTO head FROM instruction_card_versions WHERE user_id=NEW.user_id AND card_id=NEW.card_id;
  IF NEW.version <> coalesce(head,0)+1 THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='card_version_conflict'; END IF;
  SELECT limits_json INTO lim FROM store_config WHERE singleton=1;
  IF octet_length(NEW.body) > (lim->>'body_bytes')::int THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='memo_body_limit'; END IF;
  IF octet_length(NEW.description) > (lim->>'description_bytes')::int THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='memo_description_limit'; END IF;
  IF octet_length(NEW.reason) > (lim->>'reason_bytes')::int THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='memo_reason_limit'; END IF;
  IF NEW.legacy AND NOT EXISTS (SELECT 1 FROM memo_versions v WHERE v.user_id=NEW.user_id AND v.memo_id=NEW.card_id AND v.version=NEW.version
    AND (v.description,v.body,v.archived,v.reason,v.actor_json,v.details_json,v.created_at) IS NOT DISTINCT FROM
        (NEW.description,NEW.body,NEW.archived,NEW.reason,NEW.actor_json,NEW.details_json,NEW.created_at)) THEN
    RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='card_legacy_invalid';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER instruction_card_versions_guard BEFORE INSERT OR UPDATE OR DELETE ON instruction_card_versions FOR EACH ROW EXECUTE FUNCTION milton_card_version_guard();
--> statement-breakpoint
CREATE FUNCTION milton_card_version_bytes() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
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
--> statement-breakpoint
CREATE TRIGGER instruction_card_versions_bytes AFTER INSERT OR DELETE ON instruction_card_versions FOR EACH ROW EXECUTE FUNCTION milton_card_version_bytes();
--> statement-breakpoint
CREATE FUNCTION milton_card_group_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
  PERFORM 1 FROM users WHERE id=NEW.user_id AND status='active' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='account_unavailable'; END IF;
  IF (TG_OP='INSERT' AND NEW.version<>1) OR (TG_OP='UPDATE' AND
    ((NEW.user_id,NEW.card_id) IS DISTINCT FROM (OLD.user_id,OLD.card_id) OR NEW.version<>OLD.version+1 OR NEW.memo_id=OLD.memo_id)) THEN
    RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='card_group_conflict';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER memo_cards_guard BEFORE INSERT OR UPDATE ON memo_cards FOR EACH ROW EXECUTE FUNCTION milton_card_group_guard();
--> statement-breakpoint
-- Transitional legacy imports/initialization may create or advance an untouched
-- one-card memo. Once a card is independently edited/regrouped, refuse legacy
-- writes instead of overwriting current card content with a stale memo body.
CREATE FUNCTION milton_legacy_card_append() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
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
--> statement-breakpoint
CREATE TRIGGER memo_versions_card_append AFTER INSERT ON memo_versions FOR EACH ROW EXECUTE FUNCTION milton_legacy_card_append();

--> statement-breakpoint
-- Legacy deletion must never strand a card or silently delete independently
-- authored/grouped instructions. Account deletion still cascades normally.
CREATE FUNCTION milton_legacy_card_delete() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
  PERFORM 1 FROM users WHERE id=OLD.user_id FOR UPDATE;
  IF NOT FOUND THEN RETURN OLD; END IF;
  IF TG_TABLE_NAME='memos' THEN
    IF EXISTS (SELECT 1 FROM memo_cards WHERE user_id=OLD.user_id AND ((memo_id=OLD.id AND (card_id<>OLD.id OR version<>1)) OR (card_id=OLD.id AND (memo_id<>OLD.id OR version<>1))))
      OR EXISTS (SELECT 1 FROM instruction_card_versions WHERE user_id=OLD.user_id AND card_id=OLD.id AND NOT legacy) THEN
      RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='card_legacy_conflict';
    END IF;
    DELETE FROM instruction_cards WHERE user_id=OLD.user_id AND id=OLD.id;
  ELSE
    IF EXISTS (SELECT 1 FROM instruction_card_versions WHERE user_id=OLD.user_id AND card_id=OLD.memo_id AND NOT legacy) THEN
      RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='card_legacy_conflict';
    END IF;
    DELETE FROM instruction_card_versions WHERE user_id=OLD.user_id AND card_id=OLD.memo_id AND version=OLD.version AND legacy;
  END IF;
  RETURN OLD;
END $$;
--> statement-breakpoint
CREATE TRIGGER memos_card_delete BEFORE DELETE ON memos FOR EACH ROW EXECUTE FUNCTION milton_legacy_card_delete();
--> statement-breakpoint
CREATE TRIGGER memo_versions_card_delete AFTER DELETE ON memo_versions FOR EACH ROW EXECUTE FUNCTION milton_legacy_card_delete();
