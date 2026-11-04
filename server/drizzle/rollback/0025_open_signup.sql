-- Rollback of 0025: re-adds signup_mode and allowed_identities_json with their
-- 0000 defaults ('closed', []) and restores both 0000 checks. Offline; stop
-- writers first, and roll back to pre-0025 code with it. The row takes the
-- state production held before 0025 (open, an empty allow-list), so pre-0025
-- code keeps creating accounts on sign-in.
BEGIN;
ALTER TABLE "store_config" ADD COLUMN "signup_mode" text DEFAULT 'closed' NOT NULL;
ALTER TABLE "store_config" ADD COLUMN "allowed_identities_json" jsonb DEFAULT '[]'::jsonb NOT NULL;
UPDATE "store_config" SET "signup_mode"='open' WHERE "singleton"=1;
ALTER TABLE "store_config" ADD CONSTRAINT "config_signup_mode" CHECK ("store_config"."signup_mode" IN ('closed','allowlist','open'));
ALTER TABLE "store_config" ADD CONSTRAINT "config_allowlist_array" CHECK (jsonb_typeof("store_config"."allowed_identities_json") = 'array');
COMMIT;
