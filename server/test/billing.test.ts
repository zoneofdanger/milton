import { expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { sql } from "drizzle-orm";
import { createMiltonApp } from "../src/index";
import { trialStatus } from "../src/store/trials";
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
  // A clock that ran out yesterday, linked to its Stripe customer by checkout.
  await local.db
    .query(sql`INSERT INTO trial_accounts(user_id,started_at,stripe_customer_id)
    VALUES (${userId},clock_timestamp()-interval '31 days','cus_fixture')`);
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

test("a signed Stripe event sets paid_through once, a replay is ignored, deletion clears it, and unknown events are recorded only", async () => {
  const { local, post, ledger, status } = await webhookFixture();
  const paidThrough = async () =>
    (
      await local.db.query<{ paid_through: Date | string | null }>(
        sql`SELECT paid_through FROM trial_accounts WHERE user_id=${userId}`,
      )
    )[0]!.paid_through;
  try {
    expect(await status()).toBe("expired");
    expect(await post(updated)).toEqual([200, '{"received":true}']);
    // The period end plus three days of grace; the expired clock reads as paid.
    expect(new Date(String(await paidThrough())).getTime()).toBe(
      (periodEnd + 3 * 86400) * 1000,
    );
    expect(await status()).toBe("paid");
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
    expect(await status()).toBe("paid");
    const deleted = event("evt_deleted", "customer.subscription.deleted", {
      customer: "cus_fixture",
      status: "canceled",
    });
    expect(await post(deleted)).toEqual([200, '{"received":true}']);
    expect(await paidThrough()).toBeNull();
    expect(await status()).toBe("expired");
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
