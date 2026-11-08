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

// Every write Milton's code makes of the Stripe state columns advances the revision, values unchanged
// included, so a write after a Stripe read can tell whether any other landed since
// its snapshot (see stripeCustomerRow).
const advanced = sql`stripe_revision=stripe_revision+1`;
const subscriptionColumns = (state: StripeSubscriptionState) =>
  sql`stripe_subscription_id=${state.id},subscription_status=${state.status},
    trial_end=to_timestamp(${state.trialEnd}::double precision),
    current_period_start=to_timestamp(${state.periodStart}::double precision),
    current_period_end=to_timestamp(${state.periodEnd}::double precision),
    ${advanced}`;

/** The account's deletion has begun: native authority refused it before its
 * Stripe step (milton_app.lifecycle past pending), and it never goes back. */
const deletionBegun = (userId: string) =>
  sql`EXISTS (SELECT 1 FROM milton_app.lifecycle l WHERE l.user_id=${userId}
    AND l.kind='delete' AND l.progress<>'pending')`;

/** The account's billing row, if any. A test account (users.test_account) is
 * permanently outside trials and billing, whatever row it holds: `test` tells
 * every caller to start, sell or manage nothing for it, and so does `deleting`.
 * `deleting` is read from the lifecycle row, which outlives the erase and
 * native cleanup, and is true too once the account itself is gone. */
export async function billingAccount(db: StoreSession, userId: string) {
  return (
    await db.query<{
      test: boolean;
      deleting: boolean;
      enrolled: boolean;
      customer: string | null;
      status: string | null;
    }>(sql`
    SELECT coalesce(u.test_account,false) AS test,
      (u.id IS NULL OR ${deletionBegun(userId)}) AS deleting,
      t.user_id IS NOT NULL AS enrolled,
      t.stripe_customer_id AS customer, t.subscription_status AS status
    FROM (SELECT ${userId}::text AS id) a LEFT JOIN users u ON u.id=a.id
    LEFT JOIN trial_accounts t ON t.user_id=u.id`)
  )[0]!;
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

/** Writes what Stripe answered. Enrolment holds the row across its Stripe calls;
 * checkout writes only while the row's revision is what it was before its read
 * (see stripeCustomerRow). */
export async function saveStripeSubscription(
  db: StoreSession,
  userId: string,
  state: StripeSubscriptionState,
) {
  await db.query(sql`UPDATE trial_accounts SET ${subscriptionColumns(state)}
    WHERE user_id=${userId}`);
}

/** The row holding this customer, if any: its subscription and the revision of
 * its stored Stripe state (as text, exact). With `lock`, the row is held for the
 * rest of the transaction, which only compares and writes: Stripe is read before
 * it opens. */
export async function stripeCustomerRow(
  db: StoreSession,
  customer: string,
  lock = false,
) {
  return (
    await db.query<{ subscription: string | null; revision: string }>(sql`
    SELECT stripe_subscription_id AS subscription, stripe_revision::text AS revision
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
    stripe_subscription_id=NULL,subscription_status='canceled',${advanced}
    WHERE user_id=${userId}`);
}

/** What Stripe answered, as the columns a reconciliation sets. "canceled" keeps
 * the stored subscription and dates and ends the status: Stripe no longer has it. */
const reconciledColumns = (state: StripeSubscriptionState | "canceled") =>
  state === "canceled"
    ? sql`subscription_status='canceled',${advanced}`
    : subscriptionColumns(state);

/** Writes what Stripe answered for this customer, with no event: the owner's
 * resync (scripts/backfill-subscriptions.ts --resync). Callers write only over an
 * unchanged revision. */
export async function saveCustomerState(
  db: StoreSession,
  customer: string,
  state: StripeSubscriptionState | "canceled",
) {
  await db.query(sql`UPDATE trial_accounts SET ${reconciledColumns(state)}
    WHERE stripe_customer_id=${customer} AND ${billable}`);
}

/** Every stored Stripe customer of an account billing serves (not a test
 * account), for the owner's resync. */
export async function storedCustomers(db: StoreSession) {
  return (
    await db.query<{ customer: string }>(sql`
    SELECT t.stripe_customer_id AS customer FROM trial_accounts t
    JOIN users u ON u.id=t.user_id
    WHERE t.stripe_customer_id IS NOT NULL AND NOT u.test_account
    ORDER BY t.user_id`)
  ).map(({ customer }) => customer);
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
        ? sql`WITH ${recorded}, u AS (UPDATE trial_accounts SET ${reconciledColumns(
            write.state,
          )} WHERE stripe_customer_id=${write.customer} AND ${billable} AND EXISTS (SELECT 1 FROM e))
          SELECT (SELECT count(*) FROM e)::int AS recorded`
        : sql`WITH ${recorded} SELECT (SELECT count(*) FROM e)::int AS recorded`,
    )
  )[0]!;
  return { recorded: row.recorded === 1 };
}

/** 0027's data statement: a returning deleted identity an older image wrote, with
 * no status and a start before its account, is canceled, never given a trial. */
export async function cancelReturningIdentities(db: StoreSession) {
  await db.query(sql`UPDATE trial_accounts t SET subscription_status='canceled',${advanced}
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
