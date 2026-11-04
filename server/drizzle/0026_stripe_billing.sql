-- Stripe billing, additive. Stripe owns the trial and the subscription; Milton
-- keeps a copy of their current state, written by sign-up and by the webhook.
-- stripe_events is the webhook ledger: one row per recorded Stripe event id (id,
-- type, received_at and a sha256 of the raw body, never the payload), so a
-- redelivered event changes nothing.
-- trial_accounts gains the Stripe customer and subscription ids, the subscription
-- status (any value Stripe sends, bounded by length only), trial_end and the
-- current period. All nullable with no default: a NULL status is an account with
-- no subscription yet, which the gate allows. The webhook finds a row by its
-- customer. started_at and paid_through stay in place, unread by the gate.
-- The one data statement marks returning deleted identities (started_at before
-- the account's created_at, written by sign-up so they get no second trial)
-- canceled, because the gate no longer reads started_at. It runs while no code
-- that writes these columns exists, so it touches no Stripe state.
-- milton_runtime gets SELECT, INSERT and UPDATE on stripe_events through the
-- 0024 default privileges and no DELETE; its table grant on trial_accounts
-- (SELECT, INSERT, UPDATE) covers the new columns. Code that reads any of this
-- ships after this migration; code before it ignores all of it.
-- rollback/0026_stripe_billing.sql drops it all while nothing is recorded.
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
ALTER TABLE "trial_accounts" ADD COLUMN "stripe_subscription_id" text;--> statement-breakpoint
ALTER TABLE "trial_accounts" ADD COLUMN "subscription_status" text;--> statement-breakpoint
ALTER TABLE "trial_accounts" ADD COLUMN "trial_end" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "trial_accounts" ADD COLUMN "current_period_start" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "trial_accounts" ADD COLUMN "current_period_end" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "trial_accounts" ADD CONSTRAINT "trial_accounts_stripe_customer_id_unique" UNIQUE("stripe_customer_id");--> statement-breakpoint
ALTER TABLE "trial_accounts" ADD CONSTRAINT "trial_accounts_stripe_subscription_id_unique" UNIQUE("stripe_subscription_id");--> statement-breakpoint
ALTER TABLE "trial_accounts" ADD CONSTRAINT "trial_stripe_customer" CHECK ("trial_accounts"."stripe_customer_id" IS NULL OR "trial_accounts"."stripe_customer_id" ~ '^cus_[A-Za-z0-9]{1,251}$');--> statement-breakpoint
ALTER TABLE "trial_accounts" ADD CONSTRAINT "trial_stripe_subscription" CHECK ("trial_accounts"."stripe_subscription_id" IS NULL OR "trial_accounts"."stripe_subscription_id" ~ '^sub_[A-Za-z0-9]{1,251}$');--> statement-breakpoint
ALTER TABLE "trial_accounts" ADD CONSTRAINT "trial_subscription_status" CHECK ("trial_accounts"."subscription_status" IS NULL OR char_length("trial_accounts"."subscription_status") BETWEEN 1 AND 64);--> statement-breakpoint
ALTER TABLE "trial_accounts" ADD CONSTRAINT "trial_stripe_dates" CHECK (("trial_accounts"."trial_end" IS NULL OR isfinite("trial_accounts"."trial_end")) AND ("trial_accounts"."current_period_start" IS NULL OR isfinite("trial_accounts"."current_period_start")) AND ("trial_accounts"."current_period_end" IS NULL OR isfinite("trial_accounts"."current_period_end")));--> statement-breakpoint
UPDATE "trial_accounts" t SET "subscription_status" = 'canceled'
FROM "users" u WHERE u."id" = t."user_id" AND t."started_at" < u."created_at";
