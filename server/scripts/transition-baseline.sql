-- One-time transition from the exact 34-entry 0033 journal to 0000_baseline.
-- Snapshot first, stop writers, then run as neondb_owner with psql -X -v ON_ERROR_STOP=1.
-- This single DO statement is atomic, including DDL and journal replacement.
-- No earlier schema is supported. Recovery uses the required pre-cleanup snapshot.
DO $transition$
DECLARE journal_count bigint; journal_fingerprint text;
BEGIN
  IF current_user <> 'neondb_owner' THEN
    RAISE EXCEPTION 'baseline_transition_requires_neondb_owner';
  END IF;
  PERFORM set_config('lock_timeout','10s',true);
  IF to_regclass('drizzle.__drizzle_migrations') IS NULL THEN
    RAISE EXCEPTION 'baseline_transition_requires_exact_0033_journal';
  END IF;
  LOCK TABLE drizzle.__drizzle_migrations IN ACCESS EXCLUSIVE MODE;
  SELECT count(*),md5(string_agg(created_at::text || ':' || hash,',' ORDER BY created_at))
    INTO journal_count,journal_fingerprint FROM drizzle.__drizzle_migrations;
  IF journal_count=1 AND EXISTS (SELECT 1 FROM drizzle.__drizzle_migrations
    WHERE created_at=1793815543500 AND hash='4167000e0d8550aa7f2852d648a176a841a5a6d7a01a763d7e73822fc7c48735') THEN
    RAISE NOTICE 'baseline_transition_already_done';
    RETURN;
  END IF;
  IF journal_count<>34 OR journal_fingerprint IS DISTINCT FROM '1adc61224f4900f74d3c535f9dd6382b' THEN
    RAISE EXCEPTION USING MESSAGE='baseline_transition_requires_exact_0033_journal',
      HINT='Expected the unmodified 34-entry journal through 0033 (1793779058436). Stop and inspect the database; do not edit the journal to bypass this check.';
  END IF;
  -- Same order as saves: account, configuration, then the version tables.
  LOCK TABLE users IN ACCESS EXCLUSIVE MODE;
  LOCK TABLE store_config,instruction_cards,instruction_card_versions,memo_cards,memo_versions,memos IN ACCESS EXCLUSIVE MODE;
  CREATE OR REPLACE FUNCTION public.milton_card_version_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE head integer; lim jsonb;
BEGIN
  IF TG_OP='UPDATE' THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='card_version_is_immutable'; END IF;
  IF TG_OP='DELETE' THEN
    IF EXISTS (SELECT 1 FROM instruction_cards WHERE user_id=OLD.user_id AND id=OLD.card_id) THEN
      RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='card_version_is_immutable';
    END IF;
    RETURN OLD;
  END IF;
  PERFORM 1 FROM users WHERE id=NEW.user_id AND status='active' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='account_unavailable'; END IF;
  SELECT max(version) INTO head FROM instruction_card_versions WHERE user_id=NEW.user_id AND card_id=NEW.card_id;
  IF NEW.version <> coalesce(head,0)+1 THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='card_version_conflict'; END IF;
  SELECT limits_json INTO lim FROM store_config WHERE singleton=1;
  IF octet_length(NEW.body) > (lim->>'body_bytes')::int THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='memo_body_limit'; END IF;
  IF octet_length(NEW.description) > (lim->>'description_bytes')::int THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='memo_description_limit'; END IF;
  IF octet_length(NEW.reason) > (lim->>'reason_bytes')::int THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='memo_reason_limit'; END IF;
  RETURN NEW;
END $function$;
  DROP TABLE memo_cards;
  DROP TABLE memo_versions;
  DROP TABLE memos;
  DROP FUNCTION milton_card_group_guard();
  DROP FUNCTION milton_legacy_card_append();
  DROP FUNCTION milton_legacy_card_delete();
  DROP FUNCTION milton_memo_guard();
  DROP FUNCTION milton_memo_version_guard();
  ALTER TABLE instruction_card_versions DROP COLUMN legacy;
  ALTER TABLE store_config ALTER COLUMN limits_json SET DEFAULT '{"body_bytes":131072,"description_bytes":500,"reason_bytes":500,"report_body_bytes":262144,"daily_calls":10000}'::jsonb;
  UPDATE store_config SET limits_json=limits_json
    - 'name_bytes' - 'memos' - 'daily_writes' - 'request_bytes' - 'page_size' - 'history_bytes'
    WHERE singleton=1;
  DELETE FROM drizzle.__drizzle_migrations;
  INSERT INTO drizzle.__drizzle_migrations(hash,created_at)
    VALUES ('4167000e0d8550aa7f2852d648a176a841a5a6d7a01a763d7e73822fc7c48735',1793815543500);
END $transition$;
