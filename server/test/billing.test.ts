import { expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { sql } from "drizzle-orm";
import { createMiltonApp } from "../src/index";
import { claimTrialNotice, trialStatus } from "../src/store/trials";
import { localStore } from "./local-store";

const appOrigin = "http://localhost:3001";
// Obviously fake values in the shapes Stripe uses.
const billing = {
  secretKey: "rk_test_fixtureNotAKey",
  webhookSecret: "whsec_fixtureNotASecret",
  priceId: "price_fixture",
};
const userId = "m_00000000-0000-4000-8000-000000000025";

async function webhookFixture(configured = true) {
  const local = await localStore();
  await local.db.query(sql`UPDATE store_config SET trials_enabled=true`);
  await local.db.query(sql`INSERT INTO users(id) VALUES (${userId})`);
  // An ended subscription on its Stripe customer.
  await local.db.query(
    sql`INSERT INTO trial_accounts(user_id,started_at,stripe_customer_id,stripe_subscription_id,subscription_status)
    VALUES (${userId},clock_timestamp()-interval '31 days','cus_fixture','sub_fixture','canceled')`,
  );
  const app = createMiltonApp({
    issuer: "https://auth.example/milton/auth",
    resource: appOrigin + "/mcp",
    appOrigin,
    cookieSecret: crypto.randomUUID(),
    ...local.env,
    ...(configured ? { billing } : {}),
  });
  const sign = (body: string, t = Math.floor(Date.now() / 1000)) =>
    `t=${t},v1=${createHmac("sha256", billing.webhookSecret).update(`${t}.${body}`).digest("hex")}`;
  const post = async (
    body: string,
    signature: string | null = sign(body),
    headers: Record<string, string> = {},
    method = "POST",
  ) => {
    const response = await app(
      new Request(appOrigin + "/billing/webhook", {
        method,
        headers: {
          Host: "localhost:3001",
          "Content-Type": "application/json; charset=utf-8",
          ...(signature ? { "Stripe-Signature": signature } : {}),
          ...headers,
        },
        ...(method === "POST" ? { body } : {}),
      }),
    );
    return [response.status, await response.text()] as const;
  };
  return {
    local,
    sign,
    post,
    status: async () => (await trialStatus(local.db, userId)).status,
    ledger: async () =>
      (
        await local.pg.query<{ id: string; type: string }>(
          "SELECT id,type FROM stripe_events ORDER BY received_at,id",
        )
      ).rows,
  };
}

const periodEnd = Math.floor(Date.now() / 1000) + 30 * 86400;
const event = (id: string, type: string, object: Record<string, unknown>) =>
  JSON.stringify({ id, object: "event", type, data: { object } });
const updated = event("evt_updated", "customer.subscription.updated", {
  object: "subscription",
  customer: "cus_fixture",
  status: "active",
  items: { data: [{ current_period_end: periodEnd }] },
});

test("Stripe webhook refuses unsigned, stale, forged, oversized and non-JSON requests and answers 503 without config", async () => {
  const { local, sign, post, ledger, status } = await webhookFixture();
  try {
    const stale = Math.floor(Date.now() / 1000) - 301;
    const forged = `t=${Math.floor(Date.now() / 1000)},v1=${createHmac("sha256", "whsec_otherFixtureSecret").update("x").digest("hex")}`;
    for (const [signature, why] of [
      [null, "no header"],
      [sign(updated, stale), "outside the five-minute tolerance"],
      [forged, "another secret"],
      [sign(updated.replace("active", "trialing")), "a different body"],
      ["t=abc,v1=00", "malformed"],
    ] as const)
      expect([why, ...(await post(updated, signature))]).toEqual([
        why,
        400,
        '{"error":"signature_invalid"}',
      ]);
    expect(
      await post(updated, sign(updated), { "Content-Type": "text/plain" }),
    ).toEqual([415, '{"error":"unsupported_media_type"}']);
    const big = JSON.stringify({ pad: "x".repeat(262144) });
    expect(await post(big)).toEqual([413, '{"error":"request_too_large"}']);
    expect(await post("", null, {}, "GET")).toEqual([
      405,
      '{"error":"method_not_allowed"}',
    ]);
    // A signed body that is not an event is refused unrecorded.
    expect(await post('{"id":"nope"}')).toEqual([
      400,
      '{"error":"event_invalid"}',
    ]);
    expect(await ledger()).toEqual([]);
    expect(await status()).toBe("expired");
  } finally {
    await local.dispose();
  }
  const off = await webhookFixture(false);
  try {
    expect(await off.post(updated)).toEqual([
      503,
      '{"error":"billing_unavailable","message":"Billing is not available yet."}',
    ]);
    expect(await off.ledger()).toEqual([]);
  } finally {
    await off.local.dispose();
  }
});

test("the gate follows the subscription status: unknown or missing is allowed, past_due has three days from the renewal, and only trialing gets reminders", async () => {
  const { local, status } = await webhookFixture();
  const set = (status: string | null, sinceRenewal = "1 day") =>
    local.db.query(sql`UPDATE trial_accounts SET subscription_status=${status},
      trial_end=clock_timestamp()+interval '6 days',
      current_period_start=clock_timestamp()-${sinceRenewal}::interval,
      current_period_end=clock_timestamp()+interval '29 days'
      WHERE user_id=${userId}`);
  try {
    for (const [stripe, expected] of [
      ["trialing", "trial"],
      ["active", "paid"],
      ["canceled", "expired"],
      ["unpaid", "expired"],
      ["incomplete", "expired"],
      ["incomplete_expired", "expired"],
      ["paused", "expired"],
      ["a_status_stripe_adds_later", "early_access"],
      [null, "early_access"],
    ] as const) {
      await set(stripe);
      expect([stripe, await status()]).toEqual([stripe, expected]);
    }
    // The period end is a month ahead here, so grace runs from the renewal.
    await set("past_due", "2 days 23 hours");
    expect(await status()).toBe("paid");
    await set("past_due", "3 days 1 minute");
    expect(await status()).toBe("expired");
    // A trial_end in the past never expires a trial: Stripe's status decides.
    await set("trialing");
    await local.db.query(
      sql`UPDATE trial_accounts SET trial_end=clock_timestamp()-interval '1 hour'`,
    );
    expect(await status()).toBe("trial");
    expect(await claimTrialNotice(local.db, userId)).toBeUndefined();
    // Reminders run from trial_end, and only while trialing.
    await set("active");
    expect(await claimTrialNotice(local.db, userId)).toBeUndefined();
    await set("trialing");
    expect((await claimTrialNotice(local.db, userId))?.code).toBe(
      "trial_ending_7_days",
    );
    await local.db.query(
      sql`DELETE FROM trial_accounts WHERE user_id=${userId}`,
    );
    expect(await status()).toBe("early_access");
  } finally {
    await local.dispose();
  }
});

test("a signed Stripe event sets paid_through once, a replay is ignored, deletion clears it, and unknown events are recorded only", async () => {
  const { local, post, ledger } = await webhookFixture();
  const paidThrough = async () =>
    (
      await local.db.query<{ paid_through: Date | string | null }>(
        sql`SELECT paid_through FROM trial_accounts WHERE user_id=${userId}`,
      )
    )[0]!.paid_through;
  try {
    expect(await post(updated)).toEqual([200, '{"received":true}']);
    // The period end plus three days of grace.
    expect(new Date(String(await paidThrough())).getTime()).toBe(
      (periodEnd + 3 * 86400) * 1000,
    );
    expect(await post(updated)).toEqual([
      200,
      '{"received":true,"duplicate":true}',
    ]);
    expect(await ledger()).toEqual([
      { id: "evt_updated", type: "customer.subscription.updated" },
    ]);
    // An earlier invoice delivered late never shortens access.
    expect(
      await post(
        event("evt_oldInvoice", "invoice.paid", {
          customer: "cus_fixture",
          lines: { data: [{ period: { end: periodEnd - 30 * 86400 } }] },
        }),
      ),
    ).toEqual([200, '{"received":true}']);
    expect(new Date(String(await paidThrough())).getTime()).toBe(
      (periodEnd + 3 * 86400) * 1000,
    );
    expect(
      await post(event("evt_unknown", "customer.created", { id: "cus_x" })),
    ).toEqual([200, '{"received":true}']);
    const deleted = event("evt_deleted", "customer.subscription.deleted", {
      customer: "cus_fixture",
      status: "canceled",
    });
    expect(await post(deleted)).toEqual([200, '{"received":true}']);
    expect(await paidThrough()).toBeNull();
    expect((await ledger()).map((row) => row.id).sort()).toEqual([
      "evt_deleted",
      "evt_oldInvoice",
      "evt_unknown",
      "evt_updated",
    ]);
  } finally {
    await local.dispose();
  }
});
