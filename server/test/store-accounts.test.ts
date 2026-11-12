import { expect, jest, spyOn, test } from "bun:test";
import { sql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { localStore } from "./local-store";
import { appStorage } from "./auth-fixtures";
import {
  eraseAccount,
  insideTransactions,
  memoSave,
  read,
  seedLegacy,
  storeForCurrentRequest,
  vendorIntent,
} from "./store-fixtures";
import { createStoreMemoTools } from "../src/mcp-tools";
import { createHash } from "node:crypto";
import { backgroundSettled, type StoreDatabase } from "../src/store/database";
import {
  resolveIdentityAccount,
  lookupIdentityAccount,
  personStoreForCurrentRequest,
  connectionKeyAccount,
  connectionKeysForAccount,
  EXPIRED_KEY_HISTORY,
  parseConnectionKey,
} from "../src/store";

test("trial transition preserves saves and TPS while notices and access follow the Stripe subscription state", async () => {
  const local = await localStore();
  try {
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
      sql`UPDATE trial_accounts SET subscription_status='canceled' WHERE user_id=${neverSaved.userId}`,
    );
    const idleTools = createStoreMemoTools(
      await storeForCurrentRequest(local.env, neverSaved, {
        issuer: "fixture",
        clientId: "idle",
      }),
    );
    expect(
      JSON.parse(
        (await idleTools.get_report({ intent: vendorIntent })).content[0].text,
      ).error,
    ).toBe("subscription_required");
    await expect(
      (await personStoreForCurrentRequest(local.env, neverSaved)).read(),
    ).resolves.toMatchObject({ memos: [] });
    const store = await storeForCurrentRequest(
      { appOrigin: "http://localhost:3001", storeDatabase: local.db },
      auth,
      { issuer: "fixture", clientId: "one" },
    );
    const person = await personStoreForCurrentRequest(local.env, auth);
    const tools = createStoreMemoTools(store);
    const result = (r: Awaited<ReturnType<typeof tools.get_report>>) =>
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
    // What Stripe's answer writes once the subscription exists.
    await local.db.query(
      sql`UPDATE trial_accounts SET subscription_status='trialing',trial_end=clock_timestamp()+interval '30 days' WHERE user_id=${auth.userId}`,
    );
    const empty = result(await tools.get_report({ intent: vendorIntent }));
    expect(empty.notice).toBeUndefined();
    expect(
      result(await tools.create_memo(memoSave({ kind_id: "missing-kind" })))
        .status,
    ).toBe("failed");
    expect((await account()).started_at).toEqual(start);
    const input = memoSave();
    const saved = result(await tools.create_memo(input));
    expect(saved.status).toBe("saved");
    // Every resend of it replays the stored outcome, labelled as one.
    const replay = { ...saved, replayed: expect.any(String) };
    expect((await account()).started_at).toEqual(start);
    expect(result(await tools.create_memo(input))).toEqual(replay);
    expect((await account()).started_at).toEqual(start);
    expect(
      result(
        await tools.create_memo({ ...input, request_id: crypto.randomUUID() }),
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
    ).toEqual(replay);
    const slowNotice = {
      code: "trial_ending_7_days",
      trial_ends_at: new Date(0).toISOString(),
      message: "Fixture notice",
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
      ).toEqual({ ...replay, notice: slowNotice });
    } finally {
      fakeSleep.mockRestore();
      fakeAbort.mockRestore();
      jest.useRealTimers();
    }
    const trialEnd = String(
      (
        await local.db.query(
          sql`SELECT trial_end FROM trial_accounts WHERE user_id=${auth.userId}`,
        )
      )[0]!.trial_end,
    );
    expect((await person.trialStatus()).trial_ends_at).toBe(
      new Date(trialEnd).toISOString(),
    );
    const tps = await person.read();
    // The AI's report and the person's TPS page count the same one memo.
    const sheet = { memos: tps.memos.length };
    expect(sheet.memos).toBe(1);
    expect(
      result(await tools.get_report({ intent: vendorIntent })),
    ).toMatchObject(sheet);
    // Move only fixture dates; Stripe's answer is the real writer of trial_end.
    await local.db.query(
      sql`UPDATE trial_accounts SET trial_end=clock_timestamp()+interval '6 days' WHERE user_id=${auth.userId}`,
    );
    const otherTools = createStoreMemoTools(
      await storeForCurrentRequest(local.env, auth, {
        issuer: "fixture",
        clientId: "two",
      }),
    );
    const reads = await Promise.all([
      tools.create_memo(input),
      otherTools.get_report({ intent: vendorIntent }),
    ]);
    expect(reads.map(result).filter((r) => r.notice).length).toBe(1);
    expect(reads.map(result).find((r) => r.notice).notice.code).toBe(
      "trial_ending_7_days",
    );
    expect(await person.read()).toEqual(tps);
    expect(
      result(await tools.get_report({ intent: vendorIntent })).notice,
    ).toBeUndefined();
    await local.db.query(
      sql`UPDATE trial_accounts SET trial_end=clock_timestamp()+interval '23 hours' WHERE user_id=${auth.userId}`,
    );
    expect(
      result(await tools.get_report({ intent: vendorIntent })).notice.code,
    ).toBe("trial_ending_1_day");
    expect(
      result(await tools.get_report({ intent: vendorIntent })).notice,
    ).toBeUndefined();
    // The subscription ends after the tools were built: the save's gate,
    // under the account lock, refuses it before any write or receipt.
    await local.db.query(
      sql`UPDATE trial_accounts SET subscription_status='canceled' WHERE user_id=${auth.userId}`,
    );
    const receipts = async () =>
      (
        await local.db.query(
          sql`SELECT count(*)::int AS n FROM save_requests WHERE user_id=${auth.userId}`,
        )
      )[0]!.n;
    const receiptsBefore = await receipts();
    const racingSave = result(
      await tools.create_memo(memoSave({ final: "Expires before saving." })),
    );
    expect(racingSave.status).toBeUndefined();
    expect(racingSave).toMatchObject({
      error: "subscription_required",
      retryable: false,
    });
    // The one link is in the message, the signed-in app home.
    expect(racingSave).not.toHaveProperty("subscription_url");
    expect(racingSave.message).toEndWith("Subscribe at http://localhost:3001/");
    expect(await person.read()).toEqual(tps);
    const denied = await tools.get_report({ intent: vendorIntent });
    expect(denied.isError).toBe(true);
    expect(result(denied)).toMatchObject({
      error: "subscription_required",
      retryable: false,
    });
    expect(result(denied).text).toBeUndefined();
    expect(result(denied).message).toBe(racingSave.message);
    expect(
      result(
        await tools.create_memo({ ...input, request_id: crypto.randomUUID() }),
      ).error,
    ).toBe("subscription_required");
    expect(await receipts()).toBe(receiptsBefore);
    // An accepted write's receipt stays recoverable even after access expires.
    expect(result(await tools.create_memo(input))).toEqual(replay);
    expect(await person.read()).toEqual(tps);
    const expiredStart = (await account()).started_at;
    // A paid_through ahead no longer opens the gate; only the status does.
    await local.db.query(
      sql`UPDATE trial_accounts SET paid_through=clock_timestamp()+interval '30 days' WHERE user_id=${auth.userId}`,
    );
    expect((await person.trialStatus()).status).toBe("expired");
    // This is a trusted-provider projection fixture, not a client subscription action.
    await local.db.query(
      sql`UPDATE trial_accounts SET subscription_status='active' WHERE user_id=${auth.userId}`,
    );
    expect((await person.trialStatus()).status).toBe("paid");
    expect(
      result(await tools.get_report({ intent: vendorIntent })),
    ).toMatchObject(sheet);
    expect((await account()).started_at).toEqual(expiredStart);
    await local.db.query(
      sql`UPDATE trial_accounts SET subscription_status='canceled' WHERE user_id=${auth.userId}`,
    );
    await local.pg.exec("UPDATE store_config SET trials_enabled=false");
    expect(
      result(await tools.get_report({ intent: vendorIntent })),
    ).toMatchObject(sheet);
    await local.pg.exec("UPDATE store_config SET trials_enabled=true");
    const earlyStore = await storeForCurrentRequest(local.env, early, {
      issuer: "fixture",
      clientId: "one",
    });
    expect(
      result(
        await createStoreMemoTools(earlyStore).get_report({
          intent: vendorIntent,
        }),
      ),
    ).toMatchObject({ is_empty: true, memos: 0, setup: expect.any(String) });
    expect(
      (
        await local.db.query(
          sql`SELECT count(*)::int AS n FROM memos WHERE user_id=${auth.userId}`,
        )
      )[0]!.n,
    ).toBe(1);
    expect(await person.read()).toEqual(tps);
  } finally {
    await local.dispose();
  }
});

