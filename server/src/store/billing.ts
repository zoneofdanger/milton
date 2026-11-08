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

/** The account's billing row, if any. A test account (users.test_account) is
 * permanently outside trials and billing, whatever row it holds: `test` tells
 * every caller to start, sell or manage nothing for it. */
export async function billingAccount(db: StoreSession, userId: string) {
  const row = (
    await db.query<{
      test: boolean;
      enrolled: boolean;
      customer: string | null;
      status: string | null;
    }>(sql`
    SELECT u.test_account AS test, t.user_id IS NOT NULL AS enrolled,
      t.stripe_customer_id AS customer, t.subscription_status AS status
    FROM users u LEFT JOIN trial_accounts t ON t.user_id=u.id WHERE u.id=${userId}`)
  )[0];
  return row ?? { test: false, enrolled: false, customer: null, status: null };
}
/** Test accounts are never written by billing. */
const billable = sql`NOT EXISTS (SELECT 1 FROM users x WHERE x.id=user_id AND x.test_account)`;

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

// Covers the most an attempt does between claiming and renewing, or renewing and
// saving: two Stripe calls (5 s timeout each) and a statement (20 s limit), 30 s,
// so a holder still working is not taken over. A holder paused longer (Cloud Run
// throttles CPU after the reply) finds its renewal refused before it can start a
// second trial.
const LEASE = sql`clock_timestamp()+interval '60 seconds'`;

/** Claims the right to enrol the account with Stripe, if it still has no
 * subscription and no other attempt holds a live lease. One committed statement,
 * so no row stays locked while Stripe is called. Returns the stored customer and
 * the lease, whose text is the token later statements compare. */
export async function claimEnrolment(db: StoreSession, userId: string) {
  return (
    await db.query<{ customer: string | null; lease: string }>(sql`
    UPDATE trial_accounts SET enrol_lease_until=${LEASE}
    WHERE user_id=${userId} AND subscription_status IS NULL AND ${billable}
      AND (enrol_lease_until IS NULL OR enrol_lease_until < clock_timestamp())
    RETURNING stripe_customer_id AS customer, enrol_lease_until::text AS lease`)
  )[0];
}

/** Extends a lease still held, before a call that could start a second trial;
 * returns the new token, or nothing once another attempt has taken it over. */
export async function renewEnrolment(
  db: StoreSession,
  userId: string,
  lease: string,
) {
  return (
    await db.query<{ lease: string }>(sql`
    UPDATE trial_accounts SET enrol_lease_until=${LEASE}
    WHERE user_id=${userId} AND subscription_status IS NULL
      AND enrol_lease_until=${lease}::timestamptz
    RETURNING enrol_lease_until::text AS lease`)
  )[0]?.lease;
}

/** Stores what Stripe answered, only while the account still has no
 * subscription (a webhook may have stored a newer one meanwhile), and ends the
 * lease. */
export async function saveEnrolment(
  db: StoreSession,
  userId: string,
  state: StripeSubscriptionState,
) {
  await db.query(sql`UPDATE trial_accounts SET ${subscriptionColumns(state)},
    enrol_lease_until=NULL
    WHERE user_id=${userId} AND subscription_status IS NULL AND ${billable}`);
}

/** Ends a lease still held, so the next attempt need not wait it out. */
export async function releaseEnrolment(
  db: StoreSession,
  userId: string,
  lease: string,
) {
  await db.query(sql`UPDATE trial_accounts SET enrol_lease_until=NULL
    WHERE user_id=${userId} AND enrol_lease_until=${lease}::timestamptz`);
}

/** Writes what Stripe answered. Callers write only while the row's stored state
 * is what it was before their read (see stripeCustomerRow). */
export async function saveStripeSubscription(
  db: StoreSession,
  userId: string,
  state: StripeSubscriptionState,
) {
  await db.query(sql`UPDATE trial_accounts SET ${subscriptionColumns(state)}
    WHERE user_id=${userId}`);
}

// The stored Stripe state as one comparable text, independent of time zone.
const storedState = sql`row(stripe_subscription_id,subscription_status,
  extract(epoch from trial_end),extract(epoch from current_period_start),
  extract(epoch from current_period_end))::text`;

/** The row holding this customer, if any: its subscription and its stored
 * Stripe state. With `lock`, the row is held for the rest of the transaction,
 * which only compares and writes: Stripe is read before it opens. */
export async function stripeCustomerRow(
  db: StoreSession,
  customer: string,
  lock = false,
) {
  return (
    await db.query<{ subscription: string | null; stored: string }>(sql`
    SELECT stripe_subscription_id AS subscription, ${storedState} AS stored
    FROM trial_accounts WHERE stripe_customer_id=${customer} AND ${billable}
    ${lock ? sql`FOR UPDATE` : sql``}`)
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

/** Forgets the customer Stripe has just ended, holding the row for the rest of
 * the caller's transaction. False when the row now holds another customer, which
 * a retry must end first. */
export async function forgetStripeCustomer(
  db: StoreSession,
  userId: string,
  ended: string | null,
) {
  const stored =
    (
      await db.query<{ customer: string | null }>(sql`
      SELECT stripe_customer_id AS customer FROM trial_accounts
      WHERE user_id=${userId} FOR UPDATE`)
    )[0]?.customer ?? null;
  if (stored === null) return true;
  if (stored !== ended) return false;
  await clearStripeCustomer(db, userId);
  return true;
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
