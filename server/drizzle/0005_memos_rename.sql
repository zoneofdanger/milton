-- Coordinated maintenance only: old callers must be blocked and drained.
-- Metadata rename; no memo/version rows or stored payloads are rewritten.
SET LOCAL lock_timeout = '10s';
--> statement-breakpoint
LOCK TABLE store_config, users, recipes, recipe_versions IN ACCESS EXCLUSIVE MODE;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM store_config WHERE singleton=1
      AND jsonb_typeof(limits_json->'recipes')='number'
      AND (limits_json->>'recipes')::numeric > 0
      AND trunc((limits_json->>'recipes')::numeric)=(limits_json->>'recipes')::numeric
      AND NOT limits_json ? 'memos') THEN
    RAISE EXCEPTION 'Unexpected count-limit keys or value; inspect the schema and journal before retrying';
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE recipes RENAME TO memos;
--> statement-breakpoint
ALTER TABLE recipe_versions RENAME TO memo_versions;
--> statement-breakpoint
ALTER TABLE memo_versions RENAME COLUMN recipe_id TO memo_id;
--> statement-breakpoint
ALTER TABLE memos RENAME CONSTRAINT recipes_user_id_id_pk TO memos_user_id_id_pk;
--> statement-breakpoint
ALTER TABLE memos RENAME CONSTRAINT recipes_user_name TO memos_user_name;
--> statement-breakpoint
ALTER TABLE memos RENAME CONSTRAINT recipes_slug TO memos_slug;
--> statement-breakpoint
ALTER TABLE memos RENAME CONSTRAINT recipes_user_id_users_id_fk TO memos_user_id_users_id_fk;
--> statement-breakpoint
ALTER TABLE memo_versions RENAME CONSTRAINT recipe_versions_user_id_recipe_id_version_pk TO memo_versions_user_id_memo_id_version_pk;
--> statement-breakpoint
ALTER TABLE memo_versions RENAME CONSTRAINT versions_recipe TO memo_versions_memo;
--> statement-breakpoint
ALTER TABLE memo_versions RENAME CONSTRAINT versions_positive TO memo_versions_positive;
--> statement-breakpoint
ALTER TABLE memo_versions RENAME CONSTRAINT versions_description TO memo_versions_description;
--> statement-breakpoint
ALTER TABLE memo_versions RENAME CONSTRAINT versions_actor_object TO memo_versions_actor_object;
--> statement-breakpoint
ALTER TABLE memo_versions RENAME CONSTRAINT versions_details_object TO memo_versions_details_object;
--> statement-breakpoint
-- PostgreSQL 18 names NOT NULL constraints; earlier versions have no contype='n' rows.
DO $$
DECLARE item record;
BEGIN
  FOR item IN SELECT conrelid::regclass AS relation, conname FROM pg_constraint
    WHERE conrelid IN ('memos'::regclass,'memo_versions'::regclass)
      AND contype='n' AND conname ~ '^(recipes_|recipe_versions_)'
  LOOP
    EXECUTE format('ALTER TABLE %s RENAME CONSTRAINT %I TO %I', item.relation, item.conname,
      replace(replace(replace(item.conname,'recipe_versions_','memo_versions_'),'recipes_','memos_'),'recipe_id','memo_id'));
  END LOOP;
END $$;
--> statement-breakpoint
ALTER FUNCTION milton_recipe_guard() RENAME TO milton_memo_guard;
--> statement-breakpoint
ALTER FUNCTION milton_version_guard() RENAME TO milton_memo_version_guard;
--> statement-breakpoint
ALTER FUNCTION milton_version_bytes() RENAME TO milton_memo_version_bytes;
--> statement-breakpoint
ALTER TRIGGER recipes_guard ON memos RENAME TO memos_guard;
--> statement-breakpoint
ALTER TRIGGER versions_guard ON memo_versions RENAME TO memo_versions_guard;
--> statement-breakpoint
ALTER TRIGGER versions_bytes ON memo_versions RENAME TO memo_versions_bytes;
--> statement-breakpoint
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
--> statement-breakpoint
CREATE OR REPLACE FUNCTION milton_memo_version_bytes() RETURNS trigger LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog, public AS $$
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
--> statement-breakpoint
CREATE OR REPLACE FUNCTION milton_memo_version_guard() RETURNS trigger LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog, public AS $$
DECLARE lim jsonb; head integer; source memo_versions%ROWTYPE; recovery text; is_vibes boolean;
BEGIN
  IF TG_OP = 'UPDATE' THEN RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'memo_version_is_immutable'; END IF;
  PERFORM 1 FROM users WHERE id = NEW.user_id AND status = 'active' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'account_unavailable'; END IF;
  SELECT limits_json INTO lim FROM store_config WHERE singleton = 1;
  SELECT max(version) INTO head FROM memo_versions WHERE user_id = NEW.user_id AND memo_id = NEW.memo_id;
  IF NEW.version <> COALESCE(head, 0) + 1 THEN RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'memo_version_conflict'; END IF;
  IF octet_length(NEW.body) > COALESCE((lim->>'body_bytes')::integer, 0) THEN RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'memo_body_limit'; END IF;
  IF octet_length(NEW.description) > COALESCE((lim->>'description_bytes')::integer, 0) THEN RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'memo_description_limit'; END IF;
  IF octet_length(NEW.reason) > COALESCE((lim->>'reason_bytes')::integer, 0) THEN RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'memo_reason_limit'; END IF;
  SELECT name='vibes' INTO is_vibes FROM memos WHERE user_id=NEW.user_id AND id=NEW.memo_id;
  recovery := COALESCE(NEW.details_json::jsonb->>'kind', '');
  IF recovery IN ('revert','restore') THEN
    IF (NEW.actor_json::jsonb->>'kind' IS DISTINCT FROM 'person'
      AND NOT (is_vibes AND recovery='restore' AND NEW.actor_json::jsonb->>'kind' IS NOT DISTINCT FROM 'system'))
      OR jsonb_typeof(NEW.details_json::jsonb->'source_version') IS DISTINCT FROM 'number' THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'memo_recovery_invalid';
    END IF;
    SELECT * INTO source FROM memo_versions
      WHERE user_id=NEW.user_id AND memo_id=NEW.memo_id
      AND to_jsonb(version)=NEW.details_json::jsonb->'source_version';
    IF NOT FOUND OR NEW.description IS DISTINCT FROM source.description OR NEW.body IS DISTINCT FROM source.body
      OR (recovery='revert' AND NEW.archived IS DISTINCT FROM (source.archived AND NOT is_vibes))
      OR (recovery='restore' AND (source.version IS DISTINCT FROM head OR NOT source.archived OR NEW.archived)) THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'memo_recovery_invalid';
    END IF;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
UPDATE store_config SET limits_json=(limits_json - 'recipes') || jsonb_build_object('memos',limits_json->'recipes') WHERE singleton=1;
--> statement-breakpoint
ALTER TABLE store_config ALTER COLUMN limits_json SET DEFAULT '{"memos":100,"body_bytes":32768,"name_bytes":64,"description_bytes":500,"reason_bytes":500,"history_bytes":67108864,"daily_calls":1000,"daily_writes":200,"request_bytes":65536,"page_size":50}'::jsonb;
