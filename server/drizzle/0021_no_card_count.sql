-- No count limit on cards or legacy memos. Archived cards are never deleted, so the
-- card count capped an account's lifetime saves; saves stay bounded by the daily
-- memo-update cap (hosted), the tool-call rate limit and the byte caps.
-- Every other check is unchanged: card identity stays immutable, writes need an
-- active account, and legacy memo names keep their byte cap. The vibes exception
-- existed only for the counts and goes with them. limits_json.memos stays, unread.
CREATE OR REPLACE FUNCTION milton_card_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
  IF TG_OP='UPDATE' THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='card_identity_is_immutable'; END IF;
  PERFORM 1 FROM users WHERE id=NEW.user_id AND status='active' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='account_unavailable'; END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION milton_memo_guard() RETURNS trigger LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog, public AS $$
DECLARE lim jsonb;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF OLD.title IS NOT NULL OR NEW.title IS NULL
      OR (NEW.user_id, NEW.id, NEW.name, NEW.created_at) IS DISTINCT FROM (OLD.user_id, OLD.id, OLD.name, OLD.created_at) THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'memo_metadata_is_immutable';
    END IF;
    PERFORM 1 FROM users WHERE id = NEW.user_id AND status = 'active' FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'account_unavailable'; END IF;
    RETURN NEW;
  END IF;
  PERFORM 1 FROM users WHERE id = NEW.user_id AND status = 'active' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'account_unavailable'; END IF;
  SELECT limits_json INTO lim FROM store_config WHERE singleton = 1;
  IF octet_length(NEW.name) > COALESCE((lim->>'name_bytes')::integer, 0) THEN RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'memo_name_limit'; END IF;
  RETURN NEW;
END $$;
