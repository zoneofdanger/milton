CREATE TABLE "trial_accounts" (
	"user_id" text PRIMARY KEY NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"paid_through" timestamp with time zone,
	"notice_stage" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "trial_notice_stage" CHECK ("trial_accounts"."notice_stage" BETWEEN 0 AND 2),
	CONSTRAINT "trial_finite_dates" CHECK (("trial_accounts"."started_at" IS NULL OR isfinite("trial_accounts"."started_at")) AND ("trial_accounts"."paid_through" IS NULL OR isfinite("trial_accounts"."paid_through")))
);
--> statement-breakpoint
ALTER TABLE "store_config" ADD COLUMN "trials_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "trial_accounts" ADD CONSTRAINT "trial_accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;