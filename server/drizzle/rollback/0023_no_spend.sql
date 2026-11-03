-- Rollback of 0023_no_spend. RESTORES SHAPE, NOT DATA.
-- Recreates, empty: foreground_usage, spend_alerts, spend_alert_emails,
-- gardening_usage and derivation_usage with their columns, checks, indexes and
-- foreign key; the guard function guard_spend_alert_email with its trigger; the
-- save trigger save_foreground_reservation with milton_foreground_reservation;
-- and store_config.spend_feed_key_hash (NULL, so the feed stays revoked) with its
-- check. Ledger totals, alerts and email delivery records come back only from
-- the pre-0023 Neon snapshot or the release export. Definitions are copied from
-- 0007 (gardening_usage), 0009 (derivation_usage), 0014 (foreground_usage,
-- spend_alerts, the reservation trigger, the feed key) and 0015
-- (spend_alert_emails and its guard). Offline; stop writers first, and roll back
-- to pre-0023 code with it. Every CREATE fails if the object already exists, so
-- a partial or repeated run rolls back as a whole.
BEGIN;
SET LOCAL lock_timeout = '10s';
ALTER TABLE store_config ADD COLUMN spend_feed_key_hash text;
ALTER TABLE store_config ADD CONSTRAINT config_spend_feed_key CHECK (spend_feed_key_hash IS NULL OR spend_feed_key_hash ~ '^[a-f0-9]{64}$');
CREATE TABLE "derivation_usage" (
	"user_id" text NOT NULL,
	"day_utc" date NOT NULL,
	"reserved_micros" bigint NOT NULL,
	CONSTRAINT "derivation_usage_user_id_day_utc_pk" PRIMARY KEY("user_id","day_utc"),
	CONSTRAINT "derivation_usage_cost" CHECK ("derivation_usage"."reserved_micros" > 0)
);
CREATE INDEX "derivation_usage_day" ON "derivation_usage" USING btree ("day_utc");
CREATE TABLE "gardening_usage" (
	"user_id" text NOT NULL,
	"day_utc" date NOT NULL,
	"reserved_micros" bigint NOT NULL,
	CONSTRAINT "gardening_usage_user_id_day_utc_pk" PRIMARY KEY("user_id","day_utc"),
	CONSTRAINT "gardening_usage_cost" CHECK ("gardening_usage"."reserved_micros" > 0)
);
CREATE INDEX "gardening_usage_day" ON "gardening_usage" USING btree ("day_utc");
CREATE TABLE "foreground_usage" (
	"day_utc" date PRIMARY KEY NOT NULL,
	"reserved_micros" bigint NOT NULL,
	CONSTRAINT "foreground_usage_cost" CHECK ("foreground_usage"."reserved_micros">=0)
);
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
CREATE INDEX "spend_alerts_published" ON "spend_alerts" USING btree ("published_at");
CREATE TABLE "spend_alert_emails" (
	"alert_id" text PRIMARY KEY NOT NULL,
	"envelope" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"first_attempt_at" timestamp with time zone,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"token" text,
	"lease_until" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"provider_id" text,
	"sent_at" timestamp with time zone,
	"last_error" text,
	CONSTRAINT "spend_alert_email_status" CHECK ("spend_alert_emails"."status" IN ('pending','sent','failed','unknown')),
	CONSTRAINT "spend_alert_email_attempts" CHECK ("spend_alert_emails"."attempts">=0),
	CONSTRAINT "spend_alert_email_lease" CHECK (("spend_alert_emails"."token" IS NULL)=("spend_alert_emails"."lease_until" IS NULL)),
	CONSTRAINT "spend_alert_email_sent" CHECK (("spend_alert_emails"."status"='sent')=("spend_alert_emails"."sent_at" IS NOT NULL AND "spend_alert_emails"."provider_id" IS NOT NULL))
);
ALTER TABLE "spend_alert_emails" ADD CONSTRAINT "spend_alert_emails_alert_id_spend_alerts_id_fk" FOREIGN KEY ("alert_id") REFERENCES "public"."spend_alerts"("id") ON DELETE no action ON UPDATE no action;
CREATE INDEX "spend_alert_emails_pending" ON "spend_alert_emails" USING btree ("status","next_attempt_at");
CREATE FUNCTION guard_spend_alert_email() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'spend_alert_email_identity_is_durable';
  END IF;
  IF NEW.alert_id IS DISTINCT FROM OLD.alert_id OR NEW.envelope IS DISTINCT FROM OLD.envelope
    OR (OLD.first_attempt_at IS NOT NULL AND NEW.first_attempt_at IS DISTINCT FROM OLD.first_attempt_at)
    OR (OLD.status<>'pending' AND NEW IS DISTINCT FROM OLD) THEN
    RAISE EXCEPTION 'spend_alert_email_identity_is_durable';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER spend_alert_email_guard BEFORE UPDATE OR DELETE ON spend_alert_emails
FOR EACH ROW EXECUTE FUNCTION guard_spend_alert_email();
CREATE FUNCTION milton_foreground_reservation() RETURNS trigger LANGUAGE plpgsql VOLATILE SET search_path=pg_catalog,public AS $$
BEGIN
  IF NEW.reserved_micros>0 THEN
    INSERT INTO foreground_usage(day_utc,reserved_micros)
    VALUES ((NEW.created_at AT TIME ZONE 'UTC')::date,NEW.reserved_micros)
    ON CONFLICT(day_utc) DO UPDATE SET reserved_micros=foreground_usage.reserved_micros+excluded.reserved_micros;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER save_foreground_reservation AFTER INSERT ON save_requests FOR EACH ROW EXECUTE FUNCTION milton_foreground_reservation();
COMMIT;
