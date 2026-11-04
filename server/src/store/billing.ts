import { sql } from "drizzle-orm";
import type { StoreSession } from "./database";

// One Stripe subscription as Milton keeps it. Dates are epoch seconds.
export type StripeSubscriptionState = {
  id: string;
  status: string;
  trialEnd: number | null;
  periodStart: number;
  periodEnd: number;
};
export type StripeEvent = { id: string; type: string; payloadSha256: string };

const subscriptionColumns = (state: StripeSubscriptionState) =>
  sql`stripe_subscription_id=${state.id},subscription_status=${state.status},
    trial_end=to_timestamp(${state.trialEnd}::double precision),
    current_period_start=to_timestamp(${state.periodStart}::double precision),
    current_period_end=to_timestamp(${state.periodEnd}::double precision)`;

export async function billingAccount(db: StoreSession, userId: string) {
  const row = (
    await db.query<{ customer: string | null; status: string | null }>(sql`
    SELECT stripe_customer_id AS customer, subscription_status AS status
    FROM trial_accounts WHERE user_id=${userId}`)
  )[0];
  return row
    ? { enrolled: true, ...row }
    : { enrolled: false, customer: null, status: null };
}

/** Stores the customer on the clock row unless one is already stored; returns
 * the stored customer. */
export async function linkStripeCustomer(
  db: StoreSession,
  userId: string,
  customer: string,
) {
  return (
    await db.query<{ customer: string }>(sql`
    UPDATE trial_accounts SET stripe_customer_id=coalesce(stripe_customer_id,${customer})
    WHERE user_id=${userId} RETURNING stripe_customer_id AS customer`)
  )[0]?.customer;
}

/** Locks the row for the rest of the transaction if it still has no subscription,
 * and returns it. A second attempt waits here and then finds it set. */
export async function lockWaitingSubscription(
  db: StoreSession,
  userId: string,
) {
  return (
    await db.query<{ customer: string | null }>(sql`
    SELECT stripe_customer_id AS customer FROM trial_accounts
    WHERE user_id=${userId} AND subscription_status IS NULL FOR UPDATE`)
  )[0];
}

/** Writes what Stripe answered. Callers hold the row, so an older read cannot
 * land after a newer one. */
export async function saveStripeSubscription(
  db: StoreSession,
  userId: string,
  state: StripeSubscriptionState,
) {
  await db.query(sql`UPDATE trial_accounts SET ${subscriptionColumns(state)}
    WHERE user_id=${userId}`);
}

/** Locks the row holding this customer, if any, for the rest of the transaction.
 * Reads of Stripe for one customer run one at a time, so a slower, older read
 * cannot land after a newer one. */
export async function lockStripeCustomer(db: StoreSession, customer: string) {
  return (
    await db.query<{ subscription: string | null }>(sql`
    SELECT stripe_subscription_id AS subscription FROM trial_accounts
    WHERE stripe_customer_id=${customer} FOR UPDATE`)
  )[0];
}

export async function stripeEventRecorded(db: StoreSession, id: string) {
  return (
    (await db.query(sql`SELECT 1 FROM stripe_events WHERE id=${id}`)).length > 0
  );
}

/** Forgets a customer Stripe has deleted. Stripe accepts nothing further for that
 * id, so keeping it would block a retry and any later subscription. */
export async function clearStripeCustomer(db: StoreSession, userId: string) {
  await db.query(sql`UPDATE trial_accounts SET stripe_customer_id=NULL,
    stripe_subscription_id=NULL,subscription_status='canceled'
    WHERE user_id=${userId}`);
}

/** Records the event and writes what Stripe answered in one statement: a
 * redelivered event id records nothing and changes nothing. "canceled" keeps the
 * stored subscription and dates and ends the status: Stripe no longer has it. */
export async function recordStripeEvent(
  db: StoreSession,
  event: StripeEvent,
  write?: { customer: string; state: StripeSubscriptionState | "canceled" },
) {
  const recorded = sql`e AS (INSERT INTO stripe_events(id,type,payload_sha256)
    VALUES (${event.id},${event.type},${event.payloadSha256})
    ON CONFLICT (id) DO NOTHING RETURNING id)`;
  const row = (
    await db.query<{ recorded: number; updated: number }>(
      write
        ? sql`WITH ${recorded}, u AS (UPDATE trial_accounts SET ${
            write.state === "canceled"
              ? sql`subscription_status='canceled'`
              : subscriptionColumns(write.state)
          } WHERE stripe_customer_id=${write.customer} AND EXISTS (SELECT 1 FROM e) RETURNING 1)
          SELECT (SELECT count(*) FROM e)::int AS recorded, (SELECT count(*) FROM u)::int AS updated`
        : sql`WITH ${recorded} SELECT (SELECT count(*) FROM e)::int AS recorded, 0 AS updated`,
    )
  )[0]!;
  return { recorded: row.recorded === 1, updated: row.updated };
}

/** Every active account and its status, null with no row or no status yet. */
export async function backfillAccounts(db: StoreSession) {
  return db.query<{ id: string; status: string | null }>(sql`
    SELECT u.id, t.subscription_status AS status FROM users u
    LEFT JOIN trial_accounts t ON t.user_id=u.id
    WHERE u.status='active' ORDER BY u.id`);
}

/** Gives an active account a clock row with no status, if it has none. */
export async function enrollForBackfill(db: StoreSession, userId: string) {
  await db.query(sql`INSERT INTO trial_accounts(user_id,started_at)
    SELECT id,created_at FROM users WHERE id=${userId} AND status='active'
    ON CONFLICT (user_id) DO NOTHING`);
}
