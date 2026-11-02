-- TPS order and grouping become write-once, so the existing card fingerprint
-- (ids, versions, archive state) still fences every change to assembled TPS.
-- Untitled groups assemble exactly as before; titles arrive only with new
-- card versions (scripts/title-groups.ts) and so publish a new report revision.
CREATE SEQUENCE "instruction_card_position" AS bigint;--> statement-breakpoint
ALTER TABLE "instruction_cards" ADD COLUMN "position" bigint;--> statement-breakpoint
-- Backfill in the current TPS order (card ID), so every stored report and
-- fingerprint is unchanged by this migration.
ALTER TABLE "instruction_cards" DISABLE TRIGGER "instruction_cards_guard";--> statement-breakpoint
UPDATE "instruction_cards" c SET "position"=o.n FROM (
  SELECT user_id,id,row_number() OVER (PARTITION BY user_id ORDER BY id) AS n FROM "instruction_cards"
) o WHERE c.user_id=o.user_id AND c.id=o.id;--> statement-breakpoint
ALTER TABLE "instruction_cards" ENABLE TRIGGER "instruction_cards_guard";--> statement-breakpoint
SELECT setval('instruction_card_position',(SELECT coalesce(max("position"),0)+1 FROM "instruction_cards"),false);--> statement-breakpoint
ALTER TABLE "instruction_cards" ALTER COLUMN "position" SET DEFAULT nextval('instruction_card_position');--> statement-breakpoint
ALTER TABLE "instruction_cards" ALTER COLUMN "position" SET NOT NULL;--> statement-breakpoint
ALTER SEQUENCE "instruction_card_position" OWNED BY "instruction_cards"."position";--> statement-breakpoint
ALTER TABLE "memos" ADD COLUMN "title" text;--> statement-breakpoint
ALTER TABLE "instruction_cards" ADD CONSTRAINT "instruction_cards_position" UNIQUE("user_id","position");--> statement-breakpoint
ALTER TABLE "memos" ADD CONSTRAINT "memos_title" CHECK ("memos"."title" IS NULL OR (char_length("memos"."title") BETWEEN 1 AND 120 AND position(chr(10) in "memos"."title")=0 AND position(chr(13) in "memos"."title")=0 AND btrim("memos"."title")="memos"."title"));--> statement-breakpoint
-- Membership no longer moves; a card's group is fixed when the card is created.
CREATE OR REPLACE FUNCTION milton_card_group_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
  PERFORM 1 FROM users WHERE id=NEW.user_id AND status='active' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='account_unavailable'; END IF;
  IF TG_OP='UPDATE' OR NEW.version<>1 THEN
    RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='card_group_conflict';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
-- Memo metadata stays immutable except one change: a title set once, from NULL,
-- together with new card versions (0005 body plus that single exception).
CREATE OR REPLACE FUNCTION milton_memo_guard() RETURNS trigger LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog, public AS $$
DECLARE lim jsonb;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF OLD.title IS NOT NULL OR NEW.title IS NULL
      OR (NEW.user_id, NEW.id, NEW.name, NEW.created_at) IS DISTINCT FROM (OLD.user_id, OLD.id, OLD.name, OLD.created_at) THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'memo_metadata_is_immutable';
    END IF;
    PERFORM 1 FROM users WHERE id = NEW.user_id AND status = 'active' FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'account_unavailable'; END IF;
    RETURN NEW;
  END IF;
  PERFORM 1 FROM users WHERE id = NEW.user_id AND status = 'active' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'account_unavailable'; END IF;
  SELECT limits_json INTO lim FROM store_config WHERE singleton = 1;
  IF octet_length(NEW.name) > COALESCE((lim->>'name_bytes')::integer, 0) THEN RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'memo_name_limit'; END IF;
  IF NEW.name <> 'vibes' AND (SELECT count(*) FROM memos WHERE user_id = NEW.user_id AND name <> 'vibes') >= COALESCE((lim->>'memos')::integer, 0) THEN RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'memo_count_limit'; END IF;
  RETURN NEW;
END $$;
