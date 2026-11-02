SET LOCAL lock_timeout='10s';
--> statement-breakpoint
ALTER TABLE "card_graphs" ADD COLUMN "pair_plan" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "card_graphs" ADD COLUMN "next_pair" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "card_graphs" ADD COLUMN "reviewed_pairs" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "card_graphs" ADD COLUMN "failed_pairs" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "card_graphs" ADD COLUMN "batch_log" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "card_graphs" ADD CONSTRAINT "card_graph_progress" CHECK (jsonb_typeof("card_graphs"."pair_plan")='array' AND jsonb_array_length("card_graphs"."pair_plan")<=128 AND "card_graphs"."next_pair">=0 AND "card_graphs"."next_pair"<=jsonb_array_length("card_graphs"."pair_plan") AND "card_graphs"."reviewed_pairs">=0 AND "card_graphs"."failed_pairs">=0 AND "card_graphs"."reviewed_pairs"+"card_graphs"."failed_pairs"="card_graphs"."next_pair" AND jsonb_typeof("card_graphs"."batch_log")='array' AND jsonb_array_length("card_graphs"."batch_log")<=32);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION milton_card_link_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
  PERFORM 1 FROM users WHERE id=NEW.user_id AND status='active' FOR UPDATE;
  IF NOT FOUND OR TG_OP='UPDATE' THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='card_link_invalid'; END IF;
  IF (SELECT count(*) FROM card_links WHERE user_id=NEW.user_id)>=128
    OR EXISTS(SELECT 1 FROM card_links WHERE user_id=NEW.user_id AND from_id=NEW.to_id AND to_id=NEW.from_id)
    OR NOT EXISTS(SELECT 1 FROM card_graphs g JOIN tps_reports r USING(user_id)
      WHERE g.user_id=NEW.user_id AND g.status='ready' AND g.source_hash=NEW.source_hash AND r.source_hash=g.source_hash)
    OR NOT EXISTS(SELECT 1 FROM instruction_card_versions v WHERE v.user_id=NEW.user_id AND v.card_id=NEW.from_id AND v.version=NEW.from_version AND NOT v.archived
      AND position(NEW.from_quote IN v.body)>0 AND NOT EXISTS(SELECT 1 FROM instruction_card_versions n WHERE n.user_id=v.user_id AND n.card_id=v.card_id AND n.version>v.version))
    OR NOT EXISTS(SELECT 1 FROM instruction_card_versions v WHERE v.user_id=NEW.user_id AND v.card_id=NEW.to_id AND v.version=NEW.to_version AND NOT v.archived
      AND position(NEW.to_quote IN v.body)>0 AND NOT EXISTS(SELECT 1 FROM instruction_card_versions n WHERE n.user_id=v.user_id AND n.card_id=v.card_id AND n.version>v.version))
  THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='card_link_invalid'; END IF;
  RETURN NEW;
END $$;
