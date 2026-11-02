import {
  observeSpendAlerts,
  spendAlertThresholds,
  readSpendAlerts,
  configuredAlertThresholds,
} from "../src/store/spend-alerts";
import {
  runSpendAlertTick as workerCycle,
  createSpendAlertHandler,
} from "../src/spend-alert-worker";
import { compiledMemos } from "../src/store/compiled";
import { expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import type { StoreDatabase } from "../src/store/database";
import { localStore } from "./local-store";
import { betweenPhases } from "./store-fixtures";

test("memo updates charge committed source batches only and recover original charges", async () => {
  const local = await localStore();
  try {
    expect(
      (
        await local.pg.query(
          "SELECT memo_updates_enabled,memo_updates_daily_limit FROM store_config",
        )
      ).rows,
    ).toEqual([{ memo_updates_enabled: false, memo_updates_daily_limit: 100 }]);
    await local.pg.exec(
      "INSERT INTO users(id) VALUES ('updates'); UPDATE store_config SET global_spend_policy='alerts_only',foreground_accounting_ready=true,memo_updates_enabled=true,memo_updates_daily_limit=2",
    );
    let calls = 0;
    const store = compiledMemos(
      betweenPhases(local.db, async () => calls++),
      "updates",
      { issuer: "fixture", clientId: "allowance" },
    );
    const input = {
      text: "Fictional batch.",
      rules: [
        { report: "cover" as const, text: "Use a fictional table." },
        { report: "cover" as const, text: "Keep synthetic exceptions." },
      ],
      request_id: crypto.randomUUID(),
      expected_version: (await store.getTpsReport()).version,
    };
    const first = await store.saveMemo(input);
    expect(first.status).toBe("saved");
    expect(first.memo_update).toMatchObject({
      charged: 1,
      state: "charged",
      replayed: false,
    });
    expect((await store.saveMemo(input)).memo_update).toMatchObject({
      charged: 1,
      replayed: true,
    });
    expect(calls).toBe(1);
    const same = "Use a fictional table.";
    for (const change of [
      { rules: [{ report: "cover" as const, text: same }] },
      { exact_edits: [{ before: same, after: same }] },
    ]) {
      const result = await store.saveMemo({
        text: "Nothing new.",
        request_id: crypto.randomUUID(),
        expected_version: (await store.getTpsReport()).version,
        ...change,
      });
      expect(result.status).toBe("unchanged");
      expect(result.memo_update).toMatchObject({
        charged: 0,
        state: "released",
      });
    }
    await local.pg.exec("UPDATE tps_reports SET source_hash=repeat('0',64)");
    const rebuild = await store.saveMemo({
      text: "rebuild",
      exact_edits: [{ before: same, after: same }],
      request_id: crypto.randomUUID(),
      expected_version: first.version!,
    });
    expect(rebuild.status).toBe("saved");
    expect(rebuild.memo_update).toMatchObject({
      charged: 0,
      state: "released",
    });
    expect(await store.memoUpdates()).toMatchObject({
      limit: 2,
      used: 1,
      pending: 0,
      available: 1,
    });
    const before = await store.getTpsReport();
    const exact = {
      text: "Fictional correction.",
      request_id: crypto.randomUUID(),
      expected_version: before.version,
      exact_edits: [
        { before: "Use a fictional table.", after: "Use fictional bullets." },
      ],
    };
    expect((await store.saveMemo(exact)).memo_update).toMatchObject({
      charged: 1,
    });
    expect(await store.memoUpdates()).toMatchObject({
      used: 2,
      pending: 0,
      available: 0,
    });
    const called = calls;
    await expect(
      store.saveMemo({
        text: "Blocked fictional attempt.",
        rules: [{ report: "cover", text: "Blocked fictional rule." }],
        request_id: crypto.randomUUID(),
        expected_version: (await store.getTpsReport()).version,
      }),
    ).rejects.toMatchObject({
      code: "memo_updates_exhausted",
      message: expect.stringContaining(
        "You can still read and download your cover sheet and reports.",
      ),
    });
    expect(calls).toBe(called);
    expect((await store.getTpsReport()).text).toContain(
      "Use fictional bullets.",
    );
    expect((await store.saveMemo(input)).memo_update).toMatchObject({
      charged: 1,
      replayed: true,
    });
  } finally {
    await local.dispose();
  }
});

test("memo-update holds fence last-slot dispatch, expired claims, activation and uncertain commits", async () => {
  const local = await localStore();
  try {
    await local.pg.exec(
      "INSERT INTO users(id) VALUES ('hold-race'),('hold-legacy'),('hold-claim'),('hold-commit'),('hold-failure'),('hold-midnight')",
    );
    const releases = new Map<string, () => void>(),
      starts = new Map<string, () => void>();
    // Claims that reached the write phase; a paused account's next one waits there.
    let calls = 0;
    const actor = { issuer: "fixture", clientId: "holds" };
    const store = (id: string, db: StoreDatabase = local.db) =>
      compiledMemos(
        betweenPhases(db, async () => {
          calls++;
          const start = starts.get(id);
          if (!start) return;
          starts.delete(id);
          const wait = new Promise<void>((resolve) =>
            releases.set(id, resolve),
          );
          start();
          await wait;
        }),
        id,
        actor,
      );
    const input = async (s: ReturnType<typeof store>, text: string) => ({
      text,
      rules: [{ report: "cover" as const, text }],
      request_id: crypto.randomUUID(),
      expected_version: (await s.getTpsReport()).version,
    });
    const pause = (id: string) =>
      new Promise<void>((resolve) => starts.set(id, resolve));
    const legacy = store("hold-legacy");
    const legacyStarted = pause("hold-legacy");
    const legacyInput = await input(legacy, "legacy pending");
    const pendingLegacy = legacy.saveMemo(legacyInput);
    await legacyStarted;
    await local.pg.exec(
      "UPDATE store_config SET global_spend_policy='alerts_only',foreground_accounting_ready=true,memo_updates_enabled=true,memo_updates_daily_limit=1",
    );
    releases.get("hold-legacy")!();
    expect((await pendingLegacy).memo_update).toMatchObject({
      charged: 0,
      state: "none",
    });
    expect((await legacy.saveMemo(legacyInput)).memo_update).toMatchObject({
      charged: 0,
      replayed: true,
    });
    expect(await legacy.memoUpdates()).toMatchObject({
      used: 0,
      pending: 0,
      available: 1,
    });
    const race = store("hold-race"),
      started = pause("hold-race");
    const heldInput = await input(race, "held request");
    const held = race.saveMemo(heldInput);
    await started;
    const called = calls;
    expect(await race.memoUpdates()).toMatchObject({
      used: 0,
      pending: 1,
      available: 0,
    });
    await expect(
      race.saveMemo(await input(race, "no dispatch")),
    ).rejects.toMatchObject({ code: "memo_updates_pending" });
    expect((await race.saveMemo(heldInput)).status).toBe("in_progress");
    expect(calls).toBe(called);
    await local.pg.exec(
      "ALTER TABLE save_requests DISABLE TRIGGER save_request_guard",
    );
    await local.db.query(
      sql`UPDATE save_requests SET deadline=clock_timestamp()-interval '1 second' WHERE request_id=${heldInput.request_id}`,
    );
    await local.pg.exec(
      "ALTER TABLE save_requests ENABLE TRIGGER save_request_guard",
    );
    expect(await race.memoUpdates()).toMatchObject({
      used: 0,
      pending: 0,
      available: 1,
    });
    expect(
      (await race.saveMemo(await input(race, "replacement request")))
        .memo_update,
    ).toMatchObject({ charged: 1 });
    releases.get("hold-race")!();
    expect(await held).toMatchObject({
      status: "failed",
      error: "request_expired",
      memo_update: { charged: 0, state: "released" },
    });
    const midnight = store("hold-midnight"),
      midnightStarted = pause("hold-midnight");
    const midnightInput = await input(midnight, "midnight request");
    const midnightPending = midnight.saveMemo(midnightInput);
    await midnightStarted;
    // Fictional clock boundary: preserve the original captured claim day on completion.
    await local.pg.exec(
      "ALTER TABLE save_requests DISABLE TRIGGER save_memo_update_guard",
    );
    await local.db.query(
      sql`UPDATE save_requests SET memo_update_day=(clock_timestamp() AT TIME ZONE 'UTC')::date-1 WHERE request_id=${midnightInput.request_id}`,
    );
    await local.pg.exec(
      "ALTER TABLE save_requests ENABLE TRIGGER save_memo_update_guard",
    );
    releases.get("hold-midnight")!();
    expect((await midnightPending).memo_update).toMatchObject({ charged: 1 });
    expect(await midnight.memoUpdates()).toMatchObject({
      used: 0,
      pending: 0,
      available: 1,
    });
    expect(
      (await midnight.saveMemo(await input(midnight, "new day request")))
        .memo_update,
    ).toMatchObject({ charged: 1 });
    let loseClaim = true,
      loseRecovery = true;
    const uncertainClaim = {
      ...local.db,
      async transaction<T>(
        work: Parameters<typeof local.db.transaction<T>>[0],
      ) {
        if (!loseClaim && loseRecovery) {
          loseRecovery = false;
          throw new Error("Fictional unavailable recovery");
        }
        const result = await local.db.transaction(work);
        if (
          loseClaim &&
          typeof result === "object" &&
          result !== null &&
          "current" in result
        ) {
          loseClaim = false;
          throw new Error("Fictional lost claim acknowledgment");
        }
        return result;
      },
    };
    const claimStore = store("hold-claim", uncertainClaim),
      claimInput = await input(claimStore, "uncertain claim");
    const beforeClaim = calls;
    await expect(claimStore.saveMemo(claimInput)).rejects.toMatchObject({
      code: "save_outcome_unknown",
    });
    expect(calls).toBe(beforeClaim);
    expect((await store("hold-claim").saveMemo(claimInput)).status).toBe(
      "in_progress",
    );
    expect(await store("hold-claim").memoUpdates()).toMatchObject({
      used: 0,
      pending: 1,
    });
    let loseCommit = true;
    const uncertainCommit = {
      ...local.db,
      async transaction<T>(
        work: Parameters<typeof local.db.transaction<T>>[0],
      ) {
        const result = await local.db.transaction(work);
        if (
          loseCommit &&
          typeof result === "object" &&
          result !== null &&
          "status" in result &&
          result.status === "saved"
        ) {
          loseCommit = false;
          throw new Error("Fictional lost publication acknowledgment");
        }
        return result;
      },
    };
    const committed = store("hold-commit", uncertainCommit),
      commitInput = await input(committed, "committed request");
    expect((await committed.saveMemo(commitInput)).memo_update).toMatchObject({
      charged: 1,
      replayed: true,
    });
    expect(await committed.memoUpdates()).toMatchObject({
      used: 1,
      pending: 0,
    });
    await local.pg.exec(
      "CREATE FUNCTION reject_update_fixture() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Fictional publication failure'; END $$; CREATE TRIGGER reject_update_fixture BEFORE INSERT OR UPDATE ON tps_reports FOR EACH ROW WHEN (NEW.user_id='hold-failure') EXECUTE FUNCTION reject_update_fixture()",
    );
    const failure = store("hold-failure");
    expect(
      (await failure.saveMemo(await input(failure, "failed request")))
        .memo_update,
    ).toMatchObject({ charged: 0, state: "released" });
    expect((await failure.getTpsReport()).is_empty).toBe(true);
    expect(await failure.memoUpdates()).toMatchObject({
      used: 0,
      pending: 0,
      available: 1,
    });
    expect(
      (
        await local.pg.query(
          "SELECT * FROM instruction_card_versions WHERE user_id='hold-failure'",
        )
      ).rows,
    ).toEqual([]);
    await local.pg.exec(
      "INSERT INTO trial_accounts(user_id,started_at) VALUES ('hold-commit',clock_timestamp()-interval '31 days'); UPDATE store_config SET trials_enabled=true",
    );
    expect((await committed.saveMemo(commitInput)).status).toBe("saved");
    await expect(
      committed.saveMemo({ ...commitInput, request_id: crypto.randomUUID() }),
    ).rejects.toMatchObject({ code: "subscription_required" });
    await expect(committed.getTpsReport()).rejects.toMatchObject({
      code: "subscription_required",
    });
    expect(
      (await compiledMemos(local.db, "hold-commit").getTpsReport()).text,
    ).toBe("- committed request");
  } finally {
    await local.dispose();
  }
});

test("alerts-only spending continues through every threshold, counts the frozen review and derived ledgers, and publishes a private deletion-safe feed", async () => {
  const { runSpendAlertEmails } =
    await import("../src/store/spend-alert-email");
  const local = await localStore();
  try {
    // Legacy ledgers have no writers; their rows still count toward today's total.
    await local.pg.exec(
      `INSERT INTO users(id) VALUES ('alerts'); UPDATE store_config SET global_spend_policy='alerts_only',foreground_accounting_ready=true,memo_updates_enabled=true;
      INSERT INTO gardening_usage(user_id,day_utc,reserved_micros) VALUES ('alerts',(clock_timestamp() AT TIME ZONE 'UTC')::date,1000000);
      INSERT INTO derivation_usage(user_id,day_utc,reserved_micros) VALUES ('alerts',(clock_timestamp() AT TIME ZONE 'UTC')::date,2000000);`,
    );
    const store = compiledMemos(local.db, "alerts", {
      issuer: "fixture",
      clientId: "alerts",
    });
    for (const [i, threshold] of spendAlertThresholds.entries()) {
      // Filing alone stays $3 short; only the legacy rows cross the threshold.
      await local.db.query(
        sql`INSERT INTO foreground_usage(day_utc,reserved_micros) VALUES ((clock_timestamp() AT TIME ZONE 'UTC')::date,${threshold - 3000000}) ON CONFLICT(day_utc) DO UPDATE SET reserved_micros=excluded.reserved_micros`,
      );
      const current = await store.getTpsReport();
      expect(
        (
          await store.saveMemo({
            text: `Fictional instruction ${i}.`,
            rules: [{ report: "cover", text: `Fictional instruction ${i}.` }],
            request_id: crypto.randomUUID(),
            expected_version: current.version,
          })
        ).status,
      ).toBe("saved");
      expect(await store.memoUpdates()).toMatchObject({
        used: i + 1,
        pending: 0,
      });
      expect(await observeSpendAlerts(local.db)).toMatchObject({
        status: "published",
        published: 1,
      });
      expect(await observeSpendAlerts(local.db)).toMatchObject({
        status: "idle",
        published: 0,
      });
    }
    const feed = await local.db.transaction(readSpendAlerts);
    expect(feed.events).toHaveLength(4);
    expect(feed.events.map((e) => e.threshold_usd).sort()).toEqual([
      "100.000000",
      "1000.000000",
      "250.000000",
      "500.000000",
    ]);
    for (const e of feed.events) {
      expect(e.reserved_usd.review).toBe("1.000000");
      expect(e.reserved_usd.derived).toBe("2.000000");
      expect(Number(e.reserved_usd.total)).toBeCloseTo(
        Number(e.reserved_usd.filing) + 3,
        6,
      );
      expect(Number(e.reserved_usd.filing)).toBeLessThan(
        Number(e.threshold_usd),
      );
      expect(Number(e.reserved_usd.total)).toBeGreaterThanOrEqual(
        Number(e.threshold_usd),
      );
    }
    expect(JSON.stringify(feed)).not.toContain("Fictional instruction");
    expect(JSON.stringify(feed)).not.toContain("user_id");
    // The email's reserved amount is the same three-ledger total.
    const sent: { key: string; subject: string }[] = [];
    const send: typeof fetch = Object.assign(
      async (_url: string | URL | Request, init?: RequestInit) => {
        sent.push({
          key: new Headers(init?.headers).get("Idempotency-Key")!,
          subject: JSON.parse(String(init?.body)).subject,
        });
        return Response.json({ id: "fixture-provider-id" });
      },
      { preconnect: fetch.preconnect },
    );
    const env = {
      RESEND_API_KEY: crypto.randomUUID(),
      MILTON_SPEND_ALERT_EMAIL_FROM: "alerts@example.com",
      MILTON_SPEND_ALERT_EMAIL_TO: "operator@example.com",
    };
    expect((await runSpendAlertEmails(local.db, env, send)).status).toBe(
      "sent",
    );
    const emailed = feed.events.find((e) => sent[0]!.key.includes(e.id))!;
    const usd = (amount: string) => amount.replace(/\.?0+$/, "");
    expect(sent[0]!.subject).toBe(
      `[Milton spend alert] Daily reserved spend: $${usd(emailed.reserved_usd.total)} of $${usd(emailed.threshold_usd)} threshold`,
    );
    expect(await store.memoUpdates()).toMatchObject({ used: 4 });
    const aggregate = (
      await local.pg.query("SELECT * FROM foreground_usage ORDER BY day_utc")
    ).rows;
    await local.pg.exec("DELETE FROM users WHERE id='alerts'");
    expect(
      (await local.pg.query("SELECT * FROM foreground_usage ORDER BY day_utc"))
        .rows,
    ).toEqual(aggregate);
    expect(
      (await local.pg.query("SELECT count(*)::int AS n FROM save_requests"))
        .rows,
    ).toEqual([{ n: 0 }]);
    expect((await local.db.transaction(readSpendAlerts)).events).toEqual(
      feed.events,
    );
    // Yesterday's jump is first observed today; an unknown publication ack replays once.
    await local.pg.exec(
      "INSERT INTO foreground_usage(day_utc,reserved_micros) VALUES ((clock_timestamp() AT TIME ZONE 'UTC')::date-1,1000000000)",
    );
    let lost = true;
    const uncertain = {
      ...local.db,
      async transaction<T>(
        work: Parameters<typeof local.db.transaction<T>>[0],
      ) {
        const result = await local.db.transaction(work);
        if (lost) {
          lost = false;
          throw new Error("Fictional lost observer acknowledgment");
        }
        return result;
      },
    };
    await expect(observeSpendAlerts(uncertain)).rejects.toThrow();
    const published = (
      await local.pg.query(
        "SELECT * FROM spend_alerts ORDER BY day_utc,threshold_micros",
      )
    ).rows;
    expect(await observeSpendAlerts(local.db)).toMatchObject({ published: 0 });
    expect(
      (
        await local.pg.query(
          "SELECT * FROM spend_alerts ORDER BY day_utc,threshold_micros",
        )
      ).rows,
    ).toEqual(published);
    expect(
      (
        await local.pg.query(
          "SELECT status,count(*)::int AS n FROM spend_alerts WHERE day_utc=(clock_timestamp() AT TIME ZONE 'UTC')::date-1 GROUP BY status ORDER BY status",
        )
      ).rows,
    ).toEqual([
      { status: "covered", n: 3 },
      { status: "published", n: 1 },
    ]);
    expect((await local.db.transaction(readSpendAlerts)).events).toHaveLength(
      5,
    );
    await local.pg.exec(
      "UPDATE foreground_usage SET reserved_micros=9007199254740993 WHERE day_utc=(clock_timestamp() AT TIME ZONE 'UTC')::date",
    );
    expect(configuredAlertThresholds("100,5000")).toEqual([
      100000000, 5000000000,
    ]);
    expect(
      (
        await observeSpendAlerts(
          local.db,
          configuredAlertThresholds("100,5000"),
        )
      ).published,
    ).toBe(1);
    const wide = await local.db.transaction(readSpendAlerts);
    expect(
      wide.events.some((e) => e.reserved_usd.filing === "9007199254.740993"),
    ).toBe(true);
  } finally {
    await local.dispose();
  }
});

test("the worker ignores stale model flags, publishes and emails spend alerts, reports failed steps as 503, and answers only GET /api/garden", async () => {
  const local = await localStore();
  const realFetch = globalThis.fetch;
  const sent: { subject: string }[] = [];
  globalThis.fetch = Object.assign(
    async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe("https://api.resend.com/emails");
      sent.push(JSON.parse(String(init?.body)));
      return Response.json({ id: "fixture-provider-id" });
    },
    { preconnect: realFetch.preconnect },
  );
  try {
    // No model configuration, and flags left over from retired features.
    const env = {
      MILTON_TASK_RETRIEVAL_ENABLED: "true",
      MILTON_GARDENING_ENABLED: "true",
      MILTON_DERIVATIONS_ENABLED: "true",
      MILTON_SPEND_ALERT_THRESHOLDS_USD: "100",
      RESEND_API_KEY: crypto.randomUUID(),
      MILTON_SPEND_ALERT_EMAIL_FROM: "alerts@example.com",
      MILTON_SPEND_ALERT_EMAIL_TO: "operator@example.com",
    };
    await local.pg.exec(
      `UPDATE store_config SET global_spend_policy='alerts_only';
      INSERT INTO foreground_usage(day_utc,reserved_micros) VALUES ((clock_timestamp() AT TIME ZONE 'UTC')::date,142000000);
      CREATE FUNCTION reject_alert_fixture() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Fictional observer failure'; END $$;
      CREATE TRIGGER reject_alert_fixture BEFORE INSERT ON spend_alerts FOR EACH ROW EXECUTE FUNCTION reject_alert_fixture()`,
    );
    // A failed observation is visible to the scheduler as 503, by step. The log
    // names the step and error class, never the message.
    const logged: unknown[] = [];
    const log = (event: unknown) => void logged.push(event);
    expect(await workerCycle(env, local.db, log)).toEqual({
      status: "failed",
      step: "spend_alerts",
    });
    expect(logged).toEqual([
      {
        event: "spend_alert_tick_failed",
        step: "spend_alerts",
        error: expect.any(String),
      },
    ]);
    expect(JSON.stringify(logged)).not.toContain("Fictional");
    expect((await local.db.transaction(readSpendAlerts)).events).toHaveLength(
      0,
    );
    await local.pg.exec("DROP TRIGGER reject_alert_fixture ON spend_alerts");
    const handler = createSpendAlertHandler(env, () =>
      workerCycle(env, local.db),
    );
    // A healthy tick is 200 "disabled".
    const reply = await handler(new Request("http://worker/api/garden"));
    expect(reply.status).toBe(200);
    expect(await reply.json()).toEqual({ status: "disabled" });
    expect((await local.db.transaction(readSpendAlerts)).events).toHaveLength(
      1,
    );
    expect(sent.map((e) => e.subject)).toEqual([
      "[Milton spend alert] Daily reserved spend: $142 of $100 threshold",
    ]);
    for (const [method, path, status] of [
      ["POST", "/api/garden", 405],
      ["PUT", "/api/garden", 405],
      ["GET", "/api/other", 404],
    ] as const)
      expect(
        (await handler(new Request(`http://worker${path}`, { method }))).status,
      ).toBe(status);
    // An unreachable database fails both steps: 503 "failed", naming the first.
    const unreachable = async () => {
      throw new Error("Fictional unreachable database");
    };
    logged.length = 0;
    const outage = await createSpendAlertHandler(env, () =>
      workerCycle(
        env,
        {
          ...local.db,
          query: unreachable,
          transaction: unreachable,
        },
        log,
      ),
    )(new Request("http://worker/api/garden"));
    expect(outage.status).toBe(503);
    expect(await outage.json()).toEqual({
      status: "failed",
      step: "spend_alerts",
    });
    expect(logged).toEqual([
      {
        event: "spend_alert_tick_failed",
        step: "spend_alerts",
        error: "Error",
      },
      {
        event: "spend_alert_tick_failed",
        step: "spend_alert_email",
        error: "failed_status",
      },
    ]);
    // A missing DATABASE_URL is 503 "unavailable".
    const unconfigured = await createSpendAlertHandler({})(
      new Request("http://worker/api/garden"),
    );
    expect(unconfigured.status).toBe(503);
    expect(await unconfigured.json()).toEqual({ status: "unavailable" });
    expect(sent).toHaveLength(1);
  } finally {
    globalThis.fetch = realFetch;
    await local.dispose();
  }
});

