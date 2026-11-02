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
import { cardHeads, cardFingerprint } from "../src/store/cards";
import { compiledMemos, type SaveMemoInput } from "../src/store/compiled";
import { expect, jest, spyOn, test } from "bun:test";
import { sql } from "drizzle-orm";
import {
  databaseFailure,
  type StoreDatabase,
  type StoreSession,
} from "../src/store/database";
import { StoreError } from "../src/store/errors";
import {
  drizzleSql,
  localStore,
  migratedThrough,
  migrationsThrough,
} from "./local-store";
import { createStoreMemoTools, reportEnvelope } from "../src/store/tools";
import { createHash } from "node:crypto";
import {
  deleteAccount,
  guardStoreRequest,
  resolveIdentityAccount,
  lookupIdentityAccount,
  storeForCurrentRequest,
  personStoreForCurrentRequest,
} from "../src/store";
import {
  importMemos,
  parseImportSource,
  verifyImportedSource,
  loadImportSources,
} from "../scripts/import-memos";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { appendFile, cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Runs `between` after a save's claim commits and before its write phase, the
// window in which another request or an account change can land.
const betweenPhases = (
  db: StoreDatabase,
  between: () => Promise<unknown>,
): StoreDatabase => ({
  ...db,
  async transaction<T>(work: (tx: StoreSession) => Promise<T>) {
    const result = await db.transaction(work);
    if (typeof result === "object" && result !== null && "current" in result)
      await between();
    return result;
  },
});

const publicTables = async (pg: PGlite) =>
  (
    await pg.query<{ tablename: string }>(
      "SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename",
    )
  ).rows.map((row) => row.tablename);

// The public schema's shape, for migration tests. Columns sort by name: a drop
// and re-add moves a column, not its definition.
const schemaCatalog = async (pg: PGlite) => {
  const rows = async (statement: string) =>
    (await pg.query<Record<string, unknown>>(statement)).rows;
  return {
    tables: await publicTables(pg),
    columns: await rows(
      `SELECT table_name,column_name,data_type,udt_name,is_nullable,column_default,generation_expression FROM information_schema.columns WHERE table_schema='public' ORDER BY table_name,column_name`,
    ),
    constraints: await rows(
      "SELECT conrelid::regclass::text AS tbl,conname,pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE connamespace='public'::regnamespace ORDER BY tbl,conname",
    ),
    indexes: await rows(
      "SELECT indexname,indexdef FROM pg_indexes WHERE schemaname='public' ORDER BY indexname",
    ),
    triggers: await rows(
      "SELECT tgname,pg_get_triggerdef(oid) AS definition FROM pg_trigger WHERE NOT tgisinternal ORDER BY tgname",
    ),
    functions: await rows(
      "SELECT proname,pg_get_functiondef(oid) AS definition FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname LIKE 'milton_%' ORDER BY proname",
    ),
    extensions: await rows(
      "SELECT extname FROM pg_extension WHERE extname<>'plpgsql' ORDER BY extname",
    ),
  };
};

test("trial transition preserves saves and TPS while notices and access follow the account clock", async () => {
  const local = await localStore();
  try {
    await local.pg.exec("UPDATE store_config SET signup_mode='open'");
    const identity = (subject: string) => ({ provider: "neon", subject });
    await resolveIdentityAccount(local.env, identity("early"));
    await local.pg.exec("UPDATE store_config SET trials_enabled=true");
    await resolveIdentityAccount(local.env, identity("early"));
    await resolveIdentityAccount(local.env, identity("trial"));
    const auth = await lookupIdentityAccount(local.env, identity("trial"));
    const early = await lookupIdentityAccount(local.env, identity("early"));
    await resolveIdentityAccount(local.env, identity("never-saved"));
    const neverSaved = await lookupIdentityAccount(
      local.env,
      identity("never-saved"),
    );
    await local.db.query(
      sql`UPDATE trial_accounts SET started_at=clock_timestamp()-interval '31 days' WHERE user_id=${neverSaved.userId}`,
    );
    const idleTools = createStoreMemoTools(
      await storeForCurrentRequest(local.env, neverSaved, {
        issuer: "fixture",
        clientId: "idle",
      }),
    );
    expect(
      JSON.parse((await idleTools.get_cover_sheet()).content[0].text).error,
    ).toBe("subscription_required");
    await expect(
      (
        await personStoreForCurrentRequest(local.env, neverSaved)
      ).readTpsReport(),
    ).resolves.toMatchObject({ is_empty: true });
    // Claims that reached the write phase; one can expire the trial there.
    let calls = 0,
      expireWhileSaving = false;
    const store = await storeForCurrentRequest(
      {
        storeDatabase: betweenPhases(local.db, async () => {
          calls++;
          if (expireWhileSaving)
            await local.db.query(
              sql`UPDATE trial_accounts SET started_at=clock_timestamp()-interval '31 days' WHERE user_id=${auth.userId}`,
            );
        }),
      },
      auth,
      { issuer: "fixture", clientId: "one" },
    );
    const person = await personStoreForCurrentRequest(local.env, auth);
    const tools = createStoreMemoTools(store);
    const result = (r: Awaited<ReturnType<typeof tools.get_cover_sheet>>) =>
      JSON.parse(r.content[0].text);
    const account = async () =>
      (
        await local.db.query(
          sql`SELECT * FROM trial_accounts WHERE user_id=${auth.userId}`,
        )
      )[0]!;
    expect(
      (
        await local.db.query(
          sql`SELECT * FROM trial_accounts WHERE user_id=${early.userId}`,
        )
      ).length,
    ).toBe(0);
    const start = (await account()).started_at;
    expect(start).not.toBeNull();
    expect(start).toEqual(
      (
        await local.db.query(
          sql`SELECT created_at FROM users WHERE id=${auth.userId}`,
        )
      )[0]!.created_at,
    );
    await resolveIdentityAccount(local.env, identity("trial"));
    expect((await account()).started_at).toEqual(start);
    const empty = result(await tools.get_cover_sheet());
    expect(empty.notice).toBeUndefined();
    expect(
      result(
        await tools.create_memo({
          request_id: crypto.randomUUID(),
          expected_version: empty.version,
          text: "Fix a rule that is not there.",
          exact_edits: [{ before: "Missing", after: "Fixture" }],
        }),
      ).status,
    ).toBe("failed");
    expect((await account()).started_at).toEqual(start);
    const input = {
      request_id: crypto.randomUUID(),
      expected_version: empty.version,
      text: "Add a rule.",
      rules: [{ report: "cover" as const, text: "Be concise." }],
    };
    const saved = result(await tools.create_memo(input));
    expect(saved.status).toBe("saved");
    expect((await account()).started_at).toEqual(start);
    expect(result(await tools.create_memo(input))).toEqual(saved);
    expect((await account()).started_at).toEqual(start);
    expect(
      result(
        await tools.create_memo({
          ...input,
          request_id: crypto.randomUUID(),
          expected_version: saved.version,
        }),
      ).status,
    ).toBe("unchanged");
    expect((await account()).started_at).toEqual(start);
    // A failed claim keeps the accepted save; a slow claim that commits is returned.
    expect(
      result(
        await createStoreMemoTools({
          ...store,
          trialNotice: () => Promise.reject(new Error("claim failed")),
        }).create_memo(input),
      ),
    ).toEqual(saved);
    const slowNotice = {
      code: "trial_ending_7_days",
      trial_ends_at: new Date(0).toISOString(),
      message: "Fixture notice",
      subscription_url: "https://app.example.test/billing",
    } as const;
    // The claim settles an hour late on fake clocks. Every timer the save could
    // race it against (setTimeout, AbortSignal.timeout, Bun.sleep), armed before
    // or after the claim starts, fires first.
    const fakeAbort = spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
      const controller = new AbortController();
      setTimeout(
        () => controller.abort(new DOMException("Timed out", "TimeoutError")),
        ms,
      );
      return controller.signal;
    });
    const fakeSleep = spyOn(Bun, "sleep").mockImplementation(
      (ms) =>
        new Promise<void>((resolve) =>
          setTimeout(resolve, typeof ms === "number" ? ms : +ms - Date.now()),
        ),
    );
    try {
      jest.useFakeTimers();
      expect(
        result(
          await createStoreMemoTools({
            ...store,
            trialNotice: async () => {
              for (let i = 0; i < 10; i++) await Promise.resolve();
              jest.advanceTimersByTime(3_600_000);
              // Let whatever those timers settled reach the save first.
              for (let i = 0; i < 10; i++) await Promise.resolve();
              return slowNotice;
            },
          }).create_memo(input),
        ),
      ).toEqual({ ...saved, notice: slowNotice });
    } finally {
      fakeSleep.mockRestore();
      fakeAbort.mockRestore();
      jest.useRealTimers();
    }
    await local.db.query(
      sql`UPDATE trial_accounts SET paid_through=clock_timestamp()+interval '60 days' WHERE user_id=${auth.userId}`,
    );
    expect((await person.trialStatus()).trial_ends_at).toBe(
      new Date(new Date(String(start)).getTime() + 30 * 86400000).toISOString(),
    );
    await local.db.query(
      sql`UPDATE trial_accounts SET paid_through=NULL WHERE user_id=${auth.userId}`,
    );
    const report = await person.readTpsReport();
    // Only cover-sheet rules exist, so the cover sheet text is the full report.
    expect(result(await tools.get_cover_sheet())).toMatchObject(report);
    // Move only fixture clocks; real writes never reset started_at.
    await local.db.query(
      sql`UPDATE trial_accounts SET started_at=clock_timestamp()-interval '24 days' WHERE user_id=${auth.userId}`,
    );
    // Background lifecycle context does not surface billing notices or consume them.
    const hook = result(
      await tools.get_cover_sheet({ hook_event: "SessionStart" }),
    );
    expect(hook.hookSpecificOutput.additionalContext).toContain(report.text);
    expect((await account()).notice_stage).toBe(0);
    const otherTools = createStoreMemoTools(
      await storeForCurrentRequest(local.env, auth, {
        issuer: "fixture",
        clientId: "two",
      }),
    );
    const reads = await Promise.all([
      tools.create_memo(input),
      otherTools.get_cover_sheet(),
    ]);
    expect(reads.map(result).filter((r) => r.notice).length).toBe(1);
    expect(reads.map(result).find((r) => r.notice).notice.code).toBe(
      "trial_ending_7_days",
    );
    expect(await person.readTpsReport()).toEqual(report);
    expect(result(await tools.get_cover_sheet()).notice).toBeUndefined();
    await local.db.query(
      sql`UPDATE trial_accounts SET started_at=clock_timestamp()-interval '29 days 1 hour' WHERE user_id=${auth.userId}`,
    );
    expect(result(await tools.get_cover_sheet()).notice.code).toBe(
      "trial_ending_1_day",
    );
    expect(result(await tools.get_cover_sheet()).notice).toBeUndefined();
    expireWhileSaving = true;
    const racingSave = result(
      await tools.create_memo({
        text: "Expires while saving",
        rules: [{ report: "cover", text: "Lead with the answer." }],
        expected_version: report.version,
        request_id: crypto.randomUUID(),
      }),
    );
    expireWhileSaving = false;
    expect(racingSave).toMatchObject({
      status: "failed",
      error: "subscription_required",
      retryable: false,
    });
    expect(racingSave.subscription_url).toBe(
      "https://app.meetmilton.com/billing",
    );
    expect(await person.readTpsReport()).toEqual(report);
    const denied = await tools.get_cover_sheet();
    expect(denied.isError).toBe(true);
    expect(result(denied)).toMatchObject({
      error: "subscription_required",
      retryable: false,
    });
    expect(result(denied).text).toBeUndefined();
    const beforeCalls = calls;
    expect(
      result(
        await tools.create_memo({
          ...input,
          request_id: crypto.randomUUID(),
          expected_version: report.version,
        }),
      ).error,
    ).toBe("subscription_required");
    expect(calls).toBe(beforeCalls);
    // An accepted write's receipt stays recoverable even after access expires.
    expect(result(await tools.create_memo(input))).toEqual(saved);
    expect(await person.readTpsReport()).toEqual(report);
    const expiredStart = (await account()).started_at;
    // This is a trusted-provider projection fixture, not a client subscription action.
    await local.db.query(
      sql`UPDATE trial_accounts SET paid_through=clock_timestamp()+interval '30 days' WHERE user_id=${auth.userId}`,
    );
    expect(result(await tools.get_cover_sheet())).toMatchObject(report);
    expect((await account()).started_at).toEqual(expiredStart);
    await local.db.query(
      sql`UPDATE trial_accounts SET paid_through=NULL WHERE user_id=${auth.userId}`,
    );
    await local.pg.exec("UPDATE store_config SET trials_enabled=false");
    expect(result(await tools.get_cover_sheet())).toMatchObject(report);
    await local.pg.exec("UPDATE store_config SET trials_enabled=true");
    const earlyStore = await storeForCurrentRequest(local.env, early, {
      issuer: "fixture",
      clientId: "one",
    });
    expect(
      result(await createStoreMemoTools(earlyStore).get_cover_sheet()).is_empty,
    ).toBe(true);
    expect(
      (
        await local.db.query(
          sql`SELECT count(*)::int AS n FROM accepted_changes WHERE user_id=${auth.userId}`,
        )
      )[0]!.n,
    ).toBe(1);
    expect(await person.readTpsReport()).toEqual(report);
  } finally {
    await local.dispose();
  }
});

test("compiled saves publish memos and TPS together and charge once with durable replay", async () => {
  const local = await localStore();
  try {
    await local.pg.exec(
      "INSERT INTO users(id) VALUES ('compiled-a'),('compiled-b')",
    );
    let calls = 0;
    const store = compiledMemos(
      betweenPhases(local.db, async () => calls++),
      "compiled-a",
      { issuer: "fixture", clientId: "assistant" },
    );
    const empty = await store.getTpsReport();
    expect(empty.text).toBe("");
    const input = {
      text: "Add two rules.",
      rules: [
        { report: "cover" as const, text: "Be concise." },
        { report: "cover" as const, text: "Ask before sending." },
      ],
      expected_version: empty.version,
      request_id: crypto.randomUUID(),
    };
    const saved = await store.saveMemo(input);
    expect(saved.status).toBe("saved");
    const current = await store.getTpsReport();
    expect(current.text.split("\n\n").sort()).toEqual([
      "Ask before sending.",
      "Be concise.",
    ]);
    expect(current.version).not.toBe(empty.version);
    expect(await store.saveMemo(input)).toEqual(saved);
    expect(calls).toBe(1);
    expect(
      (
        await local.pg.query(
          "SELECT writes FROM usage_daily WHERE user_id='compiled-a'",
        )
      ).rows,
    ).toEqual([{ writes: 1 }]);
    const noop = await store.saveMemo({
      text: "Repeat",
      rules: [{ report: "cover", text: "Be concise." }],
      expected_version: current.version,
      request_id: crypto.randomUUID(),
    });
    expect(noop.status).toBe("unchanged");
    expect(await store.getTpsReport()).toEqual(current);
    expect(
      (
        await local.pg.query(
          "SELECT writes FROM usage_daily WHERE user_id='compiled-a'",
        )
      ).rows,
    ).toEqual([{ writes: 1 }]);
    await expect(
      store.saveMemo({ ...input, text: "Changed" }),
    ).rejects.toMatchObject({ code: "request_id_reused" });
    // A completed receipt is immutable, so a replay can only return what was saved.
    await expect(
      local.pg.exec(
        "UPDATE save_requests SET result_json='{}' WHERE user_id='compiled-a'",
      ),
    ).rejects.toThrow("save_receipt_is_immutable");
    expect(
      (await compiledMemos(local.db, "compiled-b").getTpsReport()).text,
    ).toBe("");
    expect(
      (
        await local.pg.query(
          "SELECT count(*)::int AS n FROM instruction_card_versions WHERE user_id='compiled-a'",
        )
      ).rows,
    ).toEqual([{ n: 2 }]);
    expect(
      (
        await local.pg.query(
          "SELECT count(*)::int AS n FROM tps_reports WHERE user_id='compiled-a'",
        )
      ).rows,
    ).toEqual([{ n: 1 }]);
  } finally {
    await local.dispose();
  }
});

