import { sql } from "drizzle-orm";
import type { StoreSession } from "./database";

// What one verified Stripe event does to the clock row it names. Milton keeps
// paid access as paid_through only; Stripe stays the record of the subscription.
export type StripeEventAction =
  | { kind: "none" }
  // checkout.session.completed: confirms the customer checkout linked.
  | { kind: "link"; customer: string; userId: string }
  // invoice.paid and an active customer.subscription.updated: the period end
  // in epoch seconds; paid_through is that plus 3 days of grace. It only moves forward, so a late or reordered
  // delivery cannot shorten access.
  | { kind: "paid_through"; customer: string; periodEnd: number }
  // customer.subscription.deleted.
  | { kind: "clear"; customer: string };

export async function billingAccount(db: StoreSession, userId: string) {
  const row = (
    await db.query<{ customer: string | null; paid: boolean }>(sql`
    SELECT stripe_customer_id AS customer,
      coalesce(paid_through > clock_timestamp(),false) AS paid
    FROM trial_accounts WHERE user_id=${userId}`)
  )[0];
  return row
    ? { enrolled: true, customer: row.customer, paid: row.paid }
    : { enrolled: false, customer: null, paid: false };
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

/** Records the event and applies its action in one statement: a redelivered
 * event id records nothing and changes nothing. */
export async function recordStripeEvent(
  db: StoreSession,
  event: {
    id: string;
    type: string;
    payloadSha256: string;
    action: StripeEventAction;
  },
) {
  const { action } = event;
  const recorded = sql`e AS (INSERT INTO stripe_events(id,type,payload_sha256)
    VALUES (${event.id},${event.type},${event.payloadSha256})
    ON CONFLICT (id) DO NOTHING RETURNING id)`;
  const until = (end: number) =>
    sql`to_timestamp(${end}::double precision) + interval '3 days'`;
  const update =
    action.kind === "paid_through"
      ? sql`UPDATE trial_accounts SET paid_through=greatest(coalesce(paid_through,${until(action.periodEnd)}),${until(action.periodEnd)})
        WHERE stripe_customer_id=${action.customer}`
      : action.kind === "clear"
        ? sql`UPDATE trial_accounts SET paid_through=NULL WHERE stripe_customer_id=${action.customer}`
        : action.kind === "link"
          ? sql`UPDATE trial_accounts SET stripe_customer_id=${action.customer}
        WHERE user_id=${action.userId} AND stripe_customer_id IS NULL
        AND NOT EXISTS (SELECT 1 FROM trial_accounts WHERE stripe_customer_id=${action.customer})`
          : undefined;
  const row = (
    await db.query<{ recorded: number; updated: number }>(
      update
        ? sql`WITH ${recorded}, u AS (${update} AND EXISTS (SELECT 1 FROM e) RETURNING 1)
          SELECT (SELECT count(*) FROM e)::int AS recorded, (SELECT count(*) FROM u)::int AS updated`
        : sql`WITH ${recorded} SELECT (SELECT count(*) FROM e)::int AS recorded, 0 AS updated`,
    )
  )[0]!;
  return { recorded: row.recorded === 1, updated: row.updated };
}