test("alerts-only policy marks compatible writers and changes the daily limit only when given", async () => {
  const { configureMemoUpdatePolicy } = await import("../scripts/memo-updates");
  const local = await localStore();
  try {
    const state = async () =>
      (
        await local.db.query<{
          policy: string;
          ready: boolean;
          limit: number;
          enabled: boolean;
        }>(
          sql`SELECT global_spend_policy AS policy,foreground_accounting_ready AS ready,memo_updates_daily_limit AS "limit",memo_updates_enabled AS enabled FROM store_config`,
        )
      )[0]!;
    const initial = await state();
    await configureMemoUpdatePolicy(local.db);
    expect(await state()).toEqual({
      policy: "alerts_only",
      ready: true,
      limit: initial.limit,
      enabled: false,
    });
    await configureMemoUpdatePolicy(local.db, { dailyLimit: 80 });
    expect(await state()).toMatchObject({ limit: 80, enabled: false });
    await configureMemoUpdatePolicy(local.db);
    expect((await state()).limit).toBe(80);
  } finally {
    await local.dispose();
  }
});

test("new spend alerts email once with the fixed prefix; retries preserve the envelope and provider identity", async () => {
  const { runSpendAlertEmails } =
    await import("../src/store/spend-alert-email");
  const local = await localStore();
  try {
    await local.db.query(
      sql`UPDATE store_config SET global_spend_policy='alerts_only'`,
    );
    await local.db.query(
      sql`INSERT INTO foreground_usage(day_utc,reserved_micros) VALUES ((clock_timestamp() AT TIME ZONE 'UTC')::date,142000000)`,
    );
    const env = {
      RESEND_API_KEY: crypto.randomUUID(),
      MILTON_SPEND_ALERT_EMAIL_FROM: "alerts@example.com",
      MILTON_SPEND_ALERT_EMAIL_TO: "operator@example.com",
    };
    const requests: {
      key: string;
      body: { subject: string; text: string; to: string[] };
    }[] = [];
    const send: typeof fetch = Object.assign(
      async (_url: string | URL | Request, init?: RequestInit) => {
        expect(String(_url)).toBe("https://api.resend.com/emails");
        expect(init?.redirect).toBe("error");
        requests.push({
          key: new Headers(init?.headers).get("Idempotency-Key")!,
          body: JSON.parse(String(init?.body)),
        });
        return Response.json({ id: "fixture-provider-id" });
      },
      { preconnect: fetch.preconnect },
    );
    expect((await observeSpendAlerts(local.db, [100000000])).published).toBe(1);
    expect((await runSpendAlertEmails(local.db, env, send)).status).toBe(
      "sent",
    );
    await observeSpendAlerts(local.db, [100000000]);
    await runSpendAlertEmails(local.db, env, send);
    expect(requests).toHaveLength(1);
    const email = requests[0]!;
    expect(email.body.subject).toBe(
      "[Milton spend alert] Daily reserved spend: $142 of $100 threshold",
    );
    expect(email.body.to).toEqual(["operator@example.com"]);
    expect(email.body.text).toContain("Severity: warning");
    expect(email.body.text).toContain("Account scope: Milton — all accounts");
    expect(email.body.text).toContain("Type: model_reservations");
    expect(email.body.text).toContain(
      "https://console.cloud.google.com/home/dashboard?project=milton-510506",
    );
    expect(email.body.text).toMatch(/Timestamp: \d{4}-\d{2}-\d{2}T[\d:.]+Z/);
    expect(email.body.text).not.toContain(env.RESEND_API_KEY);
    expect(email.body.text).not.toContain("operator/spend-alerts");
    expect(email.key).toContain(
      (await readSpendAlerts(local.db)).events[0]!.id,
    );
  } finally {
    await local.dispose();
  }
});

