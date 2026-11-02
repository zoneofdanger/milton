-- Offline rollback. Stop writers first. Refuses when data the previous runtime
-- cannot carry exists: any sample, or a full report over the old 32 KB bound.
-- Card report assignments and the removal of empty groups are not restored; the
-- previous runtime ignores the report column and never read those groups.
BEGIN;
LOCK TABLE samples, instruction_cards, tps_reports, store_config IN ACCESS EXCLUSIVE MODE;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM samples) THEN
    RAISE EXCEPTION 'reports_rollback_requires_no_samples';
  END IF;
  IF EXISTS (SELECT 1 FROM tps_reports WHERE octet_length(body) > 32768) THEN
    RAISE EXCEPTION 'reports_rollback_requires_small_reports';
  END IF;
END $$;
DROP TRIGGER samples_guard ON samples;
DROP FUNCTION milton_sample_guard();
DROP TABLE samples;
ALTER TABLE instruction_cards DROP CONSTRAINT instruction_cards_report;
ALTER TABLE instruction_cards DROP COLUMN report;
ALTER TABLE tps_reports DROP CONSTRAINT tps_body_limit;
ALTER TABLE tps_reports ADD CONSTRAINT tps_body_limit CHECK (octet_length(body) <= 32768);
ALTER TABLE store_config ALTER COLUMN limits_json SET DEFAULT '{"memos":100,"body_bytes":32768,"name_bytes":64,"description_bytes":500,"reason_bytes":500,"history_bytes":67108864,"daily_calls":1000,"daily_writes":200,"request_bytes":65536,"page_size":50}'::jsonb;
UPDATE store_config SET limits_json=limits_json - 'report_body_bytes' WHERE singleton=1;
COMMIT;
