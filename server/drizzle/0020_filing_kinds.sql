-- Correctable filing and stable sample kinds. Offline: stop writers first.
-- A card's report moves from the immutable card row to each version, so moving
-- a rule is a new version that keeps the card's identity, text and history.
-- The cover sheet is the explicit value 'cover'; NULL never means cover sheet.
ALTER TABLE "instruction_card_versions" ADD COLUMN "report" text;--> statement-breakpoint
-- Versions are immutable, so the guard is paused for this one backfill.
ALTER TABLE "instruction_card_versions" DISABLE TRIGGER "instruction_card_versions_guard";--> statement-breakpoint
UPDATE "instruction_card_versions" v SET "report"=coalesce(c."report",'cover') FROM "instruction_cards" c
  WHERE c."user_id"=v."user_id" AND c."id"=v."card_id";--> statement-breakpoint
ALTER TABLE "instruction_card_versions" ENABLE TRIGGER "instruction_card_versions_guard";--> statement-breakpoint
ALTER TABLE "instruction_card_versions" ALTER COLUMN "report" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "instruction_card_versions" ADD CONSTRAINT "instruction_card_versions_report" CHECK ("instruction_card_versions"."report" IN ('cover','email','chat','post','document','speech'));--> statement-breakpoint
ALTER TABLE "instruction_cards" DROP CONSTRAINT "instruction_cards_report";--> statement-breakpoint
ALTER TABLE "instruction_cards" DROP COLUMN "report";--> statement-breakpoint
-- Legacy memo writes keep appending card versions; they stay where the card is.
CREATE OR REPLACE FUNCTION milton_legacy_card_append() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM instruction_cards WHERE user_id=NEW.user_id AND id=NEW.memo_id) THEN
    INSERT INTO instruction_cards(user_id,id) VALUES (NEW.user_id,NEW.memo_id);
  END IF;
  INSERT INTO memo_cards(user_id,card_id,memo_id) VALUES (NEW.user_id,NEW.memo_id,NEW.memo_id) ON CONFLICT DO NOTHING;
  IF NOT EXISTS (SELECT 1 FROM memo_cards WHERE user_id=NEW.user_id AND card_id=NEW.memo_id AND memo_id=NEW.memo_id AND version=1)
    OR (SELECT count(*) FROM memo_cards WHERE user_id=NEW.user_id AND memo_id=NEW.memo_id) <> 1
    OR EXISTS (SELECT 1 FROM instruction_card_versions WHERE user_id=NEW.user_id AND card_id=NEW.memo_id AND NOT legacy) THEN
    RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='card_legacy_conflict';
  END IF;
  INSERT INTO instruction_card_versions(user_id,card_id,version,description,body,archived,reason,actor_json,details_json,legacy,created_at,report)
    VALUES(NEW.user_id,NEW.memo_id,NEW.version,NEW.description,NEW.body,NEW.archived,NEW.reason,NEW.actor_json,NEW.details_json,true,NEW.created_at,
      coalesce((SELECT report FROM instruction_card_versions WHERE user_id=NEW.user_id AND card_id=NEW.memo_id ORDER BY version DESC LIMIT 1),'cover'));
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TABLE "sample_kinds" (
	"user_id" text NOT NULL,
	"id" text NOT NULL,
	"report" text NOT NULL,
	"label" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sample_kinds_user_id_id_pk" PRIMARY KEY("user_id","id"),
	CONSTRAINT "sample_kinds_report_key" UNIQUE("user_id","id","report"),
	CONSTRAINT "sample_kinds_report" CHECK ("sample_kinds"."report" IN ('email','chat','post','document','speech')),
	CONSTRAINT "sample_kinds_label_check" CHECK (char_length("sample_kinds"."label") BETWEEN 1 AND 60 AND position(chr(10) in "sample_kinds"."label")=0 AND position(chr(13) in "sample_kinds"."label")=0 AND btrim("sample_kinds"."label")="sample_kinds"."label")
);
--> statement-breakpoint
ALTER TABLE "sample_kinds" ADD CONSTRAINT "sample_kinds_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "sample_kinds_label" ON "sample_kinds" USING btree ("user_id","report",lower("label"));--> statement-breakpoint
-- One kind per report and case-folded label; its label is the earliest
-- sample's spelling. Retired samples were evicted by the previous runtime.
INSERT INTO "sample_kinds"("user_id","id","report","label","created_at")
  SELECT DISTINCT ON ("user_id","report",lower("kind")) "user_id",gen_random_uuid()::text,"report","kind","created_at"
  FROM "samples" ORDER BY "user_id","report",lower("kind"),"created_at","id";--> statement-breakpoint
