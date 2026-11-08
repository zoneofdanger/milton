-- Enrolment without row locks (src/store/billing.ts):
-- * enrol_lease_until: while in the future, one attempt holds the right to call Stripe to
--   start the account's trial, with no transaction open and no row locked; 'infinity'
--   once account deletion has begun, so no attempt can claim, renew or link again.
-- * enrol_generation: names the enrolment's Stripe idempotency keys, so an attempt that
--   takes over from a paused one sends the same keys and Stripe returns the same objects.
--   It advances only after a refusal Stripe replays for those keys.
-- * stripe_revision: advances on every accepted write of the Stripe state columns, values
--   unchanged included; a write after a Stripe read lands only if it has not moved.
-- Additive: one nullable column and two NOT NULL columns with constant defaults, catalog
-- changes with no table rewrite; existing rows read NULL, 0 and 0, and older app/MCP code,
-- which never names the columns, runs unchanged. Grants: 005-app-roles.sql's table-wide
-- SELECT, INSERT, UPDATE on trial_accounts already covers them for the app runtime; MCP's
-- column list leaves them out. Apply before code that writes them. Rollback is the
-- pre-migration snapshot; there is no down script. Adding the columns briefly takes an
-- exclusive lock on trial_accounts. Set in the migrator's one transaction, because Neon
-- drops the limits a client passes at connect: a lock not free within 5 s fails this
-- migration instead of queueing requests behind it.
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE "trial_accounts" ADD COLUMN "enrol_lease_until" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "trial_accounts" ADD COLUMN "enrol_generation" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "trial_accounts" ADD COLUMN "stripe_revision" bigint DEFAULT 0 NOT NULL;
