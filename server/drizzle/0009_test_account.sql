-- Marks the fictional end-to-end check account (server/scripts/test-account.ts).
-- Usage and metric counts exclude test_account users (server README, "Test accounts").
-- Additive: one column with a constant default, a catalog change with no table rewrite;
-- every existing account reads false and older app/MCP code, which never names the
-- column, runs unchanged. Grants: migrations/011-test-account-roles.sql, so no runtime
-- login can set it. Rollback is the pre-migration snapshot; there is no down script.
-- Adding the column briefly takes an exclusive lock on users. Set in the migrator's one
-- transaction, because Neon drops the limits a client passes at connect: a lock not free
-- within 5 s fails this migration instead of queueing requests behind it.
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "test_account" boolean DEFAULT false NOT NULL;
