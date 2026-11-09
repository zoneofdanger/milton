import { appStorage, clientSettings } from "./auth-fixtures";
import { expect, spyOn, test } from "bun:test";
import { createHmac } from "node:crypto";
import { sql } from "drizzle-orm";
import { createMiltonApp } from "../src/index";
import { claimTrialNotice, trialStatus } from "../src/store/trials";
import {
  backfillExitCode,
  backfillSubscriptions,
  resyncExitCode,
  resyncSubscriptions,
} from "../scripts/backfill-subscriptions";
import { linkStripeCustomer } from "../src/store/billing";
import { localStore, openTransactions } from "./local-store";
import { fixtureStore, memoSave, vendorIntent } from "./store-fixtures";
import { billingAccount } from "../src/store/billing";

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
    // Every call made while a database transaction was open.
    inTransaction: [] as string[],
    // Runs while each call is out, after its answer is fixed.
    during: async () => {},
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
        if (openTransactions() > 0) stripe.inTransaction.push(url);
        const answer = stripe.answer?.clone();
        await stripe.during();
        if (!answer) throw new Error("Stripe is unreachable");
        return answer;
      },
    },
  };
};
const userId = "m_00000000-0000-4000-8000-000000000025";
const webhookSecret = "whsec_fixtureNotASecret";

