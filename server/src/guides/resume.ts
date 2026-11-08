import { sql } from "drizzle-orm";
import type { StoreDatabase } from "../store/database";

/** Resumes the parked guide pilot (deploy/guides.md): recreates 0003's trigger, which
 * 0010 dropped, then resyncs report_guides for every account as that trigger would have
 * recorded the changes made while parked. Which changes those were is not kept, so every
 * report counts as changed: one with an active sample queues on a new source version
 * (keeping its last guide as stale text), and every other guide row is cleared to
 * empty/no_samples. Nobody is enrolled or processed.
 *
 * Owner only: CREATE TRIGGER needs ownership of sample_versions, so with any runtime or
 * guide-worker login the first statement fails with permission denied and the
 * transaction changes nothing. The only caller is the owner-operated
 * scripts/guide-enrollment.ts `resume`, which checks for neondb_owner first.
 *
 * One transaction, trigger first: its lock holds sample inserts until commit, so no
 * change falls between the resync and the trigger. Parking again means running 0010 by
 * hand: psql -1 -X -v ON_ERROR_STOP=1 -f server/drizzle/0010_park_guides.sql */
export const resumeGuides = (db: StoreDatabase) =>
  db.transaction(async (tx) => {
    await tx.query(sql`SELECT set_config('lock_timeout','5s',true)`);
    await tx.query(sql`CREATE TRIGGER report_guide_source AFTER INSERT ON public.sample_versions
      FOR EACH ROW EXECUTE FUNCTION public.milton_guide_source_changed()`);
    await tx.query(sql`INSERT INTO public.report_guides(user_id,report,source_version,status,reason)
      SELECT user_id,report,1,'queued','samples_changed'
      FROM (SELECT DISTINCT ON (user_id,sample_id) user_id,report,retired
            FROM public.sample_versions ORDER BY user_id,sample_id,version DESC) h
      WHERE NOT retired GROUP BY user_id,report
      ON CONFLICT(user_id,report) DO UPDATE SET source_version=report_guides.source_version+1,
        status=excluded.status,reason=excluded.reason,attempts=0,next_attempt_at=clock_timestamp()`);
    await tx.query(sql`UPDATE public.report_guides g SET source_version=g.source_version+1,
        status='empty',reason='no_samples',attempts=0,next_attempt_at=clock_timestamp(),
        guide_text=NULL,completed_version=NULL
      WHERE NOT EXISTS (
        SELECT 1 FROM (SELECT DISTINCT ON (sample_id) report,retired FROM public.sample_versions v
          WHERE v.user_id=g.user_id ORDER BY sample_id,version DESC) h
        WHERE h.report=g.report AND NOT h.retired)`);
  });
