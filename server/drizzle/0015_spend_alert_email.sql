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
--> statement-breakpoint
ALTER TABLE "spend_alert_emails" ADD CONSTRAINT "spend_alert_emails_alert_id_spend_alerts_id_fk" FOREIGN KEY ("alert_id") REFERENCES "public"."spend_alerts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "spend_alert_emails_pending" ON "spend_alert_emails" USING btree ("status","next_attempt_at");--> statement-breakpoint
-- Delivery identity, content, and the provider's deduplication epoch cannot move.
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
--> statement-breakpoint
CREATE TRIGGER spend_alert_email_guard BEFORE UPDATE OR DELETE ON spend_alert_emails
FOR EACH ROW EXECUTE FUNCTION guard_spend_alert_email();
