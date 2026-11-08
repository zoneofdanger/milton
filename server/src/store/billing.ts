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

// Every write of the Stripe state columns advances the revision, values unchanged
// included, so a write after a Stripe read can tell whether any other landed since
// its snapshot (see stripeCustomerRow).
const advanced = sql`stripe_revision=stripe_revision+1`;
const subscriptionColumns = (state: StripeSubscriptionState) =>
  sql`stripe_subscription_id=${state.id},subscription_status=${state.status},
    trial_end=to_timestamp(${state.trialEnd}::double precision),
    current_period_start=to_timestamp(${state.periodStart}::double precision),
    current_period_end=to_timestamp(${state.periodEnd}::double precision),
    ${advanced}`;

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
      generation: number;
    }>(sql`
    SELECT u.test_account AS test, t.user_id IS NOT NULL AS enrolled,
      t.stripe_customer_id AS customer, t.subscription_status AS status,
      coalesce(t.enrol_generation,0) AS generation
    FROM users u LEFT JOIN trial_accounts t ON t.user_id=u.id WHERE u.id=${userId}`)
  )[0];
  return (
    row ?? {
      test: false,
      enrolled: false,
      customer: null,
      status: null,
      generation: 0,
    }
  );
}
/** Test accounts are never written by billing. */
const billable = sql`NOT EXISTS (SELECT 1 FROM users x WHERE x.id=user_id AND x.test_account)`;
/** An active account billing may enrol: not a test account. */
const enrollable = sql`EXISTS (SELECT 1 FROM users a WHERE a.id=user_id AND a.status='active' AND NOT a.test_account)`;
/** The caller's lease, still unexpired. */
const holding = (lease: string) =>
  sql`enrol_lease_until=${lease}::timestamptz AND enrol_lease_until>clock_timestamp()`;
/** Account deletion's lease, which never expires (fenceEnrolment). */
const FENCE = sql`'infinity'::timestamptz`;

/** Stores the customer on the clock row of an active account unless one is
 * already stored; returns the stored customer. With `lease`, only while that lease
 * is live, so an enrolment taken over or fenced by deletion links nothing. */
export async function linkStripeCustomer(
  db: StoreSession,
  userId: string,
  customer: string,
  lease?: string,
) {
  return (
    await db.query<{ customer: string }>(sql`
    UPDATE trial_accounts SET stripe_customer_id=coalesce(stripe_customer_id,${customer})
    WHERE user_id=${userId} AND ${enrollable}${lease ? sql` AND ${holding(lease)}` : sql``}
    RETURNING stripe_customer_id AS customer`)
  )[0]?.customer;
}

// Covers the most an attempt does between claiming and renewing, or renewing and
// saving: two Stripe calls (5 s timeout each) and a statement (20 s limit), 30 s,
// so a holder still working is not taken over. A holder paused longer (Cloud Run
// throttles CPU after the reply) finds its renewal refused before it can start a
// second trial.
const LEASE = sql`clock_timestamp()+interval '60 seconds'`;

/** Claims the right to enrol an active account with Stripe, if it still has no
 * subscription and no other attempt holds a live lease (deletion's never expires).
 * One committed statement, so no row stays locked while Stripe is called. Returns
 * the stored customer, the generation that names the idempotency keys, and the
 * lease, whose text is the token later statements compare. A takeover keeps the
 * generation, so it sends the keys the attempt before it sent. */
export async function claimEnrolment(db: StoreSession, userId: string) {
  return (
    await db.query<{
      customer: string | null;
      generation: number;
      lease: string;
    }>(sql`
    UPDATE trial_accounts SET enrol_lease_until=${LEASE}
    WHERE user_id=${userId} AND subscription_status IS NULL AND ${enrollable}
      AND (enrol_lease_until IS NULL OR enrol_lease_until < clock_timestamp())
    RETURNING stripe_customer_id AS customer, enrol_generation AS generation,
      enrol_lease_until::text AS lease`)
  )[0];
}

/** Extends a lease still live, before a call that could start a trial; returns
 * the new token, or nothing once it expired, was taken over or was fenced. */
export async function renewEnrolment(
  db: StoreSession,
  userId: string,
  lease: string,
) {
  return (
    await db.query<{ lease: string }>(sql`
    UPDATE trial_accounts SET enrol_lease_until=${LEASE}
    WHERE user_id=${userId} AND subscription_status IS NULL AND ${enrollable}
      AND ${holding(lease)}
    RETURNING enrol_lease_until::text AS lease`)
  )[0]?.lease;
}

