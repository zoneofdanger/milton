-- Adds memos_request_typed: the request's 12-line and pasted-mail rules, which only
-- save.ts checked (#38), so a write path that skips it keeps none. The SQL is never
-- stricter than the code: anything save.ts accepts passes it (schema.ts says how each
-- pattern mirrors PASTED, and its one deliberate looseness). Purely additive: no column,
-- grant or other check changes, and no row is rewritten; the code before and after this
-- release writes only requests it takes, so traffic may stay open. It refuses rows the
-- old checks took, so run this read-only preflight on production first and expect 0; any
-- other count stops the migration for Peter's decision:
--   BEGIN TRANSACTION READ ONLY;
--   SELECT count(*) AS refused FROM memos WHERE NOT ("memos"."request" IS NULL OR (char_length("memos"."request") - char_length(replace("memos"."request", chr(10), '')) <= 11 AND "memos"."request" !~ '(^|[\n\r\u2028\u2029])[\t\v\f \u00a0\u1680\u2000-\u200a\u202f\u205f\u3000\ufeff]*>' AND "memos"."request" !~ '(^|[\n\r\u2028\u2029])[\t\v\f \u00a0\u1680\u2000-\u200a\u202f\u205f\u3000\ufeff]*[Oo][Nn][^A-Za-z0-9_\n\r\u2028\u2029]([^\n\r\u2028\u2029]*[^A-Za-z0-9_\n\r\u2028\u2029])?[Ww][Rr][Oo][Tt][Ee]:[\t\v\f \u00a0\u1680\u2000-\u200a\u202f\u205f\u3000\ufeff]*([\n\r\u2028\u2029]|$)' AND "memos"."request" !~ '(^|[\n\r\u2028\u2029])[\t\v\f \u00a0\u1680\u2000-\u200a\u202f\u205f\u3000\ufeff]*([Ff][Rr][Oo][Mm]|[Ss][Uu][Bb][Jj][Ee][Cc][Tt]):'));
--   ROLLBACK;
-- Locks: ADD CONSTRAINT takes ACCESS EXCLUSIVE (no reads or writes) on memos alone and
-- holds it until commit, scanning memos once to validate, without a rewrite; it touches
-- no other table, so it cannot deadlock with a save. NOT VALID and a later VALIDATE
-- would gain nothing: db:migrate runs every pending migration in one transaction, so
-- the VALIDATE would scan under the same lock. The 5 s lock_timeout and 30 s
-- statement_timeout are set inside the migration's transaction, because Neon drops the
-- limits a client passes at connect; requests behind the lock queue meanwhile, under
-- their own 10 s lock and 20 s statement limits. A lock not free in time, or a row the
-- check refuses, fails this migration and its journal row together, leaving the old
-- checks. Rollback is the pre-migration snapshot; there is no down script. Nothing
-- touches neon_auth.
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
SET LOCAL statement_timeout = '30s';
--> statement-breakpoint
ALTER TABLE "memos" ADD CONSTRAINT "memos_request_typed" CHECK ("memos"."request" IS NULL OR (char_length("memos"."request") - char_length(replace("memos"."request", chr(10), '')) <= 11 AND "memos"."request" !~ '(^|[\n\r\u2028\u2029])[\t\v\f \u00a0\u1680\u2000-\u200a\u202f\u205f\u3000\ufeff]*>' AND "memos"."request" !~ '(^|[\n\r\u2028\u2029])[\t\v\f \u00a0\u1680\u2000-\u200a\u202f\u205f\u3000\ufeff]*[Oo][Nn][^A-Za-z0-9_\n\r\u2028\u2029]([^\n\r\u2028\u2029]*[^A-Za-z0-9_\n\r\u2028\u2029])?[Ww][Rr][Oo][Tt][Ee]:[\t\v\f \u00a0\u1680\u2000-\u200a\u202f\u205f\u3000\ufeff]*([\n\r\u2028\u2029]|$)' AND "memos"."request" !~ '(^|[\n\r\u2028\u2029])[\t\v\f \u00a0\u1680\u2000-\u200a\u202f\u205f\u3000\ufeff]*([Ff][Rr][Oo][Mm]|[Ss][Uu][Bb][Jj][Ee][Cc][Tt]):'));
