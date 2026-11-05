-- OFFLINE OWNER-ONLY rollback. Stop all app/MCP processes; snapshot first.
-- Refuses revised/unrepresentable context and reclassified replacement lineage.
BEGIN;
LOCK TABLE samples IN ACCESS EXCLUSIVE MODE;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM samples WHERE context_revision<>1
  OR context - ARRAY['version','summary','audience','purposes','register'] <> '{}'::jsonb
  OR (context ? 'audience' AND ((context->'audience') - 'relationship' <> '{}'::jsonb OR context#>>'{audience,relationship}' NOT IN ('client','boss','colleague','friend','public','other')))
  OR (context ? 'purposes' AND (jsonb_array_length(context->'purposes')<>1 OR context#>>'{purposes,0}' NOT IN ('decline','ask','thank','update','announce','apologize','introduce','follow up','other')))
  OR (context ? 'register' AND context->>'register' NOT IN ('formal','plain','casual')))
  OR EXISTS(SELECT 1 FROM samples s JOIN samples previous
    ON previous.user_id=s.user_id AND previous.id=s.replaces_id
    WHERE s.kind_id<>previous.kind_id)
 THEN RAISE EXCEPTION 'sample_context_rollback_would_lose_metadata'; END IF;
END $$;
ALTER TABLE samples DISABLE TRIGGER samples_guard;
ALTER TABLE samples DROP COLUMN search, DROP CONSTRAINT samples_context, DROP CONSTRAINT samples_context_revision;
ALTER TABLE samples ADD COLUMN audience text, ADD COLUMN purpose text, ADD COLUMN register text;
UPDATE samples SET audience=context#>>'{audience,relationship}',purpose=context#>>'{purposes,0}',register=context->>'register';
ALTER TABLE samples ALTER COLUMN context TYPE text USING context->>'summary';
ALTER TABLE samples DROP COLUMN context_revision;
ALTER TABLE samples ADD CONSTRAINT samples_context CHECK (char_length(context) BETWEEN 1 AND 200 AND position(chr(10) in context)=0 AND position(chr(13) in context)=0 AND btrim(context)=context),
 ADD CONSTRAINT samples_labels CHECK ((audience IS NULL OR audience IN ('client','boss','colleague','friend','public','other')) AND (purpose IS NULL OR purpose IN ('decline','ask','thank','update','announce','apologize','introduce','follow up','other')) AND (register IS NULL OR register IN ('formal','plain','casual'))),
 ADD COLUMN search tsvector GENERATED ALWAYS AS (to_tsvector('english'::regconfig,context || ' ' || body)) STORED;
ALTER TABLE samples DROP CONSTRAINT samples_replaces_fk;
ALTER TABLE samples ADD CONSTRAINT samples_kind_key UNIQUE(user_id,id,kind_id);
ALTER TABLE samples ADD CONSTRAINT samples_replaces_fk FOREIGN KEY(user_id,replaces_id,kind_id) REFERENCES samples(user_id,id,kind_id) ON DELETE CASCADE;
CREATE OR REPLACE FUNCTION public.milton_sample_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public'
AS $function$
BEGIN
  IF TG_OP='DELETE' THEN
    IF EXISTS (SELECT 1 FROM users WHERE id=OLD.user_id) THEN
      RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='sample_is_append_only';
    END IF;
    RETURN OLD;
  END IF;
  IF TG_OP='UPDATE' THEN
    IF OLD.retired_at IS NOT NULL OR NEW.retired_at IS NULL OR NEW.retire_reason IS NULL
      OR (NEW.user_id,NEW.id,NEW.report,NEW.kind_id,NEW.context,NEW.body,NEW.client_json,NEW.replaces_id,NEW.created_at,NEW.audience,NEW.purpose,NEW.register)
        IS DISTINCT FROM (OLD.user_id,OLD.id,OLD.report,OLD.kind_id,OLD.context,OLD.body,OLD.client_json,OLD.replaces_id,OLD.created_at,OLD.audience,OLD.purpose,OLD.register) THEN
      RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='sample_is_append_only';
    END IF;
    RETURN NEW;
  END IF;
  PERFORM 1 FROM users WHERE id=NEW.user_id AND status='active' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='account_unavailable'; END IF;
  RETURN NEW;
END $function$;

ALTER TABLE samples ENABLE TRIGGER samples_guard;
DROP FUNCTION public.milton_sample_context_valid(jsonb);
DELETE FROM drizzle.__drizzle_migrations WHERE created_at=1793901943500;
COMMIT;