// Two signed-up accounts behind the real tool layer.
async function tenantPair(local: Awaited<ReturnType<typeof localStore>>) {
  const tenant = async (subject: string) => {
    const identity = { provider: "neon", subject };
    await resolveIdentityAccount(local.env, identity);
    const auth = await lookupIdentityAccount(local.env, identity);
    const tools = createStoreMemoTools(
      await storeForCurrentRequest(local.env, auth, {
        issuer: "fixture",
        clientId: subject,
      }),
    );
    // Everything this tenant's AI can read, as one string.
    const everything = async () =>
      JSON.stringify(read(await tools.get_report({ intent: vendorIntent })));
    return { id: auth.userId, tools, everything };
  };
  return [
    await tenant("isolation-alpha"),
    await tenant("isolation-beta"),
  ] as const;
}

// A draft the person steered, with a new kind; its tweaks come from code.
const steered = (who: string) =>
  memoSave({
    final: `${who} memo body.`,
    first_draft: `${who} first draft, with a warm-up opener.`,
    mode: "draft",
    new_kind: "follow-up",
    context: {
      summary: `${who} context`,
      medium: "email",
      audience: "a vendor",
      purpose: "decline",
    },
  });

test("tenants with overlapping memo, kind and request IDs never read, change or replay each other", async () => {
  const local = await localStore();
  try {
    const [alpha, beta] = await tenantPair(local);
    const alphaMemo = steered("Alpha");
    const alphaMemoSaved = read(await alpha.tools.create_memo(alphaMemo));
    expect(alphaMemoSaved.status).toBe("saved");
    const memoId: string = alphaMemoSaved.memo.memo_id;
    const kindId: string = alphaMemoSaved.memo.kind_id;
    // Beta holds a memo and a kind under Alpha's exact IDs.
    await local.db.query(
      sql`INSERT INTO memo_kinds(user_id,id,label) VALUES (${beta.id},${kindId},'follow-up')`,
    );
    await local.db
      .query(sql`INSERT INTO memos(user_id,id,kind_id,medium,summary,mode,first_draft,first_draft_state,final,tier,client_json,request_id)
      VALUES (${beta.id},${memoId},${kindId},'email','Beta context','draft','Beta first draft.','kept','Beta memo body.','steered','{}',${crypto.randomUUID()})`);
    // (c) The report shows only the caller's own memos, kinds and changes,
    // and counts only the caller's memos.
    const alphaOwn = ["Alpha memo body", "Alpha context", "warm-up opener"];
    const betaOwn = ["Beta memo body", "Beta context"];
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
    expect(JSON.parse(betaSees).memos).toBe(1);
    // (a) Alpha's request ID with Beta's own input saves fresh for Beta, and
    // Alpha's kind ID names Beta's own kind.
    const betaMemo = {
      ...memoSave({
        final: "Beta reuse body.",
        first_draft: "Beta reuse draft.",
        mode: "draft",
        kind_id: kindId,
        context: {
          summary: "Beta reuse",
          medium: "email",
          audience: "a vendor",
          purpose: "decline",
        },
      }),
      request_id: alphaMemo.request_id,
    };
    const betaMemoSaved = read(await beta.tools.create_memo(betaMemo));
    expect(betaMemoSaved).toMatchObject({
      status: "saved",
      memo: { kind_id: kindId },
    });
    // (a) Alpha's exact request from Beta meets Beta's own receipt for that
    // request ID, never Alpha's.
    const copied = read(await beta.tools.create_memo(alphaMemo));
    expect(copied.error).toBe("request_id_reused");
    expect(JSON.stringify(copied)).not.toContain("Alpha");
    // Each tenant's replay returns its own receipt; crossing inputs is reuse.
    expect(read(await alpha.tools.create_memo(alphaMemo))).toEqual({
      ...alphaMemoSaved,
      replayed: expect.any(String),
    });
    expect(read(await beta.tools.create_memo(betaMemo))).toEqual({
      ...betaMemoSaved,
      replayed: expect.any(String),
    });
    expect(
      await local.db.query(
        sql`SELECT count(DISTINCT user_id)::int AS n FROM save_requests WHERE request_id=${alphaMemo.request_id}`,
      ),
    ).toEqual([{ n: 2 }]);
    // (b) Beta's correction and forgetting under Alpha's memo ID change only
    // Beta's memo.
    const context = (userId: string) =>
      local.db.query(
        sql`SELECT summary,medium FROM memos WHERE user_id=${userId} AND id=${memoId}`,
      );
    expect(
      read(
        await beta.tools.create_memo({
          request_id: crypto.randomUUID(),
          memo_context: {
            memo_id: memoId,
            context: { summary: "Beta corrected", medium: "chat" },
          },
        }),
      ).status,
    ).toBe("saved");
    expect(await context(alpha.id)).toEqual([
      { summary: "Alpha context", medium: "email" },
    ]);
    expect(await context(beta.id)).toEqual([
      { summary: "Beta corrected", medium: "chat" },
    ]);
    expect(
      read(
        await beta.tools.create_memo({
          request_id: crypto.randomUUID(),
          forget_memos: [memoId],
        }),
      ),
    ).toMatchObject({ status: "saved", forgotten: [memoId] });
    expect(await context(alpha.id)).toEqual([
      { summary: "Alpha context", medium: "email" },
    ]);
    expect(await context(beta.id)).toEqual([]);
    // Alpha's reads are byte-identical after all of Beta's activity.
    expect(await alpha.everything()).toBe(alphaSees);
    const betaAfter = await beta.everything();
    for (const text of alphaOwn) expect(betaAfter).not.toContain(text);
    expect(betaAfter).toContain("Beta reuse");
  } finally {
    await local.dispose();
  }
}, 30000);

