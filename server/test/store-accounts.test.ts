import { expect, jest, spyOn, test } from "bun:test";
import { sql } from "drizzle-orm";
import { localStore } from "./local-store";
import { betweenPhases, read, seedUsers } from "./store-fixtures";
import { createStoreMemoTools } from "../src/store/tools";
import { createHash } from "node:crypto";
import {
  deleteAccount,
  resolveIdentityAccount,
  lookupIdentityAccount,
  storeForCurrentRequest,
  personStoreForCurrentRequest,
} from "../src/store";

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
    expect(racingSave).not.toHaveProperty("subscription_url");
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

test("Postgres accounts per user for immutable contiguous history and plain deletion", async () => {
  const local = await localStore();
  try {
    await seedUsers(local.pg, "m_first", "m_second");
    await local.pg
      .exec(`INSERT INTO memos (user_id,id,name) VALUES ('m_first','same-id','sample'),('m_second','same-id','sample');
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

test("the signup seed's empty legacy card changes no read or save", async () => {
  const local = await localStore();
  try {
    await seedUsers(local.pg, "m_bare");
    await local.pg.exec(`UPDATE store_config SET signup_mode='open';
      INSERT INTO identities (provider,subject,user_id) VALUES ('neon','bare','m_bare');`);
    const seeded = { provider: "neon", subject: "seeded" };
    await resolveIdentityAccount(local.env, seeded);
    const open = async (subject: string) =>
      createStoreMemoTools(
        await storeForCurrentRequest(
          local.env,
          await lookupIdentityAccount(local.env, { provider: "neon", subject }),
          { issuer: "fixture", clientId: "seed" },
        ),
      );
    const cards = (userId: string) =>
      local.db.query(
        sql`SELECT count(*)::integer AS n FROM instruction_cards WHERE user_id=${userId}`,
      );
    const seededId = (await lookupIdentityAccount(local.env, seeded)).userId;
    // The seeded account holds one empty legacy card; the bare one holds none.
    expect(await cards(seededId)).toEqual([{ n: 1 }]);
    expect(await cards("m_bare")).toEqual([{ n: 0 }]);
    const tools = { seeded: await open("seeded"), bare: await open("bare") };
    const read = async (t: typeof tools.bare) => {
      const sheet = JSON.parse((await t.get_cover_sheet({})).content[0].text);
      const all = JSON.parse((await t.list_reports()).content[0].text);
      return { sheet, all };
    };
    const withoutVersion = (value: unknown) =>
      JSON.parse(
        JSON.stringify(value, (key, item) =>
          key === "version" ? undefined : item,
        ),
      );
    expect(withoutVersion(await read(tools.seeded))).toEqual(
      withoutVersion(await read(tools.bare)),
    );
    expect((await read(tools.bare)).sheet.is_empty).toBe(true);
    for (const t of [tools.seeded, tools.bare]) {
      const version = (await read(t)).sheet.version;
      const saved = JSON.parse(
        (
          await t.create_memo({
            text: "File two rules.",
            rules: [
              { report: "cover", text: "Fictional rule for all writing." },
              { report: "email", text: "Fictional email rule." },
            ],
            request_id: crypto.randomUUID(),
            expected_version: version,
          })
        ).content[0].text,
      );
      expect(saved.status).toBe("saved");
    }
    const after = {
      seeded: await read(tools.seeded),
      bare: await read(tools.bare),
    };
    expect(withoutVersion(after.seeded)).toEqual(withoutVersion(after.bare));
    expect(after.bare.sheet.text).toContain("Fictional rule for all writing.");
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
    await seedUsers(local.pg, "m_unfinished");
    await local.pg.exec(`
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
    // A legacy memo with history, beside the signup seed.
    await local.db.query(
      sql`INSERT INTO memos (user_id,id,name) VALUES (${gone.auth.userId},'legacy','legacy')`,
    );
    await local.db
      .query(sql`INSERT INTO memo_versions (user_id,memo_id,version,description,body,reason,actor_json)
      VALUES (${gone.auth.userId},'legacy',1,'Fictional','A legacy rule.','Fixture','{}'),
        (${gone.auth.userId},'legacy',2,'Fictional','A legacy rule, revised.','Fixture','{}')`);
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