test("TPS preserves every active source body verbatim and refreshes only the derived report", async () => {
  const local = await localStore();
  try {
    await local.pg.exec(
      "INSERT INTO users(id) VALUES ('fidelity'),('fidelity-other')",
    );
    const source =
      "Where relevant, identify products by their full model names.\n\nKeep exceptions intact.\n";
    const companion = "  Keep units explicit: µm.\r\nDo not infer a model.  ";
    const exact = companion + "\n\n" + source;
    await local.db.query(sql`INSERT INTO memos(user_id,id,name) VALUES
      ('fidelity','z','product-naming'),('fidelity','a','units'),('fidelity','retired','old');`);
    await local.db
      .query(sql`INSERT INTO memo_versions(user_id,memo_id,version,description,body,archived,reason,actor_json) VALUES
      ('fidelity','a',1,'Units',${companion},false,'Fixture','{}'),
      ('fidelity','z',1,'Product naming',${source},false,'Fixture','{}'),
      ('fidelity','retired',1,'Old','Archived instructions must stay out.',true,'Fixture','{}')`);
    let slow = false;
    let release!: () => void, started!: () => void;
    const begun = new Promise<void>((r) => {
      started = r;
    });
    const held = new Promise<void>((r) => {
      release = r;
    });
    const store = compiledMemos(
      betweenPhases(local.db, async () => {
        if (slow) {
          started();
          await held;
        }
      }),
      "fidelity",
      { issuer: "fixture", clientId: "assistant" },
    );
    // Legacy sources assemble on first read, in stored position order.
    const initial = await store.getTpsReport();
    expect(initial.text).toBe(exact);
    const same = "Keep exceptions intact.";
    const save = (
      version: string,
      exact_edits = [{ before: same, after: same }],
    ) =>
      store.saveMemo({
        text: "Fictional instruction change.",
        expected_version: version,
        request_id: crypto.randomUUID(),
        exact_edits,
      });
    // The read already assembled, so an edit that changes nothing is unchanged.
    expect(await save(initial.version)).toMatchObject({ status: "unchanged" });
    expect((await store.getTpsReport()).text).toBe(exact);
    const canonical = await store.getTpsReport();
    expect(Object.keys(canonical).sort()).toEqual([
      "is_empty",
      "text",
      "version",
    ]);
    const documents = await store.readDocuments();
    expect(documents.version).toBe(canonical.version);
    expect(documents.cover_rules).toEqual([companion, source]);
    expect(documents.index.map((r) => r.id)).toEqual([
      "email",
      "chat",
      "post",
      "document",
      "speech",
    ]);
    expect(documents.reports.every((r) => r.is_empty)).toBe(true);
    const preserved = async () =>
      (
        await local.pg.query<{
          memos: unknown;
          versions: unknown;
          receipts: unknown;
          usage: unknown;
          retained_bytes: number;
        }>(`SELECT
      (SELECT jsonb_agg(m) FROM memos m WHERE user_id='fidelity') AS memos,
      (SELECT jsonb_agg(v) FROM memo_versions v WHERE user_id='fidelity') AS versions,
      (SELECT jsonb_agg(r) FROM save_requests r WHERE user_id='fidelity') AS receipts,
      (SELECT jsonb_agg(d) FROM usage_daily d WHERE user_id='fidelity') AS usage,
      (SELECT retained_bytes FROM users WHERE id='fidelity') AS retained_bytes`)
      ).rows;
    // A stored paraphrase with the right source fence is kept: the fence, not the
    // text, decides whether assembly runs. A source change rebuilds on read.
    await local.pg.exec(
      "UPDATE tps_reports SET body='Identify products by full model names.' WHERE user_id='fidelity'",
    );
    const before = await preserved();
    const admin = compiledMemos(local.db, "fidelity"); // No actor or model configuration.
    expect((await admin.getTpsReport()).text).toBe(exact);
    expect((await store.getTpsReport()).version).toBe(canonical.version);
    expect(await preserved()).toEqual(before);
    await local.pg
      .exec(`INSERT INTO memo_versions(user_id,memo_id,version,description,body,reason,actor_json)
      SELECT user_id,memo_id,2,description,body || 'Updated condition.','Fixture','{}'
      FROM memo_versions WHERE user_id='fidelity' AND memo_id='z' AND version=1`);
    const rebuilt = await admin.getTpsReport();
    expect(rebuilt.version).not.toBe(canonical.version);
    expect(rebuilt.text).toBe(exact + "Updated condition.");
    expect((await store.getTpsReport()).version).toBe(rebuilt.version);
    // A save fenced on a version that a concurrent read superseded conflicts.
    slow = true;
    const pending = save(rebuilt.version);
    await begun;
    await local.pg
      .exec(`INSERT INTO memo_versions(user_id,memo_id,version,description,body,reason,actor_json)
      SELECT user_id,memo_id,3,description,body,'Fixture','{}'
      FROM memo_versions WHERE user_id='fidelity' AND memo_id='z' AND version=2`);
    const changed = await admin.getTpsReport();
    release();
    slow = false;
    expect((await pending).status).toBe("conflict");
    expect(changed.text).toBe(exact + "Updated condition.");
    // Each body fits; the assembled cover sheet does not. Nothing is truncated.
    await local.pg.exec(
      "UPDATE store_config SET limits_json=limits_json || '{\"report_body_bytes\":128}'::jsonb",
    );
    const boundedBefore = await preserved();
    expect(
      (
        await save(changed.version, [
          { before: same, after: same + "!" },
          { before: "Do not infer a model.", after: "Do not infer a model.!" },
        ])
      ).error,
    ).toBe("tps_body_limit");
    const boundedAfter = await preserved();
    expect(boundedAfter[0]!.versions).toEqual(boundedBefore[0]!.versions);
    expect(boundedAfter[0]!.memos).toEqual(boundedBefore[0]!.memos);
    expect(boundedAfter[0]!.usage).toEqual(boundedBefore[0]!.usage);
    await local.pg.exec(
      "UPDATE store_config SET limits_json=limits_json || '{\"report_body_bytes\":262144}'::jsonb",
    );
    expect((await store.getTpsReport()).version).toBe(changed.version);
    expect(
      (
        await save(changed.version, [
          { before: companion, after: "" },
          { before: source + "Updated condition.", after: "" },
        ])
      ).status,
    ).toBe("saved");
    expect((await store.getTpsReport()).text).toBe("");
    expect((await store.getTpsReport()).is_empty).toBe(true);
    // An account that never held anything is not written by a read.
    const other = compiledMemos(local.db, "fidelity-other");
    expect(await other.getTpsReport()).toEqual({
      text: "",
      version: (await other.getTpsReport()).version,
      is_empty: true,
    });
    expect(
      (
        await local.pg.query(
          "SELECT count(*)::int AS n FROM tps_reports WHERE user_id='fidelity-other'",
        )
      ).rows,
    ).toEqual([{ n: 0 }]);
  } finally {
    await local.dispose();
  }
});

test("stale and failed compiled saves preserve current memos, receipts and charges", async () => {
  const local = await localStore();
  try {
    await local.pg.exec("INSERT INTO users(id) VALUES ('race'),('foreign')");
    let release!: () => void, started!: () => void;
    const begun = new Promise<void>((r) => {
      started = r;
    });
    const held = new Promise<void>((r) => {
      release = r;
    });
    // Claims that reached the write phase; the first one waits there.
    let calls = 0;
    const actor = { issuer: "fixture", clientId: "fixture" };
    const store = compiledMemos(
      betweenPhases(local.db, async () => {
        if (++calls === 1) {
          started();
          await held;
        }
      }),
      "race",
      actor,
    );
    const initial = await store.getTpsReport();
    const slow = {
      text: "Slow",
      rules: [{ report: "cover" as const, text: "Slow" }],
      request_id: crypto.randomUUID(),
      expected_version: initial.version,
    };
    const pending = store.saveMemo(slow);
    await begun;
    expect((await store.saveMemo(slow)).status).toBe("in_progress");
    expect((await store.getTpsReport()).text).toBe("");
    const fast = {
      text: "Be concise.",
      rules: [{ report: "cover" as const, text: "Be concise." }],
      request_id: crypto.randomUUID(),
      expected_version: initial.version,
    };
    expect((await store.saveMemo(fast)).status).toBe("saved");
    release();
    expect((await pending).status).toBe("conflict");
    expect(calls).toBe(2);
    const first = await store.getTpsReport();
    expect(first.text).toBe("Be concise.");
    // Throw after actual commit: receipt resolution must report the committed result.
    let dropped = false;
    const uncertain = {
      ...local.db,
      async transaction<T>(
        work: Parameters<typeof local.db.transaction<T>>[0],
      ) {
        const result = await local.db.transaction(work);
        if (
          !dropped &&
          typeof result === "object" &&
          result !== null &&
          "status" in result &&
          result.status === "saved"
        ) {
          dropped = true;
          throw new Error("lost acknowledgment");
        }
        return result;
      },
    };
    const saved = await compiledMemos(uncertain, "race", actor).saveMemo({
      text: "Lead with the answer.",
      exact_edits: [{ before: "Be concise.", after: "Lead with the answer." }],
      request_id: crypto.randomUUID(),
      expected_version: first.version,
    });
    expect(saved.status).toBe("saved");
    if (!saved.version) throw new Error("Saved revision missing");
    expect((await store.getTpsReport()).text).toBe("Lead with the answer.");
    expect((await store.saveMemo(fast)).version).toBe(first.version);
    expect((await store.getTpsReport()).version).toBe(saved.version);
    const before = await local.pg.query(
      "SELECT card_id,version,body FROM instruction_card_versions WHERE user_id='race' ORDER BY card_id,version",
    );
    await local.pg
      .exec(`CREATE FUNCTION reject_report() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture report failure'; END $$;
      CREATE TRIGGER reject_report BEFORE UPDATE ON tps_reports FOR EACH ROW EXECUTE FUNCTION reject_report();`);
    const failed = await store.saveMemo({
      text: "A changed instruction.",
      exact_edits: [
        { before: "Lead with the answer.", after: "A changed instruction." },
      ],
      request_id: crypto.randomUUID(),
      expected_version: String(saved.version),
    });
    expect(failed.status).toBe("failed");
    expect(
      await local.pg.query(
        "SELECT card_id,version,body FROM instruction_card_versions WHERE user_id='race' ORDER BY card_id,version",
      ),
    ).toEqual(before);
    expect((await store.getTpsReport()).version).toBe(saved.version);
    expect(
      (
        await local.pg.query(
          "SELECT writes FROM usage_daily WHERE user_id='race'",
        )
      ).rows,
    ).toEqual([{ writes: 2 }]);
    expect(
      (
        await local.pg.query(
          "SELECT count(*)::int AS n FROM tps_reports WHERE user_id='race'",
        )
      ).rows,
    ).toEqual([{ n: 1 }]);
    expect(
      (
        await local.pg.query(`SELECT id FROM users u WHERE retained_bytes <>
      (SELECT coalesce(sum(payload_bytes),0) FROM memo_versions WHERE user_id=u.id) +
      (SELECT coalesce(sum(payload_bytes),0) FROM instruction_card_versions WHERE user_id=u.id) +
      (SELECT coalesce(sum(payload_bytes),0) FROM save_requests WHERE user_id=u.id) +
      (SELECT coalesce(sum(payload_bytes),0) FROM accepted_changes WHERE user_id=u.id)`)
      ).rows,
    ).toEqual([]);
  } finally {
    await local.dispose();
  }
});

test("saves anchor in every active memo, never archived or foreign text, and respect the daily write cap", async () => {
  const local = await localStore();
  try {
    await local.pg.exec(`INSERT INTO users(id) VALUES ('collection'),('other');
      INSERT INTO memos(user_id,id,name) SELECT 'collection','m-'||n,'memo-'||n FROM generate_series(1,52) n;
      INSERT INTO memo_versions(user_id,memo_id,version,description,body,archived,reason,actor_json)
        SELECT user_id,id,1,'Scoped instruction','Instruction '||id,id='m-52','Fixture','{}' FROM memos;
      INSERT INTO memos(user_id,id,name) VALUES ('other','foreign-id','other');
      INSERT INTO memo_versions(user_id,memo_id,version,description,body,reason,actor_json) VALUES ('other','foreign-id',1,'Other','Never exposed','Fixture','{}');
      UPDATE store_config SET limits_json=limits_json || '{"page_size":1}'::jsonb;`);
    const actor = { issuer: "fixture", clientId: "fixture" };
    const store = compiledMemos(local.db, "collection", actor);
    // Legacy sources without a compiled snapshot assemble on first read.
    let base = (await store.getTpsReport()).version;
    const send = (before: string, after = before) =>
      store.saveMemo({
        text: "Edit the existing instructions.",
        exact_edits: [{ before, after }],
        request_id: crypto.randomUUID(),
        expected_version: base,
      });
    // The read assembled the sources, so an edit that changes nothing is unchanged.
    expect((await send("Instruction m-51")).status).toBe("unchanged");
    base = (await store.getTpsReport()).version;
    // Every active memo is in the snapshot despite page_size 1; archived and
    // foreign text is not.
    for (const anchor of ["Instruction m-52", "Never exposed"])
      expect((await send(anchor, "Changed")).error).toBe("edit_conflict");
    expect((await store.getTpsReport()).version).toBe(base);
    expect(
      (await send("Instruction m-51", "Instruction m-51 changed")).status,
    ).toBe("saved");
    base = (await store.getTpsReport()).version;
    await local.pg.exec(
      `UPDATE store_config SET limits_json=limits_json || '{"daily_writes":1}'::jsonb`,
    );
    expect(
      (await send("Instruction m-50", "Instruction m-50 changed")).error,
    ).toBe("rate_limited");
    expect((await store.getTpsReport()).version).toBe(base);
    expect((await send("Instruction m-50")).status).toBe("unchanged");
    expect(
      (
        await local.pg.query(
          "SELECT writes FROM usage_daily WHERE user_id='collection'",
        )
      ).rows,
    ).toEqual([{ writes: 1 }]);
  } finally {
    await local.dispose();
  }
});

// Two signed-up accounts behind the real tool layer.
async function tenantPair(
  local: Awaited<ReturnType<typeof localStore>>,
  between: () => Promise<unknown> = async () => {},
) {
  await local.db.query(sql`UPDATE store_config SET signup_mode='open'`);
  const storeDatabase = betweenPhases(local.db, between);
  const tenant = async (subject: string) => {
    const identity = { provider: "neon", subject };
    await resolveIdentityAccount(local.env, identity);
    const auth = await lookupIdentityAccount(local.env, identity);
    const tools = createStoreMemoTools(
      await storeForCurrentRequest({ storeDatabase }, auth, {
        issuer: "fixture",
        clientId: subject,
      }),
    );
    const version = async (): Promise<string> =>
      read(await tools.get_cover_sheet()).version;
    // Everything this tenant's assistant can read, as one string.
    const everything = async () =>
      JSON.stringify([
        read(await tools.get_cover_sheet()),
        read(await tools.get_report({ report_id: "email" })),
        read(await tools.list_reports()),
      ]);
    return { id: auth.userId, tools, version, everything };
  };
  return [
    await tenant("isolation-alpha"),
    await tenant("isolation-beta"),
  ] as const;
}
const read = (result: { content: [{ text: string }] }) =>
  JSON.parse(result.content[0].text);
const emailRule = (text: string) => ({
  text,
  rules: [{ report: "email" as const, text }],
});

