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
--> statement-breakpoint
CREATE TABLE "retrieval_enrollments" (
	"user_id" text PRIMARY KEY NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"backfill" boolean DEFAULT false NOT NULL,
	"baseline" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "retrieval_baseline" CHECK (jsonb_typeof("retrieval_enrollments"."baseline")='array' AND jsonb_array_length("retrieval_enrollments"."baseline")<=100)
);
--> statement-breakpoint
ALTER TABLE "store_config" ADD COLUMN "derivation_account_budget_micros" integer;--> statement-breakpoint
ALTER TABLE "store_config" ADD COLUMN "derivation_global_budget_micros" integer;--> statement-breakpoint
ALTER TABLE "store_config" ADD COLUMN "derivation_budget_revision" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "store_config" ADD COLUMN "derivation_cursor" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "card_retrieval_embeddings" ADD CONSTRAINT "card_retrieval_embeddings_user_id_card_id_version_instruction_card_versions_user_id_card_id_version_fk" FOREIGN KEY ("user_id","card_id","version") REFERENCES "public"."instruction_card_versions"("user_id","card_id","version") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "card_retrieval_embeddings" ADD CONSTRAINT "card_retrieval_embeddings_user_id_retrieval_enrollments_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."retrieval_enrollments"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retrieval_enrollments" ADD CONSTRAINT "retrieval_enrollments_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_config" ADD CONSTRAINT "config_derivation_budget" CHECK (("store_config"."derivation_account_budget_micros" IS NULL AND "store_config"."derivation_global_budget_micros" IS NULL AND "store_config"."derivation_budget_revision"=0) OR ("store_config"."derivation_account_budget_micros">0 AND "store_config"."derivation_global_budget_micros">0 AND "store_config"."derivation_budget_revision">0 AND "store_config"."derivation_account_budget_micros" IS NOT NULL AND "store_config"."derivation_global_budget_micros" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "store_config" ADD CONSTRAINT "config_derivation_cursor" CHECK ("store_config"."derivation_cursor" BETWEEN 0 AND 2);