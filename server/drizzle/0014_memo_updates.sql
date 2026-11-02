-- Expand only. The shared lock and receipt write fence protect the initial seed.
-- Historical receipt dates are preserved, including unrecoverable prior misdating.
SET LOCAL lock_timeout='10s';
--> statement-breakpoint
SELECT singleton FROM store_config WHERE singleton=1 FOR UPDATE;
--> statement-breakpoint
LOCK TABLE save_requests IN ACCESS EXCLUSIVE MODE;
--> statement-breakpoint
CREATE TABLE "foreground_usage" (
	"day_utc" date PRIMARY KEY NOT NULL,
	"reserved_micros" bigint NOT NULL,
	CONSTRAINT "foreground_usage_cost" CHECK ("foreground_usage"."reserved_micros">=0)
);
--> statement-breakpoint
CREATE TABLE "spend_alerts" (
	"id" text NOT NULL,
	"day_utc" date NOT NULL,
	"metric" text NOT NULL,
	"threshold_micros" bigint NOT NULL,
	"filing_micros" bigint NOT NULL,
	"review_micros" bigint NOT NULL,
	"derived_micros" bigint NOT NULL,
	"status" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"published_at" timestamp with time zone,
	CONSTRAINT "spend_alerts_day_utc_metric_threshold_micros_pk" PRIMARY KEY("day_utc","metric","threshold_micros"),
	CONSTRAINT "spend_alerts_id_unique" UNIQUE("id"),
	CONSTRAINT "spend_alert_metric" CHECK ("spend_alerts"."metric"='model_reservations'),
	CONSTRAINT "spend_alert_id" CHECK ("spend_alerts"."id" ~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'),
	CONSTRAINT "spend_alert_cost" CHECK ("spend_alerts"."threshold_micros">0 AND "spend_alerts"."filing_micros">=0 AND "spend_alerts"."review_micros">=0 AND "spend_alerts"."derived_micros">=0),
	CONSTRAINT "spend_alert_publication" CHECK (("spend_alerts"."status"='published' AND "spend_alerts"."published_at" IS NOT NULL) OR ("spend_alerts"."status"='covered' AND "spend_alerts"."published_at" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "store_config" DROP CONSTRAINT "config_derivation_budget";--> statement-breakpoint
ALTER TABLE "save_requests" ADD COLUMN "claimed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "save_requests" ADD COLUMN "memo_update_day" date;--> statement-breakpoint
ALTER TABLE "save_requests" ADD COLUMN "memo_update_state" text DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE "store_config" ADD COLUMN "global_spend_policy" text DEFAULT 'capped' NOT NULL;--> statement-breakpoint
ALTER TABLE "store_config" ADD COLUMN "foreground_accounting_ready" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "store_config" ADD COLUMN "memo_updates_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "store_config" ADD COLUMN "memo_updates_daily_limit" integer DEFAULT 100 NOT NULL;--> statement-breakpoint
CREATE INDEX "spend_alerts_published" ON "spend_alerts" USING btree ("published_at");--> statement-breakpoint
CREATE INDEX "save_requests_memo_updates" ON "save_requests" USING btree ("user_id","memo_update_day") WHERE "save_requests"."memo_update_state" IN ('held','charged');--> statement-breakpoint
ALTER TABLE "save_requests" ADD CONSTRAINT "save_request_claim_clock" CHECK ("save_requests"."claimed_at" IS NULL OR (isfinite("save_requests"."claimed_at") AND "save_requests"."claimed_at"="save_requests"."created_at"));--> statement-breakpoint
ALTER TABLE "save_requests" ADD CONSTRAINT "save_request_memo_update" CHECK (("save_requests"."memo_update_state"='none' AND "save_requests"."memo_update_day" IS NULL) OR ("save_requests"."memo_update_day" IS NOT NULL AND isfinite("save_requests"."memo_update_day") AND (("save_requests"."memo_update_state"='held' AND NOT "save_requests"."completed") OR ("save_requests"."memo_update_state" IN ('charged','released') AND "save_requests"."completed"))));--> statement-breakpoint
ALTER TABLE "store_config" ADD CONSTRAINT "config_global_spend_policy" CHECK ("store_config"."global_spend_policy" IN ('capped','alerts_only'));--> statement-breakpoint
ALTER TABLE "store_config" ADD CONSTRAINT "config_memo_updates" CHECK ("store_config"."memo_updates_daily_limit">0 AND (NOT "store_config"."memo_updates_enabled" OR ("store_config"."foreground_accounting_ready" AND "store_config"."global_spend_policy"='alerts_only')));--> statement-breakpoint
ALTER TABLE "store_config" ADD CONSTRAINT "config_derivation_budget" CHECK (("store_config"."derivation_account_budget_micros" IS NULL AND "store_config"."derivation_global_budget_micros" IS NULL AND "store_config"."derivation_budget_revision"=0) OR ("store_config"."derivation_account_budget_micros" IS NOT NULL AND "store_config"."derivation_account_budget_micros">0 AND "store_config"."derivation_budget_revision">0 AND (("store_config"."global_spend_policy"='alerts_only' AND ("store_config"."derivation_global_budget_micros" IS NULL OR "store_config"."derivation_global_budget_micros">0)) OR ("store_config"."global_spend_policy"='capped' AND "store_config"."derivation_global_budget_micros" IS NOT NULL AND "store_config"."derivation_global_budget_micros">0))));
--> statement-breakpoint
INSERT INTO foreground_usage(day_utc,reserved_micros)
SELECT (created_at AT TIME ZONE 'UTC')::date,sum(reserved_micros)::bigint
FROM save_requests GROUP BY (created_at AT TIME ZONE 'UTC')::date;
--> statement-breakpoint
-- Legacy writers used transaction-start now(). Normalize only NEW claims; no
-- completed receipt is changed. Compatible writers provide one post-lock clock.
CREATE FUNCTION milton_claim_clock() RETURNS trigger LANGUAGE plpgsql VOLATILE SET search_path=pg_catalog,public AS $$
BEGIN
  NEW.claimed_at := coalesce(NEW.claimed_at,clock_timestamp());
  NEW.created_at := NEW.claimed_at;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER save_claim_clock BEFORE INSERT ON save_requests FOR EACH ROW EXECUTE FUNCTION milton_claim_clock();
--> statement-breakpoint
CREATE FUNCTION milton_foreground_reservation() RETURNS trigger LANGUAGE plpgsql VOLATILE SET search_path=pg_catalog,public AS $$
BEGIN
  IF NEW.reserved_micros>0 THEN
    INSERT INTO foreground_usage(day_utc,reserved_micros)
    VALUES ((NEW.created_at AT TIME ZONE 'UTC')::date,NEW.reserved_micros)
    ON CONFLICT(day_utc) DO UPDATE SET reserved_micros=foreground_usage.reserved_micros+excluded.reserved_micros;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER save_foreground_reservation AFTER INSERT ON save_requests FOR EACH ROW EXECUTE FUNCTION milton_foreground_reservation();
--> statement-breakpoint
-- Date(4), timestamp(8), bounded state(<=12) and alignment/null overhead fit
-- within the original 128-byte receipt metadata reserve. Keep its expression.
CREATE FUNCTION milton_memo_update_guard() RETURNS trigger LANGUAGE plpgsql VOLATILE SET search_path=pg_catalog,public AS $$
BEGIN
  IF NEW.claimed_at IS DISTINCT FROM OLD.claimed_at OR
    (OLD.memo_update_state<>'none' AND (NEW.memo_update_day IS DISTINCT FROM OLD.memo_update_day OR NEW.memo_update_state='none')) THEN
    RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='memo_update_is_immutable';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER save_memo_update_guard BEFORE UPDATE ON save_requests FOR EACH ROW EXECUTE FUNCTION milton_memo_update_guard();
--> statement-breakpoint
-- Default disabled. Only the operator CLI installs/revokes the current hash.
ALTER TABLE store_config ADD COLUMN spend_feed_key_hash text;
--> statement-breakpoint
ALTER TABLE store_config ADD CONSTRAINT config_spend_feed_key CHECK (spend_feed_key_hash IS NULL OR spend_feed_key_hash ~ '^[a-f0-9]{64}$');
