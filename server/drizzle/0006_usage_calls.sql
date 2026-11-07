-- Usage after the daily allowance: one appended row per admitted tool call,
-- written after the response. No foreign key, so an append takes no lock on the
-- account row; account erasure deletes an account's rows explicitly. Creates an
-- empty table only; safe to apply while older app/MCP code serves (it never
-- touches this table). Apply before code that writes it; until then that code's
-- appends fail, are logged by code and change no response. Grants:
-- migrations/009-usage-calls-roles.sql. Rollback: rollback/0006_usage_calls.sql.
CREATE TABLE "usage_calls" (
	"user_id" text NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"tool" text NOT NULL,
	"outcome" text NOT NULL,
	CONSTRAINT "usage_calls_tool" CHECK ("usage_calls"."tool" IN ('get_cover_sheet','get_report','list_reports','create_memo')),
	CONSTRAINT "usage_calls_outcome" CHECK ("usage_calls"."outcome" IN ('read','saved','unchanged','conflict','refused','failed'))
);
--> statement-breakpoint
CREATE INDEX "usage_calls_by_user" ON "usage_calls" USING btree ("user_id","at");--> statement-breakpoint
-- Only the split app and MCP runtimes reach it, through the owner-applied
-- migrations/009-usage-calls-roles.sql; the legacy writing group's default
-- grants never do.
REVOKE ALL ON usage_calls FROM milton_runtime;
