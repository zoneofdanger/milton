-- The enrolment lease (src/store/billing.ts, claimEnrolment): while it is in the future,
-- one attempt holds the right to call Stripe to start the account's trial, with no
-- transaction open and no row locked. It replaces holding trial_accounts FOR UPDATE across
-- the Stripe calls. Additive: one nullable column with no default, a catalog change with no
-- table rewrite; every row reads NULL (no lease) and older app/MCP code, which never names
-- the column, runs unchanged. Grants: 005-app-roles.sql's table-wide SELECT, INSERT, UPDATE
-- on trial_accounts already covers it for the app runtime; MCP's column list leaves it out.
-- Apply before code that writes it. Rollback is the pre-migration snapshot; there is no
-- down script. Adding the column briefly takes an exclusive lock on trial_accounts. Set in
-- the migrator's one transaction, because Neon drops the limits a client passes at connect:
-- a lock not free within 5 s fails this migration instead of queueing requests behind it.
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE "trial_accounts" ADD COLUMN "enrol_lease_until" timestamp with time zone;
