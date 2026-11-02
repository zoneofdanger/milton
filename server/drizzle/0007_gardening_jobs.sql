CREATE TABLE "gardening_jobs" (
	"user_id" text NOT NULL,
	"request_id" text NOT NULL,
	"payload_json" jsonb NOT NULL,
	"report_revision" integer NOT NULL,
	"source_hash" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"available_at" timestamp with time zone DEFAULT clock_timestamp() + interval '30 seconds' NOT NULL,
	"attempt_id" text,
	"attempted_at" timestamp with time zone,
	"lease_until" timestamp with time zone,
	"reserved_micros" integer DEFAULT 0 NOT NULL,
	"result_json" jsonb,
	"error" text,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"payload_bytes" bigint GENERATED ALWAYS AS (octet_length(payload_json::text)::bigint + 32768 + 1024) STORED NOT NULL,
	CONSTRAINT "gardening_jobs_user_id_request_id_pk" PRIMARY KEY("user_id","request_id"),
	CONSTRAINT "gardening_state" CHECK ("gardening_jobs"."status" IN ('pending','running','observed','superseded','failed')),
	CONSTRAINT "gardening_source" CHECK ("gardening_jobs"."report_revision" > 0 AND "gardening_jobs"."source_hash" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "gardening_payload" CHECK (jsonb_typeof("gardening_jobs"."payload_json") = 'object' AND octet_length("gardening_jobs"."payload_json"::text) <= 131072),
	CONSTRAINT "gardening_result" CHECK ("gardening_jobs"."result_json" IS NULL OR (jsonb_typeof("gardening_jobs"."result_json") = 'object' AND octet_length("gardening_jobs"."result_json"::text) <= 32768)),
	CONSTRAINT "gardening_error" CHECK ("gardening_jobs"."error" IS NULL OR "gardening_jobs"."error" ~ '^[a-z_]{1,64}$'),
	CONSTRAINT "gardening_cost" CHECK ("gardening_jobs"."reserved_micros" >= 0),
	CONSTRAINT "gardening_attempt" CHECK (("gardening_jobs"."attempt_id" IS NULL AND "gardening_jobs"."attempted_at" IS NULL AND "gardening_jobs"."lease_until" IS NULL AND "gardening_jobs"."reserved_micros"=0) OR ("gardening_jobs"."attempt_id" IS NOT NULL AND length("gardening_jobs"."attempt_id")=36 AND "gardening_jobs"."attempted_at" IS NOT NULL AND "gardening_jobs"."lease_until" IS NOT NULL AND "gardening_jobs"."reserved_micros">0))
);
--> statement-breakpoint
CREATE TABLE "gardening_usage" (
	"user_id" text NOT NULL,
	"day_utc" date NOT NULL,
	"reserved_micros" bigint NOT NULL,
	CONSTRAINT "gardening_usage_user_id_day_utc_pk" PRIMARY KEY("user_id","day_utc"),
	CONSTRAINT "gardening_usage_cost" CHECK ("gardening_usage"."reserved_micros" > 0)
);
--> statement-breakpoint
ALTER TABLE "gardening_jobs" ADD CONSTRAINT "gardening_request" FOREIGN KEY ("user_id","request_id") REFERENCES "public"."save_requests"("user_id","request_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "gardening_due" ON "gardening_jobs" USING btree ("status","available_at");--> statement-breakpoint
CREATE INDEX "gardening_spend" ON "gardening_jobs" USING btree ("attempted_at","user_id");--> statement-breakpoint
CREATE INDEX "gardening_retention" ON "gardening_jobs" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "gardening_usage_day" ON "gardening_usage" USING btree ("day_utc");--> statement-breakpoint
-- Reserve space for terminal observations at enqueue time. History + jobs share
-- the existing account storage ceiling; observations never consume write quota.
CREATE FUNCTION milton_gardening_guard() RETURNS trigger LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog, public AS $$
DECLARE retained bigint; ceiling bigint;
BEGIN
  IF TG_OP='DELETE' THEN
    UPDATE users SET retained_bytes=retained_bytes-OLD.payload_bytes WHERE id=OLD.user_id;
    RETURN OLD;
  END IF;
  IF TG_OP='UPDATE' THEN
    IF (NEW.user_id,NEW.request_id,NEW.payload_json,NEW.report_revision,NEW.source_hash,NEW.created_at,NEW.available_at)
      IS DISTINCT FROM (OLD.user_id,OLD.request_id,OLD.payload_json,OLD.report_revision,OLD.source_hash,OLD.created_at,OLD.available_at)
      OR OLD.status NOT IN ('pending','running')
      OR (OLD.status='pending' AND NEW.status NOT IN ('running','failed'))
      OR (OLD.status='running' AND (NEW.status NOT IN ('observed','superseded','failed') OR
        (NEW.attempt_id,NEW.attempted_at,NEW.lease_until,NEW.reserved_micros) IS DISTINCT FROM
        (OLD.attempt_id,OLD.attempted_at,OLD.lease_until,OLD.reserved_micros))) THEN
      RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='gardening_job_is_immutable';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.status <> 'pending' OR NEW.attempt_id IS NOT NULL OR NEW.result_json IS NOT NULL OR NEW.error IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='gardening_job_invalid';
  END IF;
  UPDATE users SET retained_bytes=retained_bytes+NEW.payload_bytes
    WHERE id=NEW.user_id AND status='active' RETURNING retained_bytes INTO retained;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='account_unavailable'; END IF;
  SELECT (limits_json->>'history_bytes')::bigint INTO ceiling FROM store_config WHERE singleton=1;
  IF retained > coalesce(ceiling,0) THEN RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='memo_history_limit'; END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER gardening_guard AFTER INSERT OR UPDATE OR DELETE ON gardening_jobs FOR EACH ROW EXECUTE FUNCTION milton_gardening_guard();
