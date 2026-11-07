CREATE TABLE "connection_keys" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"issuer" text NOT NULL,
	"subject" text NOT NULL,
	"incarnation" text NOT NULL,
	"generation" text NOT NULL,
	"secret_hash" text NOT NULL,
	"name" text NOT NULL,
	"scope" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "connection_key_binding" CHECK (char_length("connection_keys"."issuer") BETWEEN 1 AND 512 AND char_length("connection_keys"."subject") BETWEEN 1 AND 512 AND char_length("connection_keys"."incarnation") BETWEEN 1 AND 128 AND char_length("connection_keys"."generation") BETWEEN 1 AND 128),
	CONSTRAINT "connection_key_id" CHECK ("connection_keys"."id" ~ '^[A-Za-z0-9_-]{22}$'),
	CONSTRAINT "connection_key_hash" CHECK ("connection_keys"."secret_hash" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "connection_key_name" CHECK (char_length("connection_keys"."name") BETWEEN 1 AND 60 AND "connection_keys"."name" = btrim("connection_keys"."name") AND "connection_keys"."name" !~ '[[:cntrl:]]'),
	CONSTRAINT "connection_key_scope" CHECK ("connection_keys"."scope" IN ('read','read_write')),
	CONSTRAINT "connection_key_dates" CHECK (isfinite("connection_keys"."created_at") AND ("connection_keys"."expires_at" IS NULL OR (isfinite("connection_keys"."expires_at") AND "connection_keys"."expires_at" > "connection_keys"."created_at")))
);
--> statement-breakpoint
ALTER TABLE "connection_keys" ADD CONSTRAINT "connection_keys_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connection_keys" ADD CONSTRAINT "connection_keys_identity_fk" FOREIGN KEY ("issuer","subject") REFERENCES "public"."identities"("provider","subject") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "connection_keys_by_user" ON "connection_keys" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "connection_keys_by_identity" ON "connection_keys" USING btree ("issuer","subject");--> statement-breakpoint
-- Only the split app and MCP runtimes reach keys, through the owner-applied
-- migrations/006-connection-keys-roles.sql; the legacy writing group's default
-- grants never do.
REVOKE ALL ON connection_keys FROM milton_runtime;
