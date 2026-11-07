import { cardHeads } from "../src/store/cards";
import { compiledMemos, type SaveMemoInput } from "../src/store/compiled";
import { expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { StoreError } from "../src/store/errors";
import { database } from "../src/store/index";
import { BASELINE_NOTE } from "../src/store/reports";
import { localStore } from "./local-store";
import {
  fixtureStore,
  insideTransactions,
  seedRule,
  seedSample,
  seedUsers,
} from "./store-fixtures";

test("compiled saves publish memos and TPS together and charge once with durable replay", async () => {
  const local = await localStore();
  try {
    await seedUsers(local.pg, "compiled-a", "compiled-b");
    const store = fixtureStore(local.db, "compiled-a", "assistant");
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
      "- Ask before sending.",
      "- Be concise.",
    ]);
    expect(current.version).not.toBe(empty.version);
    expect(await store.saveMemo(input)).toEqual(saved);
    expect(
      (
        await local.pg.query(
          "SELECT count(*)::int AS n FROM accepted_changes WHERE user_id='compiled-a'",
        )
      ).rows,
    ).toEqual([{ n: 1 }]);
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
          "SELECT count(*)::int AS n FROM accepted_changes WHERE user_id='compiled-a'",
        )
      ).rows,
    ).toEqual([{ n: 1 }]);
    await expect(
      store.saveMemo({ ...input, text: "Changed" }),
    ).rejects.toMatchObject({ code: "request_id_reused" });
    await expect(
      local.pg.query(
        `INSERT INTO save_requests(user_id,request_id,input_hash,source_hash,result_json)
      VALUES ('compiled-a',$1,repeat('a',64),repeat('b',64),'{}')`,
        [crypto.randomUUID()],
      ),
    ).rejects.toThrow("save_request_outcome");
    // A receipt is immutable, so a replay can only return what was saved.
    await expect(
      local.pg.exec(
        `UPDATE save_requests SET result_json='{"status":"failed"}' WHERE user_id='compiled-a'`,
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
  } finally {
    await local.dispose();
  }
});

test("TPS preserves every active source body verbatim and refreshes only the derived report", async () => {
  const local = await localStore();
  try {
    await seedUsers(local.pg, "fidelity", "fidelity-other");
    const source =
      "Where relevant, identify products by their full model names.\n\nKeep exceptions intact.\n";
    const companion = "  Keep units explicit: µm.\r\nDo not infer a model.  ";
    // Each rule prints as a bullet ahead of its exact stored bytes.
    const exact = "- " + companion + "\n\n- " + source;
    await seedRule(local.pg, "fidelity", "a", companion, {
      description: "Units",
    });
    await seedRule(local.pg, "fidelity", "z", source, {
      description: "Product naming",
    });
    await seedRule(
      local.pg,
      "fidelity",
      "retired",
      "Archived instructions must stay out.",
      { archived: true },
    );
    const store = fixtureStore(local.db, "fidelity", "assistant");
    // Sources assemble on every read, in stored position order.
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
          cards: unknown;
          versions: unknown;
          receipts: unknown;
          usage: unknown;
        }>(`SELECT
      (SELECT jsonb_agg(c) FROM instruction_cards c WHERE user_id='fidelity') AS cards,
      (SELECT jsonb_agg(v) FROM instruction_card_versions v WHERE user_id='fidelity') AS versions,
      (SELECT jsonb_agg(r) FROM save_requests r WHERE user_id='fidelity') AS receipts,
      (SELECT jsonb_agg(d) FROM usage_daily d WHERE user_id='fidelity') AS usage`)
      ).rows;
    // Reads write nothing; a source change shows on the next read.
    const before = await preserved();
    const admin = compiledMemos(local.db, "fidelity"); // No actor or model configuration.
    expect((await admin.getTpsReport()).text).toBe(exact);
    expect((await store.getTpsReport()).version).toBe(canonical.version);
    expect(await preserved()).toEqual(before);
    await local.pg
      .exec(`INSERT INTO instruction_card_versions(user_id,card_id,version,description,body,report,reason,actor_json)
      SELECT user_id,card_id,2,description,body || 'Updated condition.',report,'Fixture','{}'
      FROM instruction_card_versions WHERE user_id='fidelity' AND card_id='z' AND version=1`);
    const rebuilt = await admin.getTpsReport();
    expect(rebuilt.version).not.toBe(canonical.version);
    expect(rebuilt.text).toBe(exact + "Updated condition.");
    expect((await store.getTpsReport()).version).toBe(rebuilt.version);
    // A new card version with the same text keeps the version; a save fenced
    // on a version a source change superseded conflicts.
    await local.pg
      .exec(`INSERT INTO instruction_card_versions(user_id,card_id,version,description,body,report,reason,actor_json)
      SELECT user_id,card_id,3,description,body,report,'Fixture','{}'
      FROM instruction_card_versions WHERE user_id='fidelity' AND card_id='z' AND version=2`);
    const changed = await admin.getTpsReport();
    expect(changed.version).toBe(rebuilt.version);
    expect((await save(canonical.version)).status).toBe("conflict");
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
    expect(boundedAfter[0]!.cards).toEqual(boundedBefore[0]!.cards);
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
    // An account that never held anything reads at a stable version.
    const other = compiledMemos(local.db, "fidelity-other");
    expect(await other.getTpsReport()).toEqual({
      text: "",
      version: (await other.getTpsReport()).version,
      is_empty: true,
    });
  } finally {
    await local.dispose();
  }
});

