-- Block and drain new callers before rollback. Preserve every committed write.
-- Retain the Drizzle journal; a later re-forward must apply 0005 explicitly.
BEGIN;

SET LOCAL lock_timeout = '10s';

LOCK TABLE store_config, users, memos, memo_versions IN ACCESS EXCLUSIVE MODE;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM store_config WHERE singleton=1
      AND jsonb_typeof(limits_json->'memos')='number'
      AND (limits_json->>'memos')::numeric > 0
      AND trunc((limits_json->>'memos')::numeric)=(limits_json->>'memos')::numeric
      AND NOT limits_json ? 'recipes') THEN
    RAISE EXCEPTION 'Unexpected count-limit keys or value; inspect the schema and journal before retrying';
  END IF;
END $$;

ALTER TABLE memos RENAME CONSTRAINT memos_user_id_id_pk TO recipes_user_id_id_pk;

ALTER TABLE memos RENAME CONSTRAINT memos_user_name TO recipes_user_name;

ALTER TABLE memos RENAME CONSTRAINT memos_slug TO recipes_slug;

ALTER TABLE memos RENAME CONSTRAINT memos_user_id_users_id_fk TO recipes_user_id_users_id_fk;

ALTER TABLE memo_versions RENAME CONSTRAINT memo_versions_user_id_memo_id_version_pk TO recipe_versions_user_id_recipe_id_version_pk;

ALTER TABLE memo_versions RENAME CONSTRAINT memo_versions_memo TO versions_recipe;

ALTER TABLE memo_versions RENAME CONSTRAINT memo_versions_positive TO versions_positive;

ALTER TABLE memo_versions RENAME CONSTRAINT memo_versions_description TO versions_description;

ALTER TABLE memo_versions RENAME CONSTRAINT memo_versions_actor_object TO versions_actor_object;

ALTER TABLE memo_versions RENAME CONSTRAINT memo_versions_details_object TO versions_details_object;

ALTER TRIGGER memos_guard ON memos RENAME TO recipes_guard;

ALTER TRIGGER memo_versions_guard ON memo_versions RENAME TO versions_guard;

ALTER TRIGGER memo_versions_bytes ON memo_versions RENAME TO versions_bytes;

-- PostgreSQL 18 names NOT NULL constraints; earlier versions have no contype='n' rows.
DO $$
DECLARE item record;
BEGIN
  FOR item IN SELECT conrelid::regclass AS relation, conname FROM pg_constraint
    WHERE conrelid IN ('memos'::regclass,'memo_versions'::regclass)
      AND contype='n' AND conname ~ '^(memos_|memo_versions_)'
  LOOP
    EXECUTE format('ALTER TABLE %s RENAME CONSTRAINT %I TO %I', item.relation, item.conname,
      replace(replace(replace(item.conname,'memo_versions_','recipe_versions_'),'memos_','recipes_'),'memo_id','recipe_id'));
  END LOOP;
END $$;

ALTER FUNCTION milton_memo_guard() RENAME TO milton_recipe_guard;

ALTER FUNCTION milton_memo_version_guard() RENAME TO milton_version_guard;

ALTER FUNCTION milton_memo_version_bytes() RENAME TO milton_version_bytes;

ALTER TABLE memo_versions RENAME COLUMN memo_id TO recipe_id;

ALTER TABLE memo_versions RENAME TO recipe_versions;

ALTER TABLE memos RENAME TO recipes;

CREATE OR REPLACE FUNCTION milton_recipe_guard() RETURNS trigger LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog, public AS $$
DECLARE lim jsonb;
BEGIN
  IF TG_OP = 'UPDATE' THEN RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'recipe_metadata_is_immutable'; END IF;
  PERFORM 1 FROM users WHERE id = NEW.user_id AND status = 'active' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'account_unavailable'; END IF;
  SELECT limits_json INTO lim FROM store_config WHERE singleton = 1;
  IF octet_length(NEW.name) > COALESCE((lim->>'name_bytes')::integer, 0) THEN RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'recipe_name_limit'; END IF;
  IF NEW.name <> 'vibes' AND (SELECT count(*) FROM recipes WHERE user_id = NEW.user_id AND name <> 'vibes') >= COALESCE((lim->>'recipes')::integer, 0) THEN RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'recipe_count_limit'; END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION milton_version_bytes() RETURNS trigger LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog, public AS $$
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
      AND EXISTS (SELECT 1 FROM recipes WHERE user_id = NEW.user_id AND id = NEW.recipe_id AND name = 'vibes')
    ) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'recipe_history_limit';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION milton_version_guard() RETURNS trigger LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog, public AS $$
DECLARE lim jsonb; head integer; source recipe_versions%ROWTYPE; recovery text; is_vibes boolean;
BEGIN
  IF TG_OP = 'UPDATE' THEN RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'recipe_version_is_immutable'; END IF;
  PERFORM 1 FROM users WHERE id = NEW.user_id AND status = 'active' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'account_unavailable'; END IF;
  SELECT limits_json INTO lim FROM store_config WHERE singleton = 1;
  SELECT max(version) INTO head FROM recipe_versions WHERE user_id = NEW.user_id AND recipe_id = NEW.recipe_id;
  IF NEW.version <> COALESCE(head, 0) + 1 THEN RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'recipe_version_conflict'; END IF;
  IF octet_length(NEW.body) > COALESCE((lim->>'body_bytes')::integer, 0) THEN RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'recipe_body_limit'; END IF;
  IF octet_length(NEW.description) > COALESCE((lim->>'description_bytes')::integer, 0) THEN RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'recipe_description_limit'; END IF;
  IF octet_length(NEW.reason) > COALESCE((lim->>'reason_bytes')::integer, 0) THEN RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'recipe_reason_limit'; END IF;
  SELECT name='vibes' INTO is_vibes FROM recipes WHERE user_id=NEW.user_id AND id=NEW.recipe_id;
  recovery := COALESCE(NEW.details_json::jsonb->>'kind', '');
  IF recovery IN ('revert','restore') THEN
    IF (NEW.actor_json::jsonb->>'kind' IS DISTINCT FROM 'person'
      AND NOT (is_vibes AND recovery='restore' AND NEW.actor_json::jsonb->>'kind' IS NOT DISTINCT FROM 'system'))
      OR jsonb_typeof(NEW.details_json::jsonb->'source_version') IS DISTINCT FROM 'number' THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'recipe_recovery_invalid';
    END IF;
    SELECT * INTO source FROM recipe_versions
      WHERE user_id=NEW.user_id AND recipe_id=NEW.recipe_id
      AND to_jsonb(version)=NEW.details_json::jsonb->'source_version';
    IF NOT FOUND OR NEW.description IS DISTINCT FROM source.description OR NEW.body IS DISTINCT FROM source.body
      OR (recovery='revert' AND NEW.archived IS DISTINCT FROM (source.archived AND NOT is_vibes))
      OR (recovery='restore' AND (source.version IS DISTINCT FROM head OR NOT source.archived OR NEW.archived)) THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'recipe_recovery_invalid';
    END IF;
  END IF;
  RETURN NEW;
END $$;

UPDATE store_config SET limits_json=(limits_json - 'memos') || jsonb_build_object('recipes',limits_json->'memos') WHERE singleton=1;

ALTER TABLE store_config ALTER COLUMN limits_json SET DEFAULT '{"recipes":100,"body_bytes":32768,"name_bytes":64,"description_bytes":500,"reason_bytes":500,"history_bytes":67108864,"daily_calls":1000,"daily_writes":200,"request_bytes":65536,"page_size":50}'::jsonb;

COMMIT;
