INSERT INTO store_config (singleton) VALUES (1);
--> statement-breakpoint

CREATE FUNCTION milton_recipe_guard() RETURNS trigger LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog, public AS $$
DECLARE lim jsonb;
BEGIN
  IF TG_OP = 'UPDATE' THEN RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'recipe_metadata_is_immutable'; END IF;
  PERFORM 1 FROM users WHERE id = NEW.user_id AND status = 'active' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'account_unavailable'; END IF;
  SELECT limits_json INTO lim FROM store_config WHERE singleton = 1;
  IF octet_length(NEW.name) > COALESCE((lim->>'name_bytes')::integer, 0) THEN RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'recipe_name_limit'; END IF;
  IF (SELECT count(*) FROM recipes WHERE user_id = NEW.user_id) >= COALESCE((lim->>'recipes')::integer, 0) THEN RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'recipe_count_limit'; END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER recipes_guard BEFORE INSERT OR UPDATE ON recipes FOR EACH ROW EXECUTE FUNCTION milton_recipe_guard();
--> statement-breakpoint

CREATE FUNCTION milton_version_guard() RETURNS trigger LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog, public AS $$
DECLARE lim jsonb; head integer;
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
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER versions_guard BEFORE INSERT OR UPDATE ON recipe_versions FOR EACH ROW EXECUTE FUNCTION milton_version_guard();
--> statement-breakpoint

CREATE FUNCTION milton_version_bytes() RETURNS trigger LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog, public AS $$
DECLARE retained bigint; lim jsonb;
BEGIN
  IF TG_OP = 'DELETE' THEN
    UPDATE users SET retained_bytes = retained_bytes - OLD.payload_bytes WHERE id = OLD.user_id;
    RETURN OLD;
  END IF;
  UPDATE users SET retained_bytes = retained_bytes + NEW.payload_bytes WHERE id = NEW.user_id RETURNING retained_bytes INTO retained;
  SELECT limits_json INTO lim FROM store_config WHERE singleton = 1;
  IF COALESCE(NEW.details_json::jsonb->>'kind', '') NOT IN ('revert','restore') AND retained > COALESCE((lim->>'history_bytes')::bigint, 0) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'recipe_history_limit';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER versions_bytes AFTER INSERT OR DELETE ON recipe_versions FOR EACH ROW EXECUTE FUNCTION milton_version_bytes();
--> statement-breakpoint

CREATE FUNCTION milton_user_id_guard() RETURNS trigger LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog, public AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id THEN RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'user_id_is_immutable'; END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER users_keep_id BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION milton_user_id_guard();
