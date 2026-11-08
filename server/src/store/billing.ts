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

/** The account's deletion has begun: native authority refused it before its
 * Stripe step (milton_app.lifecycle past pending), and it never goes back. */
const deletionBegun = (userId: string) =>
  sql`EXISTS (SELECT 1 FROM milton_app.lifecycle l WHERE l.user_id=${userId}
    AND l.kind='delete' AND l.progress<>'pending')`;

/** The account's billing row, if any. A test account (users.test_account) is
 * permanently outside trials and billing, whatever row it holds: `test` tells
 * every caller to start, sell or manage nothing for it, and so does `deleting`. */
export async function billingAccount(db: StoreSession, userId: string) {
  const row = (
    await db.query<{
      test: boolean;
      deleting: boolean;
      enrolled: boolean;
      customer: string | null;
      status: string | null;
    }>(sql`
    SELECT u.test_account AS test, ${deletionBegun(userId)} AS deleting,
      t.user_id IS NOT NULL AS enrolled,
      t.stripe_customer_id AS customer, t.subscription_status AS status
    FROM users u LEFT JOIN trial_accounts t ON t.user_id=u.id WHERE u.id=${userId}`)
  )[0];
  return (
    row ?? {
      test: false,
      deleting: false,
      enrolled: false,
      customer: null,
      status: null,
    }
  );
}
/** Test accounts are never written by billing. */
const billable = sql`NOT EXISTS (SELECT 1 FROM users x WHERE x.id=user_id AND x.test_account)`;

/** Stores the customer on the clock row unless one is already stored; returns
 * the stored customer. Nothing, once the account's deletion has begun or the
 * row is gone. The caller holds the row (lockStripeAccount) from an earlier
 * statement, so this statement's read of the deletion is no older than the
 * lock: a deletion's Stripe step holds the same row while it reads the customer,
 * and either it sees this link or this link sees the deletion. */
export async function linkStripeCustomer(
  db: StoreSession,
  userId: string,
  customer: string,
) {
  return (
    await db.query<{ customer: string }>(sql`
    UPDATE trial_accounts SET stripe_customer_id=coalesce(stripe_customer_id,${customer})
    WHERE user_id=${userId} AND NOT ${deletionBegun(userId)}
    RETURNING stripe_customer_id AS customer`)
  )[0]?.customer;
}

/** Locks the account's clock row for the rest of the transaction, whatever it
 * holds, and returns its customer. Enrolment holds the same row across its
 * Stripe calls, so a deletion reading the customer here waits for it. */
export async function lockStripeAccount(db: StoreSession, userId: string) {
  return (
    await db.query<{ customer: string | null }>(sql`
    SELECT stripe_customer_id AS customer FROM trial_accounts
    WHERE user_id=${userId} FOR UPDATE`)
  )[0];
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
    WHERE user_id=${userId} AND subscription_status IS NULL AND ${billable} FOR UPDATE`)
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
    WHERE stripe_customer_id=${customer} AND ${billable} FOR UPDATE`)
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
    await db.query<{ recorded: number }>(
      // A data-modifying WITH runs to completion even though nothing reads it.
      write
        ? sql`WITH ${recorded}, u AS (UPDATE trial_accounts SET ${
            write.state === "canceled"
              ? sql`subscription_status='canceled'`
              : subscriptionColumns(write.state)
          } WHERE stripe_customer_id=${write.customer} AND ${billable} AND EXISTS (SELECT 1 FROM e))
          SELECT (SELECT count(*) FROM e)::int AS recorded`
        : sql`WITH ${recorded} SELECT (SELECT count(*) FROM e)::int AS recorded`,
    )
  )[0]!;
  return { recorded: row.recorded === 1 };
}

/** 0027's data statement: a returning deleted identity an older image wrote, with
 * no status and a start before its account, is canceled, never given a trial. */
export async function cancelReturningIdentities(db: StoreSession) {
  await db.query(sql`UPDATE trial_accounts t SET subscription_status='canceled'
    FROM users u WHERE u.id=t.user_id AND t.started_at < u.created_at
    AND t.subscription_status IS NULL AND NOT u.test_account`);
}

/** Every active account and its status, null with no row or no status yet.
 * returning marks a row cancelReturningIdentities has not reached. Test accounts
 * (users.test_account) are neither counted nor given a trial: no Stripe call. */
export async function backfillAccounts(db: StoreSession) {
  return db.query<{
    id: string;
    status: string | null;
    returning: boolean;
  }>(sql`
    SELECT u.id, t.subscription_status AS status,
      coalesce(t.subscription_status IS NULL AND t.started_at < u.created_at,false) AS returning
    FROM users u LEFT JOIN trial_accounts t ON t.user_id=u.id
    WHERE u.status='active' AND NOT u.test_account ORDER BY u.id`);
}

/** Gives an active account a clock row with no status, if it has none. */
export async function enrollForBackfill(db: StoreSession, userId: string) {
  await db.query(sql`INSERT INTO trial_accounts(user_id,started_at)
    SELECT id,created_at FROM users WHERE id=${userId} AND status='active'
    AND NOT test_account ON CONFLICT (user_id) DO NOTHING`);
}
