-- Restore parked evidence without rewriting it or refunding retained bytes.
DO $$ BEGIN
 IF to_regclass('milton_rollback.accepted_changes') IS NOT NULL THEN
  ALTER TABLE milton_rollback.accepted_changes SET SCHEMA public;
 END IF;
END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "accepted_changes" (
	"user_id" text NOT NULL,
	"request_id" text NOT NULL,
	"operation" text NOT NULL,
	"request_json" jsonb NOT NULL,
	"actor_json" jsonb NOT NULL,
	"transformation_json" jsonb NOT NULL,
	"affected_json" jsonb NOT NULL,
	"before_tps" text NOT NULL,
	"after_tps" text NOT NULL,
	"before_source" text NOT NULL,
	"after_source" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"payload_bytes" bigint GENERATED ALWAYS AS (octet_length(request_id)::bigint + octet_length(operation) + octet_length(request_json::text) + octet_length(actor_json::text) + octet_length(transformation_json::text) + octet_length(affected_json::text) + octet_length(before_tps) + octet_length(after_tps) + octet_length(before_source) + octet_length(after_source) + 128) STORED NOT NULL,
	CONSTRAINT "accepted_changes_user_id_request_id_pk" PRIMARY KEY("user_id","request_id"),
	CONSTRAINT "accepted_change_shape" CHECK (length("accepted_changes"."request_id")=36 AND "accepted_changes"."operation" IN ('save_memo','refinement_apply') AND jsonb_typeof("accepted_changes"."request_json")='object' AND jsonb_typeof("accepted_changes"."actor_json")='object' AND jsonb_typeof("accepted_changes"."transformation_json")='object' AND jsonb_typeof("accepted_changes"."affected_json")='array' AND jsonb_array_length("accepted_changes"."affected_json")<=100),
	CONSTRAINT "accepted_change_hashes" CHECK ("accepted_changes"."before_tps" ~ '^[a-f0-9]{64}$' AND "accepted_changes"."after_tps" ~ '^[a-f0-9]{64}$' AND "accepted_changes"."before_source" ~ '^[a-f0-9]{64}$' AND "accepted_changes"."after_source" ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='accepted_changes'::regclass AND conname='accepted_changes_user_id_users_id_fk') THEN
  ALTER TABLE accepted_changes ADD CONSTRAINT accepted_changes_user_id_users_id_fk FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE;
 END IF;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION milton_accepted_change_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE item jsonb; ids text[] := ARRAY[]::text[];
BEGIN
 IF TG_OP='DELETE' THEN
  IF EXISTS(SELECT 1 FROM users WHERE id=OLD.user_id) THEN RAISE EXCEPTION 'accepted_change_is_immutable'; END IF;
  RETURN OLD;
 END IF;
 IF TG_OP='UPDATE' THEN RAISE EXCEPTION 'accepted_change_is_immutable'; END IF;
 PERFORM 1 FROM users WHERE id=NEW.user_id AND status='active' FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='account_unavailable'; END IF;
 FOR item IN SELECT value FROM jsonb_array_elements(NEW.affected_json) LOOP
  IF item->>'id'=ANY(ids) OR NOT EXISTS(SELECT 1 FROM instruction_card_versions WHERE user_id=NEW.user_id AND card_id=item->>'id' AND version=(item->>'after')::int)
    OR (item->>'before' IS NOT NULL AND (NOT EXISTS(SELECT 1 FROM instruction_card_versions WHERE user_id=NEW.user_id AND card_id=item->>'id' AND version=(item->>'before')::int) OR (item->>'before')::int >= (item->>'after')::int)) THEN
   RAISE EXCEPTION 'accepted_change_reference_invalid';
  END IF;
  ids := array_append(ids,item->>'id');
 END LOOP;
 RETURN NEW;
END $$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS accepted_changes_guard ON accepted_changes;
--> statement-breakpoint
CREATE TRIGGER accepted_changes_guard BEFORE INSERT OR UPDATE OR DELETE ON accepted_changes FOR EACH ROW EXECUTE FUNCTION milton_accepted_change_guard();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION milton_accepted_change_bytes() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE retained bigint; lim jsonb;
BEGIN
 IF TG_OP='DELETE' THEN
  UPDATE users SET retained_bytes=retained_bytes-OLD.payload_bytes WHERE id=OLD.user_id;
  RETURN OLD;
 END IF;
 UPDATE users SET retained_bytes=retained_bytes+NEW.payload_bytes WHERE id=NEW.user_id RETURNING retained_bytes INTO retained;
 SELECT limits_json INTO lim FROM store_config WHERE singleton=1;
 IF retained>(lim->>'history_bytes')::bigint THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='memo_history_limit'; END IF;
 RETURN NEW;
END $$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS accepted_changes_bytes ON accepted_changes;
--> statement-breakpoint
CREATE TRIGGER accepted_changes_bytes AFTER INSERT OR DELETE ON accepted_changes FOR EACH ROW EXECUTE FUNCTION milton_accepted_change_bytes();