ALTER TABLE "samples" ADD COLUMN "kind_id" text;--> statement-breakpoint
ALTER TABLE "samples" ADD COLUMN "replaces_id" text;--> statement-breakpoint
ALTER TABLE "samples" ADD COLUMN "retire_reason" text;--> statement-breakpoint
ALTER TABLE "samples" ADD COLUMN "retired_request_id" text;--> statement-breakpoint
ALTER TABLE "samples" DISABLE TRIGGER "samples_guard";--> statement-breakpoint
UPDATE "samples" s SET "kind_id"=k."id","retire_reason"=CASE WHEN s."retired_at" IS NULL THEN NULL ELSE 'evicted' END
  FROM "sample_kinds" k WHERE k."user_id"=s."user_id" AND k."report"=s."report" AND lower(k."label")=lower(s."kind");--> statement-breakpoint
ALTER TABLE "samples" ENABLE TRIGGER "samples_guard";--> statement-breakpoint
ALTER TABLE "samples" ALTER COLUMN "kind_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "samples" DROP CONSTRAINT "samples_kind";--> statement-breakpoint
ALTER TABLE "samples" DROP COLUMN "kind";--> statement-breakpoint
ALTER TABLE "samples" ADD CONSTRAINT "samples_kind_key" UNIQUE("user_id","id","kind_id");--> statement-breakpoint
ALTER TABLE "samples" ADD CONSTRAINT "samples_kind_fk" FOREIGN KEY ("user_id","kind_id","report") REFERENCES "public"."sample_kinds"("user_id","id","report") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "samples" ADD CONSTRAINT "samples_replaces_fk" FOREIGN KEY ("user_id","replaces_id","kind_id") REFERENCES "public"."samples"("user_id","id","kind_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "samples_by_kind" ON "samples" USING btree ("user_id","kind_id");--> statement-breakpoint
ALTER TABLE "samples" ADD CONSTRAINT "samples_retirement" CHECK (("samples"."retire_reason" IS NULL) = ("samples"."retired_at" IS NULL) AND ("samples"."retire_reason" IS NULL OR "samples"."retire_reason" IN ('replaced','removed','evicted')) AND ("samples"."retired_request_id" IS NULL OR "samples"."retired_at" IS NOT NULL));--> statement-breakpoint
-- A sample is never rewritten or removed; the only change is retirement: its
-- time, reason and request, set once and together. Rows leave only with their
-- account.
CREATE OR REPLACE FUNCTION milton_sample_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    IF EXISTS (SELECT 1 FROM users WHERE id=OLD.user_id) THEN
      RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='sample_is_append_only';
    END IF;
    RETURN OLD;
  END IF;
  IF TG_OP='UPDATE' THEN
    IF OLD.retired_at IS NOT NULL OR NEW.retired_at IS NULL OR NEW.retire_reason IS NULL
      OR (NEW.user_id,NEW.id,NEW.report,NEW.kind_id,NEW.context,NEW.body,NEW.client_json,NEW.replaces_id,NEW.created_at)
        IS DISTINCT FROM (OLD.user_id,OLD.id,OLD.report,OLD.kind_id,OLD.context,OLD.body,OLD.client_json,OLD.replaces_id,OLD.created_at) THEN
      RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='sample_is_append_only';
    END IF;
    RETURN NEW;
  END IF;
  PERFORM 1 FROM users WHERE id=NEW.user_id AND status='active' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='account_unavailable'; END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
-- A kind's report and label never change. Rows leave only with their account.
CREATE FUNCTION milton_sample_kind_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    IF EXISTS (SELECT 1 FROM users WHERE id=OLD.user_id) THEN
      RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='sample_kind_is_immutable';
    END IF;
    RETURN OLD;
  END IF;
  IF TG_OP='UPDATE' THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='sample_kind_is_immutable'; END IF;
  PERFORM 1 FROM users WHERE id=NEW.user_id AND status='active' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='account_unavailable'; END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER sample_kinds_guard BEFORE INSERT OR UPDATE OR DELETE ON "sample_kinds" FOR EACH ROW EXECUTE FUNCTION milton_sample_kind_guard();
