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

// Stripe statuses that end access. Anything Milton does not recognize allows it,
// so a new Stripe status or an outage never locks anyone out.
const ENDED = new Set([
  "canceled",
  "unpaid",
  "incomplete",
  "incomplete_expired",
  "paused",
]);

export async function trialStatus(
  db: StoreSession,
  userId: string,
): Promise<TrialStatus> {
  const row = (
    await db.query<{
      enabled: boolean;
      status: string | null;
      trial_end: Date | string | null;
      now: Date | string;
      in_grace: boolean;
    }>(sql`SELECT c.trials_enabled AS enabled, t.subscription_status AS status,
    t.trial_end, clock_timestamp() AS now,
    coalesce(clock_timestamp() < t.current_period_start + interval '3 days',true) AS in_grace
    FROM store_config c LEFT JOIN trial_accounts t ON t.user_id=${userId}
    WHERE c.singleton=1`)
  )[0];
  if (!row)
    throw new StoreError("configuration", "Account access is unavailable.");
  const { status } = row;
  if (!row.enabled || !status)
    return { status: "early_access", reminder_stage: 0 };
  // A failed renewal's period end is already a month ahead, so past_due's grace
  // runs from the renewal, the start of the unpaid period.
  if (status === "active" || (status === "past_due" && row.in_grace))
    return { status: "paid", reminder_stage: 0 };
  if (status === "past_due" || ENDED.has(status))
    return { status: "expired", reminder_stage: 0 };
  if (status !== "trialing")
    return { status: "early_access", reminder_stage: 0 };
  if (!row.trial_end) return { status: "trial", reminder_stage: 0 };
  const end = new Date(row.trial_end);
  const remaining = end.getTime() - new Date(row.now).getTime();
  return {
    status: "trial",
    trial_ends_at: end.toISOString(),
    reminder_stage:
      remaining <= 0 || remaining > 7 * 86400000
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
      WHEN t.trial_end <= clock_timestamp()+interval '24 hours' THEN 2 ELSE 1 END
    WHERE t.user_id=${userId}
      AND EXISTS (SELECT 1 FROM users u WHERE u.id=t.user_id AND u.status='active')
      AND EXISTS (SELECT 1 FROM store_config WHERE singleton=1 AND trials_enabled)
      AND t.subscription_status='trialing'
      AND t.trial_end > clock_timestamp()
      AND t.trial_end <= clock_timestamp()+interval '168 hours'
      AND t.notice_stage < CASE WHEN t.trial_end <= clock_timestamp()+interval '24 hours' THEN 2 ELSE 1 END
    RETURNING notice_stage AS stage, trial_end AS ends_at`)
  )[0];
  if (!row) return;
  const ends = new Date(row.ends_at).toISOString();
  return {
    code: row.stage === 2 ? "trial_ending_1_day" : "trial_ending_7_days",
    trial_ends_at: ends,
    message: `Your Milton trial ends ${ends.slice(0, 10)} (UTC). Keep using Milton for $5.01/month. Your preferences remain available to view and download after expiry.`,
  };
}