test("identity resolution preserves a typed store failure", async () => {
  const local = await localStore();
  try {
    const unavailable = {
      ...local.env,
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
      lookupIdentityAccount(local.env, identity),
    ).rejects.toMatchObject({ code: "account_unavailable", status: 403 });
    expect(
      await local.db.query(sql`SELECT count(*)::integer AS n FROM users`),
    ).toEqual([{ n: 0 }]);
    // Preserve concurrent sign-up; new accounts have no memos.
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
      await local.db.query(sql`SELECT count(*)::integer AS n FROM memos`),
    ).toEqual([{ n: 0 }]);
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
    expect(
      (await resolveIdentityAccount(local.env, identity)).miltonUserId,
    ).toBe(admitted.miltonUserId);
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
    const auth = await lookupIdentityAccount(local.env, identity);
    const store = await storeForCurrentRequest(local.env, auth);
    await local.db.query(
      sql`UPDATE users SET status='deleting' WHERE id=${admitted.miltonUserId}`,
    );
    // A closed account gets no store, and a store built before it closed
    // serves no further reads.
    await expect(storeForCurrentRequest(local.env, auth)).rejects.toMatchObject(
      { code: "account_unavailable", status: 403 },
    );
    await expect(store.readReport(vendorIntent)).rejects.toMatchObject({
      code: "account_unavailable",
      status: 403,
    });
    await expect(
      lookupIdentityAccount(local.env, identity),
    ).rejects.toMatchObject({ code: "account_unavailable", status: 403 });
    await expect(
      resolveIdentityAccount(local.env, identity),
    ).rejects.toMatchObject({ code: "account_unavailable", status: 403 });
  } finally {
    await local.dispose();
  }
}, 30000);

