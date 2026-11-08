-- Usage after the daily allowance: one appended row per admitted tool call
-- (account, time, tool), written alongside the call's work. The foreign key
-- cascades from users, so account erasure removes the rows and an append for
-- an erased account fails its check instead of leaving one behind. Creates an
-- empty table only; safe while older app/MCP code serves (it never touches this
-- table). Apply before code that writes it; until then that code's appends fail,
-- are logged by code and change no response. Grants:
-- migrations/009-usage-calls-roles.sql. Rollback: rollback/0006_usage_calls.sql.
CREATE TABLE "usage_calls" (
	"user_id" text NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"tool" text NOT NULL,
	CONSTRAINT "usage_calls_tool" CHECK ("usage_calls"."tool" IN ('get_cover_sheet','get_report','list_reports','create_memo'))
);
--> statement-breakpoint
ALTER TABLE "usage_calls" ADD CONSTRAINT "usage_calls_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "usage_calls_by_user" ON "usage_calls" USING btree ("user_id","at");--> statement-breakpoint
-- Only the MCP runtime reaches it, through the owner-applied
-- migrations/009-usage-calls-roles.sql; the legacy writing group's default
-- grants never do.
REVOKE ALL ON usage_calls FROM milton_runtime;
--> statement-breakpoint
-- Every writer's account lock becomes FOR NO KEY UPDATE, so a usage row's
-- foreign-key check (KEY SHARE) never waits on a save. These guards lock the
-- account only to serialize writers and to refuse a closed account; none
-- changes users.id. Each definition is its current one (0000, or 0002 for the
-- two sample guards) with only that lock changed; CREATE OR REPLACE keeps
-- owner, privileges and SECURITY INVOKER. Rollback restores them.
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
 PERFORM 1 FROM users WHERE id=NEW.user_id AND status='active' FOR NO KEY UPDATE;
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
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.milton_card_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public'
AS $function$
BEGIN
  IF TG_OP='UPDATE' THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='card_identity_is_immutable'; END IF;
  PERFORM 1 FROM users WHERE id=NEW.user_id AND status='active' FOR NO KEY UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='account_unavailable'; END IF;
  RETURN NEW;
END $function$;
--> statement-breakpoint
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
  PERFORM 1 FROM users WHERE id=NEW.user_id AND status='active' FOR NO KEY UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='account_unavailable'; END IF;
  SELECT max(version) INTO head FROM instruction_card_versions WHERE user_id=NEW.user_id AND card_id=NEW.card_id;
  IF NEW.version <> coalesce(head,0)+1 THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='card_version_conflict'; END IF;
  SELECT limits_json INTO lim FROM store_config WHERE singleton=1;
  IF octet_length(NEW.body) > (lim->>'body_bytes')::int THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='memo_body_limit'; END IF;
  IF octet_length(NEW.description) > (lim->>'description_bytes')::int THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='memo_description_limit'; END IF;
  IF octet_length(NEW.reason) > (lim->>'reason_bytes')::int THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='memo_reason_limit'; END IF;
  RETURN NEW;
END $function$;
--> statement-breakpoint
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
  PERFORM 1 FROM users WHERE id=NEW.user_id AND status='active' FOR NO KEY UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='account_unavailable'; END IF;
  RETURN NEW;
END $function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.milton_sample_guard() RETURNS trigger LANGUAGE plpgsql
SET search_path TO 'pg_catalog', 'public' AS $$
BEGIN
 IF TG_OP='DELETE' THEN
  IF EXISTS(SELECT 1 FROM users WHERE id=OLD.user_id) THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='sample_identity_is_immutable'; END IF;
  RETURN OLD;
 END IF;
 IF TG_OP='UPDATE' THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='sample_identity_is_immutable'; END IF;
 PERFORM 1 FROM users WHERE id=NEW.user_id AND status='active' FOR NO KEY UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='account_unavailable'; END IF;
 RETURN NEW;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.milton_sample_version_guard() RETURNS trigger LANGUAGE plpgsql
SET search_path TO 'pg_catalog', 'public' AS $$
DECLARE head sample_versions%ROWTYPE;
BEGIN
 IF TG_OP='DELETE' THEN
  IF EXISTS(SELECT 1 FROM users WHERE id=OLD.user_id) THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='sample_version_is_immutable'; END IF;
  RETURN OLD;
 END IF;
 IF TG_OP='UPDATE' THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='sample_version_is_immutable'; END IF;
 PERFORM 1 FROM users WHERE id=NEW.user_id AND status='active' FOR NO KEY UPDATE;
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
