-- Sign-ups are open and the only mode (Peter, 2026-11-03). Every successful
-- sign-in creates or finds its account, so no code reads signup_mode or
-- allowed_identities_json. Release the code that stops reading them first,
-- then run this migration.
ALTER TABLE "store_config" DROP CONSTRAINT "config_signup_mode";--> statement-breakpoint
ALTER TABLE "store_config" DROP CONSTRAINT "config_allowlist_array";--> statement-breakpoint
ALTER TABLE "store_config" DROP COLUMN "signup_mode";--> statement-breakpoint
ALTER TABLE "store_config" DROP COLUMN "allowed_identities_json";