test("stale and failed compiled saves preserve current memos, receipts and charges", async () => {
  const local = await localStore();
  try {
    await seedUsers(local.pg, "race", "foreign");
    let release!: () => void, started!: () => void;
    const begun = new Promise<void>((r) => {
      started = r;
    });
    const held = new Promise<void>((r) => {
      release = r;
    });
    // The next transaction stays open until released.
    let hold = false;
    const store = fixtureStore(
      insideTransactions(local.db, async () => {
        if (!hold) return;
        hold = false;
        started();
        await held;
      }),
      "race",
    );
    const initial = await store.getTpsReport();
    const slow = {
      text: "Be concise.",
      rules: [{ report: "cover" as const, text: "Be concise." }],
      request_id: crypto.randomUUID(),
      expected_version: initial.version,
    };
    hold = true;
    const pending = store.saveMemo(slow);
    await begun;
    // A replay and another save on the same version wait for the open save,
    // as on the account lock: the replay returns its outcome, never a
    // pending state, and the other save conflicts.
    const replay = store.saveMemo(slow);
    const reading = store.getTpsReport();
    const fast = {
      text: "Slow",
      rules: [{ report: "cover" as const, text: "Slow" }],
      request_id: crypto.randomUUID(),
      expected_version: initial.version,
    };
    const racing = store.saveMemo(fast);
    release();
    const committed = await pending;
    expect(committed.status).toBe("saved");
    expect(await replay).toEqual(committed);
    expect((await reading).text).toBe("- Be concise.");
    expect(await racing).toMatchObject({
      status: "conflict",
      version: committed.version,
    });
    const first = await store.getTpsReport();
    expect(first.text).toBe("- Be concise.");
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
    const saved = await fixtureStore(uncertain, "race").saveMemo({
      text: "Lead with the answer.",
      exact_edits: [{ before: "Be concise.", after: "Lead with the answer." }],
      request_id: crypto.randomUUID(),
      expected_version: first.version,
    });
    expect(saved.status).toBe("saved");
    if (!saved.version) throw new Error("Saved revision missing");
    expect((await store.getTpsReport()).text).toBe("- Lead with the answer.");
    expect((await store.saveMemo(fast)).version).toBe(first.version);
    expect((await store.getTpsReport()).version).toBe(saved.version);
    const before = await local.pg.query(
      "SELECT card_id,version,body FROM instruction_card_versions WHERE user_id='race' ORDER BY card_id,version",
    );
    await local.pg
      .exec(`CREATE FUNCTION reject_report() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture report failure'; END $$;
      CREATE TRIGGER reject_report BEFORE INSERT ON accepted_changes FOR EACH ROW EXECUTE FUNCTION reject_report();`);
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
          "SELECT count(*)::int AS n FROM accepted_changes WHERE user_id='race'",
        )
      ).rows,
    ).toEqual([{ n: 2 }]);
  } finally {
    await local.dispose();
  }
});

test("saves anchor in every active memo, never archived or foreign text, and have no technical write cap", async () => {
  const local = await localStore();
  try {
    await seedUsers(local.pg, "collection", "other");
    for (let n = 1; n <= 52; n++)
      await seedRule(local.pg, "collection", `m-${n}`, `Instruction m-${n}`, {
        archived: n === 52,
      });
    await seedRule(local.pg, "other", "foreign-id", "Never exposed");
    const store = fixtureStore(local.db, "collection");
    // Every read assembles current sources.
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
    // Every active rule is served; archived and foreign text is excluded.
    for (const anchor of ["Instruction m-52", "Never exposed"])
      expect((await send(anchor, "Changed")).error).toBe("edit_conflict");
    expect((await store.getTpsReport()).version).toBe(base);
    expect(
      (await send("Instruction m-51", "Instruction m-51 changed")).status,
    ).toBe("saved");
    base = (await store.getTpsReport()).version;
    // Saves leave no per-day write counter.
    expect(
      (await send("Instruction m-50", "Instruction m-50 changed")).status,
    ).toBe("saved");
    expect((await store.getTpsReport()).version).not.toBe(base);
    base = (await store.getTpsReport()).version;
    expect((await send("Instruction m-50 changed")).status).toBe("unchanged");
    expect((await local.pg.query("SELECT * FROM usage_daily")).rows).toEqual(
      [],
    );
  } finally {
    await local.dispose();
  }
});

test("targeted saves preserve omitted memos and reject invalid changes atomically", async () => {
  const local = await localStore();
  try {
    await seedUsers(local.pg, "targeted");
    for (const id of ["a", "b", "c"])
      await seedRule(local.pg, "targeted", id, `Preserve ${id} exactly.`, {
        description: `Instruction ${id}`,
      });
    const store = fixtureStore(local.db, "targeted");
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
      "- Change a only.\n\n- Preserve b exactly.\n\n- Add d.",
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
    expect(
      (
        await send({
          rules: [
            { report: "cover", text: "A valid fictional rule." },
            { report: "cover", text: "# A fictional heading" },
          ],
        })
      ).error,
    ).toBe("card_heading");
    expect(await store.getTpsReport()).toEqual(current);
    expect(
      await local.pg.query(
        "SELECT * FROM instruction_card_versions WHERE user_id='targeted' ORDER BY card_id,version",
      ),
    ).toEqual(history);
    expect(
      (
        await local.pg.query(
          "SELECT count(*)::int AS n FROM accepted_changes WHERE user_id='targeted'",
        )
      ).rows,
    ).toEqual([{ n: 1 }]);
  } finally {
    await local.dispose();
  }
});

