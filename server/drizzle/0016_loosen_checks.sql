-- Loosens three checks, the schema half of "expand now, contract later": memos_first_draft
-- lets a kept or missing first draft go without rounds (a memo with no first draft still
-- has none), and save_request_id and memos_request_id take any request id of 1 to 64
-- letters, digits and . _ : - instead of exactly 36 characters. Every other clause and
-- column stays as it was; no row is rewritten. The code before this release satisfies
-- every new check (it writes only UUIDs, and rounds whenever there is a first draft), so
-- it runs unchanged beside it; traffic may stay open. Not a pure loosening: a 36-character
-- id holding a character outside the alphabet, such as "/", passes the old check and
-- fails the new one, failing this migration whole. So run this read-only preflight on
-- production first and expect 0 and 0:
--   BEGIN TRANSACTION READ ONLY;
--   SELECT (SELECT count(*) FROM memos WHERE request_id !~ '^[A-Za-z0-9._:-]{1,64}$') AS memos, (SELECT count(*) FROM save_requests WHERE request_id !~ '^[A-Za-z0-9._:-]{1,64}$') AS save_requests;
--   ROLLBACK;
-- Locks: each DROP and ADD CONSTRAINT takes ACCESS EXCLUSIVE (no reads or writes) on memos,
-- then on save_requests, each held until commit; memos stays locked while this works on, or
-- waits for, save_requests. Each ADD scans its table once to validate it, without a
-- rewrite. The 5 s lock_timeout and 30 s statement_timeout are set inside the migration's
-- transaction, because Neon drops the limits a client passes at connect. They bound each
-- lock wait and each statement, not the whole transaction: requests behind the locks
-- queue meanwhile, under their own 10 s lock and 20 s statement limits. A lock not free in
-- time, or a row the new checks refuse, fails this migration and its journal row together,
-- leaving the old checks. Rollback is the pre-migration snapshot; there is no down script.
-- No grant changes. Nothing touches neon_auth.
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
SET LOCAL statement_timeout = '30s';
--> statement-breakpoint
ALTER TABLE "memos" DROP CONSTRAINT "memos_first_draft";--> statement-breakpoint
ALTER TABLE "memos" DROP CONSTRAINT "memos_request_id";--> statement-breakpoint
ALTER TABLE "save_requests" DROP CONSTRAINT "save_request_id";--> statement-breakpoint
ALTER TABLE "memos" ADD CONSTRAINT "memos_first_draft" CHECK ("memos"."first_draft_state" IN ('kept','missing','none') AND ("memos"."first_draft" IS NOT NULL) = ("memos"."first_draft_state" = 'kept') AND ("memos"."mode" IS NULL) = ("memos"."first_draft_state" = 'none') AND ("memos"."first_draft_state" <> 'none' OR "memos"."rounds" IS NULL) AND ("memos"."change" IS NULL OR "memos"."first_draft_state" = 'kept'));--> statement-breakpoint
ALTER TABLE "memos" ADD CONSTRAINT "memos_request_id" CHECK ("memos"."request_id" ~ '^[A-Za-z0-9._:-]{1,64}$');--> statement-breakpoint
ALTER TABLE "save_requests" ADD CONSTRAINT "save_request_id" CHECK ("save_requests"."request_id" ~ '^[A-Za-z0-9._:-]{1,64}$');
