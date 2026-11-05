-- Owner-only, atomic maintenance migration. Drain old app/MCP writers first.
-- Preserve every approved summary/label in one canonical representation.
CREATE FUNCTION public.milton_sample_context_valid(c jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path TO 'pg_catalog', 'public' AS $$
DECLARE k text; v jsonb; item jsonb;
BEGIN
 IF jsonb_typeof(c) IS DISTINCT FROM 'object' OR octet_length(c::text)>8192
   OR c->'version' IS DISTINCT FROM '1'::jsonb OR jsonb_typeof(c->'summary') IS DISTINCT FROM 'string' THEN RETURN false; END IF;
 FOR k,v IN SELECT * FROM jsonb_each(c) LOOP
  IF k IN ('version') THEN CONTINUE;
  ELSIF k IN ('summary','medium','interaction','language','register') THEN
   IF jsonb_typeof(v)<>'string' OR char_length(v#>>'{}') NOT BETWEEN 1 AND (CASE WHEN k='summary' THEN 200 ELSE 60 END)
     OR btrim(v#>>'{}')<>v#>>'{}' OR (v#>>'{}') ~ E'[\\n\\r]' THEN RETURN false; END IF;
  ELSIF k='purposes' THEN
   IF jsonb_typeof(v)<>'array' THEN RETURN false; END IF;
   IF jsonb_array_length(v) NOT BETWEEN 1 AND 8 THEN RETURN false; END IF;
   FOR item IN SELECT * FROM jsonb_array_elements(v) LOOP
    IF jsonb_typeof(item)<>'string' OR char_length(item#>>'{}') NOT BETWEEN 1 AND 60 OR btrim(item#>>'{}')<>item#>>'{}' OR (item#>>'{}') ~ E'[\\n\\r]' THEN RETURN false; END IF;
   END LOOP;
   IF (SELECT count(*)<>count(DISTINCT x) FROM jsonb_array_elements(v) x) THEN RETURN false; END IF;
  ELSIF k IN ('audience','scope') THEN
   IF jsonb_typeof(v)<>'object' OR v='{}'::jsonb THEN RETURN false; END IF;
   IF k='scope' AND ((v->>'unit') IS NULL OR (v->>'unit') NOT IN ('whole','excerpt') OR (v ? 'role' AND v->>'unit'<>'excerpt')) THEN RETURN false; END IF;
   IF EXISTS(SELECT 1 FROM jsonb_each(v) e WHERE
      (k='audience' AND e.key NOT IN ('relationship','role','familiarity','expertise','group')) OR
      (k='scope' AND e.key NOT IN ('unit','role')) OR
      jsonb_typeof(e.value)<>'string' OR char_length(e.value#>>'{}') NOT BETWEEN 1 AND 60 OR btrim(e.value#>>'{}')<>e.value#>>'{}' OR (e.value#>>'{}') ~ E'[\\n\\r]') THEN RETURN false; END IF;
  ELSE RETURN false;
  END IF;
 END LOOP;
 RETURN true;
END $$;
--> statement-breakpoint
ALTER TABLE samples DISABLE TRIGGER samples_guard;
--> statement-breakpoint
ALTER TABLE samples DROP COLUMN search, DROP CONSTRAINT samples_context, DROP CONSTRAINT samples_labels;
--> statement-breakpoint
ALTER TABLE samples ALTER COLUMN context TYPE jsonb USING
 jsonb_build_object('version',1,'summary',context)
 || CASE WHEN audience IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('audience',jsonb_build_object('relationship',audience)) END
 || CASE WHEN purpose IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('purposes',jsonb_build_array(purpose)) END
 || CASE WHEN register IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('register',register) END;
--> statement-breakpoint
ALTER TABLE samples DROP COLUMN audience, DROP COLUMN purpose, DROP COLUMN register,
 ADD COLUMN context_revision integer NOT NULL DEFAULT 1,
 ADD CONSTRAINT samples_context CHECK (public.milton_sample_context_valid(context)),
 ADD CONSTRAINT samples_context_revision CHECK (context_revision>0),
 ADD COLUMN search tsvector GENERATED ALWAYS AS (to_tsvector('english'::regconfig,(context->>'summary') || ' ' || body)) STORED;
--> statement-breakpoint
ALTER TABLE samples DROP CONSTRAINT samples_replaces_fk, DROP CONSTRAINT samples_kind_key;
--> statement-breakpoint
ALTER TABLE samples ADD CONSTRAINT samples_replaces_fk FOREIGN KEY(user_id,replaces_id) REFERENCES samples(user_id,id) ON DELETE CASCADE;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.milton_sample_guard() RETURNS trigger LANGUAGE plpgsql
SET search_path TO 'pg_catalog', 'public' AS $function$
BEGIN
 IF TG_OP='DELETE' THEN
  IF EXISTS(SELECT 1 FROM users WHERE id=OLD.user_id) THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='sample_is_append_only'; END IF;
  RETURN OLD;
 END IF;
 IF TG_OP='UPDATE' THEN
  IF OLD.retired_at IS NOT NULL OR (NEW.user_id,NEW.id,NEW.report,NEW.body,NEW.client_json,NEW.replaces_id,NEW.created_at)
    IS DISTINCT FROM (OLD.user_id,OLD.id,OLD.report,OLD.body,OLD.client_json,OLD.replaces_id,OLD.created_at) THEN
    RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='sample_is_append_only';
  END IF;
  PERFORM 1 FROM users WHERE id=OLD.user_id AND status='active' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='account_unavailable'; END IF;
  IF NEW.retired_at IS NOT NULL THEN
   IF NEW.retire_reason IS NULL OR (NEW.context,NEW.kind_id,NEW.context_revision) IS DISTINCT FROM (OLD.context,OLD.kind_id,OLD.context_revision) THEN
    RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='sample_is_append_only';
   END IF;
  ELSIF NEW.retire_reason IS DISTINCT FROM OLD.retire_reason OR NEW.retired_request_id IS DISTINCT FROM OLD.retired_request_id
    OR (NEW.context,NEW.kind_id) IS NOT DISTINCT FROM (OLD.context,OLD.kind_id)
    OR NEW.context_revision<>OLD.context_revision+1 THEN
    RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='sample_is_append_only';
  END IF;
  RETURN NEW;
 END IF;
 PERFORM 1 FROM users WHERE id=NEW.user_id AND status='active' FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='account_unavailable'; END IF;
 IF NEW.context_revision<>1 THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='sample_context_revision'; END IF;
 IF NEW.replaces_id IS NOT NULL AND NOT EXISTS (
   SELECT 1 FROM samples WHERE user_id=NEW.user_id AND id=NEW.replaces_id
     AND report=NEW.report AND kind_id=NEW.kind_id
 ) THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='sample_replacement_kind'; END IF;
 RETURN NEW;
END $function$;
--> statement-breakpoint
ALTER TABLE samples ENABLE TRIGGER samples_guard;
