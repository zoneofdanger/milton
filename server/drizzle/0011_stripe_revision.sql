-- trial_accounts.stripe_revision advances on every write of the Stripe state columns
-- (subscription id, status, trial end, period start and end), values unchanged included.
-- Checkout's live read and the webhook read Stripe with no transaction open, then write
-- only if the revision is what it was before the read (src/store/index.ts). Additive: one
-- NOT NULL column with a constant default, a catalog change with no table rewrite; every
-- row reads 0, and older app/MCP code, which never names the column, runs unchanged
-- (its writes do not advance it, so drain old revisions before relying on it). Grants:
-- 005-app-roles.sql's table-wide SELECT, INSERT, UPDATE on trial_accounts already covers
-- it for the app runtime; MCP's column list leaves it out. Rollback is the pre-migration
-- snapshot; there is no down script. Adding the column briefly takes an exclusive lock on
-- trial_accounts. Set in the migrator's one transaction, because Neon drops the limits a
-- client passes at connect: a lock not free within 5 s fails this migration instead of
-- queueing requests behind it.
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE "trial_accounts" ADD COLUMN "stripe_revision" bigint DEFAULT 0 NOT NULL;
