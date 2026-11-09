-- code-stopped-by: #76
-- Drops the writing tables before memos and wipes every save receipt (SPEC.md, "Memos
-- and tweaks"; PR #76, "Follow-up drop and wipe"). Since #76 no code reads or writes
-- accepted_changes, instruction_card_versions, instruction_cards, sample_versions,
-- samples, sample_kinds or the parked guide pilot's report_guides, guide_accounts,
-- guide_spend and guide_budget_lock; their triggers, constraints and grants go with
-- them, then the instruction_card_position sequence and the eight functions only they
-- used. No CASCADE: an unexpected dependent fails this migration instead of being
-- dropped with it. Every save_requests row goes too: the receipts of rule and sample
-- saves (which the memo code cannot read) and of memo saves since #76, so a replayed
-- memo save then answers unchanged. The table, its guard and its grants stay; the
-- code keeps writing it.
-- Rows and tables come back only from the pre-migration snapshot; there is no down
-- script, and this is not a code-only rollback: app/MCP older than #76 fails on it.
-- After it, migrations/005-app-roles.sql names dropped tables and is never rerun; the
-- owner file migrations/015-drop-guide-roles.sql drops the guide roles.
-- Each DROP takes an exclusive lock on its table and, for a foreign key to users, on
-- users until commit, so every request waits for this migration's few milliseconds.
-- Lock limits are set inside the migration's transaction, because Neon drops the
-- limits a client passes at connect: a lock not free within 5 s fails this migration
-- whole instead of queueing requests behind it. The receipt wipe runs last, under that
-- users lock, so no save can add a receipt between it and the commit.
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
DELETE FROM save_requests;
