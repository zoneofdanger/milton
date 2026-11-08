-- Rollback of 0006. Drops usage_calls and every row in it (usage collected
-- since 0006; recoverable only from a snapshot), and restores the six writer
-- guards' FOR UPDATE account lock. Run only once no serving code
-- writes it, or accept that its appends fail (logged by code, responses
-- unchanged). Run as neondb_owner: psql -X -v ON_ERROR_STOP=1 -f this file.
-- The 0006 journal row stays, so re-forwarding means running
-- 0006_usage_calls.sql by hand, as one transaction:
-- psql -1 -X -v ON_ERROR_STOP=1 -f server/drizzle/0006_usage_calls.sql
-- and then migrations/009-usage-calls-roles.sql.
BEGIN;
DROP TABLE "usage_calls";
-- The six writer guards as 0000 and 0002 left them: FOR UPDATE.
CREATE OR REPLACE FUNCTION public.milton_accepted_change_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE item jsonb; ids text[] := ARRAY[]::text[];
BEGIN
 IF TG_OP='DELETE' THEN
  IF EXISTS(SELECT 1 FROM users WHERE id=OLD.user_id) THEN RAISE EXCEPTION 'accepted_change_is_immutable'; END IF;
  RETURN OLD;
 END IF;
 IF TG_OP='UPDATE' THEN RAISE EXCEPTION 'accepted_change_is_immutable'; END IF;
 PERFORM 1 FROM users WHERE id=NEW.user_id AND status='active' FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='account_unavailable'; END IF;
 FOR item IN SELECT value FROM jsonb_array_elements(NEW.affected_json) LOOP
  IF item->>'id'=ANY(ids) OR NOT EXISTS(SELECT 1 FROM instruction_card_versions WHERE user_id=NEW.user_id AND card_id=item->>'id' AND version=(item->>'after')::int)
    OR (item->>'before' IS NOT NULL AND (NOT EXISTS(SELECT 1 FROM instruction_card_versions WHERE user_id=NEW.user_id AND card_id=item->>'id' AND version=(item->>'before')::int) OR (item->>'before')::int >= (item->>'after')::int)) THEN
   RAISE EXCEPTION 'accepted_change_reference_invalid';
  END IF;
  ids := array_append(ids,item->>'id');
 END LOOP;
 RETURN NEW;
END $function$;
CREATE OR REPLACE FUNCTION public.milton_card_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public'
AS $function$
BEGIN
  IF TG_OP='UPDATE' THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='card_identity_is_immutable'; END IF;
  PERFORM 1 FROM users WHERE id=NEW.user_id AND status='active' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='account_unavailable'; END IF;
  RETURN NEW;
END $function$;
CREATE OR REPLACE FUNCTION public.milton_card_version_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE head integer; lim jsonb;
BEGIN
  IF TG_OP='UPDATE' THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='card_version_is_immutable'; END IF;
  IF TG_OP='DELETE' THEN
    IF EXISTS (SELECT 1 FROM instruction_cards WHERE user_id=OLD.user_id AND id=OLD.card_id) THEN
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
  RETURN NEW;
END $function$;
CREATE OR REPLACE FUNCTION public.milton_sample_kind_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public'
AS $function$
BEGIN
  IF TG_OP='DELETE' THEN
    IF EXISTS (SELECT 1 FROM users WHERE id=OLD.user_id) THEN
      RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='sample_kind_is_immutable';
    END IF;
    RETURN OLD;
  END IF;
  IF TG_OP='UPDATE' THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='sample_kind_is_immutable'; END IF;
  PERFORM 1 FROM users WHERE id=NEW.user_id AND status='active' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='account_unavailable'; END IF;
  RETURN NEW;
END $function$;
CREATE OR REPLACE FUNCTION public.milton_sample_guard() RETURNS trigger LANGUAGE plpgsql
SET search_path TO 'pg_catalog', 'public' AS $$
BEGIN
 IF TG_OP='DELETE' THEN
  IF EXISTS(SELECT 1 FROM users WHERE id=OLD.user_id) THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='sample_identity_is_immutable'; END IF;
  RETURN OLD;
 END IF;
 IF TG_OP='UPDATE' THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='sample_identity_is_immutable'; END IF;
 PERFORM 1 FROM users WHERE id=NEW.user_id AND status='active' FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='account_unavailable'; END IF;
 RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION public.milton_sample_version_guard() RETURNS trigger LANGUAGE plpgsql
SET search_path TO 'pg_catalog', 'public' AS $$
DECLARE head sample_versions%ROWTYPE;
BEGIN
 IF TG_OP='DELETE' THEN
  IF EXISTS(SELECT 1 FROM users WHERE id=OLD.user_id) THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='sample_version_is_immutable'; END IF;
  RETURN OLD;
 END IF;
 IF TG_OP='UPDATE' THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='sample_version_is_immutable'; END IF;
 PERFORM 1 FROM users WHERE id=NEW.user_id AND status='active' FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='account_unavailable'; END IF;
 SELECT * INTO head FROM sample_versions WHERE user_id=NEW.user_id AND sample_id=NEW.sample_id ORDER BY version DESC LIMIT 1;
 IF NEW.version<>coalesce(head.version,0)+1 OR coalesce(head.retired,false)
   OR (head.version IS NULL AND NEW.retired) THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='sample_version_conflict'; END IF;
 IF NEW.retired AND (NEW.body,NEW.context,NEW.kind_id,NEW.report) IS DISTINCT FROM (head.body,head.context,head.kind_id,head.report)
   THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='sample_version_conflict'; END IF;
 IF NEW.request_id IS NULL OR NEW.request_id !~* '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'
   OR NEW.provenance<>'{}'::jsonb THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='sample_version_conflict'; END IF;
 RETURN NEW;
END $$;
COMMIT;
