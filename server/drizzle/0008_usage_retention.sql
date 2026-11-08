-- Usage retention, and the retired daily allowance's leftovers. Since PR #40 nothing
-- reads or writes usage_daily or the stored daily_calls key; app/MCP code before #40
-- reads both and requires daily_calls, so apply only while code from #40 or later serves
-- (and roll app/MCP back no further than #40 unless the snapshot is restored first).
-- Grants: migrations/010-usage-retention-roles.sql. Rollback is the pre-migration
-- snapshot; there is no down script.
-- Every statement is a catalog change or touches a small table. The DROP briefly takes
-- an exclusive lock on users (its foreign key's triggers) and the index build a share
-- lock on usage_calls (appends wait for it; each reply waits at most 250 ms), so a lock
-- that is not free within 5 s fails this migration instead of queueing requests.
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
-- Lets the prune read the oldest rows first and stop after its batch, instead of
-- scanning the table on every batch (usage_calls_by_user leads with the account). One
-- more index entry per append.
CREATE INDEX "usage_calls_by_at" ON "usage_calls" USING btree ("at");--> statement-breakpoint
ALTER TABLE "store_config" ALTER COLUMN "limits_json" SET DEFAULT '{"body_bytes":131072,"description_bytes":500,"reason_bytes":500,"report_body_bytes":262144}'::jsonb;--> statement-breakpoint
-- Idempotent: a row without the key is left as it is.
UPDATE store_config SET limits_json = limits_json - 'daily_calls'
WHERE singleton = 1 AND limits_json ? 'daily_calls';
--> statement-breakpoint
-- Deletes at most p_batch usage rows older than 90 days, oldest first, and returns how
-- many. Retention is 90 days (Peter, 2026-11-08): a quarter of per-call history is
-- enough to review usage, and older rows only keep account activity longer. It lives
-- here, not in the caller, so the one role that may run this cannot shorten it. Rows an
-- account erasure has locked are skipped (SKIP LOCKED), never waited on; the next run
-- takes them if they survive. The usage writer and saves only insert rows and lock
-- users, which this never does. SECURITY DEFINER as the table owner with a fixed
-- search path and qualified names: the caller needs no table privilege.
CREATE FUNCTION public.prune_usage_calls(p_batch integer) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE removed integer;
BEGIN
 IF p_batch IS NULL OR p_batch NOT BETWEEN 1 AND 10000 THEN
  RAISE EXCEPTION USING ERRCODE='22023', MESSAGE='usage_prune_batch_invalid';
 END IF;
 DELETE FROM public.usage_calls WHERE ctid = ANY (ARRAY(
  SELECT ctid FROM public.usage_calls
  WHERE at < pg_catalog.now() - interval '90 days'
  ORDER BY at LIMIT p_batch FOR UPDATE SKIP LOCKED));
 GET DIAGNOSTICS removed = ROW_COUNT;
 RETURN removed;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.prune_usage_calls(integer) FROM PUBLIC;
--> statement-breakpoint
-- No CASCADE: an unexpected dependent fails this migration instead of being dropped
-- with it. Its grants go with it.
DROP TABLE "usage_daily";
