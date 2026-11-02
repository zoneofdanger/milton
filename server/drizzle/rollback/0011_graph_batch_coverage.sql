-- Stop/drain derived workers; only replaceable graph caches are cleared.
BEGIN;
SET LOCAL lock_timeout='10s';
LOCK TABLE card_graphs,card_links IN ACCESS EXCLUSIVE MODE;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM card_graphs WHERE status='running' AND lease_until>clock_timestamp()) THEN RAISE EXCEPTION 'derivation_workers_running'; END IF;
END $$;
DELETE FROM card_graphs;
ALTER TABLE card_graphs DROP CONSTRAINT card_graph_progress;
ALTER TABLE card_graphs DROP COLUMN pair_plan, DROP COLUMN next_pair, DROP COLUMN reviewed_pairs, DROP COLUMN failed_pairs, DROP COLUMN batch_log;
CREATE OR REPLACE FUNCTION milton_card_link_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
  PERFORM 1 FROM users WHERE id=NEW.user_id AND status='active' FOR UPDATE;
  IF NOT FOUND OR TG_OP='UPDATE' THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='card_link_invalid'; END IF;
  IF (SELECT count(*) FROM card_links WHERE user_id=NEW.user_id)>=8
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

COMMIT;
