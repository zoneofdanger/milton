CREATE TABLE "identities" (
	"provider" text NOT NULL,
	"subject" text NOT NULL,
	"user_id" text NOT NULL,
	"profile_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "identities_provider_subject_pk" PRIMARY KEY("provider","subject"),
	CONSTRAINT "identities_subject" CHECK ("identities"."subject" <> ''),
	CONSTRAINT "identities_profile_object" CHECK (jsonb_typeof("identities"."profile_json") = 'object')
);
--> statement-breakpoint
CREATE TABLE "recipe_versions" (
	"user_id" text NOT NULL,
	"recipe_id" text NOT NULL,
	"version" integer NOT NULL,
	"description" text NOT NULL,
	"body" text NOT NULL,
	"archived" boolean DEFAULT false NOT NULL,
	"reason" text NOT NULL,
	"actor_json" text NOT NULL,
	"details_json" text DEFAULT '{}' NOT NULL,
	"payload_bytes" bigint GENERATED ALWAYS AS (octet_length(description)::bigint + octet_length(body) + octet_length(reason) + octet_length(actor_json) + octet_length(details_json)) STORED NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "recipe_versions_user_id_recipe_id_version_pk" PRIMARY KEY("user_id","recipe_id","version"),
	CONSTRAINT "versions_positive" CHECK ("recipe_versions"."version" >= 1),
	CONSTRAINT "versions_description" CHECK ("recipe_versions"."description" <> '' AND position(chr(10) in "recipe_versions"."description") = 0 AND position(chr(13) in "recipe_versions"."description") = 0),
	CONSTRAINT "versions_actor_object" CHECK (jsonb_typeof("recipe_versions"."actor_json"::jsonb) = 'object'),
	CONSTRAINT "versions_details_object" CHECK (jsonb_typeof("recipe_versions"."details_json"::jsonb) = 'object')
);
--> statement-breakpoint
CREATE TABLE "recipes" (
	"user_id" text NOT NULL,
	"id" text DEFAULT gen_random_uuid()::text NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "recipes_user_id_id_pk" PRIMARY KEY("user_id","id"),
	CONSTRAINT "recipes_user_name" UNIQUE("user_id","name"),
	CONSTRAINT "recipes_slug" CHECK ("recipes"."name" ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND "recipes"."name" !~ '[^a-z0-9-]')
);
--> statement-breakpoint
CREATE TABLE "store_config" (
	"singleton" integer PRIMARY KEY NOT NULL,
	"signup_mode" text DEFAULT 'closed' NOT NULL,
	"signup_cap" integer DEFAULT 50 NOT NULL,
	"allowed_identities_json" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"limits_json" jsonb DEFAULT '{"recipes":100,"body_bytes":32768,"name_bytes":64,"description_bytes":500,"reason_bytes":500,"history_bytes":67108864,"daily_calls":1000,"daily_writes":200,"request_bytes":65536,"page_size":50}'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "config_singleton" CHECK ("store_config"."singleton" = 1),
	CONSTRAINT "config_signup_mode" CHECK ("store_config"."signup_mode" IN ('closed','allowlist','open')),
	CONSTRAINT "config_signup_cap" CHECK ("store_config"."signup_cap" >= 0),
	CONSTRAINT "config_allowlist_array" CHECK (jsonb_typeof("store_config"."allowed_identities_json") = 'array'),
	CONSTRAINT "config_limits_object" CHECK (jsonb_typeof("store_config"."limits_json") = 'object')
);
--> statement-breakpoint
CREATE TABLE "usage_daily" (
	"user_id" text NOT NULL,
	"day_utc" date NOT NULL,
	"tool_calls" integer DEFAULT 0 NOT NULL,
	"writes" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "usage_daily_user_id_day_utc_pk" PRIMARY KEY("user_id","day_utc"),
	CONSTRAINT "usage_nonnegative" CHECK ("usage_daily"."tool_calls" >= 0 AND "usage_daily"."writes" >= 0)
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"templates_revision" integer DEFAULT 0 NOT NULL,
	"profile_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"retained_bytes" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_status" CHECK ("users"."status" IN ('active','deleting')),
	CONSTRAINT "users_revision" CHECK ("users"."templates_revision" >= 0),
	CONSTRAINT "users_profile_object" CHECK (jsonb_typeof("users"."profile_json") = 'object'),
	CONSTRAINT "users_bytes" CHECK ("users"."retained_bytes" >= 0),
	CONSTRAINT "users_id_format" CHECK ("users"."id" <> '' AND position(':' in "users"."id") = 0)
);
--> statement-breakpoint
ALTER TABLE "identities" ADD CONSTRAINT "identities_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recipe_versions" ADD CONSTRAINT "versions_recipe" FOREIGN KEY ("user_id","recipe_id") REFERENCES "public"."recipes"("user_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recipes" ADD CONSTRAINT "recipes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_daily" ADD CONSTRAINT "usage_daily_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "identities_by_user" ON "identities" USING btree ("user_id");