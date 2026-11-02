-- No data or table changes. Validate every history-cap recovery exemption.
SET LOCAL lock_timeout = '10s';
--> statement-breakpoint
CREATE OR REPLACE FUNCTION milton_version_guard() RETURNS trigger LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog, public AS $$
DECLARE lim jsonb; head integer; source recipe_versions%ROWTYPE; recovery text;
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
  recovery := COALESCE(NEW.details_json::jsonb->>'kind', '');
  IF recovery IN ('revert','restore') THEN
    IF NEW.actor_json::jsonb->>'kind' IS DISTINCT FROM 'person'
      OR jsonb_typeof(NEW.details_json::jsonb->'source_version') IS DISTINCT FROM 'number' THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'recipe_recovery_invalid';
    END IF;
    SELECT * INTO source FROM recipe_versions
      WHERE user_id=NEW.user_id AND recipe_id=NEW.recipe_id
      AND to_jsonb(version)=NEW.details_json::jsonb->'source_version';
    IF NOT FOUND OR NEW.description IS DISTINCT FROM source.description OR NEW.body IS DISTINCT FROM source.body
      OR (recovery='revert' AND NEW.archived IS DISTINCT FROM source.archived)
      OR (recovery='restore' AND (source.version IS DISTINCT FROM head OR NOT source.archived OR NEW.archived)) THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'recipe_recovery_invalid';
    END IF;
  END IF;
  RETURN NEW;
END $$;
