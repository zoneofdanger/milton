-- Rollback of 0018_remove_derived. RESTORES SHAPE, NOT DATA.
-- Recreates, empty: the vector extension; gardening_jobs, card_embeddings,
-- card_graphs, card_links, retrieval_enrollments and card_retrieval_embeddings
-- with their columns, checks, indexes and foreign keys; the guard functions
-- milton_gardening_guard and milton_card_link_guard with their triggers; and the
-- four store_config derivation columns with their checks. The restored defaults
-- (NULL budgets, revision 0, cursor 0) satisfy the restored checks, which is the
-- "derived budget off" state. Deleted jobs, embeddings, the graph, links and
-- enrollments are recoverable only from the pre-0018 Neon snapshot; caches
-- rebuild only if their runtime flags are re-enabled. Definitions are copied from
-- 0007, 0009, 0011 (card_graphs progress, link guard), 0013 and 0014
-- (config_derivation_budget). CREATE EXTENSION IF NOT EXISTS is idempotent, so a
-- database where the extension survived still rolls back; every table, column,
-- constraint, function and trigger CREATE fails if the object already exists, so
-- a partial or repeated run rolls back as a whole.
BEGIN;
SET LOCAL lock_timeout = '10s';
LOCK TABLE users, save_requests, instruction_card_versions IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE store_config IN ACCESS EXCLUSIVE MODE;
CREATE EXTENSION IF NOT EXISTS vector;
ALTER TABLE "store_config" ADD COLUMN "derivation_account_budget_micros" integer;
ALTER TABLE "store_config" ADD COLUMN "derivation_global_budget_micros" integer;
ALTER TABLE "store_config" ADD COLUMN "derivation_budget_revision" integer DEFAULT 0 NOT NULL;
ALTER TABLE "store_config" ADD COLUMN "derivation_cursor" integer DEFAULT 0 NOT NULL;
ALTER TABLE "store_config" ADD CONSTRAINT "config_derivation_budget" CHECK (("store_config"."derivation_account_budget_micros" IS NULL AND "store_config"."derivation_global_budget_micros" IS NULL AND "store_config"."derivation_budget_revision"=0) OR ("store_config"."derivation_account_budget_micros" IS NOT NULL AND "store_config"."derivation_account_budget_micros">0 AND "store_config"."derivation_budget_revision">0 AND (("store_config"."global_spend_policy"='alerts_only' AND ("store_config"."derivation_global_budget_micros" IS NULL OR "store_config"."derivation_global_budget_micros">0)) OR ("store_config"."global_spend_policy"='capped' AND "store_config"."derivation_global_budget_micros" IS NOT NULL AND "store_config"."derivation_global_budget_micros">0))));
ALTER TABLE "store_config" ADD CONSTRAINT "config_derivation_cursor" CHECK ("store_config"."derivation_cursor" BETWEEN 0 AND 2);
CREATE TABLE "gardening_jobs" (
	"user_id" text NOT NULL,
	"request_id" text NOT NULL,
	"payload_json" jsonb NOT NULL,
	"report_revision" integer NOT NULL,
	"source_hash" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"available_at" timestamp with time zone DEFAULT clock_timestamp() + interval '30 seconds' NOT NULL,
	"attempt_id" text,
	"attempted_at" timestamp with time zone,
	"lease_until" timestamp with time zone,
	"reserved_micros" integer DEFAULT 0 NOT NULL,
	"result_json" jsonb,
	"error" text,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"payload_bytes" bigint GENERATED ALWAYS AS (octet_length(payload_json::text)::bigint + 32768 + 1024) STORED NOT NULL,
	CONSTRAINT "gardening_jobs_user_id_request_id_pk" PRIMARY KEY("user_id","request_id"),
	CONSTRAINT "gardening_state" CHECK ("gardening_jobs"."status" IN ('pending','running','observed','superseded','failed')),
	CONSTRAINT "gardening_source" CHECK ("gardening_jobs"."report_revision" > 0 AND "gardening_jobs"."source_hash" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "gardening_payload" CHECK (jsonb_typeof("gardening_jobs"."payload_json") = 'object' AND octet_length("gardening_jobs"."payload_json"::text) <= 131072),
	CONSTRAINT "gardening_result" CHECK ("gardening_jobs"."result_json" IS NULL OR (jsonb_typeof("gardening_jobs"."result_json") = 'object' AND octet_length("gardening_jobs"."result_json"::text) <= 32768)),
	CONSTRAINT "gardening_error" CHECK ("gardening_jobs"."error" IS NULL OR "gardening_jobs"."error" ~ '^[a-z_]{1,64}$'),
	CONSTRAINT "gardening_cost" CHECK ("gardening_jobs"."reserved_micros" >= 0),
	CONSTRAINT "gardening_attempt" CHECK (("gardening_jobs"."attempt_id" IS NULL AND "gardening_jobs"."attempted_at" IS NULL AND "gardening_jobs"."lease_until" IS NULL AND "gardening_jobs"."reserved_micros"=0) OR ("gardening_jobs"."attempt_id" IS NOT NULL AND length("gardening_jobs"."attempt_id")=36 AND "gardening_jobs"."attempted_at" IS NOT NULL AND "gardening_jobs"."lease_until" IS NOT NULL AND "gardening_jobs"."reserved_micros">0))
);
ALTER TABLE "gardening_jobs" ADD CONSTRAINT "gardening_request" FOREIGN KEY ("user_id","request_id") REFERENCES "public"."save_requests"("user_id","request_id") ON DELETE cascade ON UPDATE no action;
CREATE INDEX "gardening_due" ON "gardening_jobs" USING btree ("status","available_at");
CREATE INDEX "gardening_spend" ON "gardening_jobs" USING btree ("attempted_at","user_id");
CREATE INDEX "gardening_retention" ON "gardening_jobs" USING btree ("created_at");
CREATE FUNCTION milton_gardening_guard() RETURNS trigger LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog, public AS $$
DECLARE retained bigint; ceiling bigint;
BEGIN
  IF TG_OP='DELETE' THEN
    UPDATE users SET retained_bytes=retained_bytes-OLD.payload_bytes WHERE id=OLD.user_id;
    RETURN OLD;
  END IF;
  IF TG_OP='UPDATE' THEN
    IF (NEW.user_id,NEW.request_id,NEW.payload_json,NEW.report_revision,NEW.source_hash,NEW.created_at,NEW.available_at)
      IS DISTINCT FROM (OLD.user_id,OLD.request_id,OLD.payload_json,OLD.report_revision,OLD.source_hash,OLD.created_at,OLD.available_at)
      OR OLD.status NOT IN ('pending','running')
      OR (OLD.status='pending' AND NEW.status NOT IN ('running','failed'))
      OR (OLD.status='running' AND (NEW.status NOT IN ('observed','superseded','failed') OR
        (NEW.attempt_id,NEW.attempted_at,NEW.lease_until,NEW.reserved_micros) IS DISTINCT FROM
        (OLD.attempt_id,OLD.attempted_at,OLD.lease_until,OLD.reserved_micros))) THEN
      RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='gardening_job_is_immutable';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.status <> 'pending' OR NEW.attempt_id IS NOT NULL OR NEW.result_json IS NOT NULL OR NEW.error IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='gardening_job_invalid';
  END IF;
  UPDATE users SET retained_bytes=retained_bytes+NEW.payload_bytes
    WHERE id=NEW.user_id AND status='active' RETURNING retained_bytes INTO retained;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='account_unavailable'; END IF;
  SELECT (limits_json->>'history_bytes')::bigint INTO ceiling FROM store_config WHERE singleton=1;
  IF retained > coalesce(ceiling,0) THEN RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='memo_history_limit'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER gardening_guard AFTER INSERT OR UPDATE OR DELETE ON gardening_jobs FOR EACH ROW EXECUTE FUNCTION milton_gardening_guard();
CREATE TABLE "card_embeddings" (
	"user_id" text NOT NULL,
	"card_id" text NOT NULL,
	"version" integer NOT NULL,
	"model" text NOT NULL,
	"body_hash" text NOT NULL,
	"embedding" vector(768),
	"status" text NOT NULL,
	"attempt_id" text NOT NULL,
	"attempted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_until" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone,
	"error" text,
	CONSTRAINT "card_embeddings_user_id_card_id_pk" PRIMARY KEY("user_id","card_id"),
	CONSTRAINT "card_embedding_status" CHECK ("card_embeddings"."status" IN ('running','ready','failed','superseded')),
	CONSTRAINT "card_embedding_hash" CHECK ("card_embeddings"."body_hash" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "card_embedding_result" CHECK (("card_embeddings"."status"='ready') = ("card_embeddings"."embedding" IS NOT NULL) AND ("card_embeddings"."embedding" IS NULL OR vector_norm("card_embeddings"."embedding") > 0)),
	CONSTRAINT "card_embedding_model" CHECK (octet_length("card_embeddings"."model") BETWEEN 1 AND 128),
	CONSTRAINT "card_embedding_error" CHECK ("card_embeddings"."error" IS NULL OR "card_embeddings"."error" ~ '^[a-z_]{1,64}$')
);
CREATE TABLE "card_graphs" (
	"user_id" text PRIMARY KEY NOT NULL,
	"source_hash" text NOT NULL,
	"model" text NOT NULL,
	"status" text NOT NULL,
	"attempt_id" text NOT NULL,
	"attempted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_until" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone,
	"error" text,
	CONSTRAINT "card_graph_status" CHECK ("card_graphs"."status" IN ('running','ready','failed','superseded')),
	CONSTRAINT "card_graph_hash" CHECK ("card_graphs"."source_hash" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "card_graph_model" CHECK (octet_length("card_graphs"."model") BETWEEN 1 AND 128),
	CONSTRAINT "card_graph_error" CHECK ("card_graphs"."error" IS NULL OR "card_graphs"."error" ~ '^[a-z_]{1,64}$')
);
CREATE TABLE "card_links" (
	"user_id" text NOT NULL,
	"from_id" text NOT NULL,
	"from_version" integer NOT NULL,
	"to_id" text NOT NULL,
	"to_version" integer NOT NULL,
	"source_hash" text NOT NULL,
	"kind" text NOT NULL,
	"from_quote" text NOT NULL,
	"to_quote" text NOT NULL,
	"reason" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "card_links_user_id_from_id_to_id_pk" PRIMARY KEY("user_id","from_id","to_id"),
	CONSTRAINT "card_link_identity" CHECK ("card_links"."from_id" <> "card_links"."to_id"),
	CONSTRAINT "card_link_kind" CHECK ("card_links"."kind" IN ('possible_overlap','possible_conflict','possible_exception','unknown')),
	CONSTRAINT "card_link_hash" CHECK ("card_links"."source_hash" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "card_link_evidence" CHECK (octet_length("card_links"."from_quote") BETWEEN 1 AND 1500 AND octet_length("card_links"."to_quote") BETWEEN 1 AND 1500 AND octet_length("card_links"."reason") BETWEEN 1 AND 1500)
);
ALTER TABLE "card_graphs" ADD COLUMN "pair_plan" jsonb DEFAULT '[]'::jsonb NOT NULL;
ALTER TABLE "card_graphs" ADD COLUMN "next_pair" integer DEFAULT 0 NOT NULL;
ALTER TABLE "card_graphs" ADD COLUMN "reviewed_pairs" integer DEFAULT 0 NOT NULL;
ALTER TABLE "card_graphs" ADD COLUMN "failed_pairs" integer DEFAULT 0 NOT NULL;
ALTER TABLE "card_graphs" ADD COLUMN "batch_log" jsonb DEFAULT '[]'::jsonb NOT NULL;
ALTER TABLE "card_graphs" ADD CONSTRAINT "card_graph_progress" CHECK (jsonb_typeof("card_graphs"."pair_plan")='array' AND jsonb_array_length("card_graphs"."pair_plan")<=128 AND "card_graphs"."next_pair">=0 AND "card_graphs"."next_pair"<=jsonb_array_length("card_graphs"."pair_plan") AND "card_graphs"."reviewed_pairs">=0 AND "card_graphs"."failed_pairs">=0 AND "card_graphs"."reviewed_pairs"+"card_graphs"."failed_pairs"="card_graphs"."next_pair" AND jsonb_typeof("card_graphs"."batch_log")='array' AND jsonb_array_length("card_graphs"."batch_log")<=32);
ALTER TABLE "card_embeddings" ADD CONSTRAINT "card_embeddings_user_id_card_id_version_instruction_card_versions_user_id_card_id_version_fk" FOREIGN KEY ("user_id","card_id","version") REFERENCES "public"."instruction_card_versions"("user_id","card_id","version") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "card_graphs" ADD CONSTRAINT "card_graphs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "card_links" ADD CONSTRAINT "card_links_user_id_card_graphs_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."card_graphs"("user_id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "card_links" ADD CONSTRAINT "card_links_user_id_from_id_from_version_instruction_card_versions_user_id_card_id_version_fk" FOREIGN KEY ("user_id","from_id","from_version") REFERENCES "public"."instruction_card_versions"("user_id","card_id","version") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "card_links" ADD CONSTRAINT "card_links_user_id_to_id_to_version_instruction_card_versions_user_id_card_id_version_fk" FOREIGN KEY ("user_id","to_id","to_version") REFERENCES "public"."instruction_card_versions"("user_id","card_id","version") ON DELETE cascade ON UPDATE no action;
CREATE FUNCTION milton_card_link_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
  PERFORM 1 FROM users WHERE id=NEW.user_id AND status='active' FOR UPDATE;
  IF NOT FOUND OR TG_OP='UPDATE' THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='card_link_invalid'; END IF;
  IF (SELECT count(*) FROM card_links WHERE user_id=NEW.user_id)>=128
    OR EXISTS(SELECT 1 FROM card_links WHERE user_id=NEW.user_id AND from_id=NEW.to_id AND to_id=NEW.from_id)
    OR NOT EXISTS(SELECT 1 FROM card_graphs g JOIN tps_reports r USING(user_id)
      WHERE g.user_id=NEW.user_id AND g.status='ready' AND g.source_hash=NEW.source_hash AND r.source_hash=g.source_hash)
    OR NOT EXISTS(SELECT 1 FROM instruction_card_versions v WHERE v.user_id=NEW.user_id AND v.card_id=NEW.from_id AND v.version=NEW.from_version AND NOT v.archived
      AND position(NEW.from_quote IN v.body)>0 AND NOT EXISTS(SELECT 1 FROM instruction_card_versions n WHERE n.user_id=v.user_id AND n.card_id=v.card_id AND n.version>v.version))
    OR NOT EXISTS(SELECT 1 FROM instruction_card_versions v WHERE v.user_id=NEW.user_id AND v.card_id=NEW.to_id AND v.version=NEW.to_version AND NOT v.archived
      AND position(NEW.to_quote IN v.body)>0 AND NOT EXISTS(SELECT 1 FROM instruction_card_versions n WHERE n.user_id=v.user_id AND n.card_id=v.card_id AND n.version>v.version))
  THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='card_link_invalid'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER card_link_guard BEFORE INSERT OR UPDATE ON card_links FOR EACH ROW EXECUTE FUNCTION milton_card_link_guard();
CREATE TABLE "card_retrieval_embeddings" (
	"user_id" text NOT NULL,
	"card_id" text NOT NULL,
	"version" integer NOT NULL,
	"model" text NOT NULL,
	"body_hash" text NOT NULL,
	"embedding" vector(768),
	"status" text NOT NULL,
	"attempt_id" text NOT NULL,
	"attempted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_until" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone,
	"error" text,
	CONSTRAINT "card_retrieval_embeddings_user_id_card_id_pk" PRIMARY KEY("user_id","card_id"),
	CONSTRAINT "retrieval_embedding_status" CHECK ("card_retrieval_embeddings"."status" IN ('running','ready','failed','superseded')),
	CONSTRAINT "retrieval_embedding_hash" CHECK ("card_retrieval_embeddings"."body_hash" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "retrieval_embedding_result" CHECK (("card_retrieval_embeddings"."status"='ready') = ("card_retrieval_embeddings"."embedding" IS NOT NULL) AND ("card_retrieval_embeddings"."embedding" IS NULL OR vector_norm("card_retrieval_embeddings"."embedding") > 0)),
	CONSTRAINT "retrieval_embedding_model" CHECK (octet_length("card_retrieval_embeddings"."model") BETWEEN 1 AND 128),
	CONSTRAINT "retrieval_embedding_error" CHECK ("card_retrieval_embeddings"."error" IS NULL OR "card_retrieval_embeddings"."error" ~ '^[a-z_]{1,64}$')
);
CREATE TABLE "retrieval_enrollments" (
	"user_id" text PRIMARY KEY NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"backfill" boolean DEFAULT false NOT NULL,
	"baseline" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "retrieval_baseline" CHECK (jsonb_typeof("retrieval_enrollments"."baseline")='array' AND jsonb_array_length("retrieval_enrollments"."baseline")<=100)
);
ALTER TABLE "card_retrieval_embeddings" ADD CONSTRAINT "card_retrieval_embeddings_user_id_card_id_version_instruction_card_versions_user_id_card_id_version_fk" FOREIGN KEY ("user_id","card_id","version") REFERENCES "public"."instruction_card_versions"("user_id","card_id","version") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "card_retrieval_embeddings" ADD CONSTRAINT "card_retrieval_embeddings_user_id_retrieval_enrollments_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."retrieval_enrollments"("user_id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "retrieval_enrollments" ADD CONSTRAINT "retrieval_enrollments_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
COMMIT;
