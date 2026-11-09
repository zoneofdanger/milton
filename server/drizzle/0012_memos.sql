-- Memos (SPEC.md, "Memos and tweaks"): creates the memo, kind, tweak, citation,
-- served-report, cover-sheet and keep-memos tables, all empty. Additive: no existing
-- table, column or row changes, so the code before memos runs unchanged beside it
-- (it never names these tables). Apply before the code that reads them. The old
-- writing tables stay until the follow-up drop, which names this release's PR in its
-- code-stopped-by line. Grants: migrations/014-memos-roles.sql, applied by the owner
-- in the same release. Rollback is the pre-migration snapshot; there is no down script.
-- The foreign keys to users take SHARE ROW EXCLUSIVE on users until commit. Lock
-- limits are set inside the migration's transaction, because Neon drops the limits a
-- client passes at connect: a lock not free within 5 s fails this migration instead of
-- queueing requests behind it.
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
CREATE TABLE "cover_sheets" (
	"user_id" text NOT NULL,
	"version" integer NOT NULL,
	"text" text NOT NULL,
	"actor_json" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cover_sheets_user_id_version_pk" PRIMARY KEY("user_id","version"),
	CONSTRAINT "cover_sheets_version" CHECK ("cover_sheets"."version" > 0),
	CONSTRAINT "cover_sheets_text" CHECK (char_length("cover_sheets"."text") <= 1500),
	CONSTRAINT "cover_sheets_actor" CHECK (jsonb_typeof("cover_sheets"."actor_json"::jsonb)='object')
);
--> statement-breakpoint
CREATE TABLE "memo_kinds" (
	"user_id" text NOT NULL,
	"id" text NOT NULL,
	"label" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "memo_kinds_user_id_id_pk" PRIMARY KEY("user_id","id"),
	CONSTRAINT "memo_kinds_label_check" CHECK (char_length("memo_kinds"."label") BETWEEN 1 AND 60 AND "memo_kinds"."label" = btrim("memo_kinds"."label") AND "memo_kinds"."label" !~ '[[:cntrl:]]')
);
--> statement-breakpoint
CREATE TABLE "memo_settings" (
	"user_id" text PRIMARY KEY NOT NULL,
	"keep_memos" boolean DEFAULT true NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "memos" (
	"user_id" text NOT NULL,
	"id" text NOT NULL,
	"kind_id" text,
	"medium" text NOT NULL,
	"summary" text NOT NULL,
	"audience" text,
	"purpose" text,
	"mode" text,
	"first_draft" text,
	"first_draft_state" text NOT NULL,
	"final" text NOT NULL,
	"rounds" integer,
	"change" double precision,
	"tier" text NOT NULL,
	"report_id" text,
	"served_tweak_ids" text[] DEFAULT '{}'::text[] NOT NULL,
	"client_json" text NOT NULL,
	"request_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"context_updated_at" timestamp with time zone,
	"search" "tsvector" GENERATED ALWAYS AS (to_tsvector('english'::regconfig, summary || ' ' || coalesce(purpose, '') || ' ' || coalesce(audience, '') || ' ' || final)) STORED,
	CONSTRAINT "memos_user_id_id_pk" PRIMARY KEY("user_id","id"),
	CONSTRAINT "memos_id" CHECK ("memos"."id" ~ '^[0-9a-f-]{36}$'),
	CONSTRAINT "memos_medium" CHECK ("memos"."medium" IN ('email','chat','post','document','speech')),
	CONSTRAINT "memos_summary" CHECK (char_length("memos"."summary") BETWEEN 1 AND 200 AND "memos"."summary" = btrim("memos"."summary") AND "memos"."summary" !~ '[[:cntrl:]]'),
	CONSTRAINT "memos_audience" CHECK ("memos"."audience" IS NULL OR (char_length("memos"."audience") BETWEEN 1 AND 100 AND "memos"."audience" = btrim("memos"."audience") AND "memos"."audience" !~ '[[:cntrl:]]')),
	CONSTRAINT "memos_purpose" CHECK ("memos"."purpose" IS NULL OR (char_length("memos"."purpose") BETWEEN 1 AND 100 AND "memos"."purpose" = btrim("memos"."purpose") AND "memos"."purpose" !~ '[[:cntrl:]]')),
	CONSTRAINT "memos_first_draft" CHECK ("memos"."first_draft_state" IN ('kept','missing','none') AND ("memos"."first_draft" IS NOT NULL) = ("memos"."first_draft_state" = 'kept') AND ("memos"."mode" IS NULL) = ("memos"."first_draft_state" = 'none') AND ("memos"."rounds" IS NULL) = ("memos"."first_draft_state" = 'none') AND ("memos"."change" IS NULL OR "memos"."first_draft_state" = 'kept')),
	CONSTRAINT "memos_mode" CHECK ("memos"."mode" IS NULL OR "memos"."mode" IN ('draft','edit')),
	CONSTRAINT "memos_words" CHECK (btrim("memos"."final") <> '' AND octet_length("memos"."final") <= 262144 AND ("memos"."first_draft" IS NULL OR octet_length("memos"."first_draft") <= 262144)),
	CONSTRAINT "memos_rounds" CHECK ("memos"."rounds" IS NULL OR "memos"."rounds" BETWEEN 0 AND 1000),
	CONSTRAINT "memos_change" CHECK ("memos"."change" IS NULL OR ("memos"."change" >= 0 AND "memos"."change" <= 1)),
	CONSTRAINT "memos_tier" CHECK ("memos"."tier" IN ('own','steered','untouched')),
	CONSTRAINT "memos_served" CHECK (cardinality("memos"."served_tweak_ids") <= 10 AND ("memos"."report_id" IS NOT NULL OR cardinality("memos"."served_tweak_ids") = 0)),
	CONSTRAINT "memos_client_object" CHECK (jsonb_typeof("memos"."client_json"::jsonb)='object'),
	CONSTRAINT "memos_request_id" CHECK (length("memos"."request_id") = 36)
);
--> statement-breakpoint
CREATE TABLE "served_reports" (
	"user_id" text NOT NULL,
	"id" text NOT NULL,
	"tweak_ids" text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "served_reports_user_id_id_pk" PRIMARY KEY("user_id","id"),
	CONSTRAINT "served_reports_tweaks" CHECK (cardinality("served_reports"."tweak_ids") <= 10)
);
--> statement-breakpoint
CREATE TABLE "tweak_citations" (
	"user_id" text NOT NULL,
	"memo_id" text NOT NULL,
	"tweak_id" text NOT NULL,
	CONSTRAINT "tweak_citations_user_id_memo_id_tweak_id_pk" PRIMARY KEY("user_id","memo_id","tweak_id")
);
--> statement-breakpoint
CREATE TABLE "tweaks" (
	"user_id" text NOT NULL,
	"id" text NOT NULL,
	"text" text NOT NULL,
	"norm" text NOT NULL,
	"client_json" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tweaks_user_id_id_pk" PRIMARY KEY("user_id","id"),
	CONSTRAINT "tweaks_norm" UNIQUE("user_id","norm"),
	CONSTRAINT "tweaks_text" CHECK (char_length("tweaks"."text") BETWEEN 1 AND 200 AND "tweaks"."text" = btrim("tweaks"."text") AND "tweaks"."text" !~ '[[:cntrl:]]'),
	CONSTRAINT "tweaks_norm_check" CHECK ("tweaks"."norm" <> ''),
	CONSTRAINT "tweaks_client_object" CHECK (jsonb_typeof("tweaks"."client_json"::jsonb)='object')
);
--> statement-breakpoint
ALTER TABLE "cover_sheets" ADD CONSTRAINT "cover_sheets_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memo_kinds" ADD CONSTRAINT "memo_kinds_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memo_settings" ADD CONSTRAINT "memo_settings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memos" ADD CONSTRAINT "memos_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memos" ADD CONSTRAINT "memos_kind_fk" FOREIGN KEY ("user_id","kind_id") REFERENCES "public"."memo_kinds"("user_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "served_reports" ADD CONSTRAINT "served_reports_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tweak_citations" ADD CONSTRAINT "tweak_citations_memo_fk" FOREIGN KEY ("user_id","memo_id") REFERENCES "public"."memos"("user_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tweak_citations" ADD CONSTRAINT "tweak_citations_tweak_fk" FOREIGN KEY ("user_id","tweak_id") REFERENCES "public"."tweaks"("user_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tweaks" ADD CONSTRAINT "tweaks_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "memo_kinds_label" ON "memo_kinds" USING btree ("user_id",lower("label"));--> statement-breakpoint
CREATE INDEX "memos_by_user" ON "memos" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "tweak_citations_by_tweak" ON "tweak_citations" USING btree ("user_id","tweak_id");
--> statement-breakpoint
-- Only the app and MCP runtimes reach these tables, through the owner-applied
-- migrations/014-memos-roles.sql; the legacy writing group's default grants never do.
REVOKE ALL ON cover_sheets, memo_kinds, memo_settings, memos, served_reports, tweak_citations, tweaks FROM milton_runtime;
