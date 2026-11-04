-- Rollback of 0026_stripe_billing. Offline; stop writers first. Code before 0026
-- can run on this schema, ignoring the ledger and the new columns, but with trials
-- on it gates on the retired started_at clock and refuses paying customers, so
-- there is no traffic rollback to it once trials are on. Before then, a runtime
-- rollback does not need this script. Dropping these loses every link from an
-- account to its Stripe customer and subscription and the record of applied
-- events, so refuse while any customer id or event is recorded. The 'canceled'
-- marks on returning deleted identities go too. Rows written before this code
-- keep started_at before created_at, so re-forwarding marks them again; rows
-- written since do not, so those accounts lose the mark for good and a second
-- trial is possible. Run as neondb_owner. The 0026 journal row stays, so re-forwarding means running
-- 0026_stripe_billing.sql by hand.
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
