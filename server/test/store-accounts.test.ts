import { expect, jest, spyOn, test } from "bun:test";
import { sql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { localStore } from "./local-store";
import { appStorage } from "./auth-fixtures";
import {
  eraseAccount,
  insideTransactions,
  read,
  seedRule,
  seedSample,
  seedUsers,
} from "./store-fixtures";
import { createStoreMemoTools } from "../src/mcp-tools";
import { createHash } from "node:crypto";
import type { StoreDatabase } from "../src/store/database";
import {
  resolveIdentityAccount,
  lookupIdentityAccount,
  storeForCurrentRequest,
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
      JSON.parse((await idleTools.get_cover_sheet()).content[0].text).error,
    ).toBe("subscription_required");
    await expect(
      (
        await personStoreForCurrentRequest(local.env, neverSaved)
      ).readTpsReport(),
    ).resolves.toMatchObject({ is_empty: true });
    const store = await storeForCurrentRequest(
      { appOrigin: "http://localhost:3001", storeDatabase: local.db },
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
    // What Stripe's answer writes once the subscription exists.
    await local.db.query(
      sql`UPDATE trial_accounts SET subscription_status='trialing',trial_end=clock_timestamp()+interval '30 days' WHERE user_id=${auth.userId}`,
    );
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
    const report = await person.readTpsReport();
    // Only cover-sheet rules exist, so the cover sheet text is the full report.
    expect(result(await tools.get_cover_sheet())).toMatchObject(report);
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
      otherTools.get_cover_sheet(),
    ]);
    expect(reads.map(result).filter((r) => r.notice).length).toBe(1);
    expect(reads.map(result).find((r) => r.notice).notice.code).toBe(
      "trial_ending_7_days",
    );
    expect(await person.readTpsReport()).toEqual(report);
    expect(result(await tools.get_cover_sheet()).notice).toBeUndefined();
    await local.db.query(
      sql`UPDATE trial_accounts SET trial_end=clock_timestamp()+interval '23 hours' WHERE user_id=${auth.userId}`,
    );
    expect(result(await tools.get_cover_sheet()).notice.code).toBe(
      "trial_ending_1_day",
    );
    expect(result(await tools.get_cover_sheet()).notice).toBeUndefined();
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
      await tools.create_memo({
        text: "Expires before saving",
        rules: [{ report: "cover", text: "Lead with the answer." }],
        expected_version: report.version,
        request_id: crypto.randomUUID(),
      }),
    );
    expect(racingSave.status).toBeUndefined();
    expect(racingSave).toMatchObject({
      error: "subscription_required",
      retryable: false,
    });
    // The one link is in the message, the signed-in app home.
    expect(racingSave).not.toHaveProperty("subscription_url");
    expect(racingSave.message).toEndWith("Subscribe at http://localhost:3001/");
    expect(await person.readTpsReport()).toEqual(report);
    const denied = await tools.get_cover_sheet();
    expect(denied.isError).toBe(true);
    expect(result(denied)).toMatchObject({
      error: "subscription_required",
      retryable: false,
    });
    expect(result(denied).text).toBeUndefined();
    expect(result(denied).message).toBe(racingSave.message);
    expect(
      result(
        await tools.create_memo({
          ...input,
          request_id: crypto.randomUUID(),
          expected_version: report.version,
        }),
      ).error,
    ).toBe("subscription_required");
    expect(await receipts()).toBe(receiptsBefore);
    // An accepted write's receipt stays recoverable even after access expires.
    expect(result(await tools.create_memo(input))).toEqual(saved);
    expect(await person.readTpsReport()).toEqual(report);
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
    expect(result(await tools.get_cover_sheet())).toMatchObject(report);
    expect((await account()).started_at).toEqual(expiredStart);
    await local.db.query(
      sql`UPDATE trial_accounts SET subscription_status='canceled' WHERE user_id=${auth.userId}`,
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
    const version = async (): Promise<string> =>
      read(await tools.get_cover_sheet()).version;
    // Everything this tenant's assistant can read, as one string.
    const everything = async () =>
      JSON.stringify([
        read(await tools.get_cover_sheet()),
        read(
          await tools.get_report({
            report_id: "email",
            intent: { situation: "confirming what is on file" },
          }),
        ),
        read(await tools.list_reports()),
      ]);
    return { id: auth.userId, tools, version, everything };
  };
  return [
    await tenant("isolation-alpha"),
    await tenant("isolation-beta"),
  ] as const;
}

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
        context: { version: 1 as const, summary: "alpha context" },
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
      sql`SELECT sample_id AS id,kind_id FROM sample_versions WHERE user_id=${alpha.id}`,
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
    await seedSample(
      local.pg,
      beta.id,
      sample!.id,
      "email",
      sample!.kind_id,
      { version: 1, summary: "beta context" },
      "Beta sample body.",
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
    // (a) Alpha's request ID with Beta's own input files fresh for Beta.
    const betaReuse = {
      ...emailRule("- Beta keeps it short."),
      request_id: alphaRule.request_id,
      expected_version: betaVersion,
    };
    const betaSaved = read(await beta.tools.create_memo(betaReuse));
    expect(betaSaved.status).toBe("saved");
    expect(betaSaved.version).not.toBe(alphaSaved.version);
    // (a) Alpha's exact request from Beta meets Beta's own receipt for that
    // request ID, never Alpha's.
    const copied = read(await beta.tools.create_memo(alphaRule));
    expect(copied.error).toBe("request_id_reused");
    expect(JSON.stringify(copied)).not.toContain(alphaSaved.version);
    const betaSample = {
      ...alphaSample,
      expected_version: betaSaved.version,
      // Beta's own kind under Alpha's kind ID; new_kind would duplicate it.
      sample: {
        report: "email" as const,
        kind_id: sample!.kind_id,
        context: { version: 1 as const, summary: "beta reuse" },
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

test("Postgres keeps immutable contiguous history per user, with plain deletion", async () => {
  const local = await localStore();
  try {
    await seedUsers(local.pg, "m_first", "m_second");
    await seedRule(local.pg, "m_first", "same-id", "hello");
    await seedRule(local.pg, "m_second", "same-id", "hello");
    await expect(
      local.pg.query("UPDATE instruction_card_versions SET body='changed'"),
    ).rejects.toThrow("card_version_is_immutable");
    await expect(
      local.pg.query(
        "INSERT INTO instruction_card_versions (user_id,card_id,version,description,body,reason,report,actor_json) VALUES ('m_first','same-id',3,'Sample.','hello','seed','cover','{}')",
      ),
    ).rejects.toThrow("card_version_conflict");
    await expect(
      local.pg.query("UPDATE users SET id='other' WHERE id='m_first'"),
    ).rejects.toThrow("user_id_is_immutable");
    await local.pg.query("DELETE FROM users WHERE id='m_first'");
    expect(
      (await local.pg.query("SELECT user_id FROM instruction_card_versions"))
        .rows,
    ).toEqual([{ user_id: "m_second" }]);
    await local.pg.query("DELETE FROM users WHERE id='m_second'");
    expect(
      (
        await local.pg.query(
          "SELECT count(*)::integer AS n FROM instruction_card_versions",
        )
      ).rows,
    ).toEqual([{ n: 0 }]);
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
    // Preserve concurrent sign-up; new accounts have no rule history.
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
        sql`SELECT count(*)::integer AS n FROM instruction_card_versions`,
      ),
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
    // charges no further calls.
    await expect(storeForCurrentRequest(local.env, auth)).rejects.toMatchObject(
      { code: "account_unavailable", status: 403 },
    );
    await expect(store.chargeToolCall()).rejects.toMatchObject({
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
        context: { version: 1 as const, summary: "alpha context" },
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
        sql`SELECT sample_id,version,body,retired FROM sample_versions WHERE user_id=${userId} ORDER BY sample_id,version`,
      ),
      await local.db.query(
        sql`SELECT count(*)::int AS n FROM accepted_changes WHERE user_id=${userId}`,
      ),
    ];
    const alphaBefore = await sources(alpha.id);
    // (f) The account closes after the tools were built; the save's account
    // lock refuses it and nothing is applied.
    await local.db.query(
      sql`UPDATE users SET status='deleting' WHERE id=${alpha.id}`,
    );
    const raced = {
      ...emailRule("- Applied after closing."),
      request_id: crypto.randomUUID(),
      expected_version: alphaVersion,
    };
    const racedOutcome = read(await alpha.tools.create_memo(raced));
    expect(racedOutcome.status).toBeUndefined();
    expect(racedOutcome.error).toBe("account_unavailable");
    expect(await sources(alpha.id)).toEqual(alphaBefore);
    const refusals = async () => {
      for (const result of [
        await alpha.tools.get_cover_sheet(),
        await alpha.tools.get_report({
          report_id: "email",
          intent: { situation: "confirming what is on file" },
        }),
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
    expect(await sources(alpha.id)).toEqual([[], [], [{ n: 0 }]]);
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
    await seedRule(local.pg, gone.auth.userId, "history", "A fictional rule.");
    await local.db
      .query(sql`INSERT INTO instruction_card_versions(user_id,card_id,version,description,body,reason,report,actor_json)
      VALUES (${gone.auth.userId},'history',2,'Fictional','A fictional rule, revised.','Fixture','cover','{}')`);
    expect((await gone.save()).status).toBe("saved");
    // A kind, a revised sample, a retired example and an active pair.
    const goneSamples = () =>
      local.db.query<{ id: string; kind_id: string }>(
        sql`SELECT sample_id AS id,kind_id FROM sample_versions WHERE user_id=${gone.auth.userId} ORDER BY created_at,sample_id`,
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
              ...(text === "Three" ? { sample_id: prior[1]!.id } : {}),
              context: { version: 1 as const, summary: "Fixture context" },
              text,
            },
          })
        ).status,
      ).toBe("saved");
    }
    await gone.save({ retire_samples: [(await goneSamples())[0]!.id] });
    await gone.store.chargeToolCall();
    expect((await kept.save()).status).toBe("saved");
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
      "instruction_cards",
      "instruction_card_versions",
      "samples",
      "sample_versions",
      "sample_kinds",
      "accepted_changes",
      "save_requests",
      "usage_daily",
    ])
      expect(populated[table]).toBeGreaterThan(0);
    expect(
      (
        await local.db.query(
          sql`SELECT 1 FROM sample_versions WHERE user_id=${gone.auth.userId} AND retired`,
        )
      ).length,
    ).toBe(1);
    const keptBefore = await counts(kept.auth.userId);
    // A save in flight when deletion starts holds the account lock: deletion
    // waits for it to commit, then removes its rows with the rest.
    const version = (await gone.store.readTpsReport()).version;
    let release!: () => void;
    let entered!: () => void;
    const saving = new Promise<void>((resolve) => (entered = resolve));
    hold = {
      entered,
      gate: new Promise<void>((resolve) => (release = resolve)),
    };
    const inflight = gone.store.saveMemo({
      text: "An in-flight fictional rule.",
      rules: [{ report: "cover", text: "An in-flight fictional rule." }],
      request_id: crypto.randomUUID(),
      expected_version: version,
    });
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
    expect((await kept.store.readTpsReport()).is_empty).toBe(false);
    // Re-signup with the same fingerprint: a fresh, empty account already
    // marked canceled, so assistant reads pause; a never-deleted identity's
    // row still waits for its trial.
    await resolveIdentityAccount(local.env, neon("leaving"), print("leaving"));
    const again = await lookupIdentityAccount(local.env, neon("leaving"));
    expect(again.userId).not.toBe(gone.auth.userId);
    const fresh = await personStoreForCurrentRequest(local.env, again);
    expect((await fresh.readTpsReport()).is_empty).toBe(true);
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
      JSON.parse((await againTools.get_cover_sheet()).content[0].text).error,
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
    // 120 rotations later: newer keys, all expired, none revoked.
    for (let n = 0; n < 120; n++) {
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
