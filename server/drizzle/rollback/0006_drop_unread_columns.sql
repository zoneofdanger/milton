-- Rollback of 0006. Restores save_requests.source_hash NOT NULL and re-adds the three
-- generated payload_bytes columns with their 0000_baseline definitions (each re-add
-- rewrites its table and recomputes every row; table grants cover the new columns).
-- Old app/MCP code runs on either schema, so this is never needed to roll code back. It
-- refuses, changing nothing, once a save from code that no longer writes source_hash
-- left a receipt without it: such a receipt cannot get its original value, and the
-- save_requests payload_bytes expression needs one. Roll app/MCP back first, or code
-- that omits source_hash fails every save. Run as neondb_owner:
-- psql -X -v ON_ERROR_STOP=1 -f this file. The 0006 journal row stays, so re-forwarding
-- means running 0006_drop_unread_columns.sql by hand, as one transaction:
-- psql -1 -X -v ON_ERROR_STOP=1 -f server/drizzle/0006_drop_unread_columns.sql
BEGIN;
LOCK TABLE save_requests IN ACCESS EXCLUSIVE MODE;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM public.save_requests WHERE source_hash IS NULL) THEN
  RAISE EXCEPTION 'rollback_0006_refused: a save receipt has no source_hash';
 END IF;
END $$;
ALTER TABLE "save_requests" ALTER COLUMN "source_hash" SET NOT NULL;
ALTER TABLE "accepted_changes" ADD COLUMN "payload_bytes" bigint GENERATED ALWAYS AS (octet_length(request_id)::bigint + octet_length(operation) + octet_length(request_json::text) + octet_length(actor_json::text) + octet_length(transformation_json::text) + octet_length(affected_json::text) + octet_length(before_tps) + octet_length(after_tps) + octet_length(before_source) + octet_length(after_source) + 128) STORED NOT NULL;
ALTER TABLE "instruction_card_versions" ADD COLUMN "payload_bytes" bigint GENERATED ALWAYS AS (octet_length(description)::bigint + octet_length(body) + octet_length(reason) + octet_length(actor_json) + octet_length(details_json)) STORED NOT NULL;
ALTER TABLE "save_requests" ADD COLUMN "payload_bytes" bigint GENERATED ALWAYS AS (octet_length(request_id)::bigint + octet_length(input_hash) + octet_length(source_hash) + 2048 + 128) STORED NOT NULL;
COMMIT;
