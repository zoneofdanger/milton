-- Rollback of 0025_stripe_billing. Offline; stop writers first. A runtime
-- rollback does not need this: code before 0025 ignores the ledger and the
-- customer column, so keep both and their rows. Dropping them loses every link
-- from an account to its Stripe customer and the record of applied events, so
-- refuse while any customer id or event is recorded. Run as neondb_owner. The
-- 0025 journal row stays, so re-forwarding means running 0025_stripe_billing.sql
-- by hand.
BEGIN;
SET LOCAL lock_timeout = '10s';
LOCK TABLE trial_accounts, stripe_events IN ACCESS EXCLUSIVE MODE;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM trial_accounts WHERE stripe_customer_id IS NOT NULL) THEN
    RAISE EXCEPTION 'stripe_billing_rollback_requires_no_customers';
  END IF;
  IF EXISTS (SELECT 1 FROM stripe_events) THEN
    RAISE EXCEPTION 'stripe_billing_rollback_requires_no_events';
  END IF;
END $$;
ALTER TABLE trial_accounts DROP CONSTRAINT trial_stripe_customer;
ALTER TABLE trial_accounts DROP CONSTRAINT trial_accounts_stripe_customer_id_unique;
ALTER TABLE trial_accounts DROP COLUMN stripe_customer_id;
DROP TABLE stripe_events;
COMMIT;