test("a first sign-in that loses the identity race returns the winner's account and keeps no second account or trial", async () => {
  const local = await localStore();
  try {
    await local.pg.exec("UPDATE store_config SET trials_enabled=true");
    const identity = { provider: "neon", subject: "race-fixture" };
    const dialect = new PgDialect();
    let raced = false;
    // The rival commits between this sign-in's lookup and its identity insert;
    // the local store has one connection, so the rival's rows go in just before.
    const storeDatabase: StoreDatabase = {
      ...local.db,
      transaction: (work) =>
        local.db.transaction((tx) =>
          work({
            async query(statement) {
              if (
                !raced &&
                dialect
                  .sqlToQuery(statement)
                  .sql.includes("INSERT INTO identities")
              ) {
                raced = true;
                await tx.query(sql`INSERT INTO users (id) VALUES ('m_rival')`);
                await tx.query(
                  sql`INSERT INTO trial_accounts (user_id,started_at) VALUES ('m_rival',now())`,
                );
                await tx.query(sql`INSERT INTO identities (provider,subject,user_id)
                  VALUES (${identity.provider},${identity.subject},'m_rival')`);
              }
              return tx.query(statement);
            },
          }),
        ),
    };
    expect(
      await resolveIdentityAccount({ ...local.env, storeDatabase }, identity),
    ).toEqual({ miltonUserId: "m_rival" });
    expect(raced).toBe(true);
    expect(await local.db.query(sql`SELECT id FROM users`)).toEqual([
      { id: "m_rival" },
    ]);
    expect(
      await local.db.query(sql`SELECT user_id FROM trial_accounts`),
    ).toEqual([{ user_id: "m_rival" }]);
  } finally {
    await local.dispose();
  }
}, 30000);

