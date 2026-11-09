-- code-stopped-by: #76
-- Drops the writing tables before memos and the save receipts of the old store (SPEC.md,
-- "Memos and tweaks"; PR #76, "Follow-up drop and wipe"). Since #76 no code reads or
-- writes accepted_changes, instruction_card_versions, instruction_cards,
-- sample_versions, samples, sample_kinds or the parked guide pilot's report_guides,
-- guide_accounts, guide_spend and guide_budget_lock; their triggers, constraints and
-- grants go with them, then the instruction_card_position sequence and the eight
-- functions only they used. No CASCADE: an unexpected dependent fails this migration
-- instead of being dropped with it. Owner file migrations/015-drop-guide-roles.sql runs
-- before this one and has already dropped the guide roles.
-- Receipts: only those the old rule, sample and report store wrote go, since their
-- outcomes can quote old writing. Every receipt the memo code writes stays, so a replay
-- of any memo-era request still returns its stored outcome: without it, a replayed save
-- of a memo since forgotten would save it again, and a replayed context correction would
-- undo a later one. Told apart by content (no time cut is needed; save.ts on main before
-- and after #76): the memo code's outcomes have only the keys status, request_id, error,
-- message, memo, receipt, cover_sheet and forgotten, and every one that is not failed
-- carries memo, cover_sheet or forgotten. The old store's carried version (every
-- conflict, unchanged and saved outcome), question or samples_retired, and its failed
-- outcomes used codes the memo code never stores (rules, edits, moves, samples, the
-- report size and the old tables' triggers). A failed old receipt with a code both
-- stores share (request_too_large, invalid_kind, unique_violation, check_violation,
-- configuration, account_unavailable and the like) stays: it is indistinguishable from
-- a memo-era one, and those codes' messages are fixed text, never writing.
-- Rows and tables come back only from the pre-migration snapshot; there is no down
-- script, and this is not a code-only rollback: app/MCP older than #76 fails on it.
-- After it, migrations/005-app-roles.sql names dropped tables and is never rerun.
-- Each DROP takes an exclusive lock on its table and, for a foreign key to users, on
-- users until commit, so every request waits for this migration. Lock limits are set
-- inside the migration's transaction, because Neon drops the limits a client passes at
-- connect: a lock not free within 5 s fails this migration whole instead of queueing
-- requests behind it. The limit bounds waiting for a lock, not the statements' run
-- time; the DELETE scans save_requests once, a table of tens of rows (about 10 a day
-- from the daily check).
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
DROP TABLE accepted_changes;
--> statement-breakpoint
DROP TABLE instruction_card_versions;
--> statement-breakpoint
DROP TABLE instruction_cards;
--> statement-breakpoint
-- 0000 made the sequence OWNED BY instruction_cards.position, so it went with that
-- table; dropped by name too in case a database's sequence is not owned.
DROP SEQUENCE IF EXISTS instruction_card_position;
--> statement-breakpoint
DROP TABLE sample_versions;
--> statement-breakpoint
DROP TABLE samples;
--> statement-breakpoint
DROP TABLE sample_kinds;
--> statement-breakpoint
DROP TABLE report_guides;
--> statement-breakpoint
DROP TABLE guide_accounts;
--> statement-breakpoint
DROP TABLE guide_spend;
--> statement-breakpoint
DROP TABLE guide_budget_lock;
--> statement-breakpoint
DROP FUNCTION public.milton_accepted_change_guard();
--> statement-breakpoint
DROP FUNCTION public.milton_card_guard();
--> statement-breakpoint
DROP FUNCTION public.milton_card_version_guard();
--> statement-breakpoint
DROP FUNCTION public.milton_guide_source_changed();
--> statement-breakpoint
DROP FUNCTION public.milton_sample_guard();
--> statement-breakpoint
DROP FUNCTION public.milton_sample_kind_guard();
--> statement-breakpoint
DROP FUNCTION public.milton_sample_version_guard();
--> statement-breakpoint
DROP FUNCTION public.milton_sample_context_valid(jsonb);
--> statement-breakpoint
DELETE FROM save_requests
WHERE EXISTS (
    SELECT 1 FROM jsonb_object_keys(result_json) AS k(key)
    WHERE key NOT IN ('status','request_id','error','message','memo','receipt','cover_sheet','forgotten'))
  OR (result_json->>'status' <> 'failed'
    AND NOT jsonb_exists_any(result_json, ARRAY['memo','cover_sheet','forgotten']))
  OR (result_json->>'status' = 'failed' AND result_json->>'error' IN (
    'baseline_unknown','card_heading','edit_conflict','move_conflict','sample_conflict',
    'tps_body_limit','memo_body_limit','memo_description_limit','memo_reason_limit',
    'card_version_conflict','card_version_is_immutable','card_identity_is_immutable',
    'sample_identity_is_immutable','sample_version_is_immutable','sample_version_conflict',
    'sample_kind_is_immutable'));