test("tenants with overlapping card, sample and request IDs never read, edit or replay each other", async () => {
  const local = await localStore();
  try {
    const [alpha, beta] = await tenantPair(local);
    const alphaRule = {
      ...emailRule("- Alpha signs as Ada."),
      request_id: crypto.randomUUID(),
      expected_version: await alpha.version(),
    };
    const alphaSaved = read(await alpha.tools.create_memo(alphaRule));
    expect(alphaSaved.status).toBe("saved");
    const alphaSample = {
      text: "Keep this approved email.",
      request_id: crypto.randomUUID(),
      expected_version: alphaSaved.version,
      sample: {
        report: "email" as const,
        new_kind: "follow-up",
        context: "alpha context",
        text: "Alpha sample body.",
      },
    };
    const alphaSampleSaved = read(await alpha.tools.create_memo(alphaSample));
    expect(alphaSampleSaved.status).toBe("saved");
    // Beta holds a card and a sample under Alpha's exact IDs in the same report.
    const [card] = await local.db.query<{ id: string }>(
      sql`SELECT card_id AS id FROM instruction_card_versions WHERE user_id=${alpha.id} AND report='email'`,
    );
    const [sample] = await local.db.query<{ id: string; kind_id: string }>(
      sql`SELECT id,kind_id FROM samples WHERE user_id=${alpha.id}`,
    );
    await local.db.query(
      sql`INSERT INTO instruction_cards(user_id,id) VALUES (${beta.id},${card!.id})`,
    );
    await local.db.query(
      sql`INSERT INTO instruction_card_versions(user_id,card_id,version,description,body,report,reason,actor_json)
      VALUES (${beta.id},${card!.id},1,'Fictional','- Beta signs as Bo.','email','Fixture','{}')`,
    );
    // Beta's sample kind also reuses Alpha's kind ID.
    await local.db.query(
      sql`INSERT INTO sample_kinds(user_id,id,report,label) VALUES (${beta.id},${sample!.kind_id},'email','follow-up')`,
    );
    await local.db.query(
      sql`INSERT INTO samples(user_id,id,report,kind_id,context,body,client_json)
      VALUES (${beta.id},${sample!.id},'email',${sample!.kind_id},'beta context','Beta sample body.','{}')`,
    );
    // (c) Cover sheet, report and list show only the caller's rules and samples.
    const alphaOwn = [
      "Alpha signs as Ada",
      "Alpha sample body",
      "alpha context",
    ];
    const betaOwn = ["Beta signs as Bo", "Beta sample body", "beta context"];
    const alphaSees = await alpha.everything();
    const betaSees = await beta.everything();
    for (const text of alphaOwn) {
      expect(alphaSees).toContain(text);
      expect(betaSees).not.toContain(text);
    }
    for (const text of betaOwn) {
      expect(betaSees).toContain(text);
      expect(alphaSees).not.toContain(text);
    }
    const alphaVersion = await alpha.version();
    const betaVersion = await beta.version();
    expect(betaVersion).not.toBe(alphaVersion);
    // (c) Alpha's revision token is a conflict for Beta, answered with Beta's own.
    expect(
      read(
        await beta.tools.create_memo({
          ...emailRule("- Beta rule."),
          request_id: crypto.randomUUID(),
          expected_version: alphaVersion,
        }),
      ),
    ).toMatchObject({ status: "conflict", version: betaVersion });
    // (a) Alpha's exact request from Beta gets Beta's refusal, never Alpha's receipt.
    const copied = read(await beta.tools.create_memo(alphaRule));
    expect(copied).toMatchObject({
      status: "conflict",
      request_id: alphaRule.request_id,
      version: betaVersion,
    });
    expect(JSON.stringify(copied)).not.toContain(alphaSaved.version);
    // (a) Alpha's request ID with Beta's own input files fresh for Beta.
    const betaReuse = {
      ...emailRule("- Beta keeps it short."),
      request_id: alphaRule.request_id,
      expected_version: betaVersion,
    };
    const betaSaved = read(await beta.tools.create_memo(betaReuse));
    expect(betaSaved.status).toBe("saved");
    expect(betaSaved.version).not.toBe(alphaSaved.version);
    const betaSample = {
      ...alphaSample,
      expected_version: betaSaved.version,
      // Beta's own kind under Alpha's kind ID; new_kind would duplicate it.
      sample: {
        report: "email" as const,
        kind_id: sample!.kind_id,
        context: "beta reuse",
        text: "Beta reuse body.",
      },
    };
    const betaSampleSaved = read(await beta.tools.create_memo(betaSample));
    expect(betaSampleSaved.status).toBe("saved");
    // Each tenant's replay returns its own receipt; crossing inputs is reuse.
    expect(read(await alpha.tools.create_memo(alphaRule))).toEqual(alphaSaved);
    expect(read(await alpha.tools.create_memo(alphaSample))).toEqual(
      alphaSampleSaved,
    );
    expect(read(await beta.tools.create_memo(betaReuse))).toEqual(betaSaved);
    expect(read(await beta.tools.create_memo(betaSample))).toEqual(
      betaSampleSaved,
    );
    expect(read(await alpha.tools.create_memo(betaReuse)).error).toBe(
      "request_id_reused",
    );
    expect(
      await local.db.query(
        sql`SELECT count(DISTINCT user_id)::int AS n FROM save_requests WHERE request_id=${alphaRule.request_id}`,
      ),
    ).toEqual([{ n: 2 }]);
    // (b) An exact edit anchored only in Alpha's text is refused for Beta.
    const foreign = read(
      await beta.tools.create_memo({
        text: "Rename the signer.",
        request_id: crypto.randomUUID(),
        expected_version: await beta.version(),
        exact_edits: [
          { before: "Alpha signs as Ada", after: "Alpha signs as Eve" },
        ],
      }),
    );
    expect(foreign).toMatchObject({ status: "failed", error: "edit_conflict" });
    // (b) Beta's edit to its card with Alpha's card ID changes only Beta's history.
    expect(
      read(
        await beta.tools.create_memo({
          text: "Rename the signer.",
          request_id: crypto.randomUUID(),
          expected_version: await beta.version(),
          exact_edits: [
            { before: "Beta signs as Bo", after: "Beta signs as Bea" },
          ],
        }),
      ).status,
    ).toBe("saved");
    const history = (userId: string) =>
      local.db.query(
        sql`SELECT version,body FROM instruction_card_versions WHERE user_id=${userId} AND card_id=${card!.id} ORDER BY version`,
      );
    expect(await history(alpha.id)).toEqual([
      { version: 1, body: "- Alpha signs as Ada." },
    ]);
    expect(await history(beta.id)).toEqual([
      { version: 1, body: "- Beta signs as Bo." },
      { version: 2, body: "- Beta signs as Bea." },
    ]);
    // Alpha's reads and version are byte-identical after all of Beta's activity.
    expect(await alpha.everything()).toBe(alphaSees);
    const betaAfter = await beta.everything();
    for (const text of [...alphaOwn, "Alpha signs as Eve"])
      expect(betaAfter).not.toContain(text);
    expect(betaAfter).toContain("Beta signs as Bea");
    expect(betaAfter).toContain("beta reuse");
  } finally {
    await local.dispose();
  }
}, 30000);

test("targeted saves preserve omitted memos and reject invalid changes atomically", async () => {
  const local = await localStore();
  try {
    await local.pg.exec(`INSERT INTO users(id) VALUES ('targeted');
      INSERT INTO memos(user_id,id,name) VALUES ('targeted','a','a'),('targeted','b','b'),('targeted','c','c');
      INSERT INTO memo_versions(user_id,memo_id,version,description,body,reason,actor_json)
        SELECT user_id,id,1,'Instruction '||id,'Preserve '||id||' exactly.','Fixture','{}' FROM memos;`);
    let calls = 0;
    const store = compiledMemos(
      betweenPhases(local.db, async () => calls++),
      "targeted",
      { issuer: "fixture", clientId: "fixture" },
    );
    const initial = await store.getTpsReport();
    const request = {
      text: "Change a, add d and remove c.",
      exact_edits: [
        { before: "Preserve a exactly.", after: "Change a only." },
        { before: "Preserve c exactly.", after: "" },
      ],
      rules: [{ report: "cover" as const, text: "Add d." }],
      expected_version: initial.version,
      request_id: crypto.randomUUID(),
    };
    const result = await store.saveMemo(request);
    expect(result.status).toBe("saved");
    expect(await store.saveMemo(request)).toEqual(result);
    expect(calls).toBe(1);
    const current = await store.getTpsReport();
    const heads = (
      await local.pg.query<{
        id: string;
        body: string;
        version: number;
        archived: boolean;
      }>(
        `SELECT DISTINCT ON (card_id) card_id AS id,body,version,archived FROM instruction_card_versions WHERE user_id='targeted' ORDER BY card_id,version DESC`,
      )
    ).rows;
    expect(heads.find((h) => h.id === "b")).toEqual({
      id: "b",
      body: "Preserve b exactly.",
      version: 1,
      archived: false,
    });
    expect(heads.find((h) => h.id === "a")?.version).toBe(2);
    expect(heads.find((h) => h.id === "c")?.archived).toBe(true);
    expect(heads.filter((h) => !h.archived)).toHaveLength(3);
    // A new card appends after existing ones, whatever its random ID.
    expect(current.text).toBe(
      "Change a only.\n\nPreserve b exactly.\n\nAdd d.",
    );
    const history = await local.pg.query(
      "SELECT * FROM instruction_card_versions WHERE user_id='targeted' ORDER BY card_id,version",
    );
    const send = (change: Partial<SaveMemoInput>) =>
      store.saveMemo({
        text: "A fictional change.",
        expected_version: current.version,
        request_id: crypto.randomUUID(),
        ...change,
      });
    expect(
      (
        await send({
          exact_edits: [{ before: "Add d.", after: "Add d." }],
        })
      ).status,
    ).toBe("unchanged");
    await local.pg.exec(
      `UPDATE store_config SET limits_json=limits_json || '{"memos":3}'::jsonb`,
    );
    expect(
      (
        await send({
          rules: [
            {
              report: "cover",
              text: "Exceeds the resulting active memo limit.",
            },
          ],
        })
      ).error,
    ).toBe("memo_count_limit");
    expect(await store.getTpsReport()).toEqual(current);
    expect(
      await local.pg.query(
        "SELECT * FROM instruction_card_versions WHERE user_id='targeted' ORDER BY card_id,version",
      ),
    ).toEqual(history);
    expect(
      (
        await local.pg.query(
          "SELECT writes FROM usage_daily WHERE user_id='targeted'",
        )
      ).rows,
    ).toEqual([{ writes: 1 }]);
  } finally {
    await local.dispose();
  }
});

test("exact caller edits preserve conditions and scope without a model, with atomic anchors and replay", async () => {
  const local = await localStore();
  try {
    await local.pg.exec("INSERT INTO users(id) VALUES ('exact')");
    const sources = [
      {
        id: "a",
        body: "When documenting a public API, include a runnable example only when the example requires no credentials and can run without network access. Otherwise, describe the call without a runnable example.",
      },
      {
        id: "b",
        body: "On mobile, use exactly three short bullets for product comparisons. On desktop only, use a table with exactly two columns: Product and Tradeoff. Other displays have no required format.",
      },
      { id: "c", body: "Preserve literal α and 😀 exactly." },
    ];
    for (const m of sources) {
      await local.db.query(
        sql`INSERT INTO memos(user_id,id,name) VALUES ('exact',${m.id},${m.id})`,
      );
      await local.db.query(
        sql`INSERT INTO memo_versions(user_id,memo_id,version,description,body,reason,actor_json) VALUES ('exact',${m.id},1,${"Instruction " + m.id},${m.body},'Fixture','{}')`,
      );
    }
    const store = compiledMemos(local.db, "exact", {
      issuer: "fixture",
      clientId: "fixture",
    });
    const initial = await store.getTpsReport();
    const input = {
      text: "Add API stability and remove mobile formatting, preserving scope.",
      request_id: crypto.randomUUID(),
      expected_version: initial.version,
      exact_edits: [
        {
          before: "only when the example",
          after: "only when the API is stable and the example",
        },
        {
          before:
            "On mobile, use exactly three short bullets for product comparisons. On desktop only,",
          after: "For product comparisons on desktop only,",
        },
      ],
    };
    const saved = await store.saveMemo(input);
    expect(saved.status).toBe("saved");
    expect(await store.saveMemo(input)).toEqual(saved);
    const report = await store.getTpsReport();
    expect(report.text).toBe(
      [
        sources[0]!.body.replace(
          input.exact_edits[0]!.before,
          input.exact_edits[0]!.after,
        ),
        sources[1]!.body.replace(
          input.exact_edits[1]!.before,
          input.exact_edits[1]!.after,
        ),
        sources[2]!.body,
      ].join("\n\n"),
    );
    const history = await local.pg.query(
      "SELECT * FROM instruction_card_versions WHERE user_id='exact' ORDER BY card_id,version",
    );
    expect(
      (
        await local.pg.query(
          "SELECT version FROM instruction_card_versions WHERE user_id='exact' AND card_id='c'",
        )
      ).rows,
    ).toEqual([{ version: 1 }]);
    expect(
      (
        await local.pg.query(
          "SELECT reserved_micros FROM save_requests WHERE user_id='exact'",
        )
      ).rows,
    ).toEqual([{ reserved_micros: 0 }]);
    await expect(
      store.saveMemo({
        ...input,
        exact_edits: [{ before: "different", after: "input" }],
      }),
    ).rejects.toMatchObject({ code: "request_id_reused" });
    expect(
      (await store.saveMemo({ ...input, request_id: crypto.randomUUID() }))
        .status,
    ).toBe("conflict");
    const send = (edits: { before: string; after: string }[]) =>
      store.saveMemo({
        text: "Apply these exact edits.",
        request_id: crypto.randomUUID(),
        expected_version: report.version,
        exact_edits: edits,
      });
    for (const edits of [
      [{ before: "missing text", after: "replacement" }],
      [{ before: "runnable example", after: "example" }],
      [{ before: "only", after: "a repeated anchor across memos" }],
      [
        { before: "the API is stable", after: "a change" },
        { before: "API is stable", after: "another change" },
      ],
      [
        { before: "α", after: "beta" },
        { before: "missing text", after: "partial failure" },
      ],
      [
        { before: "α", after: "new anchor" },
        { before: "new anchor", after: "cascade" },
      ],
    ])
      expect((await send(edits)).error).toBe("edit_conflict");
    for (const edits of [
      [],
      [{ before: "", after: "new" }],
      [{ before: "\ud83d", after: "broken" }],
      [{ before: "α", after: "\ud83d" }],
    ])
      await expect(send(edits)).rejects.toMatchObject({
        code: "invalid_input",
      });
    expect(
      (await send([{ before: "α", after: "x".repeat(32768) }])).error,
    ).toBe("memo_body_limit");
    expect((await send([{ before: "α", after: "α" }])).status).toBe(
      "unchanged",
    );
    expect(await store.getTpsReport()).toEqual(report);
    expect(
      await local.pg.query(
        "SELECT * FROM instruction_card_versions WHERE user_id='exact' ORDER BY card_id,version",
      ),
    ).toEqual(history);
    expect(
      (
        await local.pg.query(
          "SELECT writes FROM usage_daily WHERE user_id='exact'",
        )
      ).rows,
    ).toEqual([{ writes: 1 }]);
    // Removing a complete body explicitly retires only that memo.
    expect((await send([{ before: sources[2]!.body, after: "" }])).status).toBe(
      "saved",
    );
    expect((await store.getTpsReport()).text).toBe(
      report.text.slice(0, -(sources[2]!.body.length + 2)),
    );
    expect(
      (
        await local.pg.query(
          "SELECT archived FROM instruction_card_versions WHERE user_id='exact' AND card_id='c' ORDER BY version DESC LIMIT 1",
        )
      ).rows,
    ).toEqual([{ archived: true }]);
  } finally {
    await local.dispose();
  }
});

const enableMemoUpdates =
  "UPDATE store_config SET global_spend_policy='alerts_only',foreground_accounting_ready=true,memo_updates_enabled=true";

test("rules are stored byte for byte, one card each, with one charge", async () => {
  const local = await localStore();
  try {
    await local.pg.exec(
      `INSERT INTO users(id) VALUES ('rules'); ${enableMemoUpdates}`,
    );
    const store = compiledMemos(local.db, "rules", {
      issuer: "fixture",
      clientId: "fixture",
    });
    const rules = [
      {
        report: "email" as const,
        text: '  Sign off with "Cheers," only in informal threads.\r\nOtherwise sign off with "Best,".  ',
      },
      {
        report: "cover" as const,
        text: "Never use em dashes.\n\nKeep α and 😀.",
      },
      { report: "doc" as const, text: "\nLead with the decision." },
    ];
    const saved = await store.saveMemo({
      text: "Add three fictional rules.",
      request_id: crypto.randomUUID(),
      expected_version: (await store.getTpsReport()).version,
      rules,
    });
    expect(saved).toMatchObject({
      status: "saved",
      memo_update: { state: "charged", charged: 1 },
    });
    expect(
      (
        await local.pg.query(
          "SELECT report,description,body,version FROM instruction_card_versions WHERE user_id='rules' ORDER BY report",
        )
      ).rows,
    ).toEqual([
      {
        report: "cover",
        description: "Never use em dashes.",
        body: rules[1]!.text,
        version: 1,
      },
      {
        report: "document",
        description: "Lead with the decision.",
        body: rules[2]!.text,
        version: 1,
      },
      {
        report: "email",
        description: 'Sign off with "Cheers," only in informal threads.',
        body: rules[0]!.text,
        version: 1,
      },
    ]);
    const documents = await store.readDocuments();
    expect(documents.cover_rules).toEqual([rules[1]!.text]);
    expect(documents.full).toContain(rules[0]!.text);
    expect(
      (
        await local.pg.query(
          "SELECT writes FROM usage_daily WHERE user_id='rules'",
        )
      ).rows,
    ).toEqual([{ writes: 1 }]);
  } finally {
    await local.dispose();
  }
});

test("an exact duplicate rule is skipped as unchanged without a charge", async () => {
  const local = await localStore();
  try {
    await local.pg.exec(
      `INSERT INTO users(id) VALUES ('dupes'); ${enableMemoUpdates}`,
    );
    const store = compiledMemos(local.db, "dupes", {
      issuer: "fixture",
      clientId: "fixture",
    });
    const rule = { report: "chat" as const, text: "Keep replies short." };
    const first = await store.saveMemo({
      text: "Add a fictional rule.",
      request_id: crypto.randomUUID(),
      // A repeat within one request is skipped too.
      rules: [rule, rule],
      expected_version: (await store.getTpsReport()).version,
    });
    expect(first.status).toBe("saved");
    const report = await store.getTpsReport();
    const history = await local.pg.query(
      "SELECT * FROM instruction_card_versions WHERE user_id='dupes'",
    );
    expect(history.rows).toHaveLength(1);
    const repeat = await store.saveMemo({
      text: "Add it again.",
      request_id: crypto.randomUUID(),
      rules: [rule],
      expected_version: report.version,
    });
    expect(repeat).toMatchObject({
      status: "unchanged",
      version: report.version,
      memo_update: { state: "released", charged: 0 },
    });
    // The same bytes in another report are a different rule.
    expect(
      (
        await store.saveMemo({
          text: "Add it for email.",
          request_id: crypto.randomUUID(),
          rules: [{ ...rule, report: "email" }],
          expected_version: report.version,
        })
      ).status,
    ).toBe("saved");
    expect(
      (
        await local.pg.query(
          "SELECT writes FROM usage_daily WHERE user_id='dupes'",
        )
      ).rows,
    ).toEqual([{ writes: 2 }]);
  } finally {
    await local.dispose();
  }
});