test("closing an account refuses its reads, saves and replays, fences a pending save, and spares other tenants", async () => {
  const local = await localStore();
  try {
    const [alpha, beta] = await tenantPair(local);
    // Tools are built while Alpha is active, so every refusal below comes from
    // the per-call account lock, not from sign-in.
    const accepted = memoSave({ final: "Alpha signs as Ada." });
    expect(read(await alpha.tools.create_memo(accepted)).status).toBe("saved");
    const alphaMemo = steered("Alpha");
    expect(read(await alpha.tools.create_memo(alphaMemo)).status).toBe("saved");
    expect(
      read(
        await beta.tools.create_memo(memoSave({ final: "Beta signs as Bo." })),
      ).status,
    ).toBe("saved");
    // Legacy rows from before this release, which the cascade still removes.
    await seedLegacy(local.pg, alpha.id, {
      cover: ["Alpha signs as Ada."],
      notes: ["Alpha drops the warm-up opener"],
    });
    const betaSees = await beta.everything();
    const sources = async (userId: string) => [
      await local.db.query(
        sql`SELECT version,text FROM cover_sheets WHERE user_id=${userId} ORDER BY version`,
      ),
      await local.db.query(
        sql`SELECT id,final,summary FROM memos WHERE user_id=${userId} ORDER BY id`,
      ),
      await local.db.query(
        sql`SELECT id,text FROM tweaks WHERE user_id=${userId} ORDER BY id`,
      ),
      await local.db.query(
        sql`SELECT count(*)::int AS n FROM served_reports WHERE user_id=${userId}`,
      ),
    ];
    const alphaBefore = await sources(alpha.id);
    // (f) The account closes after the tools were built; the save's account
    // lock refuses it and nothing is applied.
    await local.db.query(
      sql`UPDATE users SET status='deleting' WHERE id=${alpha.id}`,
    );
    const raced = memoSave({ final: "Applied after closing." });
    const racedOutcome = read(await alpha.tools.create_memo(raced));
    expect(racedOutcome.status).toBeUndefined();
    expect(racedOutcome.error).toBe("account_unavailable");
    expect(await sources(alpha.id)).toEqual(alphaBefore);
    const refusals = async () => {
      for (const result of [
        await alpha.tools.get_report({ intent: vendorIntent }),
        await alpha.tools.get_report({ intent: vendorIntent }),
        await alpha.tools.create_memo(
          memoSave({ final: "Fresh after closing." }),
        ),
        await alpha.tools.create_memo(memoSave()),
        await alpha.tools.create_memo(accepted),
        await alpha.tools.create_memo(alphaMemo),
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
    // Deleting the closing account's row cascades its memos, tweaks and
    // cover sheet.
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
    expect(read(await beta.tools.create_memo(accepted)).status).toBe("saved");
    const betaAfter = await beta.everything();
    expect(betaAfter).toContain("Beta signs as Bo");
    expect(betaAfter).toContain("Alpha signs as Ada");
  } finally {
    await local.dispose();
  }
}, 30000);

test("account deletion removes every tenant row, waits for an in-flight save and removes it too, and allows no second trial", async () => {
  const local = await localStore();
  try {
    await appStorage(local.pg);
    await local.pg.exec("UPDATE store_config SET trials_enabled=true");
    const neon = (subject: string) => ({ provider: "neon", subject });
    // Each subject's trial-eligibility fingerprint, as admission computes one
    // from a verified email.
    const print = (subject: string) => [
      createHash("sha256").update(`fixture email:${subject}`).digest("hex"),
    ];
    let hold: { entered: () => void; gate: Promise<void> } | undefined;
    const storeDatabase = insideTransactions(local.db, async () => {
      if (hold) {
        hold.entered();
        await hold.gate;
      }
    });
    const open = async (subject: string) => {
      await resolveIdentityAccount(local.env, neon(subject), print(subject));
      const auth = await lookupIdentityAccount(local.env, neon(subject));
      const store = await storeForCurrentRequest(
        { ...local.env, storeDatabase },
        auth,
        {
          issuer: "fixture",
          clientId: "client-c",
        },
      );
      return { auth, store };
    };
    const gone = await open("leaving");
    const kept = await open("staying");
    // A row in every memo table: a steered memo with its kind and changes,
    // the keep-memos switch, and the legacy rows earlier versions wrote (a
    // cover sheet line, a served report, a note citing the memo).
    const leaving = await gone.store.saveMemo(steered("Leaving"));
    expect(leaving.status).toBe("saved");
    await seedLegacy(local.pg, gone.auth.userId, {
      cover: ["Fictional line, with its exception."],
      notes: ["Leaving drops the warm-up opener"],
      citedBy: leaving.memo!.memo_id,
    });
    await local.pg.query(
      "INSERT INTO served_reports(user_id,id,tweak_ids) VALUES ($1,$2,'{}')",
      [gone.auth.userId, crypto.randomUUID()],
    );
    await personStoreForCurrentRequest(local.env, gone.auth).setKeepMemos(true);
    expect((await kept.store.saveMemo(memoSave())).status).toBe("saved");
    // An admitted read of each account appends a usage row.
    for (const { store } of [gone, kept])
      await store.readReport(vendorIntent, { tool: "get_report" });
    await backgroundSettled();
    const tenantTables = (
      await local.db.query<{ table_name: string }>(
        sql`SELECT DISTINCT c.table_name FROM information_schema.columns c
        JOIN information_schema.tables t ON t.table_schema=c.table_schema AND t.table_name=c.table_name
        WHERE c.table_schema='public' AND c.column_name='user_id' AND t.table_type='BASE TABLE' ORDER BY 1`,
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
      "cover_sheets",
      "served_reports",
      "memos",
      "memo_kinds",
      "tweaks",
      "tweak_citations",
      "memo_changes",
      "memo_settings",
      "save_requests",
      "usage_calls",
    ])
      expect(populated[table]).toBeGreaterThan(0);
    const keptBefore = await counts(kept.auth.userId);
    // A save in flight when deletion starts holds the account lock: deletion
    // waits for it to commit, then removes its rows with the rest.
    let release!: () => void;
    let entered!: () => void;
    const saving = new Promise<void>((resolve) => (entered = resolve));
    hold = {
      entered,
      gate: new Promise<void>((resolve) => (release = resolve)),
    };
    const inflight = gone.store.saveMemo(
      memoSave({ final: "An in-flight fictional memo." }),
    );
    await saving;
    hold = undefined;
    const deleting = eraseAccount(local.db, neon("leaving"));
    release();
    expect((await inflight).status).toBe("saved");
    await deleting;
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
    // An account's ID never changes, so no tenant row can move to another.
    await expect(
      local.pg.query("UPDATE users SET id='other' WHERE id=$1", [
        kept.auth.userId,
      ]),
    ).rejects.toThrow("user_id_is_immutable");
    expect((await kept.store.readReport(vendorIntent)).memos).toBe(1);
    // Re-signup with the same fingerprint: a fresh, empty account already
    // marked canceled, so assistant reads pause; a never-deleted identity's
    // row still waits for its trial.
    await resolveIdentityAccount(local.env, neon("leaving"), print("leaving"));
    const again = await lookupIdentityAccount(local.env, neon("leaving"));
    expect(again.userId).not.toBe(gone.auth.userId);
    const fresh = await personStoreForCurrentRequest(local.env, again);
    expect(await fresh.read()).toMatchObject({ memos: [] });
    expect((await fresh.trialStatus()).status).toBe("expired");
    // The status alone marks it; no clock is written backwards.
    expect(
      await local.db.query(
        sql`SELECT t.subscription_status AS status,t.started_at=u.created_at AS plain
          FROM trial_accounts t JOIN users u ON u.id=t.user_id WHERE u.id=${again.userId}`,
      ),
    ).toEqual([{ status: "canceled", plain: true }]);
    const againTools = createStoreMemoTools(
      await storeForCurrentRequest(local.env, again, {
        issuer: "fixture",
        clientId: "client-new",
      }),
    );
    expect(
      JSON.parse(
        (await againTools.get_report({ intent: vendorIntent })).content[0].text,
      ).error,
    ).toBe("subscription_required");
    expect(
      (
        await (
          await personStoreForCurrentRequest(local.env, kept.auth)
        ).trialStatus()
      ).status,
    ).toBe("early_access");
    await resolveIdentityAccount(
      local.env,
      neon("newcomer"),
      print("newcomer"),
    );
    const newcomer = await lookupIdentityAccount(local.env, neon("newcomer"));
    // A newcomer's row waits for Stripe's answer; the gate allows it meanwhile.
    expect(
      (
        await (
          await personStoreForCurrentRequest(local.env, newcomer)
        ).trialStatus()
      ).status,
    ).toBe("early_access");
    // Re-signup while trials are off: no effect until trials are enabled.
    await eraseAccount(local.db, neon("leaving"));
    await local.pg.exec("UPDATE store_config SET trials_enabled=false");
    await resolveIdentityAccount(local.env, neon("leaving"), print("leaving"));
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

// Unit stand-in for native 007 (real SQL runs in the PG18 rehearsal): a key's
// snapshot is current while it matches this table's row for its subject.
async function nativeKeyStatus(local: Awaited<ReturnType<typeof localStore>>) {
  await local.pg.exec(`CREATE SCHEMA IF NOT EXISTS milton_guard;
    CREATE TABLE milton_guard.fixture_native(subject text PRIMARY KEY,incarnation text,generation text);
    CREATE FUNCTION milton_guard.connection_key_status(text,text,text) RETURNS boolean LANGUAGE sql
      AS $$ SELECT EXISTS(SELECT 1 FROM milton_guard.fixture_native WHERE (subject,incarnation,generation)=($1,$2,$3)) $$`);
  return async (subject: string) => {
    await local.pg.query(
      "INSERT INTO milton_guard.fixture_native VALUES($1,'f:1','f:2')",
      [subject],
    );
    return {
      issuer: "neon",
      subject,
      incarnation: "f:1",
      generation: "f:2",
    };
  };
}

test("connection keys store only a hash, list without secrets, expire, revoke, cap active keys and leave with the account", async () => {
  const local = await localStore();
  const quiet = spyOn(console, "error").mockImplementation(() => {});
  try {
    const neon = (subject: string) => ({ provider: "neon", subject });
    const native = await nativeKeyStatus(local);
    const env = { ...local.env, issuer: "neon" };
    await resolveIdentityAccount(local.env, neon("keys"));
    await resolveIdentityAccount(local.env, neon("other"));
    const auth = await lookupIdentityAccount(local.env, neon("keys"));
    const keys = connectionKeysForAccount(
      local.env,
      auth,
      await native("keys"),
    );
    const others = connectionKeysForAccount(
      local.env,
      await lookupIdentityAccount(local.env, neon("other")),
      await native("other"),
    );
    const check = (key: string) =>
      connectionKeyAccount(env, parseConnectionKey(key)!);
    const made = await keys.create({
      name: "  Nightly job ",
      scope: "read",
      expiry: 90,
    });
    const [, id, secret] = /^mk_([A-Za-z0-9_-]{22})_([A-Za-z0-9_-]{43})$/.exec(
      made.key,
    )!;
    expect(made.record).toMatchObject({
      id,
      name: "Nightly job",
      scope: "read",
      lastUsedAt: null,
      expired: false,
      stopped: false,
    });
    const days = (date: Date | null) =>
      Math.round((date!.getTime() - made.record.createdAt.getTime()) / 864e5);
    expect(days(made.record.expiresAt)).toBe(90);
    // Only the secret's SHA-256 is stored; nothing listed carries it or the hash.
    const stored = (
      await local.pg.query<Record<string, unknown>>(
        "SELECT * FROM connection_keys",
      )
    ).rows;
    expect(stored).toHaveLength(1);
    expect(JSON.stringify(stored)).not.toContain(secret!);
    expect(stored[0]!.secret_hash).toBe(
      createHash("sha256").update(secret!).digest("hex"),
    );
    const listed = await keys.list();
    expect(listed.active.map((key) => key.id)).toEqual([id!]);
    expect(JSON.stringify(listed)).not.toContain(
      String(stored[0]!.secret_hash),
    );
    expect(await others.list()).toEqual({ active: [], expired: [] });
    // A good key grants its account and scope and records use once a minute.
    expect(await check(made.key)).toMatchObject({
      ok: true,
      auth: { userId: auth.userId },
      keyId: id,
      scope: "read",
    });
    const used = async () =>
      (
        await local.pg.query<{ at: Date | null }>(
          "SELECT last_used_at AS at FROM connection_keys WHERE id=$1",
          [id],
        )
      ).rows[0]!.at;
    const first = await used();
    expect(first).not.toBeNull();
    await check(made.key);
    expect(await used()).toEqual(first);
    await local.pg.query(
      "UPDATE connection_keys SET last_used_at=now()-interval '2 minutes' WHERE id=$1",
      [id],
    );
    await check(made.key);
    expect((await used())!.getTime()).toBeGreaterThanOrEqual(first!.getTime());
    // Failing to record use never refuses the key.
    await local.pg.exec(`UPDATE connection_keys SET last_used_at=NULL;
      CREATE FUNCTION fixture_refuse() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fictional write outage'; END $$;
      CREATE TRIGGER fixture_refuse BEFORE UPDATE OF last_used_at ON connection_keys FOR EACH ROW EXECUTE FUNCTION fixture_refuse()`);
    expect(await check(made.key)).toMatchObject({ ok: true, keyId: id });
    await local.pg.exec("DROP TRIGGER fixture_refuse ON connection_keys");
    // A wrong, altered, padded or non-canonical key reads as no key at all.
    const flip = (s: string) => (s[0] === "A" ? "B" : "A") + s.slice(1);
    for (const bad of [
      `mk_${id}_${flip(secret!)}`,
      `mk_${flip(id!)}_${secret}`,
      made.key + "A",
      made.key.slice(0, -1),
      ` ${made.key}`,
      `mk_${id}_${secret!.slice(0, -1)}${secret!.endsWith("A") ? "B" : "A"}`,
      `mk_${id}-${secret}`,
    ])
      expect(
        parseConnectionKey(bad) &&
          (await connectionKeyAccount(env, parseConnectionKey(bad)!)).ok,
      ).toBeFalsy();
    // An unknown id and a known one with a wrong secret are refused alike.
    expect(await check(`mk_${flip(id!)}_${secret}`)).toEqual({ ok: false });
    expect(await check(`mk_${id}_${flip(secret!)}`)).toEqual({ ok: false });
    // Never-expiring keys have no expiry; expired keys stay listed, refused.
    const forever = await keys.create({
      name: "CI",
      scope: "read_write",
      expiry: null,
    });
    expect(forever.record.expiresAt).toBeNull();
    await local.pg.query(
      "UPDATE connection_keys SET created_at=now()-interval '91 days',expires_at=now()-interval '1 day' WHERE id=$1",
      [id],
    );
    expect((await check(made.key)).ok).toBe(false);
    const both = await keys.list();
    expect(both.active.map((key) => key.name)).toEqual(["CI"]);
    expect(both.expired.map((key) => [key.name, key.expired])).toEqual([
      ["Nightly job", true],
    ]);
    // Revocation is per key and per account, once.
    expect(await others.revoke(forever.record.id)).toBe(false);
    expect(await keys.revoke(forever.record.id)).toBe(true);
    expect(await keys.revoke(forever.record.id)).toBe(false);
    expect((await check(forever.key)).ok).toBe(false);
    expect((await keys.list()).expired.map((key) => key.name)).toEqual([
      "Nightly job",
    ]);
    for (const name of ["", "   ", "a\nb", "tab\there", "x".repeat(61)])
      await expect(
        keys.create({ name, scope: "read", expiry: 30 }),
      ).rejects.toMatchObject({ code: "invalid_input" });
    // Twenty active keys at most; expired and revoked ones do not count.
    for (let n = 0; n < 20; n++)
      await keys.create({ name: `Agent ${n}`, scope: "read", expiry: 30 });
    await expect(
      keys.create({ name: "One more", scope: "read", expiry: 30 }),
    ).rejects.toMatchObject({ code: "connection_key_limit", status: 409 });
    // A closing account's keys are refused; deletion removes them.
    await keys.revoke((await keys.list()).active[0]!.id);
    const last = await keys.create({ name: "Last", scope: "read", expiry: 30 });
    await local.pg.query("UPDATE users SET status='deleting' WHERE id=$1", [
      auth.userId,
    ]);
    expect((await check(last.key)).ok).toBe(false);
    await local.pg.query("UPDATE users SET status='active' WHERE id=$1", [
      auth.userId,
    ]);
    expect(await check(last.key)).toMatchObject({
      ok: true,
      keyId: last.record.id,
    });
    await eraseAccount(local.db, neon("keys"));
    expect(
      (await local.pg.query("SELECT 1 FROM connection_keys")).rows,
    ).toEqual([]);
  } finally {
    quiet.mockRestore();
    await local.dispose();
  }
});

test("an active key older than many expired keys stays listed, confirmable and revocable", async () => {
  const local = await localStore();
  try {
    const native = await nativeKeyStatus(local);
    const identity = { provider: "neon", subject: "rotating" };
    await resolveIdentityAccount(local.env, identity);
    const auth = await lookupIdentityAccount(local.env, identity);
    const keys = connectionKeysForAccount(
      local.env,
      auth,
      await native("rotating"),
    );
    const old = await keys.create({ name: "Old", scope: "read", expiry: null });
    await local.pg.query(
      "UPDATE connection_keys SET created_at=now()-interval '2 years' WHERE id=$1",
      [old.record.id],
    );
    // One more rotation than the expired history shows: newer keys, all
    // expired, none revoked.
    for (let n = 0; n <= EXPIRED_KEY_HISTORY; n++) {
      const made = await keys.create({
        name: `Rotated ${n}`,
        scope: "read",
        expiry: 30,
      });
      await local.pg.query(
        "UPDATE connection_keys SET created_at=now()-make_interval(days=>40,mins=>$2),expires_at=now()-make_interval(days=>10,mins=>$2) WHERE id=$1",
        [made.record.id, n],
      );
    }
    const listed = await keys.list();
    expect(listed.active.map((key) => key.id)).toEqual([old.record.id]);
    expect(listed.expired).toHaveLength(EXPIRED_KEY_HISTORY);
    expect(listed.expired[0]!.name).toBe("Rotated 0");
    expect(await keys.find(old.record.id)).toMatchObject({ name: "Old" });
    expect(await keys.revoke(old.record.id)).toBe(true);
    expect(await keys.find(old.record.id)).toBeUndefined();
    expect((await keys.list()).active).toEqual([]);
  } finally {
    await local.dispose();
  }
}, 30000);
