-- Offline rollback. Stop writers first. A runtime rollback does not need this:
-- the previous runtime ignores both tables, so keep them and their rows (then
-- those refusals and no-second-trial marks simply stop applying until the
-- current runtime returns). Dropping them loses every recorded disconnect and
-- every deleted-identity fingerprint, so refuse while any row is recorded.
BEGIN;
LOCK TABLE assistant_disconnects, deleted_identities IN ACCESS EXCLUSIVE MODE;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM assistant_disconnects) THEN
    RAISE EXCEPTION 'assistant_disconnects_rollback_requires_no_disconnects';
  END IF;
  IF EXISTS (SELECT 1 FROM deleted_identities) THEN
    RAISE EXCEPTION 'deleted_identities_rollback_requires_no_deleted_identities';
  END IF;
END $$;
DROP TABLE deleted_identities;
DROP TABLE assistant_disconnects;
COMMIT;