test("a save that would leave two identical rules in one report is refused; re-adding a removed rule saves it", async () => {
  const local = await localStore();
  try {
    await local.pg.exec("INSERT INTO users(id) VALUES ('collide')");
    const store = compiledMemos(local.db, "collide", {
      issuer: "fixture",
      clientId: "fixture",
    });
    const save = async (change: Partial<SaveMemoInput>) =>
      store.saveMemo({
        text: "Fictional change.",
        request_id: crypto.randomUUID(),
        expected_version: (await store.getTpsReport()).version,
        ...change,
      });
    expect(
      (
        await save({
          rules: [
            { report: "chat", text: "Rule one." },
            { report: "chat", text: "Rule two." },
          ],
        })
      ).status,
    ).toBe("saved");
    // A pre-existing identical pair elsewhere never blocks an unrelated save.
    for (const id of ["twin-a", "twin-b"]) {
      await local.db.query(
        sql`INSERT INTO instruction_cards(user_id,id) VALUES ('collide',${id})`,
      );
      await local.db.query(
        sql`INSERT INTO instruction_card_versions(user_id,card_id,version,description,body,report,reason,actor_json)
        VALUES ('collide',${id},1,'Twin','Twin rule.','post','Fixture','{}')`,
      );
    }
    const history = async () =>
      (
        await local.pg.query(
          "SELECT card_id,version,body,archived FROM instruction_card_versions WHERE user_id='collide' ORDER BY card_id,version",
        )
      ).rows;
    const before = await history();
    expect(
      await save({
        exact_edits: [{ before: "Rule two.", after: "Rule one." }],
      }),
    ).toMatchObject({
      status: "failed",
      error: "edit_conflict",
      message: expect.stringContaining("Rule one."),
    });
    expect(await history()).toEqual(before);
    expect(
      (
        await save({
          exact_edits: [{ before: "Rule two.", after: "Rule three." }],
        })
      ).status,
    ).toBe("saved");
    // Removing a rule and adding the same bytes in one save keeps the rule.
    expect(
      (
        await save({
          exact_edits: [{ before: "Rule three.", after: "" }],
          rules: [{ report: "chat", text: "Rule three." }],
        })
      ).status,
    ).toBe("saved");
    expect(
      (await store.readDocuments()).reports.find((r) => r.id === "chat")!.rules,
    ).toEqual(["Rule one.", "Rule three."]);
  } finally {
    await local.dispose();
  }
});

test("malformed rules are refused with a message that says how to fix them", async () => {
  const local = await localStore();
  try {
    await local.pg.exec("INSERT INTO users(id) VALUES ('bad-rules')");
    const store = compiledMemos(local.db, "bad-rules", {
      issuer: "fixture",
      clientId: "fixture",
    });
    const base = {
      text: "Add rules.",
      request_id: crypto.randomUUID(),
      expected_version: (await store.getTpsReport()).version,
    };
    const rule = { report: "chat", text: "Keep it short." };
    for (const rules of [
      Array.from({ length: 21 }, (_, i) => ({ ...rule, text: `Rule ${i}.` })),
      [],
      [{ ...rule, report: "linkedin" }],
      [{ ...rule, text: " \n " }],
    ])
      await expect(
        store.saveMemo({ ...base, rules } as SaveMemoInput),
      ).rejects.toMatchObject({
        code: "invalid_input",
        message:
          "rules takes 1–20 entries, each with a report (one of the five, doc or cover) and non-blank text. Nothing was changed.",
      });
    // Other malformed input names text as the purpose, not as instruction text.
    await expect(
      store.saveMemo({
        ...base,
        request_id: "not-a-uuid",
        rules: [rule],
      } as SaveMemoInput),
    ).rejects.toMatchObject({
      code: "invalid_input",
      message: expect.not.stringContaining("instruction text"),
    });
  } finally {
    await local.dispose();
  }
});

test("a save without a structured field is refused with invalid_input", async () => {
  const local = await localStore();
  try {
    await local.pg.exec("INSERT INTO users(id) VALUES ('prose')");
    const store = compiledMemos(local.db, "prose", {
      issuer: "fixture",
      clientId: "fixture",
    });
    await expect(
      store.saveMemo({
        text: "Always sign off with Best.",
        request_id: crypto.randomUUID(),
        expected_version: (await store.getTpsReport()).version,
      }),
    ).rejects.toMatchObject({
      code: "invalid_input",
      message: "Name the report and send the rule's text in rules.",
    });
    expect((await local.pg.query("SELECT * FROM save_requests")).rows).toEqual(
      [],
    );
  } finally {
    await local.dispose();
  }
});

test("a failing migration changes no table, row or journal entry, empty or populated", async () => {
  const bad = await mkdtemp(join(tmpdir(), "milton-migration-"));
  const pg = new PGlite();
  const failure = "\n--> statement-breakpoint\nSELECT 1/0;\n";
  let populated: PGlite | undefined;
  try {
    await cp(new URL("../drizzle/", import.meta.url), bad, { recursive: true });
    await appendFile(join(bad, "0001_store_invariants.sql"), failure);
    await expect(
      migrate(drizzle(pg), { migrationsFolder: bad }),
    ).rejects.toMatchObject({ cause: { code: "22012" } });
    expect(
      (
        await pg.query(
          "SELECT tablename FROM pg_tables WHERE schemaname='public'",
        )
      ).rows,
    ).toEqual([]);
    expect(
      (
        await pg.query(
          "SELECT count(*)::integer AS n FROM drizzle.__drizzle_migrations",
        )
      ).rows,
    ).toEqual([{ n: 0 }]);
    // Over populated data, the newest migration failing changes nothing; the
    // fixed migration then applies.
    await cp(
      new URL("../drizzle/0001_store_invariants.sql", import.meta.url),
      join(bad, "0001_store_invariants.sql"),
    );
    const { entries } = (await Bun.file(
      join(bad, "meta/_journal.json"),
    ).json()) as { entries: { idx: number; tag: string }[] };
    const newest = entries.at(-1)!;
    populated = await migratedThrough(newest.idx - 1);
    const db = populated;
    await db.exec(`INSERT INTO users(id) VALUES ('kept-a'),('kept-b');
      INSERT INTO identities(provider,subject,user_id) VALUES ('neon','kept-a','kept-a');`);
    const state = async () => {
      const tables: Record<string, unknown> = {};
      for (const table of await publicTables(db))
        tables[table] = (
          await db.query<{ rows: unknown }>(
            `SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]') AS rows FROM ${table} t`,
          )
        ).rows[0]!.rows;
      return {
        tables,
        catalog: await schemaCatalog(db),
        journal: (
          await db.query(
            "SELECT * FROM drizzle.__drizzle_migrations ORDER BY id",
          )
        ).rows,
      };
    };
    const before = await state();
    await appendFile(join(bad, newest.tag + ".sql"), failure);
    await expect(
      migrate(drizzle(db), { migrationsFolder: bad }),
    ).rejects.toMatchObject({ cause: { code: "22012" } });
    expect(await state()).toEqual(before);
    await cp(
      new URL(`../drizzle/${newest.tag}.sql`, import.meta.url),
      join(bad, newest.tag + ".sql"),
    );
    await migrate(drizzle(db), { migrationsFolder: bad });
    expect(
      (
        await db.query(
          "SELECT count(*)::integer AS n FROM drizzle.__drizzle_migrations",
        )
      ).rows,
    ).toEqual([{ n: entries.length }]);
    expect((await db.query("SELECT id FROM users ORDER BY id")).rows).toEqual([
      { id: "kept-a" },
      { id: "kept-b" },
    ]);
  } finally {
    await pg.close();
    await populated?.close();
    await rm(bad, { recursive: true, force: true });
  }
});

test("Postgres accounts per user for immutable contiguous history and plain deletion", async () => {
  const local = await localStore();
  try {
    await local.pg.exec(`INSERT INTO users (id) VALUES ('m_first'),('m_second');
      INSERT INTO memos (user_id,id,name) VALUES ('m_first','same-id','sample'),('m_second','same-id','sample');
      INSERT INTO memo_versions (user_id,memo_id,version,description,body,reason,actor_json)
      VALUES ('m_first','same-id',1,'Sample.','hello','seed','{}'),('m_second','same-id',1,'Sample.','hello','seed','{}');`);
    expect(
      (await local.pg.query("SELECT id,retained_bytes FROM users ORDER BY id"))
        .rows,
    ).toEqual([
      { id: "m_first", retained_bytes: 40 },
      { id: "m_second", retained_bytes: 40 },
    ]);
    await expect(
      local.pg.query("UPDATE memo_versions SET body='changed'"),
    ).rejects.toThrow("memo_version_is_immutable");
    await expect(
      local.pg.query(
        "INSERT INTO memo_versions (user_id,memo_id,version,description,body,reason,actor_json) VALUES ('m_first','same-id',3,'Sample.','hello','seed','{}')",
      ),
    ).rejects.toThrow("memo_version_conflict");
    await expect(
      local.pg.query("UPDATE users SET id='other' WHERE id='m_first'"),
    ).rejects.toThrow("user_id_is_immutable");
    await local.pg.query(
      "DELETE FROM memos WHERE user_id='m_first' AND id='same-id'",
    );
    expect(
      (await local.pg.query("SELECT id,retained_bytes FROM users ORDER BY id"))
        .rows,
    ).toEqual([
      { id: "m_first", retained_bytes: 0 },
      { id: "m_second", retained_bytes: 40 },
    ]);
    await local.pg.query("DELETE FROM users WHERE id='m_second'");
    expect(
      (await local.pg.query("SELECT count(*)::integer AS n FROM memo_versions"))
        .rows,
    ).toEqual([{ n: 0 }]);
  } finally {
    await local.dispose();
  }
}, 30000);

test("Postgres enforces separate UTF-8 field and memo caps and counts recovery bytes", async () => {
  const local = await localStore();
  try {
    await local.pg.exec(
      `UPDATE store_config SET limits_json=limits_json || '{"memos":1}'::jsonb; INSERT INTO users (id) VALUES ('m_caps');`,
    );
    await local.pg.query(
      "INSERT INTO memos (user_id,id,name) VALUES ('m_caps','memo',$1)",
      ["a".repeat(64)],
    );
    const append = (
      version: number,
      description: string,
      body: string,
      reason: string,
      kind = "seed",
    ) =>
      local.pg.query(
        "INSERT INTO memo_versions (user_id,memo_id,version,description,body,reason,actor_json,details_json) VALUES ('m_caps','memo',$1,$2,$3,$4,'{}',$5)",
        [version, description, body, reason, JSON.stringify({ kind })],
      );
    await append(1, "é".repeat(250), "é".repeat(16384), "x".repeat(500));
    // Vibes remains available even when the ordinary memo allowance is full.
    await local.pg.query(
      "INSERT INTO memos (user_id,id,name) VALUES ('m_caps','vibes','vibes')",
    );
    expect(
      (await local.pg.query("SELECT retained_bytes FROM users")).rows,
    ).toEqual([{ retained_bytes: 67570 }]);
    await expect(
      local.pg.query(
        "INSERT INTO memos (user_id,id,name) VALUES ('m_caps','too-long',$1)",
        ["a".repeat(65)],
      ),
    ).rejects.toThrow("memo_name_limit");
    await expect(
      local.pg.query(
        "INSERT INTO memos (user_id,id,name) VALUES ('m_caps','second','second')",
      ),
    ).rejects.toThrow("memo_count_limit");
    await expect(append(2, "é".repeat(250) + "x", "", "")).rejects.toThrow(
      "memo_description_limit",
    );
    await expect(append(2, "ok", "é".repeat(16384) + "x", "")).rejects.toThrow(
      "memo_body_limit",
    );
    await expect(append(2, "ok", "", "x".repeat(501))).rejects.toThrow(
      "memo_reason_limit",
    );
    await local.pg.query(
      `UPDATE store_config SET limits_json=limits_json || '{"history_bytes":33785}'::jsonb`,
    );
    // A legacy append must fit BOTH retained copies, even without details.kind.
    await local.pg.exec(
      `UPDATE store_config SET limits_json=limits_json || '{"history_bytes":67590}'::jsonb`,
    );
    await expect(
      local.pg
        .exec(`INSERT INTO memo_versions(user_id,memo_id,version,description,body,reason,actor_json)
      VALUES ('m_caps','memo',2,'Sample','New','Edit','{}')`),
    ).rejects.toThrow("memo_history_limit");
    await local.pg.exec(
      `UPDATE store_config SET limits_json=limits_json || '{"history_bytes":67570}'::jsonb`,
    );
    await expect(append(2, "ok", "", "")).rejects.toThrow("memo_history_limit");
    expect(
      (await local.pg.query("SELECT count(*)::integer AS n FROM memo_versions"))
        .rows,
    ).toEqual([{ n: 1 }]);
    await expect(append(2, "ok", "", "", "revert")).rejects.toThrow(
      "memo_recovery_invalid",
    );
    const forgedRecovery = await local.pg
      .query(
        `INSERT INTO memo_versions (user_id,memo_id,version,description,body,reason,actor_json,details_json)
      VALUES ('m_caps','memo',2,'ok','arbitrary recovery','','{"kind":"person"}','{"kind":"revert","source_version":1}')`,
      )
      .catch(databaseFailure);
    expect(forgedRecovery).toMatchObject({
      code: "memo_recovery_invalid",
      status: 422,
    });
    await local.pg
      .query(`INSERT INTO memo_versions (user_id,memo_id,version,description,body,archived,reason,actor_json,details_json)
      SELECT user_id,memo_id,2,description,body,archived,'','{"kind":"person"}','{"kind":"revert","source_version":1}' FROM memo_versions WHERE version=1`);
    expect(
      (
        await local.pg.query<{ retained_bytes: number }>(
          "SELECT retained_bytes FROM users",
        )
      ).rows[0]!.retained_bytes,
    ).toBeGreaterThan(33785);
    await local.pg.query("DELETE FROM memo_versions WHERE version=2");
    expect(
      (await local.pg.query("SELECT retained_bytes FROM users")).rows,
    ).toEqual([{ retained_bytes: 67570 }]);
    await local.pg.exec(
      `UPDATE store_config SET limits_json=limits_json || '{"memos":2}'::jsonb`,
    );
    await local.pg.query(
      "INSERT INTO memos (user_id,id,name) VALUES ('m_caps','second','second')",
    );
    await expect(
      local.pg.query(
        "INSERT INTO memos (user_id,id,name) VALUES ('m_caps','third','third')",
      ),
    ).rejects.toThrow("memo_count_limit");
  } finally {
    await local.dispose();
  }
}, 30000);

test("Postgres version conflicts and history-cap import refusals return typed errors", async () => {
  const local = await localStore();
  const userId = "m_00000000-0000-4000-8000-000000000001";
  try {
    await local.db.query(sql`INSERT INTO users (id) VALUES (${userId})`);
    await local.db.query(
      sql`INSERT INTO memos (user_id,id,name) VALUES (${userId},'memo','sample')`,
    );
    await local.db
      .query(sql`INSERT INTO memo_versions (user_id,memo_id,version,description,body,reason,actor_json)
      VALUES (${userId},'memo',1,'Sample.','hello','seed','{}')`);
    const conflict = await local.db
      .query(
        sql`INSERT INTO memo_versions (user_id,memo_id,version,description,body,reason,actor_json)
      VALUES (${userId},'memo',1,'Sample.','changed','edit','{}')`,
      )
      .catch(databaseFailure);
    await local.db.query(
      sql`UPDATE store_config SET limits_json=limits_json || '{"history_bytes":1}'::jsonb`,
    );
    const source = parseImportSource(
      "sample",
      "---\nname: sample\ndescription: An import fixture.\n---\n# Imported\n",
    );
    const history = await importMemos(
      local.db,
      userId,
      [source],
      new Map([[source.name, 1]]),
    ).catch(databaseFailure);
    expect(conflict).toBeInstanceOf(StoreError);
    expect(history).toBeInstanceOf(StoreError);
    expect([conflict, history]).toMatchObject([
      {
        code: "memo_version_conflict",
        message: "The memo version conflicts with the current memo.",
        status: 409,
      },
      {
        code: "memo_history_limit",
        message: "The memo history limit has been reached.",
        status: 422,
      },
    ]);
    expect(
      await local.db.query(
        sql`SELECT version,body FROM memo_versions WHERE user_id=${userId}`,
      ),
    ).toEqual([{ version: 1, body: "hello" }]);
    expect(
      await local.db.query(
        sql`SELECT retained_bytes FROM users WHERE id=${userId}`,
      ),
    ).toEqual([{ retained_bytes: 40 }]);
  } finally {
    await local.dispose();
  }
}, 30000);

