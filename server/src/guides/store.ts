import { sql, type SQL } from "drizzle-orm";
import type { StoreDatabase, StoreSession } from "../store/database";
import { StoreError } from "../store/errors";
import { REPORT_IDS } from "../store/reports";

// This deliberately does not use the permissive base-access billing gate.
export const guideEligible = (userId: string | SQL) => sql`EXISTS (
  SELECT 1 FROM users u JOIN guide_accounts a ON a.user_id=u.id
  JOIN trial_accounts b ON b.user_id=u.id
  WHERE u.id=${userId} AND u.status='active' AND a.enabled
    AND a.opted_in_at IS NOT NULL AND a.opt_in_reference IS NOT NULL
    AND (b.subscription_status='active'
      OR (b.subscription_status='trialing' AND b.trial_end>clock_timestamp())))`;

export const GUIDE_PRECEDENCE =
  "Derived interpretation of approved samples, not a rule. Explicit rules override inferred tendencies; preserve Baseline precedence. Samples remain the evidence. Requested edit scope always wins. Stale text may reflect removed or corrected samples. Draft with available guidance; do not wait, poll or refresh.";
export type GuidePresentation = {
  derived: true;
  text: string | null;
  source_version: number | null;
  current_version: number;
  stale: boolean;
  status: string;
  reason: string;
  precedence: string;
};
export const guidePresentation = (
  userId: string,
) => sql`SELECT coalesce(json_object_agg(g.report,
  json_build_object('derived',true,'text',g.guide_text,'source_version',g.completed_version,
    'current_version',g.source_version,'stale',g.completed_version IS NOT NULL AND g.completed_version<>g.source_version,
    'status',CASE WHEN g.status='running' AND g.lease_until<=clock_timestamp() THEN
      CASE WHEN g.attempts>=2 THEN 'failed' ELSE 'queued' END ELSE g.status END,
    'reason',CASE WHEN g.status='running' AND g.lease_until<=clock_timestamp() THEN
      CASE WHEN g.attempts>=2 THEN 'attempts_exhausted' ELSE 'lease_expired' END ELSE g.reason END,
    'precedence',${GUIDE_PRECEDENCE}::text)), '{}'::json)
  FROM report_guides g WHERE g.user_id=${userId} AND ${guideEligible(userId)}`;

/** Operator-only entrypoint. No account creation, person API or assistant tool. */
export async function setGuideEnrollment(
  db: StoreDatabase,
  userId: string,
  input: { enabled: boolean; optInReference?: string },
) {
  if (
    input.enabled &&
    (!input.optInReference?.trim() || input.optInReference.length > 200)
  )
    throw new Error(
      "Record explicit guide processing opt-in before enablement.",
    );
  await db.transaction(async (tx) => {
    if (
      !(
        await tx.query(
          sql`SELECT id FROM users WHERE id=${userId} AND status='active' FOR UPDATE`,
        )
      ).length
    )
      throw new StoreError(
        "account_unavailable",
        "This Milton account is unavailable.",
        403,
      );
    const [prior] = await tx.query<{ enabled: boolean }>(
      sql`SELECT enabled FROM guide_accounts WHERE user_id=${userId} FOR UPDATE`,
    );
    if (prior?.enabled === input.enabled) return;
    await tx.query(sql`INSERT INTO guide_accounts(user_id,enabled,epoch,opted_in_at,opt_in_reference)
      VALUES (${userId},${input.enabled},1,${input.enabled ? sql`clock_timestamp()` : sql`NULL`},${input.optInReference ?? null})
      ON CONFLICT(user_id) DO UPDATE SET enabled=excluded.enabled,epoch=guide_accounts.epoch+1,
        opted_in_at=CASE WHEN excluded.enabled THEN excluded.opted_in_at ELSE guide_accounts.opted_in_at END,
        opt_in_reference=CASE WHEN excluded.enabled THEN excluded.opt_in_reference ELSE guide_accounts.opt_in_reference END`);
    for (const report of REPORT_IDS)
      await tx.query(
        sql`INSERT INTO report_guides(user_id,report) VALUES (${userId},${report}) ON CONFLICT DO NOTHING`,
      );
    // Keep live leases: off/on cannot create overlapping work before the old call ends.
    await tx.query(sql`UPDATE report_guides SET attempts=0,next_attempt_at=clock_timestamp(),
      status=CASE WHEN source_version=0 OR status='empty' THEN 'empty'
        WHEN completed_version=source_version THEN CASE WHEN guide_text IS NULL THEN 'insufficient' ELSE 'ready' END ELSE 'queued' END,
      reason=CASE WHEN source_version=0 OR status='empty' THEN 'no_samples'
        WHEN completed_version=source_version THEN CASE WHEN guide_text IS NULL THEN 'insufficient_evidence' ELSE 'completed' END ELSE 'enrollment_changed' END
      WHERE user_id=${userId}`);
  });
}
export const guideEpoch = async (tx: StoreSession, userId: string) =>
  (
    await tx.query<{ epoch: number }>(
      sql`SELECT epoch FROM guide_accounts WHERE user_id=${userId} AND ${guideEligible(userId)}`,
    )
  )[0]?.epoch;
