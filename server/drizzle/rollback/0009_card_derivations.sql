-- Disable and drain derived workers first. Source/card/TPS/history stay intact.
-- Derived caches are rebuildable. Keep spending so rollback cannot refund calls.
BEGIN;
SET LOCAL lock_timeout = '10s';
LOCK TABLE card_embeddings,card_graphs,card_links,derivation_usage IN ACCESS EXCLUSIVE MODE;
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM card_embeddings WHERE status='running' AND lease_until>clock_timestamp())
    OR EXISTS(SELECT 1 FROM card_graphs WHERE status='running' AND lease_until>clock_timestamp()) THEN
    RAISE EXCEPTION 'derivation_workers_running';
  END IF;
END $$;
CREATE SCHEMA IF NOT EXISTS milton_rollback;
CREATE TABLE IF NOT EXISTS milton_rollback.derivation_usage (LIKE public.derivation_usage INCLUDING ALL);
INSERT INTO milton_rollback.derivation_usage SELECT * FROM public.derivation_usage
  ON CONFLICT(user_id,day_utc) DO UPDATE SET reserved_micros=greatest(milton_rollback.derivation_usage.reserved_micros,excluded.reserved_micros);
DROP TABLE card_links,card_graphs,card_embeddings,derivation_usage;
DROP FUNCTION milton_card_link_guard();
-- vector is a shared extension; never drop it here.
COMMIT;