test("store ingress bounds streamed bodies before parsing and preserves typed failures", async () => {
  const local = await localStore();
  try {
    const bindings = { ...local.env, MEMOS_SOURCE: "store" };
    const refused = await guardStoreRequest(
      new Request("http://localhost:8787/mcp", {
        method: "POST",
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array(65537));
            controller.close();
          },
        }),
      }),
      bindings,
    );
    expect(refused).toBeInstanceOf(Response);
    if (!(refused instanceof Response))
      throw new Error("Expected body refusal");
    expect(refused.status).toBe(413);
    expect(
      await guardStoreRequest(
        new Request("http://localhost:8787/register", {
          method: "POST",
          body: "{}",
        }),
        bindings,
      ),
    ).toBeInstanceOf(Request);
    const unavailable = {
      ...bindings,
      storeDatabase: new Proxy(local.db, {
        get(target, key) {
          if (key === "query" || key === "transaction")
            return async () => {
              throw new Error("fixture database failure");
            };
          return Reflect.get(target, key);
        },
      }),
    };
    await expect(
      guardStoreRequest(
        new Request("http://localhost:8787/register", {
          method: "POST",
          body: "{}",
        }),
        unavailable,
      ),
    ).rejects.toMatchObject({ code: "store_unavailable", status: 503 });
    await expect(
      resolveIdentityAccount(unavailable, {
        provider: "neon",
        subject: "3004",
      }),
    ).rejects.toMatchObject({ code: "store_unavailable", status: 503 });
  } finally {
    await local.dispose();
  }
}, 30000);

test("identity lookup never admits or seeds an MCP caller", async () => {
  const local = await localStore();
  const identity = { provider: "neon", subject: "lookup-fixture" };
  try {
    await expect(
      resolveIdentityAccount(local.env, identity),
    ).rejects.toMatchObject({ code: "admission_refused", status: 403 });
    await local.db.query(sql`UPDATE store_config SET signup_mode='open'`);
    await expect(
      lookupIdentityAccount(local.env, identity),
    ).rejects.toMatchObject({ code: "account_unavailable", status: 403 });
    expect(
      await local.db.query(sql`SELECT count(*)::integer AS n FROM users`),
    ).toEqual([{ n: 0 }]);
    // Preserve concurrent admission, repeatable seeding, and failed-admission rollback.
    const same = await Promise.all([
      resolveIdentityAccount(local.env, identity),
      resolveIdentityAccount(local.env, identity),
    ]);
    const admitted = same[0]!;
    expect(same[1]!.miltonUserId).toBe(admitted.miltonUserId);
    expect((await lookupIdentityAccount(local.env, identity)).userId).toBe(
      admitted.miltonUserId,
    );
    expect(
      await local.db.query(
        sql`SELECT count(*)::integer AS n FROM memo_versions`,
      ),
    ).toEqual([{ n: 1 }]);
    expect(
      await local.db.query(
        sql`SELECT r.name,v.body,u.templates_revision FROM users u JOIN memos r ON r.user_id=u.id JOIN memo_versions v ON v.user_id=r.user_id AND v.memo_id=r.id WHERE u.id=${admitted.miltonUserId}`,
      ),
    ).toEqual([{ name: "vibes", body: "", templates_revision: 2 }]);
    const concurrent = await Promise.allSettled([
      resolveIdentityAccount(local.env, {
        provider: "neon",
        subject: "second-fixture",
      }),
      resolveIdentityAccount(local.env, {
        provider: "neon",
        subject: "third-fixture",
      }),
    ]);
    expect(concurrent.map((result) => result.status)).toEqual([
      "fulfilled",
      "fulfilled",
    ]);
    await local.db.query(sql`UPDATE store_config SET signup_mode='closed'`);
    expect(
      (await resolveIdentityAccount(local.env, identity)).miltonUserId,
    ).toBe(admitted.miltonUserId);
    expect(
      await local.db.query(
        sql`SELECT count(*)::integer AS n FROM memo_versions`,
      ),
    ).toEqual([{ n: 3 }]);
    await local.db.query(
      sql`UPDATE store_config SET signup_mode='open', limits_json=limits_json || '{"description_bytes":1}'::jsonb`,
    );
    await expect(
      resolveIdentityAccount(local.env, {
        provider: "neon",
        subject: "failed-seed",
      }),
    ).rejects.toMatchObject({ code: "memo_description_limit", status: 422 });
    expect(
      await local.db.query(sql`SELECT count(*)::integer AS n FROM users`),
    ).toEqual([{ n: 3 }]);
    expect(
      await local.db.query(sql`SELECT count(*)::integer AS n FROM identities`),
    ).toEqual([{ n: 3 }]);
    expect(
      await local.db.query(
        sql`SELECT count(*)::integer AS n FROM users u WHERE NOT EXISTS (SELECT 1 FROM identities i WHERE i.user_id=u.id)`,
      ),
    ).toEqual([{ n: 0 }]);
    await local.db.query(
      sql`UPDATE users SET status='deleting' WHERE id=${admitted.miltonUserId}`,
    );
    await expect(
      lookupIdentityAccount(local.env, identity),
    ).rejects.toMatchObject({ code: "account_unavailable", status: 403 });
    await expect(
      resolveIdentityAccount(local.env, identity),
    ).rejects.toMatchObject({ code: "account_unavailable", status: 403 });
    expect(
      await local.db.query(
        sql`SELECT count(*)::integer AS n FROM memo_versions`,
      ),
    ).toEqual([{ n: 3 }]);
  } finally {
    await local.dispose();
  }
}, 30000);

test("closing an account refuses its reads, saves and replays, fences a pending save, and spares other tenants", async () => {
  const local = await localStore();
  let closeDuringSave: (() => Promise<unknown>) | undefined;
  try {
    const [alpha, beta] = await tenantPair(local, async () => {
      await closeDuringSave?.();
    });
    // Tools are built while Alpha is active, so every refusal below comes from
    // the per-call account lock, not from admission.
    const accepted = {
      ...emailRule("- Alpha signs as Ada."),
      request_id: crypto.randomUUID(),
      expected_version: await alpha.version(),
    };
    expect(read(await alpha.tools.create_memo(accepted)).status).toBe("saved");
    const alphaSample = {
      text: "Keep this approved email.",
      request_id: crypto.randomUUID(),
      expected_version: await alpha.version(),
      sample: {
        report: "email" as const,
        new_kind: "follow-up",
        context: "alpha context",
        text: "Alpha sample body.",
      },
    };
    expect(read(await alpha.tools.create_memo(alphaSample)).status).toBe(
      "saved",
    );
    expect(
      read(
        await beta.tools.create_memo({
          ...emailRule("- Beta signs as Bo."),
          request_id: crypto.randomUUID(),
          expected_version: await beta.version(),
        }),
      ).status,
    ).toBe("saved");
    const betaSees = await beta.everything();
    const alphaVersion = await alpha.version();
    const sources = async (userId: string) => [
      await local.db.query(
        sql`SELECT card_id,version,body FROM instruction_card_versions WHERE user_id=${userId} ORDER BY card_id,version`,
      ),
      await local.db.query(
        sql`SELECT id,body,retired_at FROM samples WHERE user_id=${userId} ORDER BY id`,
      ),
      await local.db.query(
        sql`SELECT revision,body FROM tps_reports WHERE user_id=${userId}`,
      ),
      await local.db.query(
        sql`SELECT count(*)::int AS n FROM accepted_changes WHERE user_id=${userId}`,
      ),
    ];
    const alphaBefore = await sources(alpha.id);
    // (f) The claim commits while active; the account closes before the write phase.
    closeDuringSave = () =>
      local.db.query(
        sql`UPDATE users SET status='deleting' WHERE id=${alpha.id}`,
      );
    const raced = {
      ...emailRule("- Applied after closing."),
      request_id: crypto.randomUUID(),
      expected_version: alphaVersion,
    };
    const racedOutcome = read(await alpha.tools.create_memo(raced));
    closeDuringSave = undefined;
    // Either refusal is acceptable; what matters is that nothing was applied.
    expect(racedOutcome.status).toBeUndefined();
    expect(["account_unavailable", "save_outcome_unknown"]).toContain(
      racedOutcome.error,
    );
    expect(await sources(alpha.id)).toEqual(alphaBefore);
    const refusals = async () => {
      for (const result of [
        await alpha.tools.get_cover_sheet(),
        await alpha.tools.get_report({ report_id: "email" }),
        await alpha.tools.list_reports(),
        await alpha.tools.create_memo({
          ...emailRule("- Fresh after closing."),
          request_id: crypto.randomUUID(),
          expected_version: alphaVersion,
        }),
        await alpha.tools.create_memo(accepted),
        await alpha.tools.create_memo(alphaSample),
        await alpha.tools.create_memo(raced),
      ]) {
        expect(result.isError).toBe(true);
        expect(read(result).error).toBe("account_unavailable");
        expect(JSON.stringify(result)).not.toContain("Alpha");
      }
    };
    await refusals();
    expect(await sources(alpha.id)).toEqual(alphaBefore);
    expect(await beta.everything()).toBe(betaSees);
    // Deleting the closing account's row cascades its sources, samples included.
    await local.db.query(sql`DELETE FROM users WHERE id=${alpha.id}`);
    expect(await sources(alpha.id)).toEqual([[], [], [], [{ n: 0 }]]);
    expect(
      await local.db.query(
        sql`SELECT count(*)::int AS n FROM save_requests WHERE user_id=${alpha.id}`,
      ),
    ).toEqual([{ n: 0 }]);
    await refusals();
    expect(await beta.everything()).toBe(betaSees);
    // Beta can still file, even reusing the deleted account's request ID and text.
    expect(
      read(
        await beta.tools.create_memo({
          ...accepted,
          expected_version: await beta.version(),
        }),
      ).status,
    ).toBe("saved");
    const betaAfter = await beta.everything();
    expect(betaAfter).toContain("Beta signs as Bo");
    expect(betaAfter).toContain("Alpha signs as Ada");
  } finally {
    await local.dispose();
  }
}, 30000);

test("unfinished initialization creates only empty TPS at retained-history capacity", async () => {
  const local = await localStore();
  try {
    await local.pg.exec(`
      INSERT INTO users (id) VALUES ('m_unfinished');
      INSERT INTO identities (provider,subject,user_id) VALUES ('neon','unfinished','m_unfinished');
      INSERT INTO memos (user_id,id,name) VALUES ('m_unfinished','ordinary','email-voice');
      INSERT INTO memo_versions (user_id,memo_id,version,description,body,reason,actor_json)
        VALUES ('m_unfinished','ordinary',1,'Keep exact.',E'café\\r\\n','Original reason','{"kind":"assistant","client_id":"fixture"}');
      UPDATE store_config SET limits_json=jsonb_set(limits_json,'{history_bytes}',
        to_jsonb((SELECT retained_bytes FROM users WHERE id='m_unfinished')));
    `);
    const before = await local.db.query(
      sql`SELECT row_to_json(v) AS row FROM memo_versions v WHERE memo_id='ordinary'`,
    );
    const identity = { provider: "neon", subject: "unfinished" };
    expect(
      (await resolveIdentityAccount(local.env, identity)).miltonUserId,
    ).toBe("m_unfinished");
    expect(
      await local.db.query(
        sql`SELECT row_to_json(v) AS row FROM memo_versions v WHERE memo_id='ordinary'`,
      ),
    ).toEqual(before);
    expect(
      await local.db.query(
        sql`SELECT name,version,body,reason,actor_json,details_json FROM memos r JOIN memo_versions v ON v.user_id=r.user_id AND v.memo_id=r.id WHERE r.name='vibes'`,
      ),
    ).toEqual([
      {
        name: "vibes",
        version: 1,
        body: "",
        reason: "Created TPS Report",
        actor_json: '{"kind":"system"}',
        details_json: '{"kind":"create"}',
      },
    ]);
    expect(
      await local.db.query(
        sql`SELECT templates_revision,retained_bytes=(SELECT sum(payload_bytes) FROM memo_versions WHERE user_id=u.id)+(SELECT sum(payload_bytes) FROM instruction_card_versions WHERE user_id=u.id) AS accounted FROM users u WHERE id='m_unfinished'`,
      ),
    ).toEqual([{ templates_revision: 2, accounted: true }]);
    await resolveIdentityAccount(local.env, identity);
    expect(
      await local.db.query(
        sql`SELECT count(*)::integer AS n FROM memo_versions`,
      ),
    ).toEqual([{ n: 2 }]);
    await local.db.query(
      sql`UPDATE users SET templates_revision=0 WHERE id='m_unfinished'`,
    );
    await local.db.query(
      sql`UPDATE store_config SET limits_json=jsonb_set(limits_json,'{history_bytes}','67108864')`,
    );
    await local.db
      .query(sql`INSERT INTO memo_versions (user_id,memo_id,version,description,body,archived,reason,actor_json,details_json)
      SELECT user_id,memo_id,2,description,body,true,'Legacy archive','{}','{}' FROM memo_versions WHERE user_id='m_unfinished' AND memo_id=(SELECT id FROM memos WHERE user_id='m_unfinished' AND name='vibes') AND version=1`);
    await local.db.query(
      sql`UPDATE store_config SET limits_json=jsonb_set(limits_json,'{history_bytes}','1')`,
    );
    const legacy = await local.db.query(
      sql`SELECT row_to_json(v) AS row FROM memo_versions v ORDER BY memo_id,version`,
    );
    await resolveIdentityAccount(local.env, identity);
    expect(
      await local.db.query(
        sql`SELECT row_to_json(v) AS row FROM memo_versions v WHERE version<3 ORDER BY memo_id,version`,
      ),
    ).toEqual(legacy);
    expect(
      await local.db.query(
        sql`SELECT version,body,archived,reason,details_json FROM memo_versions WHERE version=3`,
      ),
    ).toEqual([
      {
        version: 3,
        body: "",
        archived: false,
        reason: "Restored TPS Report",
        details_json: '{"kind":"restore","source_version":2}',
      },
    ]);
    await local.db.query(
      sql`UPDATE users SET templates_revision=0 WHERE id='m_unfinished'`,
    );
    const active = await local.db.query(
      sql`SELECT row_to_json(v) AS row FROM memo_versions v ORDER BY memo_id,version`,
    );
    await resolveIdentityAccount(local.env, identity);
    expect(
      await local.db.query(
        sql`SELECT row_to_json(v) AS row FROM memo_versions v ORDER BY memo_id,version`,
      ),
    ).toEqual(active);
    await local.db.query(
      sql`UPDATE users SET templates_revision=1 WHERE id='m_unfinished'`,
    );
    await resolveIdentityAccount(local.env, identity);
    expect(
      await local.db.query(
        sql`SELECT templates_revision FROM users WHERE id='m_unfinished'`,
      ),
    ).toEqual([{ templates_revision: 1 }]);
  } finally {
    await local.dispose();
  }
}, 30000);

test("one expected-version conflict rolls back every imported memo and byte increment", async () => {
  const local = await localStore();
  try {
    await local.db.query(sql`UPDATE store_config SET signup_mode='open'`);
    const account = await resolveIdentityAccount(local.env, {
      provider: "neon",
      subject: "fixture-import",
    });
    if (!account) throw new Error("Fixture admission failed");
    await importMemos(
      local.db,
      account.miltonUserId,
      [
        parseImportSource(
          "email-voice",
          "---\nname: email-voice\ndescription: Existing ordinary fixture.\n---\n# Existing\n",
        ),
      ],
      new Map([["email-voice", 0]]),
    );
    const sources = ["email-voice", "vibes"].map((name) =>
      parseImportSource(
        name,
        `---\nname: ${name}\ndescription: An atomic import fixture.\n---\n# Imported\n`,
      ),
    );
    const before = await local.db.query(
      sql`SELECT retained_bytes FROM users WHERE id=${account.miltonUserId}`,
    );
    await expect(
      importMemos(
        local.db,
        account.miltonUserId,
        sources,
        new Map([
          ["email-voice", 1],
          ["vibes", 999],
        ]),
      ),
    ).rejects.toThrow("expected version conflicts");
    expect(
      await local.db.query(
        sql`SELECT max(version) AS n FROM memo_versions WHERE user_id=${account.miltonUserId}`,
      ),
    ).toEqual([{ n: 1 }]);
    expect(
      await local.db.query(
        sql`SELECT retained_bytes FROM users WHERE id=${account.miltonUserId}`,
      ),
    ).toEqual(before);
  } finally {
    await local.dispose();
  }
}, 30000);

test("import verifies exact bytes, conflicts on retry and permits recreation after deletion", async () => {
  const local = await localStore();
  try {
    await local.db.query(sql`UPDATE store_config SET signup_mode='open'`);
    const account = await resolveIdentityAccount(local.env, {
      provider: "neon",
      subject: "opaque-better-auth-user",
    });
    await importMemos(
      local.db,
      account.miltonUserId,
      [
        parseImportSource(
          "email-voice",
          "---\nname: email-voice\ndescription: Existing ordinary fixture.\n---\n# Existing\n",
        ),
      ],
      new Map([["email-voice", 0]]),
    );
    const source = parseImportSource(
      "email-voice",
      "---\r\nname: email-voice\r\ndescription: An imported fixture.\r\n---\r\n# Fixture\r\n\r\nKeep café exact.\r\n",
    );
    const created = parseImportSource(
      "new-fixture",
      "---\nname: new-fixture\ndescription: A new fixture.\n---\n# New\n",
    );
    await expect(
      importMemos(local.db, account.miltonUserId, [source], new Map()),
    ).rejects.toThrow("expected version");
    const expected = new Map([
      [source.name, 1],
      [created.name, 0],
    ]);
    const first = await importMemos(
      local.db,
      account.miltonUserId,
      [source, created],
      expected,
    );
    expect(first.map((row) => [row.name, row.version])).toEqual([
      ["email-voice", 2],
      ["new-fixture", 1],
    ]);
    await expect(
      importMemos(local.db, account.miltonUserId, [source, created], expected),
    ).rejects.toThrow("conflicts");
    await expect(
      importMemos(
        local.db,
        account.miltonUserId,
        [created],
        new Map([[created.name, 0]]),
      ),
    ).rejects.toThrow("conflicts");
    expect(() =>
      verifyImportedSource(source, {
        ...source,
        description: "Wrong stored description.",
      }),
    ).toThrow("fields");
    await local.db.query(
      sql`DELETE FROM memos WHERE user_id=${account.miltonUserId} AND name=${created.name}`,
    );
    expect(
      (
        await importMemos(local.db, account.miltonUserId, [created], new Map())
      ).map((row) => row.version),
    ).toEqual([1]);
    expect(
      (
        await loadImportSources(new URL("./fixtures/memos/", import.meta.url))
      ).map((row) => row.name),
    ).toEqual(["sample"]);
  } finally {
    await local.dispose();
  }
}, 30000);

