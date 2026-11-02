-- Assistants a person disconnected. The MCP server refuses any access token for
-- a listed (provider, subject, client_id), including unexpired ones; approving
-- the assistant again on the consent page removes the row. Keyed by sign-in
-- identity with no foreign key to users, so the refusal survives account
-- re-creation for the same identity.
CREATE TABLE "assistant_disconnects" (
	"provider" text NOT NULL,
	"subject" text NOT NULL,
	"client_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "assistant_disconnects_provider_subject_client_id_pk" PRIMARY KEY("provider","subject","client_id"),
	CONSTRAINT "assistant_disconnects_bounds" CHECK (char_length("assistant_disconnects"."provider") BETWEEN 1 AND 64 AND char_length("assistant_disconnects"."subject") BETWEEN 1 AND 512 AND char_length("assistant_disconnects"."client_id") BETWEEN 1 AND 2048)
);--> statement-breakpoint
-- One-way sha256("provider:subject") of deleted sign-in identities, kept only so
-- a re-created account gets no second trial. No foreign key and no content.
CREATE TABLE "deleted_identities" (
	"identity_hash" text PRIMARY KEY NOT NULL,
	"deleted_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "deleted_identities_hash" CHECK ("deleted_identities"."identity_hash" ~ '^[a-f0-9]{64}$')
);
