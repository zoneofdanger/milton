-- Sample labels and ranking (Peter, 2026-11-04). A report read serves eight
-- samples ranked by label overlap with the assistant's intent, then full-text
-- rank, then recency. Adds three optional labels to samples, chosen by the saving
-- assistant from fixed lists and compared for equality only: audience, purpose
-- and register (nullable text, one CHECK, samples_labels). Samples saved before
-- 0033 stay unlabeled; there is no backfill. Adds search, a stored generated
-- tsvector of context and body, so a read ranks without parsing every body
-- again; adding it rewrites samples once. No GIN index: the read ranks every
-- active sample of one report (samples_by_report narrows it) and filters on no
-- text match, so an index would never be used. The append-only guard now holds
-- the labels as it holds every other stored field. Additive: the previous
-- revision names its columns, so it runs on this schema. Released before the
-- code that reads it; see deploy/README.md "Sample labels (0033)".
-- rollback/0033_sample_labels.sql drops what this adds.
SET LOCAL lock_timeout = '10s';
--> statement-breakpoint
LOCK TABLE "samples" IN ACCESS EXCLUSIVE MODE;
--> statement-breakpoint
ALTER TABLE "samples" ADD COLUMN "audience" text;--> statement-breakpoint
ALTER TABLE "samples" ADD COLUMN "purpose" text;--> statement-breakpoint
ALTER TABLE "samples" ADD COLUMN "register" text;--> statement-breakpoint
ALTER TABLE "samples" ADD COLUMN "search" "tsvector" GENERATED ALWAYS AS (to_tsvector('english'::regconfig, context || ' ' || body)) STORED;--> statement-breakpoint
ALTER TABLE "samples" ADD CONSTRAINT "samples_labels" CHECK (("samples"."audience" IS NULL OR "samples"."audience" IN ('client','boss','colleague','friend','public','other')) AND ("samples"."purpose" IS NULL OR "samples"."purpose" IN ('decline','ask','thank','update','announce','apologize','introduce','follow up','other')) AND ("samples"."register" IS NULL OR "samples"."register" IN ('formal','plain','casual')));--> statement-breakpoint
-- A sample is never rewritten or removed; the only change is retirement: its
-- time, reason and request, set once and together. Labels never change either.
-- Rows leave only with their account.
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
      OR (NEW.user_id,NEW.id,NEW.report,NEW.kind_id,NEW.context,NEW.body,NEW.client_json,NEW.replaces_id,NEW.created_at,NEW.audience,NEW.purpose,NEW.register)
        IS DISTINCT FROM (OLD.user_id,OLD.id,OLD.report,OLD.kind_id,OLD.context,OLD.body,OLD.client_json,OLD.replaces_id,OLD.created_at,OLD.audience,OLD.purpose,OLD.register) THEN
      RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='sample_is_append_only';
    END IF;
    RETURN NEW;
  END IF;
  PERFORM 1 FROM users WHERE id=NEW.user_id AND status='active' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='account_unavailable'; END IF;
  RETURN NEW;
END $$;