test("instruction cards edit independently inside a memo, keep write-once grouping, and fence stale changes", async () => {
  const local = await localStore();
  try {
    await local.pg.exec(`INSERT INTO users(id) VALUES ('cards');
      INSERT INTO memos(user_id,id,name) VALUES ('cards','a','writing'),('cards','b','actions');
      INSERT INTO memo_versions(user_id,memo_id,version,description,body,reason,actor_json) VALUES
      ('cards','a',1,'Writing','When comparing products, include units.','Fixture','{}'),
      ('cards','b',1,'Actions','Ask before sending.','Fixture','{}');`);
    const store = compiledMemos(local.db, "cards", {
      issuer: "fixture",
      clientId: "assistant",
    });
    const before = await store.getTpsReport();
    const versions = (
      await local.pg.query(
        "SELECT * FROM instruction_card_versions ORDER BY card_id,version",
      )
    ).rows;
    // Membership and position are write-once, so the source fingerprint fences TPS.
    await expect(
      local.pg.query(
        "UPDATE memo_cards SET memo_id='a',version=2 WHERE user_id='cards' AND card_id='b'",
      ),
    ).rejects.toThrow("card_group_conflict");
    await expect(
      local.pg.query(
        "UPDATE instruction_cards SET position=position+10 WHERE user_id='cards'",
      ),
    ).rejects.toThrow("card_identity_is_immutable");
    expect(await store.getTpsReport()).toEqual(before);
    expect(
      (
        await local.pg.query(
          "SELECT * FROM instruction_card_versions ORDER BY card_id,version",
        )
      ).rows,
    ).toEqual(versions);
    const request = {
      request_id: crypto.randomUUID(),
      expected_version: before.version,
      text: "Require approval before sending.",
      exact_edits: [
        {
          before: "Ask before sending.",
          after: "Get approval before sending.",
        },
      ],
    };
    const saved = await store.saveMemo(request);
    expect(saved.status).toBe("saved");
    expect(await store.saveMemo(request)).toEqual(saved);
    expect((await store.getTpsReport()).text).toBe(
      "When comparing products, include units.\n\nGet approval before sending.",
    );
    expect(
      (
        await local.pg.query(
          "SELECT card_id,version,body FROM instruction_card_versions WHERE card_id='a'",
        )
      ).rows,
    ).toEqual([
      {
        card_id: "a",
        version: 1,
        body: "When comparing products, include units.",
      },
    ]);
    expect(
      (
        await local.pg.query(
          "SELECT card_id,version FROM instruction_card_versions WHERE card_id='b' ORDER BY version",
        )
      ).rows,
    ).toEqual([
      { card_id: "b", version: 1 },
      { card_id: "b", version: 2 },
    ]);
    expect(
      (await store.saveMemo({ ...request, request_id: crypto.randomUUID() }))
        .status,
    ).toBe("conflict");
    await expect(
      local.pg.exec(
        "UPDATE instruction_card_versions SET body='Changed' WHERE card_id='a'",
      ),
    ).rejects.toThrow("card_version_is_immutable");
    await expect(
      local.pg.exec(
        "DELETE FROM instruction_card_versions WHERE card_id='b' AND version=2",
      ),
    ).rejects.toThrow("card_version_is_immutable");
    await expect(
      local.pg.exec("DELETE FROM memos WHERE user_id='cards' AND id='b'"),
    ).rejects.toThrow("card_legacy_conflict");
    const next = await store.saveMemo({
      text: "Add a document rule.",
      rules: [
        {
          report: "document",
          text: "Use full model names in product comparisons.",
        },
      ],
      expected_version: (await store.getTpsReport()).version,
      request_id: crypto.randomUUID(),
    });
    expect(next.status).toBe("saved");
    // New cards carry their report; legacy group membership is untouched history.
    expect((await cardHeads(local.db, "cards")).map((h) => h.report)).toEqual([
      "cover",
      "cover",
      "document",
    ]);
    expect(
      (
        await local.pg.query(
          "SELECT memo_id FROM memo_cards WHERE user_id='cards' ORDER BY memo_id",
        )
      ).rows,
    ).toEqual([{ memo_id: "a" }, { memo_id: "b" }]);
    await expect(
      local.pg.query(
        "UPDATE instruction_card_versions SET report='email' WHERE user_id='cards' AND report='document'",
      ),
    ).rejects.toThrow("card_version_is_immutable");
    expect(
      (
        await local.pg.query(
          "SELECT count(*)::int AS n FROM instruction_card_versions WHERE card_id='a'",
        )
      ).rows,
    ).toEqual([{ n: 1 }]);
  } finally {
    await local.dispose();
  }
});

test("reports print a heading, when line, samples newest first and rules; samples replace per kind; card text cannot add headings", async () => {
  const local = await localStore();
  try {
    await local.pg.exec(`INSERT INTO users(id) VALUES ('reports');
      INSERT INTO memos(user_id,id,name) VALUES ('reports','w','working');
      INSERT INTO memo_versions(user_id,memo_id,version,description,body,reason,actor_json) VALUES
      ('reports','w',1,'One','- No em dashes.','Fixture','{}');`);
    const store = compiledMemos(local.db, "reports", {
      issuer: "fixture",
      clientId: "assistant",
    });
    const save = async (extra: object) =>
      store.saveMemo({
        text: "Fictional change.",
        request_id: crypto.randomUUID(),
        expected_version: (await store.getTpsReport()).version,
        ...extra,
      } as SaveMemoInput);
    const create = (text: string, report: string) => ({
      rules: [{ text, report }],
    });
    // Legacy cards are cover-sheet rules; the cover sheet is the whole text.
    expect((await store.getTpsReport()).text).toBe("- No em dashes.");
    expect(await save(create("# Email\n\n- Two.", "email"))).toMatchObject({
      status: "failed",
      error: "card_heading",
    });
    expect(
      await save({
        exact_edits: [{ before: "- No em dashes.", after: "## Nested\n- No." }],
      }),
    ).toMatchObject({ status: "failed", error: "card_heading" });
    await expect(save(create("- Two.", "nowhere"))).rejects.toMatchObject({
      code: "invalid_input",
    });
    expect((await save(create("- Keep it short.", "email"))).status).toBe(
      "saved",
    );
    expect((await save(create("- Oxford comma.", "cover"))).status).toBe(
      "saved",
    );
    expect((await store.getTpsReport()).text).toBe(
      "- No em dashes.\n\n- Oxford comma.\n\n# Email\n\nApplies when drafting an email I'll send, warm or cold.\n\n- Keep it short.",
    );
    // Samples: stored exactly, quoted, newest first, no model call or reservation.
    // Reuse a kind once it exists, as an assistant reading get_report would.
    const sample = async (kind: string, text: string, report = "email") => {
      const known = (await store.readDocuments()).reports
        .find((r) => r.id === (report === "doc" ? "document" : report))!
        .samples.find((s) => s.kind === kind);
      return save({
        sample: {
          report,
          ...(known ? { kind_id: known.kind_id } : { new_kind: kind }),
          context: `${kind} context`,
          text,
        },
      });
    };
    expect((await sample("follow-up", "Hi [name],\n\nThanks!")).status).toBe(
      "saved",
    );
    expect((await sample("follow-up", "Second follow-up")).status).toBe(
      "saved",
    );
    expect((await sample("cold intro", "Cold one", "doc")).status).toBe(
      "saved",
    );
    const documents = await store.readDocuments();
    const email = documents.reports.find((r) => r.id === "email")!;
    expect(email.samples.map((s) => s.body)).toEqual([
      "Second follow-up",
      "Hi [name],\n\nThanks!",
    ]);
    expect(email.body).toBe(
      `# Email\n\nApplies when drafting an email I'll send, warm or cold.\n\nApproved, follow-up context, ${email.samples[0]!.date}:\n> Second follow-up\n\nApproved, follow-up context, ${email.samples[1]!.date}:\n> Hi [name],\n>\n> Thanks!\n\n- Keep it short.`,
    );
    expect(
      documents.reports.find((r) => r.id === "document")!.samples,
    ).toHaveLength(1);
    expect(documents.cover).toBe("- No em dashes.\n\n- Oxford comma.");
    expect(documents.is_empty).toBe(false);
    // A third sample of one kind retires the oldest; retirement is the only change.
    // A saved sample is a user-directed filing, so it charges one memo update.
    await local.pg.exec(
      "UPDATE store_config SET global_spend_policy='alerts_only',foreground_accounting_ready=true,memo_updates_enabled=true",
    );
    expect(await sample("follow-up", "Third follow-up")).toMatchObject({
      status: "saved",
      memo_update: { state: "charged", charged: 1 },
    });
    expect(
      (
        await local.pg.query(
          "SELECT body,retired_at IS NULL AS live FROM samples WHERE user_id='reports' AND kind_id IN (SELECT id FROM sample_kinds WHERE label='follow-up') ORDER BY created_at,id",
        )
      ).rows,
    ).toEqual([
      { body: "Hi [name],\n\nThanks!", live: false },
      { body: "Second follow-up", live: true },
      { body: "Third follow-up", live: true },
    ]);
    await expect(
      local.pg.query(
        "UPDATE samples SET body='Edited' WHERE user_id='reports' AND body='Third follow-up'",
      ),
    ).rejects.toThrow("sample_is_append_only");
    await expect(
      local.pg.query("DELETE FROM samples WHERE user_id='reports'"),
    ).rejects.toThrow("sample_is_append_only");
    // Every sample save is a fenced, receipted write with no model reservation.
    expect(
      (
        await local.pg.query(
          "SELECT count(*)::int AS n FROM accepted_changes WHERE user_id='reports' AND transformation_json->>'pipeline'='exact:v1' AND request_json ? 'sample'",
        )
      ).rows,
    ).toEqual([{ n: 4 }]);
    expect((await store.getTpsReport()).is_empty).toBe(false);
  } finally {
    await local.dispose();
  }
});

// One account with a cover rule and an email rule.
async function filingFixture(userId: string) {
  const local = await localStore();
  await local.pg.exec(`INSERT INTO users(id) VALUES ('${userId}')`);
  const store = compiledMemos(local.db, userId, {
    issuer: "fixture",
    clientId: "assistant",
  });
  const save = async (extra: object) =>
    store.saveMemo({
      text: "Fictional change.",
      request_id: crypto.randomUUID(),
      expected_version: (await store.getTpsReport()).version,
      ...extra,
    } as SaveMemoInput);
  await save({
    rules: [
      { report: "cover", text: "- Cover rule." },
      { report: "email", text: "- Email rule." },
    ],
  });
  const heads = () => cardHeads(local.db, userId);
  const [cover, email] = await heads();
  const report = async (id: string) =>
    (await store.readDocuments()).reports.find((r) => r.id === id)!;
  return {
    local,
    store,
    save,
    heads,
    report,
    cover: cover!,
    email: email!,
  };
}

test("exact moves keep a card's identity and bytes, add one version and change the fence", async () => {
  const f = await filingFixture("moves");
  try {
    const before = await f.heads();
    const version = (await f.store.getTpsReport()).version;
    expect(
      await f.save({ moves: [{ before: "Email rule", report: "cover" }] }),
    ).toMatchObject({ status: "saved" });
    const after = await f.heads();
    expect(after.map((h) => h.id)).toEqual(before.map((h) => h.id));
    expect(after[1]).toMatchObject({
      id: f.email.id,
      version: 2,
      body: "- Email rule.",
      description: "- Email rule.",
      report: "cover",
    });
    expect(cardFingerprint(after)).not.toBe(cardFingerprint(before));
    expect((await f.store.getTpsReport()).version).not.toBe(version);
    const documents = await f.store.readDocuments();
    expect(documents.cover).toBe("- Cover rule.\n\n- Email rule.");
    expect((await f.report("email")).is_empty).toBe(true);
    // Cover sheet to a report; a move to where the rule already is changes nothing.
    await f.save({ moves: [{ before: "Cover rule", report: "chat" }] });
    expect((await f.report("chat")).rules).toEqual(["- Cover rule."]);
    expect(
      await f.save({ moves: [{ before: "Cover rule", report: "chat" }] }),
    ).toMatchObject({ status: "unchanged" });
    // A rule this save empties cannot also move.
    expect(
      await f.save({
        exact_edits: [{ before: "- Cover rule.", after: "" }],
        moves: [{ before: "Cover rule", report: "email" }],
      }),
    ).toMatchObject({ status: "failed", error: "move_conflict" });
    expect(
      (
        await f.local.pg.query(
          "SELECT card_id,version,report,details_json::jsonb->>'kind' AS kind FROM instruction_card_versions WHERE user_id='moves' ORDER BY card_id,version",
        )
      ).rows,
    ).toEqual(
      [
        { card_id: f.cover.id, version: 1, report: "cover", kind: "create" },
        { card_id: f.cover.id, version: 2, report: "chat", kind: "move" },
        { card_id: f.email.id, version: 1, report: "email", kind: "create" },
        { card_id: f.email.id, version: 2, report: "cover", kind: "move" },
      ].sort((a, b) => a.card_id.localeCompare(b.card_id)),
    );
  } finally {
    await f.local.dispose();
  }
});

test("an exact edit and a move of one rule land in one version", async () => {
  const f = await filingFixture("edit-moves");
  try {
    expect(
      await f.save({
        exact_edits: [
          { before: "- Email rule.", after: "- Email rule, edited." },
        ],
        moves: [{ before: "Email rule", report: "document" }],
      }),
    ).toMatchObject({ status: "saved" });
    expect((await f.heads())[1]).toMatchObject({
      id: f.email.id,
      version: 2,
      body: "- Email rule, edited.",
      report: "document",
    });
    expect((await f.report("document")).rules).toEqual([
      "- Email rule, edited.",
    ]);
  } finally {
    await f.local.dispose();
  }
});

test("a reused kind_id shares one eviction group; evictions are reported and replay identically", async () => {
  const f = await filingFixture("kinds-evict");
  try {
    const sample = (text: string, kind: object) => ({
      sample: { report: "email", context: "after a call", text, ...kind },
    });
    await f.save(sample("One", { new_kind: "Follow-up" }));
    const kind = (await f.report("email")).samples[0]!;
    expect(kind.kind).toBe("Follow-up");
    await expect(
      f.save(sample("Both", { kind_id: kind.kind_id, new_kind: "Follow-up" })),
    ).rejects.toMatchObject({
      code: "invalid_input",
      message:
        "A sample needs kind_id or new_kind, not both. Nothing was changed.",
    });
    expect(
      await f.save({
        sample: {
          report: "chat",
          kind_id: kind.kind_id,
          context: "after a call",
          text: "Wrong report",
        },
      }),
    ).toMatchObject({ status: "failed", error: "sample_conflict" });
    await f.save(sample("Two", { kind_id: kind.kind_id }));
    const input = {
      text: "Fictional change.",
      request_id: crypto.randomUUID(),
      expected_version: (await f.store.getTpsReport()).version,
      ...sample("Three", { kind_id: kind.kind_id }),
    } as SaveMemoInput;
    const saved = await f.store.saveMemo(input);
    expect(saved).toMatchObject({
      status: "saved",
      samples_retired: [{ id: kind.id, reason: "evicted" }],
    });
    expect(await f.store.saveMemo(input)).toEqual(saved);
    expect((await f.report("email")).samples.map((s) => s.body)).toEqual([
      "Three",
      "Two",
    ]);
  } finally {
    await f.local.dispose();
  }
});

