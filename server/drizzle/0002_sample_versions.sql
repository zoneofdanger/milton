-- Breaking, owner-only cutover: stop/drain old writers and close reads first.
-- Run transactionally. Accepted-change evidence is retained unchanged.
LOCK TABLE samples IN ACCESS EXCLUSIVE MODE;
--> statement-breakpoint
DO $$
BEGIN
 IF EXISTS(SELECT 1 FROM samples s LEFT JOIN samples p ON p.user_id=s.user_id AND p.id=s.replaces_id
   WHERE s.replaces_id IS NOT NULL AND (p.id IS NULL OR p.report<>s.report
     OR p.retire_reason IS DISTINCT FROM 'replaced' OR p.retired_at IS NULL)) THEN
  RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='sample_lineage_invalid_parent';
 END IF;
 IF EXISTS(SELECT 1 FROM samples WHERE replaces_id IS NOT NULL GROUP BY user_id,replaces_id HAVING count(*)>1) THEN
  RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='sample_lineage_branch';
 END IF;
 IF EXISTS(WITH RECURSIVE chain AS (
   SELECT user_id,id,ARRAY[id] AS path,false AS cycle FROM samples
   UNION ALL SELECT s.user_id,s.replaces_id,c.path || s.replaces_id,s.replaces_id=ANY(c.path)
   FROM chain c JOIN samples s ON s.user_id=c.user_id AND s.id=c.id
   WHERE s.replaces_id IS NOT NULL AND NOT c.cycle
 ) SELECT 1 FROM chain WHERE cycle) THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='sample_lineage_cycle'; END IF;
END $$;
--> statement-breakpoint
CREATE TEMP TABLE sample_lineage ON COMMIT DROP AS
WITH RECURSIVE chain AS (
 SELECT user_id,id,id AS root_id,1 AS version FROM samples WHERE replaces_id IS NULL
 UNION ALL SELECT s.user_id,s.id,c.root_id,c.version+1 FROM samples s
 JOIN chain c ON s.user_id=c.user_id AND s.replaces_id=c.id
) SELECT * FROM chain;
--> statement-breakpoint
CREATE TABLE "sample_versions" (
	"user_id" text NOT NULL,
	"sample_id" text NOT NULL,
	"version" integer NOT NULL,
	"report" text NOT NULL,
	"kind_id" text NOT NULL,
	"context" jsonb NOT NULL,
	"body" text NOT NULL,
	"retired" boolean DEFAULT false NOT NULL,
	"retire_reason" text,
	"actor_json" text NOT NULL,
	"request_id" text,
	"provenance" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"search" "tsvector" GENERATED ALWAYS AS (to_tsvector('english'::regconfig, (context->>'summary') || ' ' || body)) STORED,
	CONSTRAINT "sample_versions_user_id_sample_id_version_pk" PRIMARY KEY("user_id","sample_id","version"),
	CONSTRAINT "sample_versions_version" CHECK ("sample_versions"."version" > 0),
	CONSTRAINT "sample_versions_report" CHECK ("sample_versions"."report" IN ('email','chat','post','document','speech')),
	CONSTRAINT "sample_versions_context" CHECK (public.milton_sample_context_valid("sample_versions"."context")),
	CONSTRAINT "sample_versions_body" CHECK (btrim("sample_versions"."body") <> '' AND octet_length("sample_versions"."body") <= 131072),
	CONSTRAINT "sample_versions_actor" CHECK (jsonb_typeof("sample_versions"."actor_json"::jsonb)='object'),
	CONSTRAINT "sample_versions_provenance" CHECK (jsonb_typeof("sample_versions"."provenance")='object'),
	CONSTRAINT "sample_versions_retirement" CHECK (("sample_versions"."retire_reason" IS NOT NULL) = "sample_versions"."retired" AND ("sample_versions"."retire_reason" IS NULL OR "sample_versions"."retire_reason" IN ('replaced','removed','evicted')))
);
--> statement-breakpoint
-- Each row is one known snapshot, not a claim to reconstruct overwritten contexts.
-- A predecessor's replacement retirement is evidence, not the current lifecycle.
INSERT INTO sample_versions(user_id,sample_id,version,report,kind_id,context,body,retired,retire_reason,actor_json,request_id,provenance,created_at)
SELECT s.user_id,c.root_id,c.version,s.report,s.kind_id,s.context,s.body,
 s.retired_at IS NOT NULL AND NOT EXISTS(SELECT 1 FROM samples n WHERE n.user_id=s.user_id AND n.replaces_id=s.id),
 CASE WHEN NOT EXISTS(SELECT 1 FROM samples n WHERE n.user_id=s.user_id AND n.replaces_id=s.id) THEN s.retire_reason END,
 s.client_json,
 CASE WHEN NOT EXISTS(SELECT 1 FROM samples n WHERE n.user_id=s.user_id AND n.replaces_id=s.id) THEN s.retired_request_id END,
 jsonb_build_object('legacy_id',s.id,'legacy_replaces_id',s.replaces_id,'legacy_created_at',s.created_at,
   'legacy_context_revision',s.context_revision,'legacy_retired_at',s.retired_at,
   'legacy_retire_reason',s.retire_reason,'legacy_retired_request_id',s.retired_request_id,
   'context_history','only last stored context is known; earlier values and correction times are not reconstructed'),
 CASE WHEN NOT EXISTS(SELECT 1 FROM samples n WHERE n.user_id=s.user_id AND n.replaces_id=s.id)
   THEN coalesce(s.retired_at,s.created_at) ELSE s.created_at END