test("ambiguous email acceptance retries its frozen request only within the provider deduplication window", async () => {
  const { runSpendAlertEmails } =
    await import("../src/store/spend-alert-email");
  const { PgDialect } = await import("drizzle-orm/pg-core");
  const local = await localStore();
  try {
    await local.db.query(
      sql`UPDATE store_config SET global_spend_policy='alerts_only'`,
    );
    await local.db.query(
      sql`INSERT INTO foreground_usage(day_utc,reserved_micros) VALUES ((clock_timestamp() AT TIME ZONE 'UTC')::date,142000000)`,
    );
    await observeSpendAlerts(local.db, [100000000]);
    const env = {
      RESEND_API_KEY: crypto.randomUUID(),
      MILTON_SPEND_ALERT_EMAIL_FROM: "alerts@example.com",
      MILTON_SPEND_ALERT_EMAIL_TO: "operator@example.com",
    };
    const logs: unknown[] = [];
    const delivered = new Map<string, string>();
    let attempts = 0;
    const send: typeof fetch = Object.assign(
      async (_url: string | URL | Request, init?: RequestInit) => {
        attempts++;
        const key = new Headers(init?.headers).get("Idempotency-Key")!;
        const body = String(init?.body);
        if (delivered.has(key)) expect(body).toBe(delivered.get(key)!);
        delivered.set(key, body);
        return Response.json({ id: "fixture-accepted-id" });
      },
      { preconnect: fetch.preconnect },
    );
    let loseAck = true;
    const db: typeof local.db = {
      ...local.db,
      async query(statement) {
        const query = new PgDialect().sqlToQuery(statement).sql;
        if (loseAck && query.includes("provider_id=")) {
          loseAck = false;
          throw new Error("fixture-secret-must-not-be-logged");
        }
        return local.db.query(statement);
      },
    };
    expect(
      (await runSpendAlertEmails(db, env, send, (e) => logs.push(e))).status,
    ).toBe("failed");
    expect(delivered.size).toBe(1);
    // While the original lease remains valid a second worker cannot dispatch.
    await runSpendAlertEmails(db, env, send, (e) => logs.push(e));
    expect(attempts).toBe(1);
    await local.db.query(
      sql`UPDATE spend_alert_emails SET lease_until=clock_timestamp()-interval '1 second'`,
    );
    // Configuration changes cannot change an already persisted request.
    expect(
      (
        await runSpendAlertEmails(
          db,
          { ...env, MILTON_SPEND_ALERT_EMAIL_TO: "changed@example.com" },
          send,
        )
      ).status,
    ).toBe("sent");
    expect(attempts).toBe(2);
    expect(delivered.size).toBe(1);
    const saved = await local.db.query<{ envelope: object }>(
      sql`SELECT envelope FROM spend_alert_emails`,
    );
    const envelope = saved[0]!.envelope;
    const expiredId = crypto.randomUUID();
    await local.db
      .query(sql`INSERT INTO spend_alerts(id,day_utc,metric,threshold_micros,filing_micros,review_micros,derived_micros,status,published_at)
      VALUES (${expiredId},(clock_timestamp() AT TIME ZONE 'UTC')::date,'model_reservations',110000000,142000000,0,0,'published',clock_timestamp())`);
    await local.db
      .query(sql`INSERT INTO spend_alert_emails(alert_id,envelope,first_attempt_at,attempts)
      VALUES (${expiredId},${JSON.stringify(envelope)}::jsonb,clock_timestamp()-interval '24 hours',1)`);
    await runSpendAlertEmails(db, env, send, (e) => logs.push(e));
    expect(attempts).toBe(2);
    expect(
      (
        await local.db.query<{ status: string }>(
          sql`SELECT status FROM spend_alert_emails WHERE alert_id=${expiredId}`,
        )
      )[0]!.status,
    ).toBe("unknown");
    expect(JSON.stringify(logs)).not.toContain("fixture-secret");
    expect(logs).toContainEqual({
      event: "spend_alert_email_failed",
      alert_id: expiredId,
      code: "retry_window_expired",
    });
    await expect(
      local.db.query(
        sql`DELETE FROM spend_alert_emails WHERE alert_id=${expiredId}`,
      ),
    ).rejects.toThrow();
    await expect(
      local.db.query(
        sql`UPDATE spend_alert_emails SET envelope='{}'::jsonb WHERE alert_id=${expiredId}`,
      ),
    ).rejects.toThrow();
    expect((await runSpendAlertEmails(db, {}, send)).status).toBe("disabled");
    expect(
      (
        await runSpendAlertEmails(
          db,
          { RESEND_API_KEY: crypto.randomUUID() },
          send,
          (e) => logs.push(e),
        )
      ).status,
    ).toBe("failed");
    expect((await readSpendAlerts(local.db)).events).toHaveLength(2);
  } finally {
    await local.dispose();
  }
});