test("replaces retires the named sample as replaced and records lineage", async () => {
  const f = await filingFixture("kinds-replace");
  try {
    await f.save({
      sample: {
        report: "post",
        new_kind: "launch post",
        context: "first launch",
        text: "Old",
      },
    });
    const old = (await f.report("post")).samples[0]!;
    // Reads carry each sample's id and kind, without its body.
    expect(
      reportEnvelope(await f.store.readDocuments(), "post").samples,
    ).toEqual([
      {
        id: old.id,
        kind_id: old.kind_id,
        kind: "launch post",
        context: "first launch",
        date: old.date,
      },
    ]);
    const replace = {
      sample: {
        report: "post",
        kind_id: old.kind_id,
        replaces: old.id,
        context: "second launch",
        text: "New",
      },
    };
    expect(await f.save(replace)).toMatchObject({
      status: "saved",
      samples_retired: [{ id: old.id, reason: "replaced" }],
    });
    expect(
      (
        await f.local.pg.query(
          "SELECT body,replaces_id,retire_reason,retired_request_id IS NOT NULL AS receipted FROM samples WHERE user_id='kinds-replace' ORDER BY created_at",
        )
      ).rows,
    ).toEqual([
      {
        body: "Old",
        replaces_id: null,
        retire_reason: "replaced",
        receipted: true,
      },
      {
        body: "New",
        replaces_id: old.id,
        retire_reason: null,
        receipted: false,
      },
    ]);
    expect(await f.save(replace)).toMatchObject({
      status: "failed",
      error: "sample_conflict",
    });
  } finally {
    await f.local.dispose();
  }
});

test("retire_samples removes a sample and reports it", async () => {
  const f = await filingFixture("kinds-remove");
  try {
    await f.save({
      sample: {
        report: "speech",
        new_kind: "toast",
        context: "a fictional toast",
        text: "Cheers",
      },
    });
    const { id } = (await f.report("speech")).samples[0]!;
    expect(await f.save({ retire_samples: [id] })).toMatchObject({
      status: "saved",
      samples_retired: [{ id, reason: "removed" }],
    });
    expect((await f.report("speech")).is_empty).toBe(true);
    // A refused save carries its code and the client-facing reason.
    expect(await f.save({ retire_samples: [id] })).toMatchObject({
      status: "failed",
      error: "sample_conflict",
      message:
        "Each sample to retire must be an active sample, listed once. Nothing was changed.",
    });
  } finally {
    await f.local.dispose();
  }
});

test("a new_kind naming a kind whose samples were all retired reuses that kind", async () => {
  const f = await filingFixture("kinds-revive");
  try {
    const toast = (new_kind: string, text: string) => ({
      sample: {
        report: "speech",
        new_kind,
        context: "a fictional toast",
        text,
      },
    });
    await f.save(toast("toast", "Cheers"));
    const first = (await f.report("speech")).samples[0]!;
    await f.save({ retire_samples: [first.id] });
    expect((await f.report("speech")).samples).toEqual([]);
    expect(await f.save(toast("Toast", "Cheers again"))).toMatchObject({
      status: "saved",
    });
    expect((await f.report("speech")).samples).toMatchObject([
      { kind_id: first.kind_id, kind: "toast", body: "Cheers again" },
    ]);
  } finally {
    await f.local.dispose();
  }
});

test("a sample and exact edits in one save apply together or not at all", async () => {
  const f = await filingFixture("kinds-mixed");
  try {
    const edit = {
      exact_edits: [{ before: "Cover rule.", after: "Cover rule, kept." }],
    };
    const sample = {
      report: "document",
      context: "weekly update",
      text: "Fictional update.",
    };
    expect(
      await f.save({ ...edit, sample: { ...sample, kind_id: "missing" } }),
    ).toMatchObject({ status: "failed", error: "sample_conflict" });
    expect((await f.store.readDocuments()).cover).toBe("- Cover rule.");
    expect(
      await f.save({ ...edit, sample: { ...sample, new_kind: "update" } }),
    ).toMatchObject({ status: "saved" });
    const documents = await f.store.readDocuments();
    expect(documents.cover).toBe("- Cover rule, kept.");
    expect(
      documents.reports.find((r) => r.id === "document")!.samples,
    ).toHaveLength(1);
    expect(
      (
        await f.local.pg.query(
          "SELECT sum(reserved_micros)::int AS n FROM save_requests WHERE user_id='kinds-mixed'",
        )
      ).rows,
    ).toEqual([{ n: 0 }]);
  } finally {
    await f.local.dispose();
  }
});

test("filing-kinds migration files every version and gives samples kinds; rollback restores the previous shape", async () => {
  const pg = await migratedThrough(19);
  try {
    await pg.exec(`INSERT INTO users(id) VALUES ('kinds');
      INSERT INTO instruction_cards(user_id,id,report) VALUES ('kinds','c1',NULL),('kinds','c2','email');
      INSERT INTO instruction_card_versions(user_id,card_id,version,description,body,reason,actor_json) VALUES
      ('kinds','c1',1,'One','- Cover rule.','Fixture','{}'),('kinds','c2',1,'Two','- Email rule.','Fixture','{}'),
      ('kinds','c2',2,'Two','- Email rule, edited.','Fixture','{}');
      INSERT INTO samples(user_id,id,report,kind,context,body,client_json,created_at,retired_at) VALUES
      ('kinds','s1','email','Follow-up','after a call','One','{}','2026-01-01',now()),
      ('kinds','s2','email','follow-up','after a call','Two','{}','2026-01-02',NULL),
      ('kinds','s3','chat','follow-up','after a call','Three','{}','2026-01-03',NULL);`);
    const up = await Bun.file(
      new URL("../drizzle/0020_filing_kinds.sql", import.meta.url),
    ).text();
    const down = await Bun.file(
      new URL("../drizzle/rollback/0020_filing_kinds.sql", import.meta.url),
    ).text();
    const forward = async () => {
      await pg.exec("BEGIN;" + up + "COMMIT;");
      expect(
        (
          await pg.query(
            "SELECT card_id,version,report FROM instruction_card_versions ORDER BY card_id,version",
          )
        ).rows,
      ).toEqual([
        { card_id: "c1", version: 1, report: "cover" },
        { card_id: "c2", version: 1, report: "email" },
        { card_id: "c2", version: 2, report: "email" },
      ]);
      expect(
        (
          await pg.query(
            "SELECT s.id,s.report,k.label,s.retire_reason,s.retired_request_id FROM samples s JOIN sample_kinds k ON k.user_id=s.user_id AND k.id=s.kind_id ORDER BY s.id",
          )
        ).rows,
      ).toEqual([
        {
          id: "s1",
          report: "email",
          label: "Follow-up",
          retire_reason: "evicted",
          retired_request_id: null,
        },
        {
          id: "s2",
          report: "email",
          label: "Follow-up",
          retire_reason: null,
          retired_request_id: null,
        },
        {
          id: "s3",
          report: "chat",
          label: "follow-up",
          retire_reason: null,
          retired_request_id: null,
        },
      ]);
    };
    await forward();
    await expect(
      pg.query("UPDATE sample_kinds SET label='Other'"),
    ).rejects.toThrow("sample_kind_is_immutable");
    await pg.exec(down);
    expect(
      (await pg.query("SELECT id,report FROM instruction_cards ORDER BY id"))
        .rows,
    ).toEqual([
      { id: "c1", report: null },
      { id: "c2", report: "email" },
    ]);
    expect(
      (await pg.query("SELECT id,kind FROM samples ORDER BY id")).rows,
    ).toEqual([
      { id: "s1", kind: "Follow-up" },
      { id: "s2", kind: "Follow-up" },
      { id: "s3", kind: "follow-up" },
    ]);
    await forward();
  } finally {
    await pg.close();
  }
}, 30000);

test("0018 removes derived systems without changing retained data, refuses a live lease, and rolls back to the empty pre-0018 shape", async () => {
  // Rehearse 0018 as the newest migration; later migrations are out of scope.
  const folder = await migrationsThrough(18);
  const pg = await migratedThrough(17);
  const derived = [
    "card_embeddings",
    "card_graphs",
    "card_links",
    "card_retrieval_embeddings",
    "gardening_jobs",
    "retrieval_enrollments",
  ];
  const derivedColumns = [
    "derivation_account_budget_micros",
    "derivation_global_budget_micros",
    "derivation_budget_revision",
    "derivation_cursor",
  ];
  const rows = async (statement: string) =>
    (await pg.query<Record<string, unknown>>(statement)).rows;
  // Full row dumps of every retained table. store_config loses only the four
  // derivation columns; users.retained_bytes is checked on its own.
  const retained = async () => {
    const dump: Record<string, unknown> = {};
    for (const table of (await publicTables(pg)).filter(
      (t) => !derived.includes(t),
    )) {
      const strip =
        table === "store_config"
          ? derivedColumns.map((c) => ` - '${c}'`).join("")
          : table === "users"
            ? " - 'retained_bytes'"
            : "";
      dump[table] = (
        await rows(
          `SELECT coalesce(jsonb_agg(r ORDER BY r::text),'[]') AS rows FROM (SELECT to_jsonb(t)${strip} AS r FROM ${table} t) x`,
        )
      )[0]!.rows;
    }
    return dump;
  };
  const bytes = async () =>
    Object.fromEntries(
      (
        await pg.query<{ id: string; retained_bytes: number }>(
          "SELECT id,retained_bytes::bigint::float8 AS retained_bytes FROM users ORDER BY id",
        )
      ).rows.map((row) => [row.id, row.retained_bytes]),
    );
  const catalog = () => schemaCatalog(pg);
  try {
    // Populate every derived table and both frozen ledgers at journal 17.
    const unit = `('[1' || repeat(',0',767) || ']')::vector`;
    await pg.exec(`INSERT INTO users(id) VALUES ('derived-a'),('derived-b');
      INSERT INTO memos(user_id,id,name) VALUES ('derived-a','a','writing'),('derived-a','b','narrative'),('derived-b','a','other');
      INSERT INTO memo_versions(user_id,memo_id,version,description,body,reason,actor_json) VALUES
      ('derived-a','a',1,'Review format','In code reviews, use bullets.','Fixture','{}'),
      ('derived-a','b',1,'Narrative format','Use prose for narrative reviews.','Fixture','{}'),
      ('derived-b','a',1,'Other account','Never send without approval.','Fixture','{}');
      INSERT INTO tps_reports(user_id,revision,body,source_hash) VALUES
      ('derived-a',1,'In code reviews, use bullets.',repeat('c',64)),('derived-b',1,'Never send without approval.',repeat('d',64));
      INSERT INTO samples(user_id,id,report,kind,context,body,client_json) VALUES ('derived-a','s1','email','follow-up','after a call','Hi there','{}');
      INSERT INTO save_requests(user_id,request_id,input_hash,source_hash,reserved_micros,deadline,completed,result_json) VALUES
      ('derived-a','00000000-0000-4000-8000-000000000001',repeat('a',64),repeat('c',64),100,now(),true,'{"status":"saved"}'),
      ('derived-a','00000000-0000-4000-8000-000000000002',repeat('b',64),repeat('c',64),100,now(),true,'{"status":"saved"}');
      UPDATE store_config SET derivation_account_budget_micros=100,derivation_global_budget_micros=1000,derivation_budget_revision=1,derivation_cursor=1;
      INSERT INTO card_embeddings(user_id,card_id,version,model,body_hash,embedding,status,attempt_id,lease_until) VALUES
      ('derived-a','a',1,'fixture-embedding',repeat('e',64),${unit},'ready','00000000-0000-4000-8000-0000000000e1',now()),
      ('derived-b','a',1,'fixture-embedding',repeat('e',64),NULL,'failed','00000000-0000-4000-8000-0000000000e2',now());
      INSERT INTO retrieval_enrollments(user_id,baseline) VALUES ('derived-a','[{"id":"a","version":1}]');
      INSERT INTO card_retrieval_embeddings(user_id,card_id,version,model,body_hash,embedding,status,attempt_id,lease_until) VALUES
      ('derived-a','a',1,'fixture-embedding',repeat('e',64),${unit},'ready','00000000-0000-4000-8000-0000000000e3',now());
      INSERT INTO card_graphs(user_id,source_hash,model,status,attempt_id,lease_until,finished_at) VALUES
      ('derived-a',repeat('c',64),'fixture-graph','ready','00000000-0000-4000-8000-0000000000e4',now(),now());
      INSERT INTO card_links(user_id,from_id,from_version,to_id,to_version,source_hash,kind,from_quote,to_quote,reason) VALUES
      ('derived-a','b',1,'a',1,repeat('c',64),'possible_exception','narrative reviews','code reviews','Fictional advisory link.');
      INSERT INTO derivation_usage(user_id,day_utc,reserved_micros) VALUES ('derived-a','2026-11-01',110);
      INSERT INTO gardening_usage(user_id,day_utc,reserved_micros) VALUES ('derived-a','2026-11-01',90);`);
    const before = await bytes();
    // A pending job carries reserved bytes on the account.
    await pg.exec(`INSERT INTO gardening_jobs(user_id,request_id,payload_json,report_revision,source_hash)
      VALUES ('derived-a','00000000-0000-4000-8000-000000000001','{"request":{"text":"Keep context."},"before":[],"after":[{"id":"a","version":1}]}',1,repeat('c',64))`);
    const [job] = await rows(
      "SELECT payload_bytes::float8 AS n FROM gardening_jobs",
    );
    const jobBytes = job!.n as number;
    expect(jobBytes).toBeGreaterThan(0);
    expect((await bytes())["derived-a"]).toBe(before["derived-a"]! + jobBytes);
    for (const table of derived)
      expect(
        (await rows(`SELECT count(*)::int AS n FROM ${table}`))[0]!.n,
      ).toBeGreaterThan(0);
    // A live lease refuses the whole migration; nothing changes.
    await pg.exec(`INSERT INTO gardening_jobs(user_id,request_id,payload_json,report_revision,source_hash)
      VALUES ('derived-a','00000000-0000-4000-8000-000000000002','{"request":{"text":"Leased."},"before":[],"after":[]}',1,repeat('c',64));
      UPDATE gardening_jobs SET status='running',attempt_id='00000000-0000-4000-8000-0000000000f1',attempted_at=now(),lease_until=now()+interval '5 minutes',reserved_micros=10
      WHERE request_id='00000000-0000-4000-8000-000000000002';`);
    const leased = await retained();
    const leasedCatalog = await catalog();
    const leasedBytes = await bytes();
    await expect(
      migrate(drizzle(pg), { migrationsFolder: folder }),
    ).rejects.toMatchObject({
      cause: { message: "remove_derived_requires_no_live_gardening_lease" },
    });
    expect(await retained()).toEqual(leased);
    expect(await catalog()).toEqual(leasedCatalog);
    expect(await bytes()).toEqual(leasedBytes);
    expect(
      (
        await rows(
          "SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations",
        )
      )[0]!.n,
    ).toBe(18);
    // Clear the leased job; its delete returns its bytes.
    await pg.exec(
      "DELETE FROM gardening_jobs WHERE request_id='00000000-0000-4000-8000-000000000002'",
    );
    expect((await bytes())["derived-a"]).toBe(before["derived-a"]! + jobBytes);
    // A live derivation lease refuses it too; nothing changes.
    await pg.exec(
      "UPDATE card_embeddings SET status='running',lease_until=now()+interval '5 minutes' WHERE user_id='derived-b'",
    );
    const derivationLeased = await retained();
    const derivationLeasedBytes = await bytes();
    await expect(
      migrate(drizzle(pg), { migrationsFolder: folder }),
    ).rejects.toMatchObject({
      cause: { message: "remove_derived_requires_no_live_derivation_lease" },
    });
    expect(await retained()).toEqual(derivationLeased);
    expect(await catalog()).toEqual(leasedCatalog);
    expect(await bytes()).toEqual(derivationLeasedBytes);
    expect(
      (
        await rows(
          "SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations",
        )
      )[0]!.n,
    ).toBe(18);
    await pg.exec(
      "UPDATE card_embeddings SET status='failed',lease_until=now() WHERE user_id='derived-b'",
    );
    const kept = await retained();
    const preCatalog = await catalog();
    const preBytes = await bytes();
    const ledgers = await rows(
      "SELECT 'derivation' AS ledger,user_id,day_utc::text,reserved_micros::int FROM derivation_usage UNION ALL SELECT 'gardening',user_id,day_utc::text,reserved_micros::int FROM gardening_usage ORDER BY 1",
    );
    expect(ledgers).toHaveLength(2);

    await migrate(drizzle(pg), { migrationsFolder: folder });
    expect(await retained()).toEqual(kept);
    expect(await bytes()).toEqual({
      ...preBytes,
      "derived-a": preBytes["derived-a"]! - jobBytes,
    });
    expect((await bytes())["derived-a"]).toBe(before["derived-a"]!);
    expect(
      await rows(
        "SELECT 'derivation' AS ledger,user_id,day_utc::text,reserved_micros::int FROM derivation_usage UNION ALL SELECT 'gardening',user_id,day_utc::text,reserved_micros::int FROM gardening_usage ORDER BY 1",
      ),
    ).toEqual(ledgers);
    const postCatalog = await catalog();
    expect(postCatalog.tables).toEqual([
      "accepted_changes",
      "derivation_usage",
      "foreground_usage",
      "gardening_usage",
      "identities",
      "instruction_card_versions",
      "instruction_cards",
      "memo_cards",
      "memo_versions",
      "memos",
      "samples",
      "save_requests",
      "spend_alert_emails",
      "spend_alerts",
      "store_config",
      "tps_reports",
      "trial_accounts",
      "usage_daily",
      "users",
    ]);
    expect(postCatalog.extensions).toEqual([]);
    expect(postCatalog.functions.map((f) => f.proname as string)).not.toContain(
      "milton_gardening_guard",
    );
    expect(postCatalog.functions.map((f) => f.proname as string)).not.toContain(
      "milton_card_link_guard",
    );
    expect(
      postCatalog.columns.filter(
        (c) =>
          derivedColumns.includes(c.column_name as string) ||
          derived.includes(c.table_name as string),
      ),
    ).toEqual([]);
    expect(
      postCatalog.constraints.filter(
        (c) =>
          derived.includes(c.tbl as string) ||
          (c.conname as string).startsWith("config_derivation"),
      ),
    ).toEqual([]);

    // The rollback restores the pre-0018 shape, empty.
    const down = await Bun.file(
      new URL("../drizzle/rollback/0018_remove_derived.sql", import.meta.url),
    ).text();
    await pg.exec(down);
    expect(await catalog()).toEqual(preCatalog);
    expect(await retained()).toEqual(kept);
    for (const table of derived)
      expect(await rows(`SELECT * FROM ${table}`)).toEqual([]);
    // A 0017-era statement set runs against it.
    expect(
      await rows(
        `SELECT ${derivedColumns.join(",")} FROM store_config WHERE singleton=1`,
      ),
    ).toEqual([
      {
        derivation_account_budget_micros: null,
        derivation_global_budget_micros: null,
        derivation_budget_revision: 0,
        derivation_cursor: 0,
      },
    ]);
    const restoredBytes = await bytes();
    await pg.exec(`INSERT INTO gardening_jobs(user_id,request_id,payload_json,report_revision,source_hash)
      VALUES ('derived-a','00000000-0000-4000-8000-000000000001','{"request":{"text":"Again."},"before":[],"after":[]}',1,repeat('c',64));
      INSERT INTO retrieval_enrollments(user_id,baseline) VALUES ('derived-a','[]');
      INSERT INTO card_retrieval_embeddings(user_id,card_id,version,model,body_hash,embedding,status,attempt_id,lease_until) VALUES
      ('derived-a','a',1,'fixture-embedding',repeat('e',64),${unit},'ready','00000000-0000-4000-8000-0000000000e5',now());
      UPDATE store_config SET derivation_account_budget_micros=100,derivation_global_budget_micros=1000,derivation_budget_revision=1;`);
    const [again] = await rows(
      "SELECT payload_bytes::float8 AS n FROM gardening_jobs",
    );
    expect((await bytes())["derived-a"]).toBe(
      restoredBytes["derived-a"]! + (again!.n as number),
    );
    await expect(
      pg.exec("UPDATE gardening_jobs SET payload_json='{}'"),
    ).rejects.toThrow("gardening_job_is_immutable");
    await expect(
      pg.exec(
        `INSERT INTO card_links(user_id,from_id,from_version,to_id,to_version,source_hash,kind,from_quote,to_quote,reason) VALUES
        ('derived-a','b',1,'a',1,repeat('c',64),'possible_exception','narrative reviews','code reviews','No graph.')`,
      ),
    ).rejects.toThrow("card_link_invalid");
    // Forward again over the restored shape returns the post-0018 catalog.
    await pg.exec(
      "BEGIN;\n" + (await drizzleSql("0018_remove_derived.sql")) + "\nCOMMIT;",
    );
    expect(await catalog()).toEqual(postCatalog);
    expect(await bytes()).toEqual(restoredBytes);
  } finally {
    await pg.close();
  }
}, 30000);

