import { compiledMemos } from "../src/store/compiled";
import { expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import type { StoreDatabase } from "../src/store/database";
import { localStore } from "./local-store";
import { betweenPhases, fixtureStore, seedUsers } from "./store-fixtures";

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
    await seedUsers(local.pg, "updates");
    await local.pg.exec(
      "UPDATE store_config SET memo_updates_enabled=true,memo_updates_daily_limit=2",
    );
    let calls = 0;
    const store = fixtureStore(
      betweenPhases(local.db, async () => calls++),
      "updates",
      "allowance",
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
    await seedUsers(
      local.pg,
      "hold-race",
      "hold-legacy",
      "hold-claim",
      "hold-commit",
      "hold-failure",
      "hold-midnight",
    );
    const releases = new Map<string, () => void>(),
      starts = new Map<string, () => void>();
    // Claims that reached the write phase; a paused account's next one waits there.
    let calls = 0;
    const store = (id: string, db: StoreDatabase = local.db) =>
      fixtureStore(
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
        "holds",
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
      "UPDATE store_config SET memo_updates_enabled=true,memo_updates_daily_limit=1",
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
      "INSERT INTO trial_accounts(user_id,started_at,subscription_status) VALUES ('hold-commit',clock_timestamp()-interval '31 days','canceled'); UPDATE store_config SET trials_enabled=true",
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

test("the policy command changes the daily limit only when given", async () => {
  const { configureMemoUpdatePolicy } = await import("../scripts/memo-updates");
  const local = await localStore();
  try {
    const state = async () =>
      (
        await local.db.query<{
          limit: number;
          enabled: boolean;
        }>(
          sql`SELECT memo_updates_daily_limit AS "limit",memo_updates_enabled AS enabled FROM store_config`,
        )
      )[0]!;
    const initial = await state();
    await configureMemoUpdatePolicy(local.db);
    expect(await state()).toEqual({
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
