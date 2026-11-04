-- Stripe billing, additive. stripe_events is the webhook ledger: one row per
-- applied Stripe event id (id, type, received_at and a sha256 of the raw body,
-- never the payload), so a redelivered event changes nothing.
-- trial_accounts.stripe_customer_id links the clock row to its Stripe customer;
-- checkout sets it before Stripe sees the account, and the webhook finds the
-- row by it. Nullable, unique, no default: existing rows are unchanged.
-- milton_runtime gets SELECT, INSERT and UPDATE on stripe_events through the
-- 0024 default privileges and no DELETE; its table grant on trial_accounts
-- (SELECT, INSERT, UPDATE) covers the new column. Code that reads either ships
-- after this migration; code before it ignores both.
-- rollback/0025_stripe_billing.sql drops both while nothing is recorded.
SET LOCAL lock_timeout = '10s';
--> statement-breakpoint
CREATE TABLE "stripe_events" (
	"id" text PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"payload_sha256" text NOT NULL,
	CONSTRAINT "stripe_event_shape" CHECK ("stripe_events"."id" ~ '^evt_[A-Za-z0-9]{1,251}$' AND char_length("stripe_events"."type") BETWEEN 1 AND 128 AND "stripe_events"."payload_sha256" ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
ALTER TABLE "trial_accounts" ADD COLUMN "stripe_customer_id" text;--> statement-breakpoint
ALTER TABLE "trial_accounts" ADD CONSTRAINT "trial_accounts_stripe_customer_id_unique" UNIQUE("stripe_customer_id");--> statement-breakpoint
ALTER TABLE "trial_accounts" ADD CONSTRAINT "trial_stripe_customer" CHECK ("trial_accounts"."stripe_customer_id" IS NULL OR "trial_accounts"."stripe_customer_id" ~ '^cus_[A-Za-z0-9]{1,251}$');
