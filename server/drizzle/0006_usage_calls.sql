-- Usage after the daily allowance: one appended row per admitted tool call
-- (account, time, tool), written alongside the call's work. The foreign key
-- cascades from users, so account erasure removes the rows and an append for
-- an erased account fails its check instead of leaving one behind. Creates an
-- empty table only; safe while older app/MCP code serves (it never touches this
-- table). Apply before code that writes it; until then that code's appends fail,
-- are logged by code and change no response. Grants:
-- migrations/009-usage-calls-roles.sql. Rollback: rollback/0006_usage_calls.sql.
CREATE TABLE "usage_calls" (
	"user_id" text NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"tool" text NOT NULL,
	CONSTRAINT "usage_calls_tool" CHECK ("usage_calls"."tool" IN ('get_cover_sheet','get_report','list_reports','create_memo'))
);
--> statement-breakpoint
ALTER TABLE "usage_calls" ADD CONSTRAINT "usage_calls_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "usage_calls_by_user" ON "usage_calls" USING btree ("user_id","at");--> statement-breakpoint
-- Only the MCP runtime reaches it, through the owner-applied
-- migrations/009-usage-calls-roles.sql; the legacy writing group's default
-- grants never do.
REVOKE ALL ON usage_calls FROM milton_runtime;
