import { sql } from "drizzle-orm";
import type { StoreSession } from "./database";
import { StoreError } from "./errors";

export type TrialStatus = {
  status: "early_access" | "trial" | "paid" | "expired";
  trial_ends_at?: string;
  /** Whole days left in a trial, rounded up; a trial still running reads 1 at least. */
  days_left?: number;
  reminder_stage: 0 | 1 | 2;
};
export type TrialNotice = {
  code: "trial_ending_7_days" | "trial_ending_1_day";
  trial_ends_at: string;
  message: string;
};

// Stripe statuses that end access. Anything Milton does not recognize allows it,
// so a new Stripe status or an outage never cuts off a connected assistant.
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
    days_left: Math.max(Math.ceil(remaining / 86400000), 1),
    reminder_stage:
      remaining <= 0 || remaining > 7 * 86400000
        ? 0
        : remaining <= 86400000
          ? 2
          : 1,
  };
}

// Read by everyone Milton stopped, a paying person past grace included, so it does
// not say the trial ended. The one link is the signed-in app home, where the button
// lives. Only tools.ts serves this, with the origin; the gate throws it without.
export function subscriptionRequired(appOrigin?: string) {
  return new StoreError(
    "subscription_required",
    "Milton is paused until you subscribe for $5.01/month. Your rules and samples stay available to view and download." +
      (appOrigin ? ` Subscribe at ${appOrigin}/` : ""),
    402,
    { retryable: false },
  );
}

// Both reminders. Someone who already added a card reads this too.
export const trialEndingMessage = (endsAt: string, appOrigin: string) =>
  `Your Milton trial ends ${endsAt.slice(0, 10)} (UTC), then it's $5.01/month. Unless you've already added a card, add one by then to keep using Milton: ${appOrigin}/`;

export async function assertTrialAccess(db: StoreSession, userId: string) {
  if ((await trialStatus(db, userId)).status === "expired")
    throw subscriptionRequired();
}

export async function claimTrialNotice(
  db: StoreSession,
  userId: string,
  appOrigin: string,
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
    message: trialEndingMessage(ends, appOrigin),
  };
}