async function webhookFixture(configured = true) {
  const { stripe, billing } = fakeStripe();
  const local = await localStore();
  // Billing reads the account's deletion from the app schema.
  await appStorage(local.pg);
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
    ...clientSettings,
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
    billing,
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
      [`t=${Math.floor(Date.now() / 1000)},v1`, "bare v1"],
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
    // The customer link is stable; later calls cannot replace it.
    expect(await linkStripeCustomer(local.db, userId, "cus_second")).toBe(
      "cus_fixture",
    );
    // An account that is gone reads as being deleted: billing sells it nothing.
    expect(
      await billingAccount(local.db, "m_00000000-0000-4000-8000-000000000099"),
    ).toMatchObject({ deleting: true, enrolled: false });
    for (const refused of [
      `subscription_status='${"x".repeat(65)}'`,
      "stripe_customer_id='sub_notACustomer'",
      "stripe_subscription_id='cus_notASubscription'",
      "trial_end='infinity'",
      "current_period_start='infinity'",
      "current_period_end='infinity'",
    ])
      await expect(
        local.pg.exec(
          `UPDATE trial_accounts SET ${refused} WHERE user_id='${userId}'`,
        ),
      ).rejects.toThrow("check constraint");
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
    // An assistant read refuses it, with or without a caller watching the gate.
    await expect(
      fixtureStore(local.db, userId).readCoverSheet(),
    ).rejects.toMatchObject({ code: "subscription_required" });
    await expect(
      fixtureStore(local.db, userId).readReport(vendorIntent),
    ).rejects.toMatchObject({ code: "subscription_required" });
    // So does an assistant save, with no caller watching the gate: no memo,
    // no cover sheet, no served report and no receipt.
    const writes = async () =>
      (
        await local.db.query<{ n: number }>(
          sql`SELECT (SELECT count(*) FROM memos WHERE user_id=${userId})
            + (SELECT count(*) FROM cover_sheets WHERE user_id=${userId})
            + (SELECT count(*) FROM served_reports WHERE user_id=${userId})
            + (SELECT count(*) FROM save_requests WHERE user_id=${userId}) AS n`,
        )
      )[0]!.n;
    const before = Number(await writes());
    for (const save of [
      memoSave(),
      {
        request_id: crypto.randomUUID(),
        cover_sheet: {
          add: "Keep fictional dates exact.",
          expected_version: 0,
        },
      },
    ])
      await expect(
        fixtureStore(local.db, userId).saveMemo(save),
      ).rejects.toMatchObject({ code: "subscription_required" });
    expect(Number(await writes())).toBe(before);
    // A trial_end in the past never expires a trial: Stripe's status decides.
    await set("trialing");
    await local.db.query(
      sql`UPDATE trial_accounts SET trial_end=clock_timestamp()-interval '1 hour'`,
    );
    expect(await status()).toBe("trial");
    expect(await claimTrialNotice(local.db, userId, appOrigin)).toBeUndefined();
    // Reminders run from trial_end, and only while trialing.
    await set("active");
    expect(await claimTrialNotice(local.db, userId, appOrigin)).toBeUndefined();
    await set("trialing");
    expect((await claimTrialNotice(local.db, userId, appOrigin))?.code).toBe(
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
        url: "https://api.stripe.com/v1/subscriptions?customer=cus_fixture&status=all&limit=100",
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

test("a webhook's read never lands over a newer write: one conflict reads again, a second answers 503 unrecorded", async () => {
  const { local, stripe, post, ledger } = await webhookFixture();
  const status = async () =>
    (
      await local.db.query<{ status: string }>(
        sql`SELECT subscription_status AS status FROM trial_accounts`,
      )
    )[0]!.status;
  // While each read is out, another writer stores a newer state; `then` is
  // what Stripe answers the next read.
  const steps: { write: string; then?: string }[] = [];
  stripe.during = async () => {
    const step = steps.shift();
    if (!step) return;
    await local.db.query(
      sql`UPDATE trial_accounts SET subscription_status=${step.write},stripe_revision=stripe_revision+1`,
    );
    if (step.then)
      stripe.answer = Response.json({ data: [subscription(step.then)] });
  };
  try {
    // The first read answers past_due, stale against the newer active write;
    // the second reads again and stores what Stripe holds now.
    stripe.answer = Response.json({ data: [subscription("past_due")] });
    steps.push({ write: "active", then: "trialing" });
    expect(await post(updated)).toEqual([200, '{"received":true}']);
    expect(await status()).toBe("trialing");
    expect(stripe.calls).toHaveLength(2);
    // Two conflicts in a row: unrecorded, so Stripe redelivers, and the newer
    // writes stand.
    stripe.calls.length = 0;
    stripe.answer = Response.json({ data: [subscription("past_due")] });
    steps.push({ write: "paused" }, { write: "active" });
    const twice = event("evt_twice", "invoice.paid", {
      customer: "cus_fixture",
    });
    expect(await post(twice)).toEqual([503, '{"error":"server_unavailable"}']);
    expect(await status()).toBe("active");
    expect(stripe.calls).toHaveLength(2);
    expect((await ledger()).map(({ id }) => id)).not.toContain("evt_twice");
    expect(stripe.inTransaction).toEqual([]);
  } finally {
    await local.dispose();
  }
});

test("a newer reconciliation that leaves the state unchanged still stops an older read from landing (ABA)", async () => {
  const { local, stripe, post, ledger, status } = await webhookFixture();
  const { applyStripeEvent } = await import("../src/store");
  const active = subscription("active");
  const activeState = {
    id: active.id,
    status: "active",
    trialEnd: active.trial_end,
    periodStart: active.items.data[0]!.current_period_start,
    periodEnd: active.items.data[0]!.current_period_end,
  };
  let newer = 0;
  try {
    // Stored and current at Stripe: active.
    expect(await post(updated)).toEqual([200, '{"received":true}']);
    expect(await status()).toBe("paid");
    // An older read answers past_due. While each of its reads is out, a newer
    // reconciliation lands active again, unchanged values.
    stripe.answer = Response.json({ data: [subscription("past_due")] });
    stripe.during = async () => {
      expect(
        await applyStripeEvent(
          local.env,
          {
            id: `evt_newer${++newer}`,
            type: "invoice.paid",
            payloadSha256: "0".repeat(64),
          },
          "cus_fixture",
          async () => activeState,
        ),
      ).toEqual({ recorded: true });
    };
    const older = event("evt_older", "invoice.payment_failed", {
      customer: "cus_fixture",
    });
    expect(await post(older)).toEqual([503, '{"error":"server_unavailable"}']);
    // The older past_due never landed, and its event stays unrecorded for
    // Stripe to redeliver; both newer events are recorded.
    expect(await status()).toBe("paid");
    const ids = (await ledger()).map(({ id }) => id);
    expect(ids).not.toContain("evt_older");
    expect(ids).toEqual(expect.arrayContaining(["evt_newer1", "evt_newer2"]));
  } finally {
    await local.dispose();
  }
});

test("the resync repairs a stale managed status an old-style writer left: dry run calls nothing, a conflict counts as failed and exits nonzero", async () => {
  const { local, stripe, billing, status } = await webhookFixture();
  const config = { ...local.env, billing };
  const pause = async () => {};
  try {
    // Stripe holds active; an old revision's write (no revision bump) left a
    // stale past_due, which checkout sends to the portal without reading Stripe.
    await local.db.query(
      sql`UPDATE trial_accounts SET subscription_status='past_due',current_period_start=clock_timestamp()-interval '10 days'`,
    );
    // Neither a test account's customer nor an account without one is read.
    await local.db.query(
      sql`INSERT INTO users(id,test_account) VALUES ('m_test',true),('m_none',false)`,
    );
    await local.db.query(
      sql`INSERT INTO trial_accounts(user_id,started_at,stripe_customer_id) VALUES ('m_test',clock_timestamp(),'cus_testAccount'),('m_none',clock_timestamp(),NULL)`,
    );
    // The same refusals as the backfill: a test key needs the flag.
    await expect(resyncSubscriptions(config, {}, pause)).rejects.toMatchObject({
      code: "configuration",
    });
    const dry = await resyncSubscriptions(
      config,
      { allowTestKey: true },
      pause,
    );
    expect(dry).toEqual({ total: 1, reconciled: 0, failed: 0 });
    expect(resyncExitCode(dry, false)).toBe(0);
    expect(stripe.calls).toEqual([]);
    expect(await status()).toBe("expired");
    // A newer write lands during each read: two conflicts count as failed.
    stripe.during = async () => {
      await local.db.query(
        sql`UPDATE trial_accounts SET stripe_revision=stripe_revision+1 WHERE user_id=${userId}`,
      );
    };
    const conflicted = await resyncSubscriptions(
      config,
      { apply: true, allowTestKey: true },
      pause,
    );
    expect(conflicted).toEqual({ total: 1, reconciled: 0, failed: 1 });
    expect(resyncExitCode(conflicted, true)).toBe(1);
    expect(await status()).toBe("expired");
    // The rerun reads Stripe, as the webhook does, and repairs it.
    stripe.during = async () => {};
    stripe.calls.length = 0;
    const repaired = await resyncSubscriptions(
      config,
      { apply: true, allowTestKey: true },
      pause,
    );
    expect(repaired).toEqual({ total: 1, reconciled: 1, failed: 0 });
    expect(resyncExitCode(repaired, true)).toBe(0);
    expect(await status()).toBe("paid");
    expect(stripe.calls.map(({ url }) => url)).toEqual([
      "https://api.stripe.com/v1/subscriptions?customer=cus_fixture&status=all&limit=100",
    ]);
    expect(stripe.inTransaction).toEqual([]);
  } finally {
    await local.dispose();
  }
});

test("a partial subscription list is a failed read: the resync counts it as failed and stores nothing", async () => {
  const { local, stripe, billing, status } = await webhookFixture();
  const config = { ...local.env, billing };
  try {
    await local.db.query(
      sql`UPDATE trial_accounts SET subscription_status='past_due',current_period_start=clock_timestamp()-interval '10 days'`,
    );
    // The first page holds only canceled subscriptions; an active one is on
    // a later page. Deciding from this page would store canceled.
    stripe.answer = Response.json({
      data: Array.from({ length: 100 }, () => subscription("canceled")),
      has_more: true,
    });
    const partial = await resyncSubscriptions(
      config,
      { apply: true, allowTestKey: true },
      async () => {},
    );
    expect(partial).toEqual({ total: 1, reconciled: 0, failed: 1 });
    expect(resyncExitCode(partial, true)).toBe(1);
    expect(await status()).toBe("expired");
  } finally {
    await local.dispose();
  }
});

test("the backfill refuses without trials or a live key, dry-runs, creates, leaves failures at NULL, and reruns as a no-op", async () => {
  const local = await localStore();
  // Billing reads the account's deletion from the app schema.
  await appStorage(local.pg);
  const { billing } = fakeStripe();
  const calls: string[] = [];
  let failing = false;
  const stripe = {
    ...billing,
    fetch: async (url: string, init: RequestInit) => {
      const { pathname } = new URL(url);
      calls.push(`${init.method} ${pathname}`);
      if (failing) return Response.json({}, { status: 500 });
      if (init.method === "GET") return Response.json({ data: [] });
      const fixture = String(calls.length).padStart(4, "0");
      return Response.json(
        pathname === "/v1/customers"
          ? { id: `cus_backfill${fixture}` }
          : { ...subscription("trialing"), id: `sub_backfill${fixture}` },
      );
    },
  };
  const config = { ...local.env, billing: stripe };
  const pause = async () => {};
  const rows = () =>
    local.db.query<Record<string, unknown>>(
      sql`SELECT u.id,t.subscription_status AS status,t.stripe_customer_id AS customer
        FROM users u LEFT JOIN trial_accounts t ON t.user_id=u.id ORDER BY u.id`,
    );
  try {
    await local.db.query(
      sql`INSERT INTO users(id) VALUES ('a-no-row'),('b-null'),('c-canceled'),('d-gone'),('e-returned')`,
    );
    await local.db.query(
      sql`UPDATE users SET status='deleting' WHERE id='d-gone'`,
    );
    // The end-to-end check's test account is never counted or given a trial.
    await local.db.query(
      sql`INSERT INTO users(id,test_account) VALUES ('f-test',true)`,
    );
    await local.db.query(
      sql`INSERT INTO trial_accounts(user_id,started_at) SELECT id,created_at FROM users WHERE id='b-null'`,
    );
    await local.db.query(
      sql`INSERT INTO trial_accounts(user_id,started_at,subscription_status) SELECT id,created_at,'canceled' FROM users WHERE id='c-canceled'`,
    );
    // A returning deleted identity an older image wrote: no status, a start
    // before the account. It must never get a trial.
    await local.db.query(
      sql`INSERT INTO trial_accounts(user_id,started_at) SELECT id,created_at-interval '1 hour' FROM users WHERE id='e-returned'`,
    );
    const refused = (
      target: Parameters<typeof backfillSubscriptions>[0],
      options = {},
    ) =>
      expect(
        backfillSubscriptions(target, options, pause),
      ).rejects.toMatchObject({ code: "configuration" });
    await refused(config, { allowTestKey: true }); // trials off
    await local.db.query(sql`UPDATE store_config SET trials_enabled=true`);
    await refused(local.env, { allowTestKey: true }); // billing unset
    await refused(config); // a test key without the flag
    expect(calls).toEqual([]);
    const before = await rows();
    // A live key passes the check; the dry run writes and calls nothing.
    const live = {
      ...config,
      billing: { ...stripe, secretKey: "rk_live_fixtureNotAKey" },
    };
    const dry = await backfillSubscriptions(live, {}, pause);
    expect(dry).toEqual({
      total: 4,
      created: 0,
      skipped: 2,
      failed: 0,
      still_null: 2,
    });
    expect(backfillExitCode(dry, false)).toBe(0);
    expect(await rows()).toEqual(before);
    expect(calls).toEqual([]);
    // A Stripe failure leaves the rows at NULL and exits nonzero.
    failing = true;
    const quiet = spyOn(console, "error").mockImplementation(() => {});
    let pauses = 0;
    const failed = await backfillSubscriptions(
      config,
      { apply: true, allowTestKey: true },
      async () => {
        pauses++;
      },
    );
    quiet.mockRestore();
    expect(failed).toEqual({
      total: 4,
      created: 0,
      skipped: 2,
      failed: 2,
      still_null: 2,
    });
    expect(backfillExitCode(failed, true)).toBe(1);
    expect(pauses).toBe(2);
    // Healthy: every waiting account gets a trial, no email, and exit 0.
    failing = false;
    calls.length = 0;
    const done = await backfillSubscriptions(
      config,
      { apply: true, allowTestKey: true },
      pause,
    );
    expect(done).toEqual({
      total: 4,
      created: 2,
      skipped: 2,
      failed: 0,
      still_null: 0,
    });
    expect(backfillExitCode(done, true)).toBe(0);
    expect(calls).toHaveLength(6);
    const after = await rows();
    expect(after.map(({ id, status }) => [id, status])).toEqual([
      ["a-no-row", "trialing"],
      ["b-null", "trialing"],
      ["c-canceled", "canceled"],
      ["d-gone", null],
      ["e-returned", "canceled"],
      ["f-test", null],
    ]);
    expect(after.find(({ id }) => id === "e-returned")?.customer).toBeNull();
    // A rerun touches nothing.
    calls.length = 0;
    const rerun = await backfillSubscriptions(
      config,
      { apply: true, allowTestKey: true },
      pause,
    );
    expect(rerun).toEqual({
      total: 4,
      created: 0,
      skipped: 4,
      failed: 0,
      still_null: 0,
    });
    expect(calls).toEqual([]);
    expect(await rows()).toEqual(after);
  } finally {
    await local.dispose();
  }
}, 30000);