test("exact caller edits preserve conditions and scope without a model, with atomic anchors and replay", async () => {
  const local = await localStore();
  try {
    await seedUsers(local.pg, "exact");
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
    for (const m of sources)
      await seedRule(local.pg, "exact", m.id, m.body, {
        description: "Instruction " + m.id,
      });
    const store = fixtureStore(local.db, "exact");
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
      ]
        .map((body) => "- " + body)
        .join("\n\n"),
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
      expect(await send(edits)).toMatchObject({
        error: "edit_conflict",
        message: expect.stringContaining(
          "Read the cover sheet and reports again",
        ),
      });
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
      (await send([{ before: "α", after: "x".repeat(131072) }])).error,
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
          "SELECT count(*)::int AS n FROM accepted_changes WHERE user_id='exact'",
        )
      ).rows,
    ).toEqual([{ n: 1 }]);
    // Removing a complete body explicitly retires only that memo.
    expect((await send([{ before: sources[2]!.body, after: "" }])).status).toBe(
      "saved",
    );
    expect((await store.getTpsReport()).text).toBe(
      report.text.slice(0, -("\n\n- ".length + sources[2]!.body.length)),
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

test("Postgres enforces separate UTF-8 field caps and no card count", async () => {
  const local = await localStore();
  try {
    await seedUsers(local.pg, "m_caps");
    await local.pg.query(
      "INSERT INTO instruction_cards(user_id,id) VALUES ('m_caps','card'),('m_caps','second'),('m_caps','third')",
    );
    const append = (
      version: number,
      description: string,
      body: string,
      reason: string,
    ) =>
      local.pg.query(
        `INSERT INTO instruction_card_versions(user_id,card_id,version,description,body,reason,report,actor_json)
        VALUES ('m_caps','card',$1,$2,$3,$4,'cover','{}')`,
        [version, description, body, reason],
      );
    await append(1, "é".repeat(250), "é".repeat(65536), "x".repeat(500));
    await expect(append(2, "é".repeat(250) + "x", "", "")).rejects.toThrow(
      "memo_description_limit",
    );
    await expect(append(2, "ok", "é".repeat(65536) + "x", "")).rejects.toThrow(
      "memo_body_limit",
    );
    await expect(append(2, "ok", "", "x".repeat(501))).rejects.toThrow(
      "memo_reason_limit",
    );
    expect(
      (
        await local.pg.query(
          "SELECT count(*)::int AS n FROM instruction_card_versions",
        )
      ).rows,
    ).toEqual([{ n: 1 }]);
    await append(2, "ok", "", "reason");
    expect(
      (
        await local.pg.query(
          "SELECT version FROM instruction_card_versions ORDER BY version",
        )
      ).rows,
    ).toEqual([{ version: 1 }, { version: 2 }]);
    // One row past each old cap, each in its own account.
    await seedUsers(local.pg, "sample", "change", "receipt");
    const hex = (c: string) => `repeat('${c}',64)`;
    await local.pg
      .exec(`INSERT INTO sample_kinds(user_id,id,report,label) VALUES ('sample','k','email','long');
      INSERT INTO save_requests(user_id,request_id,input_hash,source_hash,result_json)
      VALUES ('receipt','${crypto.randomUUID()}',${hex("a")},${hex("c")},jsonb_build_object('status','saved','pad',repeat('x',60000)));`);
    await seedSample(
      local.pg,
      "sample",
      "s",
      "email",
      "k",
      { version: 1, summary: "A long sample." },
      "x".repeat(131072),
    );
    // A save that changes 101 cards: 100 rules, then 100 edits and one more.
    const change = fixtureStore(local.db, "change", "assistant");
    const changeSave = async (
      extra: Pick<SaveMemoInput, "rules" | "exact_edits">,
    ) =>
      change.saveMemo({
        text: "Fictional change.",
        request_id: crypto.randomUUID(),
        expected_version: (await change.getTpsReport()).version,
        ...extra,
      });
    for (let b = 0; b < 4; b++)
      await changeSave({
        rules: Array.from({ length: 25 }, (_, i) => ({
          report: "email",
          text: `Rule ${b * 25 + i}.`,
        })),
      });
    expect(
      await changeSave({
        rules: [{ report: "email", text: "One more." }],
        exact_edits: Array.from({ length: 100 }, (_, i) => ({
          before: `Rule ${i}.`,
          after: `Rule ${i}!`,
        })),
      }),
    ).toMatchObject({ status: "saved" });
  } finally {
    await local.dispose();
  }
});

test("Postgres version conflicts return typed errors from the local adapter as from production", async () => {
  const local = await localStore();
  const userId = "m_00000000-0000-4000-8000-000000000001";
  try {
    await seedUsers(local.pg, userId);
    await seedRule(local.pg, userId, "card", "hello", {
      description: "Sample.",
    });
    // database() maps every adapter's failures, so callers never re-wrap.
    const db = database(local.env);
    const insert = sql`INSERT INTO instruction_card_versions (user_id,card_id,version,description,body,reason,report,actor_json)
      VALUES (${userId},'card',1,'Sample.','changed','edit','cover','{}')`;
    const failures = [
      await db.query(insert).catch((error: unknown) => error),
      await db
        .transaction((tx) => tx.query(insert))
        .catch((error: unknown) => error),
    ];
    for (const conflict of failures) {
      expect(conflict).toBeInstanceOf(StoreError);
      expect(conflict).toMatchObject({
        code: "card_version_conflict",
        message: "The instruction card changed. Read the current report.",
        status: 409,
      });
    }
    // The transaction's own callback failure keeps its identity.
    const own = new Error("fixture callback failure");
    expect(
      await db
        .transaction(async () => {
          throw own;
        })
        .catch((error: unknown) => error),
    ).toBe(own);
    expect(
      await local.db.query(
        sql`SELECT version,body FROM instruction_card_versions WHERE user_id=${userId}`,
      ),
    ).toEqual([{ version: 1, body: "hello" }]);
  } finally {
    await local.dispose();
  }
}, 30000);

test("instruction cards edit independently, keep write-once identity, and fence stale changes", async () => {
  const local = await localStore();
  try {
    await seedUsers(local.pg, "cards");
    await seedRule(
      local.pg,
      "cards",
      "a",
      "When comparing products, include units.",
      { description: "Writing" },
    );
    await seedRule(local.pg, "cards", "b", "Ask before sending.", {
      description: "Actions",
    });
    const store = fixtureStore(local.db, "cards", "assistant");
    const before = await store.getTpsReport();
    const versions = (
      await local.pg.query(
        "SELECT * FROM instruction_card_versions ORDER BY card_id,version",
      )
    ).rows;
    // Identity and position are write-once.
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
      "- When comparing products, include units.\n\n- Get approval before sending.",
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
    // Every card version carries its report.
    expect((await cardHeads(local.db, "cards")).map((h) => h.report)).toEqual([
      "cover",
      "cover",
      "document",
    ]);
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

test("accepted change evidence replays once", async () => {
  const local = await localStore();
  try {
    await seedUsers(local.pg, "provenance");
    const store = fixtureStore(local.db, "provenance", "assistant");
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
  } finally {
    await local.dispose();
  }
});

test("a conflict or refusal stores a receipt with its outcome and replays it", async () => {
  const local = await localStore();
  try {
    await seedUsers(local.pg, "replay");
    const store = fixtureStore(local.db, "replay");
    const initial = await store.getTpsReport();
    const rule = (text: string, expected_version = initial.version) => ({
      text: "A fictional rule.",
      rules: [{ report: "cover" as const, text }],
      request_id: crypto.randomUUID(),
      expected_version,
    });
    expect((await store.saveMemo(rule("First."))).status).toBe("saved");
    const stale = rule("Stale.");
    const conflict = await store.saveMemo(stale);
    expect(conflict).toMatchObject({ status: "conflict" });
    // The account moves on; the same request still replays its first outcome.
    const current = await store.getTpsReport();
    expect(
      (await store.saveMemo(rule("Second.", current.version))).status,
    ).toBe("saved");
    expect(await store.saveMemo(stale)).toEqual(conflict);
    // A refreshed retry under the same ID is told to take a new one.
    await expect(
      store.saveMemo({ ...stale, expected_version: current.version }),
    ).rejects.toMatchObject({
      code: "request_id_reused",
      message:
        "This request ID belongs to different input. A changed save needs a new request_id; the original arguments replay the same outcome.",
    });
    // A refusal decided against the request replays the same way.
    const oversized = {
      ...rule("Large.", (await store.getTpsReport()).version),
      rules: [..."abcdefghi"].map((c) => ({
        report: "cover" as const,
        text: c.repeat(30000),
      })),
    };
    const refused = await store.saveMemo(oversized);
    expect(refused).toMatchObject({
      status: "failed",
      error: "request_too_large",
    });
    expect(await store.saveMemo(oversized)).toEqual(refused);
    await expect(
      store.saveMemo({ ...oversized, text: "Different input." }),
    ).rejects.toMatchObject({ code: "request_id_reused" });
    expect(
      (
        await local.pg.query<{ status: string }>(
          "SELECT result_json->>'status' AS status FROM save_requests WHERE user_id='replay' ORDER BY created_at",
        )
      ).rows.map((row) => row.status),
    ).toEqual(["saved", "conflict", "saved", "failed"]);
  } finally {
    await local.dispose();
  }
});

test("a save and its receipt commit together: a lost acknowledgment replays the outcome, a failed lookup answers save_outcome_unknown, and an uncommitted save leaves no receipt", async () => {
  const local = await localStore();
  try {
    await seedUsers(local.pg, "uncertain");
    // Each transaction takes the next cue: "abort" fails it before commit,
    // "ack" loses the acknowledgment of its commit, "lookup" fails it unrun.
    const cues: ("abort" | "ack" | "lookup" | undefined)[] = [];
    const flaky = {
      ...local.db,
      async transaction<T>(
        work: Parameters<typeof local.db.transaction<T>>[0],
      ) {
        const cue = cues.shift();
        if (cue === "lookup") throw new Error("Fictional unavailable lookup");
        const result = await local.db.transaction(async (tx) => {
          const done = await work(tx);
          if (cue === "abort")
            throw new Error("Fictional connection lost before commit");
          return done;
        });
        if (cue === "ack") throw new Error("Fictional lost acknowledgment");
        return result;
      },
    };
    const store = fixtureStore(flaky, "uncertain", "assistant");
    const input = async (text: string) => ({
      text,
      rules: [{ report: "cover" as const, text }],
      request_id: crypto.randomUUID(),
      expected_version: (await store.getTpsReport()).version,
    });
    const receipts = async () =>
      (
        await local.pg.query(
          "SELECT count(*)::int AS n FROM save_requests WHERE user_id='uncertain'",
        )
      ).rows;
    // Rolled back before commit: the lookup finds no receipt, so nothing was
    // written and the same request runs again.
    const aborted = await input("Aborted rule.");
    cues.push("abort");
    await expect(store.saveMemo(aborted)).rejects.toMatchObject({
      code: "store_unavailable",
    });
    expect(await receipts()).toEqual([{ n: 0 }]);
    expect((await store.getTpsReport()).is_empty).toBe(true);
    const retried = await store.saveMemo(aborted);
    expect(retried.status).toBe("saved");
    // Committed without its acknowledgment: the lookup returns the outcome.
    const lost = await input("Acknowledged late.");
    cues.push("ack");
    const recovered = await store.saveMemo(lost);
    expect(recovered.status).toBe("saved");
    expect(await store.saveMemo(lost)).toEqual(recovered);
    // When the lookup fails too, the outcome is unknown until the same
    // request replays it.
    const unknown = await input("Unknown until replayed.");
    cues.push("ack", "lookup");
    await expect(store.saveMemo(unknown)).rejects.toMatchObject({
      code: "save_outcome_unknown",
      details: { request_id: unknown.request_id },
    });
    const replayed = await store.saveMemo(unknown);
    expect(replayed.status).toBe("saved");
    expect((await store.getTpsReport()).version).toBe(replayed.version!);
    expect(await receipts()).toEqual([{ n: 3 }]);
  } finally {
    await local.dispose();
  }
});

test("a Baseline: rule must be a setup rule byte for byte in its report, filed new, edited or moved", async () => {
  const local = await localStore();
  try {
    await seedUsers(local.pg, "baseline");
    const store = fixtureStore(local.db, "baseline");
    const save = async (change: Partial<SaveMemoInput>) =>
      store.saveMemo({
        text: "Setup baseline",
        request_id: crypto.randomUUID(),
        expected_version: (await store.getTpsReport()).version,
        ...change,
      });
    const near = 'Baseline: Sign off with "Cheers," and my first name.';
    const refused = await save({ rules: [{ report: "email", text: near }] });
    expect(refused).toMatchObject({
      status: "failed",
      error: "baseline_unknown",
    });
    expect(refused.message).toContain(
      "Copy the closest rule and its report shown below exactly",
    );
    expect(refused.message).toContain(
      'Closest setup rule: [email] "Baseline: Sign off with "Thanks," and my first name."',
    );
    expect((await store.getTpsReport()).text).toBe("");
    const rule = 'Baseline: Sign off with "Best," and my first name.';
    // A catalog text counts only in the report it is served for.
    expect(
      await save({ rules: [{ report: "chat", text: rule }] }),
    ).toMatchObject({ error: "baseline_unknown" });
    expect(
      (
        await save({
          rules: [
            { report: "cover", text: "Lead with the answer." },
            { report: "email", text: rule },
          ],
        })
      ).status,
    ).toBe("saved");
    expect(
      (await cardHeads(local.db, "baseline")).map((h) => [h.report, h.body]),
    ).toEqual([
      ["cover", "Lead with the answer."],
      ["email", rule],
    ]);
    // The cover sheet explains the prefix itself; nothing stores the note.
    expect((await store.getTpsReport()).text).toStartWith(
      BASELINE_NOTE + "\n\n- Lead with the answer.",
    );
    // An edit may not leave a prefixed rule outside the catalog; dropping the
    // prefix makes it the person's own rule.
    const edit = (after: string) =>
      save({ exact_edits: [{ before: rule, after }] });
    // A refusal leaves the rule as filed.
    expect(await edit(near)).toMatchObject({
      status: "failed",
      error: "baseline_unknown",
    });
    expect((await cardHeads(local.db, "baseline")).at(-1)!.body).toBe(rule);
    expect(
      await save({ moves: [{ before: rule, report: "chat" }] }),
    ).toMatchObject({ error: "baseline_unknown" });
    const own = 'Sign off with "Cheers," and my first name.';
    expect((await edit(own)).status).toBe("saved");
    expect((await cardHeads(local.db, "baseline")).at(-1)!.body).toBe(own);
  } finally {
    await local.dispose();
  }
});

test("opt-in report guides fence lifecycle work without changing approved sources", async () => {
  const { setGuideEnrollment } = await import("../src/guides/store");
  const { runGuideWorker } = await import("../src/guides/worker");
  const { reportEnvelope, reportList } = await import("../src/store/tools");
  const local = await localStore();
  try {
    await seedUsers(local.pg, "guide-a", "guide-b");
    await local.pg
      .exec(`INSERT INTO sample_kinds(user_id,id,report,label) VALUES ('guide-a','kind','email','Fictional note');
      INSERT INTO trial_accounts(user_id,started_at,subscription_status,trial_end) VALUES
      ('guide-a',now(),'trialing',now()+interval '1 day')`);
    for (let i = 0; i < 10; i++)
      await seedSample(
        local.pg,
        "guide-a",
        `sample-${i}`,
        "email",
        "kind",
        {
          version: 1,
          summary: `Fictional garden note ${i}`,
          scope: { unit: "whole" },
        },
        `The seedlings are ready ${i}. Collect them on Saturday.`,
      );
    const store = fixtureStore(local.db, "guide-a");
    const original = await store.readDocuments();
    const exported = await store.exportTpsReport();
    expect(original.reports[0]!.guide).toBeUndefined();
    let seen = 0;
    let during: (() => Promise<void>) | undefined;
    let insufficient = false;
    const provider = {
      async count(request: { messages: { content: string }[] }) {
        const input = JSON.parse(request.messages[0]!.content);
        expect(input.samples).toHaveLength(10);
        expect(
          input.samples.every(
            (s: { revision: number; context: unknown; kind: string }) =>
              s.revision === 1 && s.context && s.kind,
          ),
        ).toBe(true);
        expect(Object.keys(input).sort()).toEqual(["report", "samples"]);
        seen++;
        return 1000;
      },
      async generate() {
        await during?.();
        return {
          stop_reason: "end_turn",
          usage: { input_tokens: 1000, output_tokens: 100 },
          content: [
            {
              type: "text",
              text: JSON.stringify({
                outcome: insufficient ? "insufficient_evidence" : "guide",
                tendencies: insufficient
                  ? []
                  : [
                      {
                        observation: "Open with the practical update.",
                        context: "Short collection notes.",
                        evidence: [{ sample_id: "sample-0", revision: 1 }],
                      },
                    ],
              }),
            },
          ],
        };
      },
    };
    expect(await runGuideWorker(local.db, provider, { maxReports: 1 })).toBe(0);
    await setGuideEnrollment(local.db, "guide-a", {
      enabled: true,
      optInReference: "fictional-consent",
    });
    expect(await runGuideWorker(local.db, provider, { maxReports: 1 })).toBe(1);
    let docs = await store.readDocuments();
    const guide = docs.reports[0]!.guide!;
    expect(guide.text).toContain("Open with the practical update.");
    expect(guide.stale).toBe(false);
    expect(docs.version).toBe(original.version);
    expect(await store.exportTpsReport()).toBe(exported);
    expect(reportEnvelope(docs, "email").guide).toEqual(
      reportList(docs).reports[0]!.guide,
    );
    expect(
      (await fixtureStore(local.db, "guide-b").readDocuments()).reports[0]!
        .guide,
    ).toBeUndefined();
    const rule = await store.saveMemo({
      text: "Fictional rule",
      rules: [{ report: "email", text: "Use plain words." }],
      expected_version: docs.version,
      request_id: crypto.randomUUID(),
    });
    expect(rule.status).toBe("saved");
    expect(await runGuideWorker(local.db, provider, { maxReports: 1 })).toBe(0);
    docs = await store.readDocuments();
    const context = {
      version: 1 as const,
      summary: "Fictional revised context",
    };
    expect(
      (
        await store.saveMemo({
          text: "Correct context",
          sample_context: { report: "email", sample_id: "sample-0", context },
          expected_version: docs.version,
          request_id: crypto.randomUUID(),
        })
      ).status,
    ).toBe("saved");
    docs = await store.readDocuments();
    expect(docs.reports[0]!.guide).toMatchObject({
      stale: true,
      status: "queued",
      text: guide.text,
    });
    const version = docs.version;
    // A stale completion after off/on is fenced, even if source is unchanged.
    provider.count = async () => 1000;
    during = async () => {
      await setGuideEnrollment(local.db, "guide-a", { enabled: false });
      expect((await store.readDocuments()).reports[0]!.guide).toBeUndefined();
      await setGuideEnrollment(local.db, "guide-a", {
        enabled: true,
        optInReference: "fictional-reconsent",
      });
    };
    await runGuideWorker(local.db, provider, { maxReports: 1 });
    docs = await store.readDocuments();
    expect(docs.reports[0]!.guide).toMatchObject({
      stale: true,
      text: guide.text,
      status: "queued",
    });
    expect(docs.version).toBe(version);
    during = undefined;
    insufficient = true;
    await runGuideWorker(local.db, provider, { maxReports: 1 });
    expect((await store.readDocuments()).reports[0]!.guide).toMatchObject({
      text: null,
      status: "insufficient",
      stale: false,
    });
    // Exact-source no-guide reuse keeps its successful terminal reason.
    await setGuideEnrollment(local.db, "guide-a", { enabled: false });
    await setGuideEnrollment(local.db, "guide-a", {
      enabled: true,
      optInReference: "fictional-reconsent",
    });
    expect((await store.readDocuments()).reports[0]!.guide).toMatchObject({
      text: null,
      status: "insufficient",
      reason: "insufficient_evidence",
      stale: false,
    });
    // Billing loss hides guides and prevents even token counting.
    await local.pg.exec(
      "UPDATE trial_accounts SET subscription_status='unknown' WHERE user_id='guide-a'",
    );
    expect((await store.readDocuments()).reports[0]!.guide).toBeUndefined();
    expect(await runGuideWorker(local.db, provider, { maxReports: 1 })).toBe(0);
    expect(seen).toBe(1);
    await local.pg.exec(
      "UPDATE trial_accounts SET subscription_status='active' WHERE user_id='guide-a'",
    );
    docs = await store.readDocuments();
    expect(
      (
        await store.saveMemo({
          text: "Remove fictional samples",
          retire_samples: docs.reports[0]!.samples.map((s) => s.id),
          expected_version: docs.version,
          request_id: crypto.randomUUID(),
        })
      ).status,
    ).toBe("saved");
    docs = await store.readDocuments();
    // Remaining samples beyond the served eight must also be removed.
    expect(
      (
        await store.saveMemo({
          text: "Remove remaining fictional samples",
          retire_samples: docs.reports[0]!.samples.map((s) => s.id),
          expected_version: docs.version,
          request_id: crypto.randomUUID(),
        })
      ).status,
    ).toBe("saved");
    expect((await store.readDocuments()).reports[0]!.guide).toMatchObject({
      text: null,
      status: "empty",
    });
    expect(await runGuideWorker(local.db, provider, { maxReports: 1 })).toBe(0);
  } finally {
    await local.dispose();
  }
});

test("guide leases, source moves, revoked eligibility and account deletion fence late work", async () => {
  const { setGuideEnrollment } = await import("../src/guides/store");
  const { runGuideWorker } = await import("../src/guides/worker");
  const local = await localStore();
  try {
    for (const mode of ["move", "revoke", "delete"] as const) {
      const id = `guide-${mode}`;
      await seedUsers(local.pg, id);
      await local.pg.query(
        "INSERT INTO sample_kinds(user_id,id,report,label) VALUES ($1,'email-kind','email','Fictional note'),($1,'chat-kind','chat','Fictional message')",
        [id],
      );
      await local.pg.query(
        "INSERT INTO trial_accounts(user_id,started_at,subscription_status) VALUES ($1,now(),'active')",
        [id],
      );
      await seedSample(
        local.pg,
        id,
        "example",
        "email",
        "email-kind",
        { version: 1, summary: "Fictional collection note" },
        "The seedlings are ready. Collect them on Saturday.",
      );
      await setGuideEnrollment(local.db, id, {
        enabled: true,
        optInReference: "fictional-consent",
      });
      let release!: () => void;
      let entered!: () => void;
      const waiting = new Promise<void>((r) => {
        release = r;
      });
      const started = new Promise<void>((r) => {
        entered = r;
      });
      const task = runGuideWorker(
        local.db,
        {
          count: async () => 100,
          async generate() {
            entered();
            await waiting;
            return {
              stop_reason: "end_turn",
              usage: { input_tokens: 100, output_tokens: 100 },
              content: [
                {
                  type: "text",
                  text: JSON.stringify({
                    outcome: "guide",
                    tendencies: [
                      {
                        observation: "Start with the update.",
                        context: "Collection notes.",
                        evidence: [{ sample_id: "example", revision: 1 }],
                      },
                    ],
                  }),
                },
              ],
            };
          },
        },
        { maxReports: 1 },
      );
      await started;
      expect(
        await runGuideWorker(
          local.db,
          {
            count: async () => {
              throw new Error("duplicate claim");
            },
            generate: async () => {
              throw new Error("duplicate call");
            },
          },
          { maxReports: 1 },
        ),
      ).toBe(0);
      if (mode === "move") {
        const store = fixtureStore(local.db, id);
        const docs = await store.readDocuments();
        expect(
          (
            await store.saveMemo({
              text: "Move fictional sample",
              sample: {
                sample_id: "example",
                report: "chat",
                kind_id: "chat-kind",
                context: { version: 1, summary: "Fictional chat note" },
                text: "The seedlings are ready. Collect them on Saturday.",
              },
              expected_version: docs.version,
              request_id: crypto.randomUUID(),
            })
          ).status,
        ).toBe("saved");
      } else if (mode === "revoke")
        await local.pg.query(
          "UPDATE trial_accounts SET subscription_status='canceled' WHERE user_id=$1",
          [id],
        );
      else await local.pg.query("DELETE FROM users WHERE id=$1", [id]);
      release();
      await task;
      const rows = await local.pg.query<{
        report: string;
        guide_text: string | null;
        status: string;
      }>(
        "SELECT report,guide_text,status FROM report_guides WHERE user_id=$1 ORDER BY report",
        [id],
      );
      expect(rows.rows.every((r) => r.guide_text === null)).toBe(true);
      if (mode === "delete") expect(rows.rows).toHaveLength(0);
      if (mode === "move") {
        expect(rows.rows.find((r) => r.report === "email")!.status).toBe(
          "empty",
        );
        expect(rows.rows.find((r) => r.report === "chat")!.status).toBe(
          "queued",
        );
      }
      await setGuideEnrollment(local.db, id, { enabled: false }).catch(
        (error) => {
          if (mode !== "delete") throw error;
        },
      );
    }
    expect(
      (await local.pg.query("SELECT * FROM guide_spend")).rows,
    ).toHaveLength(3);
  } finally {
    await local.dispose();
  }
});

test("guide reservations and recovery bound concurrent spend and retries", async () => {
  const { setGuideEnrollment } = await import("../src/guides/store");
  const { runGuideWorker } = await import("../src/guides/worker");
  const conservativeReservation = 1_120_000; // Full 200k input + 16,000 output, even for tiny reports.
  const local = await localStore();
  try {
    for (const id of ["budget-a", "budget-b"]) {
      await seedUsers(local.pg, id);
      await local.pg.query(
        "INSERT INTO sample_kinds(user_id,id,report,label) VALUES ($1,'kind','email','Fictional note')",
        [id],
      );
      await local.pg.query(
        "INSERT INTO trial_accounts(user_id,started_at,subscription_status) VALUES ($1,now(),'active')",
        [id],
      );
      await seedSample(
        local.pg,
        id,
        "example",
        "email",
        "kind",
        { version: 1, summary: "Fictional note" },
        "Collect the seedlings on Saturday.",
      );
      await setGuideEnrollment(local.db, id, {
        enabled: true,
        optInReference: "fictional-consent",
      });
    }
    await local.pg.exec(
      "UPDATE report_guides SET next_attempt_at=now()+interval '1 hour' WHERE user_id='budget-b'",
    );
    let calls = 0;
    const bad = {
      count: async () => 100,
      generate: async () => {
        calls++;
        return {
          stop_reason: "max_tokens",
          usage: { input_tokens: 100, output_tokens: 100 },
          content: [],
        };
      },
    };
    await runGuideWorker(local.db, bad, { maxReports: 1 });
    // A restart recovers an expired claim, counts the next attempt durably, then stops.
    await local.pg.exec(
      "UPDATE report_guides SET status='running',lease_token='abandoned',lease_until=now()-interval '1 second',next_attempt_at=now() WHERE user_id='budget-a' AND report='email'",
    );
    await runGuideWorker(local.db, bad, { maxReports: 1 });
    expect(calls).toBe(2);
    expect(
      (
        await local.pg.query(
          "SELECT status,attempts FROM report_guides WHERE user_id='budget-a' AND report='email'",
        )
      ).rows,
    ).toEqual([{ status: "failed", attempts: 2 }]);
    await setGuideEnrollment(local.db, "budget-a", { enabled: false });
    // Reserve against a nearly-full global day. Unknown outcomes keep their reservation.
    await local.pg.query(
      "INSERT INTO guide_spend(id,account_key,amount_micros) VALUES ('prior','fictional',$1)",
      [5_000_000 - conservativeReservation - 6000],
    );
    await local.pg.exec(
      "UPDATE report_guides SET next_attempt_at=now() WHERE user_id='budget-b'",
    );
    const unknown = {
      count: async () => 100,
      generate: async () => {
        calls++;
        throw new Error("unknown outcome");
      },
    };
    await Promise.all([
      runGuideWorker(local.db, unknown, { maxReports: 1 }),
      runGuideWorker(local.db, unknown, { maxReports: 1 }),
    ]);
    expect(calls).toBe(3);
    const [spent] = (
      await local.pg.query<{ n: number; unknown: number }>(
        "SELECT sum(amount_micros)::int AS n,count(*) FILTER(WHERE NOT settled)::int AS unknown FROM guide_spend",
      )
    ).rows;
    expect(spent!.n).toBeLessThanOrEqual(5_000_000);
    expect(spent!.unknown).toBe(2); // prior + unknown request
    expect(
      (
        await local.pg.query(
          "SELECT amount_micros FROM guide_spend WHERE NOT settled AND id<>'prior'",
        )
      ).rows,
    ).toEqual([{ amount_micros: conservativeReservation }]);
    await local.pg.exec(
      "UPDATE report_guides SET next_attempt_at=now() WHERE user_id='budget-b'",
    );
    await runGuideWorker(local.db, unknown, { maxReports: 1 });
    expect(calls).toBe(3); // global day cap prevents another conservative reservation
    await local.pg.exec("DELETE FROM users WHERE id='budget-b'");
    expect(
      (await local.pg.query("SELECT * FROM guide_spend")).rows,
    ).toHaveLength(4);
  } finally {
    await local.dispose();
  }
});

test("guide bounds reject whole oversize input before processing and reserve monthly/account caps", async () => {
  const { setGuideEnrollment } = await import("../src/guides/store");
  const { runGuideWorker } = await import("../src/guides/worker");
  const conservativeReservation = 1_120_000; // Full 200k input + 16,000 output, even for tiny reports.
  const local = await localStore();
  try {
    await seedUsers(local.pg, "bounded");
    await local.pg.exec(
      "INSERT INTO sample_kinds(user_id,id,report,label) VALUES ('bounded','kind','email','Fictional note'); INSERT INTO trial_accounts(user_id,started_at,subscription_status) VALUES ('bounded',now(),'active')",
    );
    for (let i = 0; i < 2; i++)
      await seedSample(
        local.pg,
        "bounded",
        `large-${i}`,
        "email",
        "kind",
        { version: 1, summary: `Fictional long note ${i}` },
        "Seedlings. ".repeat(9000),
      );
    await setGuideEnrollment(local.db, "bounded", {
      enabled: true,
      optInReference: "fictional-consent",
    });
    let counts = 0,
      calls = 0,
      inputTokens = 100;
    const provider = {
      count: async () => {
        counts++;
        return inputTokens;
      },
      generate: async () => {
        calls++;
        throw new Error("unknown outcome");
      },
    };
    await runGuideWorker(local.db, provider, { maxReports: 1 });
    expect([counts, calls]).toEqual([0, 0]);
    expect(
      (await fixtureStore(local.db, "bounded").readDocuments()).reports[0]!
        .guide,
    ).toMatchObject({
      status: "unavailable",
      reason: "input_too_large",
      text: null,
    });
    // Shrink all originals through approved complete revisions; rules do not enter input.
    const store = fixtureStore(local.db, "bounded");
    for (let i = 0; i < 2; i++)
      expect(
        (
          await store.saveMemo({
            text: "Fictional revision",
            sample: {
              sample_id: `large-${i}`,
              report: "email",
              kind_id: "kind",
              context: { version: 1, summary: `Fictional short note ${i}` },
              text: `Collect ${i + 1} trays on Saturday.`,
            },
            expected_version: (await store.readDocuments()).version,
            request_id: crypto.randomUUID(),
          })
        ).status,
      ).toBe("saved");
    // Prior global-month spending may sit on a different UTC day.
    await local.pg.query(
      "INSERT INTO guide_spend(id,account_key,amount_micros,created_at) VALUES ('month','fictional',$1,date_trunc('month',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')",
      [20_000_000 - conservativeReservation + 1],
    );
    await runGuideWorker(local.db, provider, { maxReports: 1 });
    expect(calls).toBe(0);
    expect((await store.readDocuments()).reports[0]!.guide).toMatchObject({
      status: "unavailable",
      reason: "budget_limit",
    });
    // An isolated local scenario resets only fictional ledger rows, never production.
    await local.pg.exec("DELETE FROM guide_spend WHERE id='month'");
    inputTokens = 200_000; // A full-sized report still reserves the complete input ceiling.
    await setGuideEnrollment(local.db, "bounded", { enabled: false });
    await setGuideEnrollment(local.db, "bounded", {
      enabled: true,
      optInReference: "fictional-reconsent",
    });
    await runGuideWorker(local.db, provider, { maxReports: 1 });
    expect(calls).toBe(1);
    await local.pg.exec(
      "UPDATE report_guides SET next_attempt_at=now() WHERE user_id='bounded'",
    );
    await runGuideWorker(local.db, provider, { maxReports: 1 });
    expect(calls).toBe(1); // $2 account/day blocks another unknown $1.12 request
    expect(
      (
        await local.pg.query<{ amount_micros: number }>(
          "SELECT amount_micros FROM guide_spend",
        )
      ).rows,
    ).toEqual([{ amount_micros: 1_120_000 }]);
  } finally {
    await local.dispose();
  }
});

test("guide billing records recognized usage up or down once and retains unknown reservations", async () => {
  const { settleGuideSpend } = await import("../src/guides/worker");
  const local = await localStore();
  try {
    await local.pg.exec(
      "INSERT INTO guide_spend(id,account_key,amount_micros) VALUES ('up','fictional',1120000),('down','fictional',1120000),('unknown','fictional',1120000)",
    );
    // Usage beyond the activation bound still costs money even when no guide can activate.
    await settleGuideSpend(local.db, "up", {
      usage: { input_tokens: 200001, output_tokens: 16000 },
    });
    await Promise.all([
      settleGuideSpend(local.db, "up", {
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
      settleGuideSpend(local.db, "up", {
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
    ]);
    await settleGuideSpend(local.db, "down", {
      stop_reason: "max_tokens",
      usage: { input_tokens: 100, output_tokens: 100 },
    });
    await settleGuideSpend(local.db, "unknown", {});
    expect(
      (
        await local.pg.query(
          "SELECT id,amount_micros,settled FROM guide_spend ORDER BY id",
        )
      ).rows,
    ).toEqual([
      { id: "down", amount_micros: 2400, settled: true },
      { id: "unknown", amount_micros: 1120000, settled: false },
      { id: "up", amount_micros: 1120004, settled: true },
    ]);
  } finally {
    await local.dispose();
  }
});