/** Moves to the next generation of idempotency keys after Stripe refused one with
 * an answer it replays for that key; once only, however many attempts saw it. */
export async function nextEnrolGeneration(
  db: StoreSession,
  userId: string,
  generation: number,
) {
  await db.query(sql`UPDATE trial_accounts SET enrol_generation=enrol_generation+1
    WHERE user_id=${userId} AND enrol_generation=${generation}`);
}

/** Stores what Stripe answered, only while the account still has no
 * subscription (a webhook may have stored a newer one meanwhile), and ends the
 * lease if it is still this attempt's, never a successor's. */
export async function saveEnrolment(
  db: StoreSession,
  userId: string,
  lease: string,
  state: StripeSubscriptionState,
) {
  await db.query(sql`UPDATE trial_accounts SET ${subscriptionColumns(state)},
    enrol_lease_until=CASE WHEN enrol_lease_until=${lease}::timestamptz
      THEN NULL ELSE enrol_lease_until END
    WHERE user_id=${userId} AND subscription_status IS NULL AND ${billable}`);
}

/** Account deletion's fence: takes the lease for good, so no attempt can claim,
 * renew or link again. Only when no other attempt holds a live lease; false then,
 * and deletion retries once it has finished or expired. True with no row. */
export async function fenceEnrolment(db: StoreSession, userId: string) {
  const row = (
    await db.query<{ fenced: number; rows: number }>(sql`
    WITH f AS (UPDATE trial_accounts SET enrol_lease_until=${FENCE}
      WHERE user_id=${userId} AND (enrol_lease_until IS NULL
        OR enrol_lease_until<=clock_timestamp() OR enrol_lease_until=${FENCE})
      RETURNING 1)
    SELECT (SELECT count(*) FROM f)::int AS fenced,
      (SELECT count(*) FROM trial_accounts WHERE user_id=${userId})::int AS rows`)
  )[0]!;
  return row.fenced === 1 || row.rows === 0;
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

/** Writes what Stripe answered. Callers write only while the row's revision is
 * what it was before their read (see stripeCustomerRow). */
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

/** Forgets the customer Stripe has just ended, holding the row for the rest of
 * the caller's transaction. False while an enrolment lease other than deletion's
 * fence is live, or when the row now holds another customer: a retry must end
 * what that enrolment made first. */
export async function forgetStripeCustomer(
  db: StoreSession,
  userId: string,
  ended: string | null,
) {
  const row = (
    await db.query<{ customer: string | null; enrolling: boolean }>(sql`
      SELECT stripe_customer_id AS customer,
        coalesce(enrol_lease_until>clock_timestamp() AND enrol_lease_until<>${FENCE},false) AS enrolling
      FROM trial_accounts WHERE user_id=${userId} FOR UPDATE`)
  )[0];
  if (row?.enrolling) return false;
  const stored = row?.customer ?? null;
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
              ? sql`subscription_status='canceled',${advanced}`
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

/** Accounts the enrolment sweep picks up, oldest first: trials on, an active,
 * non-test account whose trial row has no status, started more than 5 minutes ago
 * (sign-in's own background enrolment has had its chance), and no live lease
 * (deletion's fence included). A returning deleted identity an older image left
 * (started before its account) never gets a trial, as in backfillAccounts. */
const pending = sql`FROM trial_accounts t JOIN users u ON u.id=t.user_id
  WHERE (SELECT trials_enabled FROM store_config WHERE singleton=1)
    AND t.subscription_status IS NULL AND u.status='active' AND NOT u.test_account
    AND t.started_at >= u.created_at
    AND t.started_at < clock_timestamp()-interval '5 minutes'
    AND (t.enrol_lease_until IS NULL OR t.enrol_lease_until < clock_timestamp())`;
export async function pendingEnrolments(db: StoreSession, limit: number) {
  return (
    await db.query<{ id: string }>(
      sql`SELECT t.user_id AS id ${pending} ORDER BY t.started_at,t.user_id LIMIT ${limit}`,
    )
  ).map(({ id }) => id);
}
export async function pendingEnrolmentCount(db: StoreSession) {
  return (
    await db.query<{ n: number }>(sql`SELECT count(*)::int AS n ${pending}`)
  )[0]!.n;
}

/** Gives an active account a clock row with no status, if it has none. */
export async function enrollForBackfill(db: StoreSession, userId: string) {
  await db.query(sql`INSERT INTO trial_accounts(user_id,started_at)
    SELECT id,created_at FROM users WHERE id=${userId} AND status='active'
    AND NOT test_account ON CONFLICT (user_id) DO NOTHING`);
}
