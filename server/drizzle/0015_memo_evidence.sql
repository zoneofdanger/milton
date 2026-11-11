-- Memo evidence (docs/research/memo-evidence-spec-2026-11-11.md, slice 2): adds
-- memo_changes (what changed from a memo's kept first draft to its final, one row per
-- change the AI named and per spot code found), memos.request (the person's typed ask)
-- and memos.changes_state, and tweaks.text_changed_at (a reword restarts its score).
-- Additive: no existing column or row changes, and the code before this release never
-- names the new table or columns, so it runs unchanged beside it; traffic may stay open.
-- Grants: migrations/016-memo-evidence-roles.sql, applied by the owner right after this
-- and before the code that reads them. Rollback is the pre-migration snapshot; there is
-- no down script. Adding the columns is a catalog change; the two memos checks scan memos
-- once, and the foreign keys take SHARE ROW EXCLUSIVE on memos and tweak_citations until
-- commit. Lock limits are set inside the migration's transaction, because Neon drops the
-- limits a client passes at connect: a lock not free within 5 s fails this migration
-- whole instead of queueing saves behind it. Nothing touches neon_auth.
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
CREATE TABLE "memo_changes" (
	"user_id" text NOT NULL,
	"memo_id" text NOT NULL,
	"n" smallint NOT NULL,
	"draft_start" integer,
	"draft_end" integer,
	"final_start" integer,
	"final_end" integer,
	"before" text NOT NULL,
	"after" text NOT NULL,
	"truncated" boolean DEFAULT false NOT NULL,
	"about" text,
	"by" text,
	"tweak_id" text,
	CONSTRAINT "memo_changes_user_id_memo_id_n_pk" PRIMARY KEY("user_id","memo_id","n"),
	CONSTRAINT "memo_changes_n" CHECK ("memo_changes"."n" BETWEEN 0 AND 119),
	CONSTRAINT "memo_changes_offsets" CHECK (("memo_changes"."draft_start" IS NULL) = ("memo_changes"."draft_end" IS NULL) AND ("memo_changes"."final_start" IS NULL) = ("memo_changes"."final_end" IS NULL) AND ("memo_changes"."draft_start" IS NULL OR 0 <= "memo_changes"."draft_start" AND "memo_changes"."draft_start" <= "memo_changes"."draft_end") AND ("memo_changes"."final_start" IS NULL OR 0 <= "memo_changes"."final_start" AND "memo_changes"."final_start" <= "memo_changes"."final_end")),
	CONSTRAINT "memo_changes_sides" CHECK (char_length("memo_changes"."before") <= 300 AND char_length("memo_changes"."after") <= 300 AND ("memo_changes"."before" <> '' OR "memo_changes"."after" <> '')),
	CONSTRAINT "memo_changes_labels" CHECK (("memo_changes"."about" IS NULL OR "memo_changes"."about" IN ('voice','content','format')) AND ("memo_changes"."by" IS NULL OR "memo_changes"."by" IN ('person','asked','unasked')) AND ("memo_changes"."by" IS NULL) = ("memo_changes"."about" IS NULL OR "memo_changes"."about" = 'format')),
	CONSTRAINT "memo_changes_tweak" CHECK ("memo_changes"."tweak_id" IS NULL OR ("memo_changes"."about" = 'voice' AND "memo_changes"."by" IN ('person','asked')))
);
--> statement-breakpoint
ALTER TABLE "memos" ADD COLUMN "request" text;--> statement-breakpoint
ALTER TABLE "memos" ADD COLUMN "changes_state" text;--> statement-breakpoint
ALTER TABLE "tweaks" ADD COLUMN "text_changed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "memo_changes" ADD CONSTRAINT "memo_changes_memo_fk" FOREIGN KEY ("user_id","memo_id") REFERENCES "public"."memos"("user_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memo_changes" ADD CONSTRAINT "memo_changes_citation_fk" FOREIGN KEY ("user_id","memo_id","tweak_id") REFERENCES "public"."tweak_citations"("user_id","memo_id","tweak_id") ON DELETE set null (tweak_id) ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memos" ADD CONSTRAINT "memos_request" CHECK ("memos"."request" IS NULL OR ("memos"."first_draft_state" <> 'none' AND char_length("memos"."request") BETWEEN 1 AND 600 AND "memos"."request" = btrim("memos"."request", ' ' || chr(10)) AND translate("memos"."request", chr(10), '') !~ '[[:cntrl:]]'));--> statement-breakpoint
ALTER TABLE "memos" ADD CONSTRAINT "memos_changes_state" CHECK ("memos"."changes_state" IS NULL OR ("memos"."changes_state" IN ('itemized','too_large') AND "memos"."first_draft_state" = 'kept'));
--> statement-breakpoint
-- Only the app and MCP runtimes reach this table, through the owner-applied
-- migrations/016-memo-evidence-roles.sql; the legacy writing group's default grants never do.
REVOKE ALL ON memo_changes FROM milton_runtime;
