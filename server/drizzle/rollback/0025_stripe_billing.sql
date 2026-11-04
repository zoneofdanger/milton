-- Rollback of 0025_stripe_billing. Offline; stop writers first. A runtime
-- rollback does not need this: code before 0025 ignores the ledger and the new
-- columns, so keep them and their rows. Dropping them loses every link from an
-- account to its Stripe customer and subscription and the record of applied
-- events, so refuse while any customer id or event is recorded. The 'canceled'
-- marks on returning deleted identities go too; started_at still records them
-- for the code before 0025, and re-forwarding marks them again. Run as
-- neondb_owner. The 0025 journal row stays, so re-forwarding means running
-- 0025_stripe_billing.sql by hand.
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
ALTER TABLE trial_accounts DROP CONSTRAINT trial_stripe_dates;
ALTER TABLE trial_accounts DROP CONSTRAINT trial_subscription_status;
ALTER TABLE trial_accounts DROP CONSTRAINT trial_stripe_subscription;
ALTER TABLE trial_accounts DROP CONSTRAINT trial_stripe_customer;
ALTER TABLE trial_accounts DROP CONSTRAINT trial_accounts_stripe_subscription_id_unique;
ALTER TABLE trial_accounts DROP CONSTRAINT trial_accounts_stripe_customer_id_unique;
ALTER TABLE trial_accounts DROP COLUMN current_period_end;
ALTER TABLE trial_accounts DROP COLUMN current_period_start;
ALTER TABLE trial_accounts DROP COLUMN trial_end;
ALTER TABLE trial_accounts DROP COLUMN subscription_status;
ALTER TABLE trial_accounts DROP COLUMN stripe_subscription_id;
ALTER TABLE trial_accounts DROP COLUMN stripe_customer_id;
DROP TABLE stripe_events;
COMMIT;
