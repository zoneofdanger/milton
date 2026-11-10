-- code-stopped-by: #45
-- Drops save_requests.source_hash, which nothing has read and which saves stopped writing
-- in #45 (with 0006, which made it nullable), and rewrites the save_request_hashes check
-- to test input_hash alone. Every app/MCP revision from #45 on, the #76 floor included,
-- names only user_id, request_id, input_hash and result_json on save_requests (save.ts:
-- SELECT input_hash,result_json and an INSERT with that explicit column list); the
-- Drizzle declarations in schema.ts are read only by drizzle-kit and the tests, never by
-- a request. So this runs while that code serves, and no release has to come first.
-- The check is dropped by name before the column, and re-added after it, so nothing is
-- dropped implicitly. No CASCADE: an unexpected dependent fails this migration instead of
-- being dropped with it. Rows and the column come back only from the pre-migration
-- snapshot; there is no down script.
-- Each statement takes an ACCESS EXCLUSIVE lock on save_requests until commit, so saves
-- wait for this migration; users and every other table are untouched. Lock limits are
-- set inside the migration's transaction, because Neon drops the limits a client passes
-- at connect: a lock not free within 5 s fails this migration whole instead of queueing
-- saves behind it. Dropping the column is a catalog change, no rewrite; re-adding the
-- check scans save_requests once, a table of tens of rows.
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE "save_requests" DROP CONSTRAINT "save_request_hashes";--> statement-breakpoint
ALTER TABLE "save_requests" DROP COLUMN "source_hash";--> statement-breakpoint
ALTER TABLE "save_requests" ADD CONSTRAINT "save_request_hashes" CHECK ("save_requests"."input_hash" ~ '^[a-f0-9]{64}$');
