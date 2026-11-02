CREATE TABLE "save_requests" (
	"user_id" text NOT NULL,
	"request_id" text NOT NULL,
	"input_hash" text NOT NULL,
	"source_hash" text NOT NULL,
	"reserved_micros" integer NOT NULL,
	"result_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"completed" boolean DEFAULT false NOT NULL,
	"deadline" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"payload_bytes" bigint GENERATED ALWAYS AS (octet_length(request_id)::bigint + octet_length(input_hash) + octet_length(source_hash) + 2048 + 128) STORED NOT NULL,
	CONSTRAINT "save_requests_user_id_request_id_pk" PRIMARY KEY("user_id","request_id"),
	CONSTRAINT "save_request_hashes" CHECK ("save_requests"."input_hash" ~ '^[a-f0-9]{64}$' AND "save_requests"."source_hash" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "save_request_cost" CHECK ("save_requests"."reserved_micros" >= 0),
	CONSTRAINT "save_request_id" CHECK (length("save_requests"."request_id") = 36),
	CONSTRAINT "save_request_result" CHECK (jsonb_typeof("save_requests"."result_json") = 'object' AND octet_length("save_requests"."result_json"::text) <= 2048)
);
--> statement-breakpoint
CREATE TABLE "tps_reports" (
	"user_id" text PRIMARY KEY NOT NULL,
	"revision" integer NOT NULL,
	"body" text NOT NULL,
	"source_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tps_revision_positive" CHECK ("tps_reports"."revision" > 0),
	CONSTRAINT "tps_body_limit" CHECK (octet_length("tps_reports"."body") <= 32768),
	CONSTRAINT "tps_source_hash" CHECK ("tps_reports"."source_hash" ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
ALTER TABLE "save_requests" ADD CONSTRAINT "save_requests_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tps_reports" ADD CONSTRAINT "tps_reports_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "save_requests_by_day" ON "save_requests" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "save_requests_by_account_day" ON "save_requests" USING btree ("user_id","created_at");--> statement-breakpoint
-- Reserve the bounded result space at claim time so terminal failure always fits.
-- Receipts retain request identity; TPS itself stores only the current projection.
CREATE FUNCTION milton_save_request_guard() RETURNS trigger LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog, public AS $$
DECLARE retained bigint; ceiling bigint;
BEGIN
  IF TG_OP='UPDATE' AND (OLD.completed OR
    (NEW.user_id,NEW.request_id,NEW.input_hash,NEW.source_hash,NEW.reserved_micros,NEW.deadline,NEW.created_at)
    IS DISTINCT FROM (OLD.user_id,OLD.request_id,OLD.input_hash,OLD.source_hash,OLD.reserved_micros,OLD.deadline,OLD.created_at)) THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='save_receipt_is_immutable';
  END IF;
  IF TG_OP='DELETE' THEN
    UPDATE users SET retained_bytes=retained_bytes-OLD.payload_bytes WHERE id=OLD.user_id;
    RETURN OLD;
  END IF;
  UPDATE users SET retained_bytes=retained_bytes+NEW.payload_bytes-CASE WHEN TG_OP='UPDATE' THEN OLD.payload_bytes ELSE 0 END
    WHERE id=NEW.user_id AND status='active' RETURNING retained_bytes INTO retained;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='account_unavailable'; END IF;
  SELECT (limits_json->>'history_bytes')::bigint INTO ceiling FROM store_config WHERE singleton=1;
  IF TG_OP='INSERT' AND retained > coalesce(ceiling,0) THEN RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='memo_history_limit'; END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER save_request_guard AFTER INSERT OR UPDATE OR DELETE ON save_requests FOR EACH ROW EXECUTE FUNCTION milton_save_request_guard();
