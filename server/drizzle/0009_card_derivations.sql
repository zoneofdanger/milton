-- Additive derived caches only. Sources, TPS and writer paths are untouched.
SET LOCAL lock_timeout = '10s';
--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS vector;
--> statement-breakpoint
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
--> statement-breakpoint
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
--> statement-breakpoint
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
--> statement-breakpoint
CREATE TABLE "derivation_usage" (
	"user_id" text NOT NULL,
	"day_utc" date NOT NULL,
	"reserved_micros" bigint NOT NULL,
	CONSTRAINT "derivation_usage_user_id_day_utc_pk" PRIMARY KEY("user_id","day_utc"),
	CONSTRAINT "derivation_usage_cost" CHECK ("derivation_usage"."reserved_micros" > 0)
);
--> statement-breakpoint
ALTER TABLE "card_embeddings" ADD CONSTRAINT "card_embeddings_user_id_card_id_version_instruction_card_versions_user_id_card_id_version_fk" FOREIGN KEY ("user_id","card_id","version") REFERENCES "public"."instruction_card_versions"("user_id","card_id","version") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "card_graphs" ADD CONSTRAINT "card_graphs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "card_links" ADD CONSTRAINT "card_links_user_id_card_graphs_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."card_graphs"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "card_links" ADD CONSTRAINT "card_links_user_id_from_id_from_version_instruction_card_versions_user_id_card_id_version_fk" FOREIGN KEY ("user_id","from_id","from_version") REFERENCES "public"."instruction_card_versions"("user_id","card_id","version") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "card_links" ADD CONSTRAINT "card_links_user_id_to_id_to_version_instruction_card_versions_user_id_card_id_version_fk" FOREIGN KEY ("user_id","to_id","to_version") REFERENCES "public"."instruction_card_versions"("user_id","card_id","version") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "derivation_usage_day" ON "derivation_usage" USING btree ("day_utc");
--> statement-breakpoint
-- Preserve prior daily reservations when re-forwarding the guarded inverse.
DO $$ BEGIN
  IF to_regclass('milton_rollback.derivation_usage') IS NOT NULL THEN
    INSERT INTO derivation_usage SELECT * FROM milton_rollback.derivation_usage
      ON CONFLICT(user_id,day_utc) DO UPDATE SET reserved_micros=greatest(derivation_usage.reserved_micros,excluded.reserved_micros);
  END IF;
END $$;
--> statement-breakpoint
CREATE FUNCTION milton_card_link_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
  PERFORM 1 FROM users WHERE id=NEW.user_id AND status='active' FOR UPDATE;
  IF NOT FOUND OR TG_OP='UPDATE' THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='card_link_invalid'; END IF;
  IF (SELECT count(*) FROM card_links WHERE user_id=NEW.user_id)>=8
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
--> statement-breakpoint
CREATE TRIGGER card_link_guard BEFORE INSERT OR UPDATE ON card_links FOR EACH ROW EXECUTE FUNCTION milton_card_link_guard();