test("0019 rollback refuses while disconnects or deleted identities exist and restores the pre-0019 shape when empty", async () => {
  const base = await migratedThrough(18);
  const pg = await migratedThrough(19);
  try {
    const down = await Bun.file(
      new URL(
        "../drizzle/rollback/0019_assistant_disconnects.sql",
        import.meta.url,
      ),
    ).text();
    const refused = async (seed: string, code: string) => {
      await pg.exec(seed);
      await expect(pg.exec(down)).rejects.toThrow(code);
      await pg.exec("ROLLBACK");
      expect(await publicTables(pg)).toContain("assistant_disconnects");
    };
    await pg.exec("INSERT INTO users(id) VALUES ('rollback-a')");
    await refused(
      "INSERT INTO assistant_disconnects(provider,subject,client_id) VALUES ('neon','fixture','client-a')",
      "assistant_disconnects_rollback_requires_no_disconnects",
    );
    await pg.exec("DELETE FROM assistant_disconnects");
    await refused(
      `INSERT INTO deleted_identities(identity_hash) VALUES (repeat('a',64))`,
      "deleted_identities_rollback_requires_no_deleted_identities",
    );
    await pg.exec("DELETE FROM deleted_identities");
    await pg.exec(down);
    expect(await schemaCatalog(pg)).toEqual(await schemaCatalog(base));
    expect((await pg.query("SELECT id FROM users")).rows).toEqual([
      { id: "rollback-a" },
    ]);
  } finally {
    await pg.close();
    await base.close();
  }
});

test("accepted change evidence replays once and rolls back with an over-quota save", async () => {
  const local = await localStore();
  try {
    await local.pg.exec("INSERT INTO users(id) VALUES ('provenance')");
    const store = compiledMemos(local.db, "provenance", {
      issuer: "fixture",
      clientId: "assistant",
    });
    const input = {
      text: "Keep examples short.\r\nOnly examples.",
      rules: [{ report: "cover" as const, text: "Keep examples short." }],
      request_id: crypto.randomUUID(),
      expected_version: (await store.getTpsReport()).version,
    };
    expect((await store.saveMemo(input)).status).toBe("saved");
    const first = (
      await local.pg.query<{
        request_json: unknown;
        affected_json: { id: string; before: number | null; after: number }[];
        after_tps: string;
      }>("SELECT * FROM accepted_changes")
    ).rows[0]!;
    // The stated purpose is recorded beside the rules and never compiled.
    expect(first.request_json).toEqual({
      text: input.text,
      rules: input.rules,
    });
    expect(first.affected_json).toHaveLength(1);
    expect(first.affected_json[0]!.before).toBeNull();
    expect(first.affected_json[0]!.after).toBe(1);
    expect(first.after_tps).toBe((await store.getTpsReport()).version);
    await store.saveMemo(input);
    expect(
      (await local.pg.query("SELECT * FROM accepted_changes")).rows,
    ).toHaveLength(1);
    const edit = {
      text: "Use brief instead.",
      exact_edits: [{ before: "short", after: "brief" }],
      expected_version: first.after_tps,
      request_id: crypto.randomUUID(),
    };
    expect((await store.saveMemo(edit)).status).toBe("saved");
    const second = (
      await local.pg.query<{
        request_json: unknown;
        affected_json: unknown;
        transformation_json: { pipeline: string };
      }>("SELECT * FROM accepted_changes WHERE request_id=$1", [
        edit.request_id,
      ])
    ).rows[0]!;
    expect(second.request_json).toEqual({
      text: edit.text,
      exact_edits: edit.exact_edits,
    });
    expect(second.affected_json).toEqual([
      { id: first.affected_json[0]!.id, before: 1, after: 2 },
    ]);
    expect(second.transformation_json.pipeline).toBe("exact:v1");
    expect(
      (await local.pg.query("SELECT * FROM accepted_changes")).rows,
    ).toHaveLength(2);
    await expect(
      local.pg.exec("UPDATE accepted_changes SET operation='other'"),
    ).rejects.toThrow();
    await expect(
      local.pg.exec("DELETE FROM accepted_changes"),
    ).rejects.toThrow();
    const before = await store.getTpsReport();
    // Enough room for the source version and receipt, but not the larger request evidence.
    await local.pg.exec(
      "UPDATE store_config SET limits_json=jsonb_set(limits_json,'{history_bytes}',to_jsonb((SELECT retained_bytes+5000 FROM users WHERE id='provenance')))",
    );
    const refused = await store.saveMemo({
      text: "purpose ".repeat(2000),
      exact_edits: [{ before: "brief", after: "concise" }],
      request_id: crypto.randomUUID(),
      expected_version: before.version,
    });
    expect(refused).toMatchObject({
      status: "failed",
      error: "memo_history_limit",
    });
    expect(await store.getTpsReport()).toEqual(before);
    expect(
      (await local.pg.query("SELECT * FROM accepted_changes")).rows,
    ).toHaveLength(2);
    expect(
      (await local.pg.query("SELECT * FROM instruction_card_versions")).rows,
    ).toHaveLength(2);
  } finally {
    await local.dispose();
  }
});

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
    ).rejects.toMatchObject({ code: "memo_updates_exhausted" });
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
    ).toBe("committed request");
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

test("account deletion removes every tenant row, keeps global spend and refusals, stops in-flight saves, and allows no second trial", async () => {
  const local = await localStore();
  try {
    await local.pg.exec(
      "UPDATE store_config SET signup_mode='open',trials_enabled=true,global_spend_policy='alerts_only',foreground_accounting_ready=true,memo_updates_enabled=true",
    );
    const neon = (subject: string) => ({ provider: "neon", subject });
    let hold: { entered: () => void; gate: Promise<void> } | undefined;
    const storeDatabase = betweenPhases(local.db, async () => {
      if (hold) {
        hold.entered();
        await hold.gate;
      }
    });
    const open = async (subject: string) => {
      await resolveIdentityAccount(local.env, neon(subject));
      const auth = await lookupIdentityAccount(local.env, neon(subject));
      const store = await storeForCurrentRequest({ storeDatabase }, auth, {
        issuer: "fixture",
        clientId: "client-c",
      });
      const save = async (extra: Record<string, unknown> = {}) =>
        store.saveMemo({
          text: "Fictional rule, with its exception.",
          rules: [
            { report: "cover", text: "Fictional rule, with its exception." },
          ],
          request_id: crypto.randomUUID(),
          expected_version: (await store.readTpsReport()).version,
          ...extra,
        });
      return { auth, store, save };
    };
    const gone = await open("leaving");
    const kept = await open("staying");
    const legacy = await gone.store.createMemo({
      name: "legacy",
      description: "Fictional",
      text: "A legacy rule.",
    });
    await gone.store.updateMemo({
      name: "legacy",
      text: "A legacy rule, revised.",
      reason: "Fixture",
      expected_version: legacy.version,
    });
    expect((await gone.save()).status).toBe("saved");
    // A kind, a sample replaced by another (lineage) and an active pair.
    const goneSamples = () =>
      local.db.query<{ id: string; kind_id: string }>(
        sql`SELECT id,kind_id FROM samples WHERE user_id=${gone.auth.userId} ORDER BY created_at,id`,
      );
    for (const text of ["One", "Two", "Three"]) {
      const prior = await goneSamples();
      expect(
        (
          await gone.save({
            sample: {
              report: "email",
              ...(prior.length
                ? { kind_id: prior[0]!.kind_id }
                : { new_kind: "follow-up" }),
              ...(text === "Three" ? { replaces: prior[1]!.id } : {}),
              context: "Fixture context",
              text,
            },
          })
        ).status,
      ).toBe("saved");
    }
    await gone.store.chargeToolCall();
    expect((await kept.save()).status).toBe("saved");
    // A save that claimed before deletion and has not reached its write phase.
    let release!: () => void;
    let entered!: () => void;
    const compiling = new Promise<void>((resolve) => (entered = resolve));
    hold = {
      entered,
      gate: new Promise<void>((resolve) => (release = resolve)),
    };
    const inflight = gone.save({
      rules: [{ report: "cover", text: "An in-flight fictional rule." }],
    });
    await compiling;
    hold = undefined;
    const tenantTables = (
      await local.db.query<{ table_name: string }>(
        sql`SELECT DISTINCT c.table_name FROM information_schema.columns c
        JOIN information_schema.tables t ON t.table_schema=c.table_schema AND t.table_name=c.table_name
        WHERE c.table_schema='public' AND c.column_name='user_id' AND t.table_type='BASE TABLE'
        AND c.table_name NOT IN ('gardening_usage','derivation_usage') ORDER BY 1`,
      )
    ).map((row) => row.table_name);
    const counts = async (userId: string) =>
      Object.fromEntries(
        await Promise.all(
          tenantTables.map(async (table) => [
            table,
            (
              await local.pg.query<{ n: number }>(
                `SELECT count(*)::integer AS n FROM "${table}" WHERE user_id=$1`,
                [userId],
              )
            ).rows[0]!.n,
          ]),
        ),
      ) as Record<string, number>;
    const populated = await counts(gone.auth.userId);
    for (const table of [
      "identities",
      "trial_accounts",
      "memos",
      "memo_versions",
      "instruction_cards",
      "instruction_card_versions",
      "memo_cards",
      "samples",
      "sample_kinds",
      "accepted_changes",
      "save_requests",
      "tps_reports",
      "usage_daily",
    ])
      expect(populated[table]).toBeGreaterThan(0);
    expect(
      (
        await local.db.query(
          sql`SELECT 1 FROM samples WHERE user_id=${gone.auth.userId} AND retired_at IS NOT NULL`,
        )
      ).length,
    ).toBe(1);
    expect(
      (
        await local.db.query(
          sql`SELECT 1 FROM save_requests WHERE user_id=${gone.auth.userId} AND NOT completed AND memo_update_state='held'`,
        )
      ).length,
    ).toBe(1);
    const keptBefore = await counts(kept.auth.userId);
    const spend = () =>
      local.pg.query(
        "SELECT day_utc::text,reserved_micros::text FROM foreground_usage ORDER BY day_utc",
      );
    // Saves reserve nothing now; a retained aggregate row must survive deletion.
    await local.pg.exec(
      "INSERT INTO foreground_usage(day_utc,reserved_micros) VALUES ((clock_timestamp() AT TIME ZONE 'UTC')::date,1000) ON CONFLICT(day_utc) DO NOTHING",
    );
    const spendBefore = (await spend()).rows;
    expect(spendBefore.length).toBeGreaterThan(0);

    await deleteAccount(local.env, neon("leaving"), ["client-c", "client-d"]);
    release();
    // Its apply step finds no active account, so nothing is written (the
    // counts below); the existing save path reports the outcome as unknown.
    await expect(inflight).rejects.toMatchObject({
      code: "save_outcome_unknown",
    });
    expect(Object.values(await counts(gone.auth.userId))).toEqual(
      tenantTables.map(() => 0),
    );
    expect(
      (
        await local.db.query(
          sql`SELECT 1 FROM users WHERE id=${gone.auth.userId}`,
        )
      ).length,
    ).toBe(0);
    expect(await counts(kept.auth.userId)).toEqual(keptBefore);
    expect((await kept.store.readTpsReport()).is_empty).toBe(false);
    expect((await spend()).rows).toEqual(spendBefore);
    expect(
      (
        await local.pg.query(
          "SELECT client_id FROM assistant_disconnects WHERE provider='neon' AND subject='leaving' ORDER BY 1",
        )
      ).rows,
    ).toEqual([{ client_id: "client-c" }, { client_id: "client-d" }]);
    const fingerprint = createHash("sha256")
      .update("neon:leaving")
      .digest("hex");
    expect(
      (await local.pg.query("SELECT identity_hash FROM deleted_identities"))
        .rows,
    ).toEqual([{ identity_hash: fingerprint }]);
    // An identity with no active account changes nothing.
    await expect(
      deleteAccount(local.env, neon("leaving"), ["client-e"]),
    ).rejects.toMatchObject({ code: "account_unavailable" });
    expect(
      (await local.pg.query("SELECT 1 FROM assistant_disconnects")).rows,
    ).toHaveLength(2);
    // Re-signup: a fresh, empty account whose trial has already ended, so
    // assistant reads pause; a never-deleted identity still gets a trial.
    await resolveIdentityAccount(local.env, neon("leaving"));
    const again = await lookupIdentityAccount(local.env, neon("leaving"));
    expect(again.userId).not.toBe(gone.auth.userId);
    const fresh = await personStoreForCurrentRequest(local.env, again);
    expect((await fresh.readTpsReport()).is_empty).toBe(true);
    expect((await fresh.trialStatus()).status).toBe("expired");
    const againTools = createStoreMemoTools(
      await storeForCurrentRequest(local.env, again, {
        issuer: "fixture",
        clientId: "client-new",
      }),
    );
    expect(
      JSON.parse((await againTools.get_cover_sheet()).content[0].text).error,
    ).toBe("subscription_required");
    expect(
      (
        await (
          await personStoreForCurrentRequest(local.env, kept.auth)
        ).trialStatus()
      ).status,
    ).toBe("trial");
    await resolveIdentityAccount(local.env, neon("newcomer"));
    const newcomer = await lookupIdentityAccount(local.env, neon("newcomer"));
    expect(
      (
        await (
          await personStoreForCurrentRequest(local.env, newcomer)
        ).trialStatus()
      ).status,
    ).toBe("trial");
    // Re-signup while trials are off: no effect until trials are enabled.
    await deleteAccount(local.env, neon("leaving"), []);
    await local.pg.exec("UPDATE store_config SET trials_enabled=false");
    await resolveIdentityAccount(local.env, neon("leaving"));
    const third = await personStoreForCurrentRequest(
      local.env,
      await lookupIdentityAccount(local.env, neon("leaving")),
    );
    expect((await third.trialStatus()).status).toBe("early_access");
    await local.pg.exec("UPDATE store_config SET trials_enabled=true");
    expect((await third.trialStatus()).status).toBe("expired");
  } finally {
    await local.dispose();
  }
}, 30000);
