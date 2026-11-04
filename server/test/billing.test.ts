import { expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { sql } from "drizzle-orm";
import { createMiltonApp } from "../src/index";
import { claimTrialNotice, trialStatus } from "../src/store/trials";
import { localStore } from "./local-store";

const appOrigin = "http://localhost:3001";
// Obviously fake values in the shapes Stripe uses.
const day = 86400;
const now = Math.floor(Date.now() / 1000);
const subscription = (status: string, created = now - 40 * day) => ({
  id: `sub_${status.replaceAll("_", "")}`,
  object: "subscription",
  customer: "cus_fixture",
  status,
  created,
  trial_end: now - 10 * day,
  items: {
    data: [
      { current_period_start: now - day, current_period_end: now + 29 * day },
    ],
  },
});
// Answers Stripe's list call with `answer`; each call is recorded.
const fakeStripe = () => {
  const stripe = {
    answer: Response.json({ data: [subscription("active")] }) as
      Response | undefined,
    calls: [] as { url: string; version: string | null }[],
  };
  return {
    stripe,
    billing: {
      secretKey: "rk_test_fixtureNotAKey",
      webhookSecret: "whsec_fixtureNotASecret",
      priceId: "price_fixture",
      fetch: async (url: string, init: RequestInit) => {
        stripe.calls.push({
          url,
          version: new Headers(init.headers).get("Stripe-Version"),
        });
        if (!stripe.answer) throw new Error("Stripe is unreachable");
        return stripe.answer.clone();
      },
    },
  };
};
const userId = "m_00000000-0000-4000-8000-000000000025";
const webhookSecret = "whsec_fixtureNotASecret";

async function webhookFixture(configured = true) {
  const { stripe, billing } = fakeStripe();
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
    `t=${t},v1=${createHmac("sha256", webhookSecret).update(`${t}.${body}`).digest("hex")}`;
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
    stripe,
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

const event = (id: string, type: string, object: Record<string, unknown>) =>
  JSON.stringify({ id, object: "event", type, data: { object } });
const updated = event("evt_updated", "customer.subscription.updated", {
  object: "subscription",
  customer: "cus_fixture",
  status: "active",
});

test("Stripe webhook refuses unsigned, stale, forged, oversized and non-JSON requests and answers 503 without config", async () => {
  const { local, stripe, sign, post, ledger, status } = await webhookFixture();
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
    expect(stripe.calls).toEqual([]);
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

test("a verified event only triggers a re-read: the list decides, a replay and an unknown customer call nothing, and a read failure stays unrecorded", async () => {
  const { local, stripe, post, ledger, status } = await webhookFixture();
  const row = async () =>
    (
      await local.db.query<Record<string, unknown>>(
        sql`SELECT stripe_subscription_id AS id,subscription_status AS status,
          extract(epoch from trial_end)::bigint::text AS trial,
          extract(epoch from current_period_start)::bigint::text AS start,
          extract(epoch from current_period_end)::bigint::text AS end
          FROM trial_accounts WHERE user_id=${userId}`,
      )
    )[0];
  const list = (...data: unknown[]) => {
    stripe.answer = Response.json({ data });
  };
  try {
    expect(await post(updated)).toEqual([200, '{"received":true}']);
    expect(await row()).toEqual({
      id: "sub_active",
      status: "active",
      trial: String(now - 10 * day),
      start: String(now - day),
      end: String(now + 29 * day),
    });
    expect(await status()).toBe("paid");
    expect(stripe.calls).toEqual([
      {
        url: "https://api.stripe.com/v1/subscriptions?customer=cus_fixture&status=all&limit=10",
        version: "2026-10-28.endive",
      },
    ]);
    // A replay reads nothing and changes nothing.
    list(subscription("canceled"));
    expect(await post(updated)).toEqual([
      200,
      '{"received":true,"duplicate":true}',
    ]);
    expect(stripe.calls).toHaveLength(1);
    expect((await row())!.status).toBe("active");
    // A stale event still writes what the list says now, whatever it carries.
    expect(
      await post(
        event("evt_stale", "invoice.paid", { customer: "cus_fixture" }),
      ),
    ).toEqual([200, '{"received":true}']);
    expect((await row())!.status).toBe("canceled");
    expect(await status()).toBe("expired");
    // active > trialing > past_due > otherwise the newest.
    const choice = [
      [["canceled", now], ["active"], ["trialing"]],
      [["canceled", now], ["trialing"], ["past_due"]],
      [["canceled", now], ["past_due"]],
      [
        ["unpaid", now - day],
        ["incomplete_expired", now],
      ],
    ] as const;
    for (const [i, rows] of choice.entries()) {
      list(...rows.map(([s, created]) => subscription(s, created)));
      await post(
        event(`evt_choice${i}`, "invoice.payment_failed", {
          customer: "cus_fixture",
        }),
      );
      expect((await row())!.status).toBe(
        ["active", "trialing", "past_due", "incomplete_expired"][i]!,
      );
    }
    // A successful empty list with a stored subscription reads as canceled.
    await local.db.query(
      sql`UPDATE trial_accounts SET subscription_status='active'`,
    );
    list();
    expect(
      await post(
        event("evt_gone", "customer.subscription.deleted", {
          customer: "cus_fixture",
        }),
      ),
    ).toEqual([200, '{"received":true}']);
    expect((await row())!.status).toBe("canceled");
    // An unknown customer is no proof of cancellation: a key from the wrong
    // mode would otherwise mark paying people canceled. It stays unrecorded.
    await local.db.query(
      sql`UPDATE trial_accounts SET subscription_status='active'`,
    );
    stripe.answer = Response.json({}, { status: 404 });
    expect(
      await post(
        event("evt_unknownToStripe", "customer.subscription.updated", {
          customer: "cus_fixture",
        }),
      ),
    ).toEqual([503, '{"error":"server_unavailable"}']);
    expect((await row())!.status).toBe("active");
    expect((await ledger()).map(({ id }) => id)).not.toContain(
      "evt_unknownToStripe",
    );
    // Without a stored subscription nothing is known to have ended.
    await local.db.query(
      sql`UPDATE trial_accounts SET stripe_subscription_id=NULL,subscription_status=NULL`,
    );
    list();
    expect(
      await post(
        event("evt_none", "checkout.session.completed", {
          customer: "cus_fixture",
        }),
      ),
    ).toEqual([200, '{"received":true}']);
    expect((await row())!.status).toBeNull();
    // A read failure is unrecorded, so Stripe's retry does the work.
    const failing = event("evt_retry", "customer.subscription.updated", {
      customer: "cus_fixture",
    });
    for (const answer of [
      Response.json({}, { status: 500 }),
      Response.json({ data: [{ id: "not a subscription" }] }),
      undefined,
    ]) {
      stripe.answer = answer;
      expect(await post(failing)).toEqual([
        503,
        '{"error":"server_unavailable"}',
      ]);
    }
    expect((await ledger()).map(({ id }) => id)).not.toContain("evt_retry");
    list(subscription("trialing"));
    expect(await post(failing)).toEqual([200, '{"received":true}']);
    expect((await row())!.status).toBe("trialing");
    // No row for the customer, no customer, or an unknown type: recorded only.
    stripe.calls.length = 0;
    for (const body of [
      event("evt_other", "invoice.paid", { customer: "cus_other" }),
      event("evt_nobody", "checkout.session.completed", { customer: null }),
      event("evt_unknown", "customer.created", { id: "cus_x" }),
    ])
      expect(await post(body)).toEqual([200, '{"received":true}']);
    expect(stripe.calls).toEqual([]);
    expect((await ledger()).map(({ id }) => id)).toContain("evt_unknown");
    // A handled type Milton cannot read is refused unrecorded.
    expect(
      await post(event("evt_bad", "invoice.paid", { customer: 7 })),
    ).toEqual([400, '{"error":"event_invalid"}']);
    expect((await ledger()).map(({ id }) => id)).not.toContain("evt_bad");
  } finally {
    await local.dispose();
  }
});
