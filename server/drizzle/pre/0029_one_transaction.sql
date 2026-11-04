-- Pre-step for 0029, run as neondb_owner before the one-transaction code ships.
-- That code writes each receipt once, with its result, and names none of
-- completed, deadline or claimed_at; deadline is NOT NULL without a default.
-- The claim trigger fills them for such a receipt: complete, its deadline its
-- claim time. A receipt inserted without a result, as every earlier revision
-- claims, is unchanged, so the running revision is unaffected and either
-- revision replays the other's receipts. 0029 drops this function with the
-- columns; rollback/0029_one_transaction.sql restores this form.
BEGIN;
SET LOCAL lock_timeout = '5s';
CREATE OR REPLACE FUNCTION milton_claim_clock() RETURNS trigger LANGUAGE plpgsql VOLATILE SET search_path=pg_catalog,public AS $$
BEGIN
  NEW.claimed_at := coalesce(NEW.claimed_at,clock_timestamp());
  NEW.created_at := NEW.claimed_at;
  IF NEW.result_json->>'status' IS NOT NULL THEN
    NEW.completed := true;
    NEW.deadline := coalesce(NEW.deadline,NEW.created_at);
  END IF;
  RETURN NEW;
END $$;
COMMIT;
