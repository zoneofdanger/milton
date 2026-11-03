import { sql } from "drizzle-orm";
import type { StoreSession } from "./database";
import { StoreError } from "./errors";

export type TrialStatus = {
  status: "early_access" | "trial" | "paid" | "expired";
  trial_ends_at?: string;
  reminder_stage: 0 | 1 | 2;
};
export type TrialNotice = {
  code: "trial_ending_7_days" | "trial_ending_1_day";
  trial_ends_at: string;
  message: string;
};

export async function trialStatus(
  db: StoreSession,
  userId: string,
): Promise<TrialStatus> {
  const row = (
    await db.query<{
      enabled: boolean;
      enrolled: boolean;
      ends_at: Date | string | null;
      now: Date | string;
      paid: boolean;
    }>(sql`SELECT c.trials_enabled AS enabled, t.user_id IS NOT NULL AS enrolled,
    t.started_at + interval '720 hours' AS ends_at, clock_timestamp() AS now,
    coalesce(t.paid_through > clock_timestamp(),false) AS paid
    FROM store_config c LEFT JOIN trial_accounts t ON t.user_id=${userId}
    WHERE c.singleton=1`)
  )[0];
  if (!row)
    throw new StoreError("configuration", "Account access is unavailable.");
  if (!row.enabled || !row.enrolled)
    return { status: "early_access", reminder_stage: 0 };
  if (!row.ends_at)
    throw new StoreError(
      "configuration",
      "Account trial clock is unavailable.",
    );
  const end = new Date(row.ends_at);
  const remaining = end.getTime() - new Date(row.now).getTime();
  return {
    status: row.paid ? "paid" : remaining <= 0 ? "expired" : "trial",
    trial_ends_at: end.toISOString(),
    reminder_stage:
      row.paid || remaining <= 0 || remaining > 7 * 86400000
        ? 0
        : remaining <= 86400000
          ? 2
          : 1,
  };
}

// No link: billing has no route yet, and the instructions say to give none.
export function subscriptionRequired() {
  return new StoreError(
    "subscription_required",
    "Your Milton trial has ended. Subscribe for $5.01/month to resume assistant reads and saves. Your preferences are still available to view and download.",
    402,
    { retryable: false },
  );
}

export async function assertTrialAccess(db: StoreSession, userId: string) {
  if ((await trialStatus(db, userId)).status === "expired")
    throw subscriptionRequired();
}

export async function claimTrialNotice(
  db: StoreSession,
  userId: string,
): Promise<TrialNotice | undefined> {
  // One SQL update arbitrates concurrent clients. Only the current milestone is
  // offered: an inactive account returning on day29 gets one reminder, not two.
  const row = (
    await db.query<{ stage: number; ends_at: string | Date }>(sql`
    UPDATE trial_accounts t SET notice_stage=CASE
      WHEN t.started_at + interval '720 hours' <= clock_timestamp()+interval '24 hours' THEN 2 ELSE 1 END
    WHERE t.user_id=${userId}
      AND EXISTS (SELECT 1 FROM users u WHERE u.id=t.user_id AND u.status='active')
      AND EXISTS (SELECT 1 FROM store_config WHERE singleton=1 AND trials_enabled)
      AND (t.paid_through IS NULL OR t.paid_through<=clock_timestamp())
      AND t.started_at + interval '720 hours' > clock_timestamp()
      AND t.started_at + interval '720 hours' <= clock_timestamp()+interval '168 hours'
      AND t.notice_stage < CASE WHEN t.started_at + interval '720 hours' <= clock_timestamp()+interval '24 hours' THEN 2 ELSE 1 END
    RETURNING notice_stage AS stage, started_at + interval '720 hours' AS ends_at`)
  )[0];
  if (!row) return;
  const ends = new Date(row.ends_at).toISOString();
  return {
    code: row.stage === 2 ? "trial_ending_1_day" : "trial_ending_7_days",
    trial_ends_at: ends,
    message: `Your Milton trial ends ${ends.slice(0, 10)} (UTC). Keep using Milton for $5.01/month. Your preferences remain available to view and download after expiry.`,
  };
}
