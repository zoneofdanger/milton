-- Fresh installs only. Existing 0033 installations use the owner-only one-time
-- transition in server/scripts/transition-baseline.sql before normal migrations.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM drizzle.__drizzle_migrations)
    OR EXISTS (SELECT 1 FROM pg_class WHERE relnamespace='public'::regnamespace AND relkind IN ('r','p','S','v','m','f')) THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='baseline_requires_empty_database',
      HINT='For the known 0033 database, run server/scripts/transition-baseline.sql as the owner; see server/deploy/README.md "Legacy schema cleanup".';
  END IF;
END $$;

--> statement-breakpoint
CREATE SEQUENCE instruction_card_position AS bigint;
--> statement-breakpoint
CREATE TABLE "accepted_changes" (
	"user_id" text NOT NULL,
	"request_id" text NOT NULL,
	"operation" text NOT NULL,
	"request_json" jsonb NOT NULL,
	"actor_json" jsonb NOT NULL,
	"transformation_json" jsonb NOT NULL,
	"affected_json" jsonb NOT NULL,
	"before_tps" text NOT NULL,
	"after_tps" text NOT NULL,
	"before_source" text NOT NULL,
	"after_source" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"payload_bytes" bigint GENERATED ALWAYS AS (octet_length(request_id)::bigint + octet_length(operation) + octet_length(request_json::text) + octet_length(actor_json::text) + octet_length(transformation_json::text) + octet_length(affected_json::text) + octet_length(before_tps) + octet_length(after_tps) + octet_length(before_source) + octet_length(after_source) + 128) STORED NOT NULL,
	CONSTRAINT "accepted_changes_user_id_request_id_pk" PRIMARY KEY("user_id","request_id"),
	CONSTRAINT "accepted_change_shape" CHECK (length("accepted_changes"."request_id")=36 AND "accepted_changes"."operation" IN ('save_memo','refinement_apply') AND jsonb_typeof("accepted_changes"."request_json")='object' AND jsonb_typeof("accepted_changes"."actor_json")='object' AND jsonb_typeof("accepted_changes"."transformation_json")='object' AND jsonb_typeof("accepted_changes"."affected_json")='array' AND jsonb_array_length("accepted_changes"."affected_json")<=1100),
	CONSTRAINT "accepted_change_hashes" CHECK ("accepted_changes"."before_tps" ~ '^[a-f0-9]{64}$' AND "accepted_changes"."after_tps" ~ '^[a-f0-9]{64}$' AND "accepted_changes"."before_source" ~ '^[a-f0-9]{64}$' AND "accepted_changes"."after_source" ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
CREATE TABLE "assistant_disconnects" (
	"provider" text NOT NULL,
	"subject" text NOT NULL,
	"client_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "assistant_disconnects_provider_subject_client_id_pk" PRIMARY KEY("provider","subject","client_id"),
	CONSTRAINT "assistant_disconnects_bounds" CHECK (char_length("assistant_disconnects"."provider") BETWEEN 1 AND 64 AND char_length("assistant_disconnects"."subject") BETWEEN 1 AND 512 AND char_length("assistant_disconnects"."client_id") BETWEEN 1 AND 2048)
);
--> statement-breakpoint
CREATE TABLE "deleted_identities" (
	"identity_hash" text PRIMARY KEY NOT NULL,
	"deleted_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "deleted_identities_hash" CHECK ("deleted_identities"."identity_hash" ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
CREATE TABLE "identities" (
	"provider" text NOT NULL,
	"subject" text NOT NULL,
	"user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "identities_provider_subject_pk" PRIMARY KEY("provider","subject"),
	CONSTRAINT "identities_subject" CHECK ("identities"."subject" <> '')
);
--> statement-breakpoint
CREATE TABLE "instruction_card_versions" (
	"user_id" text NOT NULL,
	"card_id" text NOT NULL,
	"version" integer NOT NULL,
	"description" text NOT NULL,
	"body" text NOT NULL,
	"archived" boolean DEFAULT false NOT NULL,
	"report" text NOT NULL,
	"reason" text NOT NULL,
	"actor_json" text NOT NULL,
	"details_json" text DEFAULT '{}' NOT NULL,
	"payload_bytes" bigint GENERATED ALWAYS AS (octet_length(description)::bigint + octet_length(body) + octet_length(reason) + octet_length(actor_json) + octet_length(details_json)) STORED NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "instruction_card_versions_pkey" PRIMARY KEY("user_id","card_id","version"),
	CONSTRAINT "instruction_card_versions_version_check" CHECK ("instruction_card_versions"."version" > 0),
	CONSTRAINT "instruction_card_versions_description_check" CHECK ("instruction_card_versions"."description" <> '' AND position(chr(10) in "instruction_card_versions"."description")=0 AND position(chr(13) in "instruction_card_versions"."description")=0),
	CONSTRAINT "instruction_card_versions_actor_json_check" CHECK (jsonb_typeof("instruction_card_versions"."actor_json"::jsonb)='object'),
	CONSTRAINT "instruction_card_versions_details_json_check" CHECK (jsonb_typeof("instruction_card_versions"."details_json"::jsonb)='object'),
	CONSTRAINT "instruction_card_versions_report" CHECK ("instruction_card_versions"."report" IN ('cover','email','chat','post','document','speech'))
);
--> statement-breakpoint
CREATE TABLE "instruction_cards" (
	"user_id" text NOT NULL,
	"id" text NOT NULL,
	"position" bigint DEFAULT nextval('instruction_card_position') NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "instruction_cards_pkey" PRIMARY KEY("user_id","id"),
	CONSTRAINT "instruction_cards_position" UNIQUE("user_id","position"),
	CONSTRAINT "card_id_nonempty" CHECK ("instruction_cards"."id" <> '')
);
--> statement-breakpoint
CREATE TABLE "sample_kinds" (
	"user_id" text NOT NULL,
	"id" text NOT NULL,
	"report" text NOT NULL,
	"label" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sample_kinds_user_id_id_pk" PRIMARY KEY("user_id","id"),
	CONSTRAINT "sample_kinds_report_key" UNIQUE("user_id","id","report"),
	CONSTRAINT "sample_kinds_report" CHECK ("sample_kinds"."report" IN ('email','chat','post','document','speech')),
	CONSTRAINT "sample_kinds_label_check" CHECK (char_length("sample_kinds"."label") BETWEEN 1 AND 60 AND position(chr(10) in "sample_kinds"."label")=0 AND position(chr(13) in "sample_kinds"."label")=0 AND btrim("sample_kinds"."label")="sample_kinds"."label")
);
--> statement-breakpoint
CREATE TABLE "samples" (
	"user_id" text NOT NULL,
	"id" text NOT NULL,
	"report" text NOT NULL,
	"kind_id" text NOT NULL,
	"context" text NOT NULL,
	"body" text NOT NULL,
	"client_json" text NOT NULL,
	"replaces_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"retired_at" timestamp with time zone,
	"retire_reason" text,
	"retired_request_id" text,
	"audience" text,
	"purpose" text,
	"register" text,
	"search" "tsvector" GENERATED ALWAYS AS (to_tsvector('english'::regconfig, context || ' ' || body)) STORED,
	CONSTRAINT "samples_user_id_id_pk" PRIMARY KEY("user_id","id"),
	CONSTRAINT "samples_kind_key" UNIQUE("user_id","id","kind_id"),
	CONSTRAINT "samples_report" CHECK ("samples"."report" IN ('email','chat','post','document','speech')),
	CONSTRAINT "samples_context" CHECK (char_length("samples"."context") BETWEEN 1 AND 200 AND position(chr(10) in "samples"."context")=0 AND position(chr(13) in "samples"."context")=0 AND btrim("samples"."context")="samples"."context"),
	CONSTRAINT "samples_body" CHECK (btrim("samples"."body") <> '' AND octet_length("samples"."body") <= 131072),
	CONSTRAINT "samples_client_object" CHECK (jsonb_typeof("samples"."client_json"::jsonb)='object'),
	CONSTRAINT "samples_retirement" CHECK (("samples"."retire_reason" IS NULL) = ("samples"."retired_at" IS NULL) AND ("samples"."retire_reason" IS NULL OR "samples"."retire_reason" IN ('replaced','removed','evicted')) AND ("samples"."retired_request_id" IS NULL OR "samples"."retired_at" IS NOT NULL)),
	CONSTRAINT "samples_labels" CHECK (("samples"."audience" IS NULL OR "samples"."audience" IN ('client','boss','colleague','friend','public','other')) AND ("samples"."purpose" IS NULL OR "samples"."purpose" IN ('decline','ask','thank','update','announce','apologize','introduce','follow up','other')) AND ("samples"."register" IS NULL OR "samples"."register" IN ('formal','plain','casual')))
);
--> statement-breakpoint
CREATE TABLE "save_requests" (
	"user_id" text NOT NULL,
	"request_id" text NOT NULL,
	"input_hash" text NOT NULL,
	"source_hash" text NOT NULL,
	"result_json" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"payload_bytes" bigint GENERATED ALWAYS AS (octet_length(request_id)::bigint + octet_length(input_hash) + octet_length(source_hash) + 2048 + 128) STORED NOT NULL,
	CONSTRAINT "save_requests_user_id_request_id_pk" PRIMARY KEY("user_id","request_id"),
	CONSTRAINT "save_request_hashes" CHECK ("save_requests"."input_hash" ~ '^[a-f0-9]{64}$' AND "save_requests"."source_hash" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "save_request_id" CHECK (length("save_requests"."request_id") = 36),
	CONSTRAINT "save_request_result" CHECK (jsonb_typeof("save_requests"."result_json") = 'object' AND octet_length("save_requests"."result_json"::text) <= 65536),
	CONSTRAINT "save_request_outcome" CHECK (("save_requests"."result_json"->>'status') IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "store_config" (
	"singleton" integer PRIMARY KEY NOT NULL,
	"trials_enabled" boolean DEFAULT false NOT NULL,
	"limits_json" jsonb DEFAULT '{"body_bytes":131072,"description_bytes":500,"reason_bytes":500,"report_body_bytes":262144,"daily_calls":10000}'::jsonb NOT NULL,
	CONSTRAINT "config_singleton" CHECK ("store_config"."singleton" = 1),
	CONSTRAINT "config_limits_object" CHECK (jsonb_typeof("store_config"."limits_json") = 'object')
);
--> statement-breakpoint
CREATE TABLE "stripe_events" (
	"id" text PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"payload_sha256" text NOT NULL,
	CONSTRAINT "stripe_event_shape" CHECK ("stripe_events"."id" ~ '^evt_[A-Za-z0-9]{1,251}$' AND char_length("stripe_events"."type") BETWEEN 1 AND 128 AND "stripe_events"."payload_sha256" ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
CREATE TABLE "trial_accounts" (
	"user_id" text PRIMARY KEY NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"paid_through" timestamp with time zone,
	"notice_stage" integer DEFAULT 0 NOT NULL,
	"stripe_customer_id" text,
	"stripe_subscription_id" text,
	"subscription_status" text,
	"trial_end" timestamp with time zone,
	"current_period_start" timestamp with time zone,
	"current_period_end" timestamp with time zone,
	CONSTRAINT "trial_accounts_stripe_customer_id_unique" UNIQUE("stripe_customer_id"),
	CONSTRAINT "trial_accounts_stripe_subscription_id_unique" UNIQUE("stripe_subscription_id"),
	CONSTRAINT "trial_notice_stage" CHECK ("trial_accounts"."notice_stage" BETWEEN 0 AND 2),
	CONSTRAINT "trial_stripe_customer" CHECK ("trial_accounts"."stripe_customer_id" IS NULL OR "trial_accounts"."stripe_customer_id" ~ '^cus_[A-Za-z0-9]{1,251}$'),
	CONSTRAINT "trial_stripe_subscription" CHECK ("trial_accounts"."stripe_subscription_id" IS NULL OR "trial_accounts"."stripe_subscription_id" ~ '^sub_[A-Za-z0-9]{1,251}$'),
	CONSTRAINT "trial_subscription_status" CHECK ("trial_accounts"."subscription_status" IS NULL OR char_length("trial_accounts"."subscription_status") BETWEEN 1 AND 64),
	CONSTRAINT "trial_stripe_dates" CHECK (("trial_accounts"."trial_end" IS NULL OR isfinite("trial_accounts"."trial_end")) AND ("trial_accounts"."current_period_start" IS NULL OR isfinite("trial_accounts"."current_period_start")) AND ("trial_accounts"."current_period_end" IS NULL OR isfinite("trial_accounts"."current_period_end"))),
	CONSTRAINT "trial_finite_dates" CHECK (("trial_accounts"."started_at" IS NULL OR isfinite("trial_accounts"."started_at")) AND ("trial_accounts"."paid_through" IS NULL OR isfinite("trial_accounts"."paid_through")))
);
--> statement-breakpoint
CREATE TABLE "usage_daily" (
	"user_id" text NOT NULL,
	"day_utc" date NOT NULL,
	"tool_calls" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "usage_daily_user_id_day_utc_pk" PRIMARY KEY("user_id","day_utc"),
	CONSTRAINT "usage_nonnegative" CHECK ("usage_daily"."tool_calls" >= 0)
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_status" CHECK ("users"."status" IN ('active','deleting')),
	CONSTRAINT "users_id_format" CHECK ("users"."id" <> '' AND position(':' in "users"."id") = 0)
);
--> statement-breakpoint
ALTER TABLE "accepted_changes" ADD CONSTRAINT "accepted_changes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identities" ADD CONSTRAINT "identities_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "instruction_card_versions" ADD CONSTRAINT "instruction_card_versions_user_id_card_id_fkey" FOREIGN KEY ("user_id","card_id") REFERENCES "public"."instruction_cards"("user_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "instruction_cards" ADD CONSTRAINT "instruction_cards_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sample_kinds" ADD CONSTRAINT "sample_kinds_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "samples" ADD CONSTRAINT "samples_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "samples" ADD CONSTRAINT "samples_kind_fk" FOREIGN KEY ("user_id","kind_id","report") REFERENCES "public"."sample_kinds"("user_id","id","report") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "samples" ADD CONSTRAINT "samples_replaces_fk" FOREIGN KEY ("user_id","replaces_id","kind_id") REFERENCES "public"."samples"("user_id","id","kind_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "save_requests" ADD CONSTRAINT "save_requests_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trial_accounts" ADD CONSTRAINT "trial_accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_daily" ADD CONSTRAINT "usage_daily_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "identities_by_user" ON "identities" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sample_kinds_label" ON "sample_kinds" USING btree ("user_id","report",lower("label"));--> statement-breakpoint
CREATE INDEX "samples_by_report" ON "samples" USING btree ("user_id","report");--> statement-breakpoint
CREATE INDEX "samples_by_kind" ON "samples" USING btree ("user_id","kind_id");
--> statement-breakpoint
ALTER SEQUENCE instruction_card_position OWNED BY instruction_cards.position;
--> statement-breakpoint
INSERT INTO store_config(singleton) VALUES (1);
--> statement-breakpoint
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
--> statement-breakpoint
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
--> statement-breakpoint
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
  PERFORM 1 FROM users WHERE id=NEW.user_id AND status='active' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='account_unavailable'; END IF;
  RETURN NEW;
END $function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.milton_save_request_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public'
AS $function$
BEGIN
  IF TG_OP='UPDATE' THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='save_receipt_is_immutable';
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  PERFORM 1 FROM users WHERE id=NEW.user_id AND status='active';
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='account_unavailable'; END IF;
  RETURN NEW;
END $function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.milton_user_id_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public'
AS $function$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id THEN RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'user_id_is_immutable'; END IF;
  RETURN NEW;
END $function$;
--> statement-breakpoint
CREATE TRIGGER accepted_changes_guard BEFORE INSERT OR DELETE OR UPDATE ON public.accepted_changes FOR EACH ROW EXECUTE FUNCTION milton_accepted_change_guard();
--> statement-breakpoint
CREATE TRIGGER instruction_card_versions_guard BEFORE INSERT OR DELETE OR UPDATE ON public.instruction_card_versions FOR EACH ROW EXECUTE FUNCTION milton_card_version_guard();
--> statement-breakpoint
CREATE TRIGGER instruction_cards_guard BEFORE INSERT OR UPDATE ON public.instruction_cards FOR EACH ROW EXECUTE FUNCTION milton_card_guard();
--> statement-breakpoint
CREATE TRIGGER sample_kinds_guard BEFORE INSERT OR DELETE OR UPDATE ON public.sample_kinds FOR EACH ROW EXECUTE FUNCTION milton_sample_kind_guard();
--> statement-breakpoint
CREATE TRIGGER samples_guard BEFORE INSERT OR DELETE OR UPDATE ON public.samples FOR EACH ROW EXECUTE FUNCTION milton_sample_guard();
--> statement-breakpoint
CREATE TRIGGER save_request_guard AFTER INSERT OR DELETE OR UPDATE ON public.save_requests FOR EACH ROW EXECUTE FUNCTION milton_save_request_guard();
--> statement-breakpoint
CREATE TRIGGER users_keep_id BEFORE UPDATE ON public.users FOR EACH ROW EXECUTE FUNCTION milton_user_id_guard();
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'milton_runtime') THEN
    CREATE ROLE milton_runtime NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  ELSIF EXISTS (
    SELECT 1 FROM pg_roles r
    WHERE r.rolname = 'milton_runtime'
      AND (r.rolcanlogin OR r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication OR r.rolbypassrls
        OR EXISTS (SELECT 1 FROM pg_auth_members m WHERE m.member = r.oid))
  ) THEN
    RAISE EXCEPTION 'milton_runtime_is_not_a_plain_group_role';
  END IF;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO milton_runtime', current_database());
END $$;
--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO milton_runtime;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE users TO milton_runtime;
--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON TABLE assistant_disconnects TO milton_runtime;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON TABLE save_requests, samples, trial_accounts, usage_daily TO milton_runtime;
--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE deleted_identities, identities, instruction_card_versions, instruction_cards, sample_kinds TO milton_runtime;
--> statement-breakpoint
GRANT INSERT ON TABLE accepted_changes TO milton_runtime;
--> statement-breakpoint
GRANT SELECT ON TABLE store_config TO milton_runtime;
--> statement-breakpoint
GRANT USAGE ON SEQUENCE instruction_card_position TO milton_runtime;
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE ON TABLES TO milton_runtime;
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE ON SEQUENCES TO milton_runtime;

--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON TABLE stripe_events TO milton_runtime;
