-- Preserve all recipes and history. Vibes has its own slot and stays active on recovery.
SET LOCAL lock_timeout = '10s';
--> statement-breakpoint
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
--> statement-breakpoint
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
--> statement-breakpoint
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