FROM samples s JOIN sample_lineage c ON c.user_id=s.user_id AND c.id=s.id;
--> statement-breakpoint
ALTER TABLE samples DISABLE TRIGGER samples_guard;
--> statement-breakpoint
ALTER TABLE samples DROP CONSTRAINT samples_replaces_fk;
--> statement-breakpoint
DELETE FROM samples s USING sample_lineage c WHERE s.user_id=c.user_id AND s.id=c.id AND c.id<>c.root_id;
--> statement-breakpoint
ALTER TABLE "samples" DROP CONSTRAINT "samples_report";
--> statement-breakpoint
ALTER TABLE "samples" DROP CONSTRAINT "samples_context";
--> statement-breakpoint
ALTER TABLE "samples" DROP CONSTRAINT "samples_context_revision";
--> statement-breakpoint
ALTER TABLE "samples" DROP CONSTRAINT "samples_body";
--> statement-breakpoint
ALTER TABLE "samples" DROP CONSTRAINT "samples_retirement";
--> statement-breakpoint
ALTER TABLE "samples" DROP CONSTRAINT "samples_kind_fk";
--> statement-breakpoint
DROP INDEX "samples_by_report";
--> statement-breakpoint
DROP INDEX "samples_by_kind";
--> statement-breakpoint
ALTER TABLE "sample_versions" ADD CONSTRAINT "sample_versions_sample_fk" FOREIGN KEY ("user_id","sample_id") REFERENCES "public"."samples"("user_id","id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "sample_versions" ADD CONSTRAINT "sample_versions_kind_fk" FOREIGN KEY ("user_id","kind_id","report") REFERENCES "public"."sample_kinds"("user_id","id","report") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "samples" DROP COLUMN "search";
--> statement-breakpoint
ALTER TABLE "samples" DROP COLUMN "report";
--> statement-breakpoint
ALTER TABLE "samples" DROP COLUMN "kind_id";
--> statement-breakpoint
ALTER TABLE "samples" DROP COLUMN "context";
--> statement-breakpoint
ALTER TABLE "samples" DROP COLUMN "context_revision";
--> statement-breakpoint
ALTER TABLE "samples" DROP COLUMN "body";
--> statement-breakpoint
ALTER TABLE "samples" DROP COLUMN "replaces_id";
--> statement-breakpoint
ALTER TABLE "samples" DROP COLUMN "retired_at";
--> statement-breakpoint
ALTER TABLE "samples" DROP COLUMN "retire_reason";
--> statement-breakpoint
ALTER TABLE "samples" DROP COLUMN "retired_request_id";
--> statement-breakpoint
ALTER TABLE "samples" ADD CONSTRAINT "samples_id" CHECK ("samples"."id" <> '');
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.milton_sample_guard() RETURNS trigger LANGUAGE plpgsql
SET search_path TO 'pg_catalog', 'public' AS $$
BEGIN
 IF TG_OP='DELETE' THEN
  IF EXISTS(SELECT 1 FROM users WHERE id=OLD.user_id) THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='sample_identity_is_immutable'; END IF;
  RETURN OLD;
 END IF;
 IF TG_OP='UPDATE' THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='sample_identity_is_immutable'; END IF;
 PERFORM 1 FROM users WHERE id=NEW.user_id AND status='active' FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='account_unavailable'; END IF;
 RETURN NEW;
END $$;
--> statement-breakpoint
ALTER TABLE samples ENABLE TRIGGER samples_guard;
--> statement-breakpoint
CREATE FUNCTION public.milton_sample_version_guard() RETURNS trigger LANGUAGE plpgsql
SET search_path TO 'pg_catalog', 'public' AS $$
DECLARE head sample_versions%ROWTYPE;
BEGIN
 IF TG_OP='DELETE' THEN
  IF EXISTS(SELECT 1 FROM users WHERE id=OLD.user_id) THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='sample_version_is_immutable'; END IF;
  RETURN OLD;
 END IF;
 IF TG_OP='UPDATE' THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='sample_version_is_immutable'; END IF;
 PERFORM 1 FROM users WHERE id=NEW.user_id AND status='active' FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='account_unavailable'; END IF;
 SELECT * INTO head FROM sample_versions WHERE user_id=NEW.user_id AND sample_id=NEW.sample_id ORDER BY version DESC LIMIT 1;
 IF NEW.version<>coalesce(head.version,0)+1 OR coalesce(head.retired,false)
   OR (head.version IS NULL AND NEW.retired) THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='sample_version_conflict'; END IF;
 IF NEW.retired AND (NEW.body,NEW.context,NEW.kind_id,NEW.report) IS DISTINCT FROM (head.body,head.context,head.kind_id,head.report)
   THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='sample_version_conflict'; END IF;
 IF NEW.request_id IS NULL OR NEW.request_id !~* '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'
   OR NEW.provenance<>'{}'::jsonb THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='sample_version_conflict'; END IF;
 RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER sample_versions_guard BEFORE INSERT OR UPDATE OR DELETE ON sample_versions
FOR EACH ROW EXECUTE FUNCTION public.milton_sample_version_guard();
--> statement-breakpoint
REVOKE UPDATE ON samples, sample_versions FROM milton_runtime;
--> statement-breakpoint
GRANT SELECT, INSERT ON samples, sample_versions TO milton_runtime;
