-- Reports replace memo groups as the unit of the compiled output. Each rule
-- card belongs to one of five fixed reports or, with NULL, to the cover sheet.
-- Approved samples get their own append-only table. Assembly is deterministic
-- and runs on read; tps_reports keeps the version fence and the full text.
CREATE TABLE "samples" (
	"user_id" text NOT NULL,
	"id" text NOT NULL,
	"report" text NOT NULL,
	"kind" text NOT NULL,
	"context" text NOT NULL,
	"body" text NOT NULL,
	"client_json" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"retired_at" timestamp with time zone,
	CONSTRAINT "samples_user_id_id_pk" PRIMARY KEY("user_id","id"),
	CONSTRAINT "samples_report" CHECK ("samples"."report" IN ('email','chat','post','document','speech')),
	CONSTRAINT "samples_kind" CHECK (char_length("samples"."kind") BETWEEN 1 AND 60 AND position(chr(10) in "samples"."kind")=0 AND position(chr(13) in "samples"."kind")=0 AND btrim("samples"."kind")="samples"."kind"),
	CONSTRAINT "samples_context" CHECK (char_length("samples"."context") BETWEEN 1 AND 200 AND position(chr(10) in "samples"."context")=0 AND position(chr(13) in "samples"."context")=0 AND btrim("samples"."context")="samples"."context"),
	CONSTRAINT "samples_body" CHECK (btrim("samples"."body") <> '' AND octet_length("samples"."body") <= 32768),
	CONSTRAINT "samples_client_object" CHECK (jsonb_typeof("samples"."client_json"::jsonb)='object')
);
--> statement-breakpoint
ALTER TABLE "tps_reports" DROP CONSTRAINT "tps_body_limit";--> statement-breakpoint
ALTER TABLE "store_config" ALTER COLUMN "limits_json" SET DEFAULT '{"memos":100,"body_bytes":32768,"name_bytes":64,"description_bytes":500,"reason_bytes":500,"history_bytes":67108864,"report_body_bytes":262144,"daily_calls":1000,"daily_writes":200,"request_bytes":65536,"page_size":50}'::jsonb;--> statement-breakpoint
UPDATE "store_config" SET "limits_json"="limits_json" || '{"report_body_bytes":262144}'::jsonb WHERE "singleton"=1 AND NOT "limits_json" ? 'report_body_bytes';--> statement-breakpoint
ALTER TABLE "instruction_cards" ADD COLUMN "report" text;--> statement-breakpoint
-- Backfill from the group title a card was filed under: a title naming a report
-- becomes that report; every other card (including archived working-style rules)
-- belongs to the cover sheet. Card rows are otherwise immutable, so the guard is
-- paused for this one statement.
ALTER TABLE "instruction_cards" DISABLE TRIGGER "instruction_cards_guard";--> statement-breakpoint
UPDATE "instruction_cards" c SET "report"=lower(m."title") FROM "memo_cards" g JOIN "memos" m ON m."user_id"=g."user_id" AND m."id"=g."memo_id"
  WHERE c."user_id"=g."user_id" AND c."id"=g."card_id" AND lower(m."title") IN ('email','chat','post','document','speech');--> statement-breakpoint
ALTER TABLE "instruction_cards" ENABLE TRIGGER "instruction_cards_guard";--> statement-breakpoint
-- Groups that never held a card or a legacy version carry nothing; remove them.
DELETE FROM "memos" m WHERE NOT EXISTS (SELECT 1 FROM "memo_cards" g WHERE g."user_id"=m."user_id" AND g."memo_id"=m."id")
  AND NOT EXISTS (SELECT 1 FROM "memo_versions" v WHERE v."user_id"=m."user_id" AND v."memo_id"=m."id");--> statement-breakpoint
ALTER TABLE "samples" ADD CONSTRAINT "samples_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "samples_by_report" ON "samples" USING btree ("user_id","report");--> statement-breakpoint
ALTER TABLE "instruction_cards" ADD CONSTRAINT "instruction_cards_report" CHECK ("instruction_cards"."report" IS NULL OR "instruction_cards"."report" IN ('email','chat','post','document','speech'));--> statement-breakpoint
ALTER TABLE "tps_reports" ADD CONSTRAINT "tps_body_limit" CHECK (octet_length("tps_reports"."body") <= 1572864);--> statement-breakpoint
-- A sample is never rewritten or removed; the only change is retirement, set
-- once. Rows leave only with their account.
CREATE FUNCTION milton_sample_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    IF EXISTS (SELECT 1 FROM users WHERE id=OLD.user_id) THEN
      RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='sample_is_append_only';
    END IF;
    RETURN OLD;
  END IF;
  IF TG_OP='UPDATE' THEN
    IF OLD.retired_at IS NOT NULL OR NEW.retired_at IS NULL
      OR (NEW.user_id,NEW.id,NEW.report,NEW.kind,NEW.context,NEW.body,NEW.client_json,NEW.created_at)
        IS DISTINCT FROM (OLD.user_id,OLD.id,OLD.report,OLD.kind,OLD.context,OLD.body,OLD.client_json,OLD.created_at) THEN
      RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='sample_is_append_only';
    END IF;
    RETURN NEW;
  END IF;
  PERFORM 1 FROM users WHERE id=NEW.user_id AND status='active' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='account_unavailable'; END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER samples_guard BEFORE INSERT OR UPDATE OR DELETE ON "samples" FOR EACH ROW EXECUTE FUNCTION milton_sample_guard();
