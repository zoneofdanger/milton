CREATE TABLE "guide_accounts" (
	"user_id" text PRIMARY KEY NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"epoch" integer DEFAULT 0 NOT NULL,
	"opted_in_at" timestamp with time zone,
	"opt_in_reference" text,
	CONSTRAINT "guide_consent" CHECK (NOT "guide_accounts"."enabled" OR ("guide_accounts"."opted_in_at" IS NOT NULL AND "guide_accounts"."opt_in_reference" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "guide_budget_lock" (
	"singleton" integer PRIMARY KEY NOT NULL,
	CONSTRAINT "guide_budget_singleton" CHECK ("guide_budget_lock"."singleton" = 1)
);
--> statement-breakpoint
CREATE TABLE "guide_spend" (
	"id" text PRIMARY KEY NOT NULL,
	"account_key" text NOT NULL,
	"amount_micros" integer NOT NULL,
	"settled" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "guide_spend_amount" CHECK ("guide_spend"."amount_micros" >= 0)
);
--> statement-breakpoint
CREATE TABLE "report_guides" (
	"user_id" text NOT NULL,
	"report" text NOT NULL,
	"source_version" integer DEFAULT 0 NOT NULL,
	"completed_version" integer,
	"guide_text" text,
	"status" text DEFAULT 'empty' NOT NULL,
	"reason" text DEFAULT 'no_samples' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"lease_token" text,
	"lease_until" timestamp with time zone,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "report_guides_user_id_report_pk" PRIMARY KEY("user_id","report"),
	CONSTRAINT "guide_report" CHECK ("report_guides"."report" IN ('email','chat','post','document','speech')),
	CONSTRAINT "guide_versions" CHECK ("report_guides"."source_version" >= 0 AND ("report_guides"."completed_version" IS NULL OR "report_guides"."completed_version" <= "report_guides"."source_version")),
	CONSTRAINT "guide_attempts" CHECK ("report_guides"."attempts" BETWEEN 0 AND 2),
	CONSTRAINT "guide_text_limit" CHECK ("report_guides"."guide_text" IS NULL OR char_length("report_guides"."guide_text") <= 6000),
	CONSTRAINT "guide_status" CHECK ("report_guides"."status" IN ('empty','queued','running','ready','insufficient','failed','unavailable'))
);
--> statement-breakpoint
ALTER TABLE "guide_accounts" ADD CONSTRAINT "guide_accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_guides" ADD CONSTRAINT "report_guides_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "guide_spend_date" ON "guide_spend" USING btree ("created_at");--> statement-breakpoint
INSERT INTO guide_budget_lock(singleton) VALUES (1);
--> statement-breakpoint
-- Seed source identities without enrolling or processing any account.
INSERT INTO report_guides(user_id,report,source_version,status,reason)
SELECT user_id,report,1,'queued','samples_changed'
FROM (SELECT DISTINCT ON (user_id,sample_id) user_id,sample_id,report,retired
      FROM sample_versions ORDER BY user_id,sample_id,version DESC) h
WHERE NOT retired GROUP BY user_id,report;
--> statement-breakpoint
CREATE FUNCTION public.milton_guide_source_changed() RETURNS trigger LANGUAGE plpgsql
SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE prior_report text; target text; active_count integer;
BEGIN
 SELECT report INTO prior_report FROM public.sample_versions
 WHERE user_id=NEW.user_id AND sample_id=NEW.sample_id AND version<NEW.version
 ORDER BY version DESC LIMIT 1;
 FOR target IN SELECT DISTINCT r FROM unnest(ARRAY[prior_report,NEW.report]) r WHERE r IS NOT NULL ORDER BY r LOOP
   SELECT count(*) INTO active_count FROM
     (SELECT DISTINCT ON (sample_id) report,retired FROM public.sample_versions
      WHERE user_id=NEW.user_id ORDER BY sample_id,version DESC) h
     WHERE report=target AND NOT retired;
   INSERT INTO public.report_guides(user_id,report,source_version,status,reason)
   VALUES (NEW.user_id,target,1,CASE WHEN active_count=0 THEN 'empty' ELSE 'queued' END,
     CASE WHEN active_count=0 THEN 'no_samples' ELSE 'samples_changed' END)
   ON CONFLICT(user_id,report) DO UPDATE SET source_version=report_guides.source_version+1,
     status=excluded.status,reason=excluded.reason,attempts=0,next_attempt_at=clock_timestamp(),
     guide_text=CASE WHEN active_count=0 THEN NULL ELSE report_guides.guide_text END,
     completed_version=CASE WHEN active_count=0 THEN NULL ELSE report_guides.completed_version END;
 END LOOP;
 RETURN NEW;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.milton_guide_source_changed() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER report_guide_source AFTER INSERT ON sample_versions
FOR EACH ROW EXECUTE FUNCTION public.milton_guide_source_changed();
--> statement-breakpoint
-- Explicit capabilities; no inherited runtime/auth role for the guide worker.
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='milton_guide_worker') THEN
   CREATE ROLE milton_guide_worker NOLOGIN;
 END IF;
END $$;
--> statement-breakpoint
REVOKE ALL ON guide_accounts,report_guides,guide_spend,guide_budget_lock FROM milton_runtime;
--> statement-breakpoint
GRANT SELECT ON guide_accounts,report_guides TO milton_runtime;
--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO milton_guide_worker;
--> statement-breakpoint
GRANT SELECT ON users,trial_accounts,samples,sample_versions,sample_kinds,guide_accounts TO milton_guide_worker;
--> statement-breakpoint
GRANT SELECT,UPDATE ON report_guides,guide_budget_lock TO milton_guide_worker;
--> statement-breakpoint
GRANT SELECT,INSERT,UPDATE ON guide_spend TO milton_guide_worker;
