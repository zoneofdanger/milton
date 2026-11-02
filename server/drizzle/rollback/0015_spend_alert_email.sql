-- Only before any delivery ledger exists. After activation, disable email config
-- and roll back the runtime while retaining this additive table and all identities.
-- Never delete sent/unknown/failed records to retry: Resend keys expire after 24h.
BEGIN;
LOCK TABLE spend_alert_emails IN ACCESS EXCLUSIVE MODE;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM spend_alert_emails) THEN
    RAISE EXCEPTION 'retain_spend_alert_email_delivery_history';
  END IF;
END $$;
DROP TABLE spend_alert_emails;
DROP FUNCTION guard_spend_alert_email();
COMMIT;
