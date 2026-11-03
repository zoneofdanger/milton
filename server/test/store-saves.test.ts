import { cardHeads } from "../src/store/cards";
import { compiledMemos, type SaveMemoInput } from "../src/store/compiled";
import { expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { databaseFailure } from "../src/store/database";
import { StoreError } from "../src/store/errors";
import { localStore } from "./local-store";
import { betweenPhases, fixtureStore, seedUsers } from "./store-fixtures";

test("compiled saves publish memos and TPS together and charge once with durable replay", async () => {
  const local = await localStore();
  try {
    await seedUsers(local.pg, "compiled-a", "compiled-b");
    let calls = 0;
    const store = fixtureStore(
      betweenPhases(local.db, async () => calls++),
      "compiled-a",
      "assistant",
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
      "- Ask before sending.",
      "- Be concise.",
    ]);
    expect(current.version).not.toBe(empty.version);
    expect(await store.saveMemo(input)).toEqual(saved);
    expect(calls).toBe(1);
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
    await seedUsers(local.pg, "fidelity", "fidelity-other");
    const source =
      "Where relevant, identify products by their full model names.\n\nKeep exceptions intact.\n";
    const companion = "  Keep units explicit: µm.\r\nDo not infer a model.  ";
    // Each rule prints as a bullet ahead of its exact stored bytes.
    const exact = "- " + companion + "\n\n- " + source;
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
    const store = fixtureStore(
      betweenPhases(local.db, async () => {
        if (slow) {
          started();
          await held;
        }
      }),
      "fidelity",
      "assistant",
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
    await seedUsers(local.pg, "race", "foreign");
    let release!: () => void, started!: () => void;
    const begun = new Promise<void>((r) => {
      started = r;
    });
    const held = new Promise<void>((r) => {
      release = r;
    });
    // Claims that reached the write phase; the first one waits there.
    let calls = 0;
    const store = fixtureStore(
      betweenPhases(local.db, async () => {
        if (++calls === 1) {
          started();
          await held;
        }
      }),
      "race",
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
          "SELECT count(*)::int AS n FROM accepted_changes WHERE user_id='race'",
        )
      ).rows,
    ).toEqual([{ n: 2 }]);
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

test("saves anchor in every active memo, never archived or foreign text, and have no technical write cap", async () => {
  const local = await localStore();
  try {
    await seedUsers(local.pg, "collection", "other");
    await local.pg
      .exec(`INSERT INTO memos(user_id,id,name) SELECT 'collection','m-'||n,'memo-'||n FROM generate_series(1,52) n;
      INSERT INTO memo_versions(user_id,memo_id,version,description,body,archived,reason,actor_json)
        SELECT user_id,id,1,'Scoped instruction','Instruction '||id,id='m-52','Fixture','{}' FROM memos;
      INSERT INTO memos(user_id,id,name) VALUES ('other','foreign-id','other');
      INSERT INTO memo_versions(user_id,memo_id,version,description,body,reason,actor_json) VALUES ('other','foreign-id',1,'Other','Never exposed','Fixture','{}');`);
    const store = fixtureStore(local.db, "collection");
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
    // Every active memo is in the snapshot; archived and foreign text is not.
    for (const anchor of ["Instruction m-52", "Never exposed"])
      expect((await send(anchor, "Changed")).error).toBe("edit_conflict");
    expect((await store.getTpsReport()).version).toBe(base);
    expect(
      (await send("Instruction m-51", "Instruction m-51 changed")).status,
    ).toBe("saved");
    base = (await store.getTpsReport()).version;
    // The stored daily_writes key is retired: a value of 1 refuses nothing, and
    // saves leave no per-day write counter. The memo-update cap is the save cap.
    await local.pg.exec(
      `UPDATE store_config SET limits_json=limits_json || '{"daily_writes":1}'::jsonb`,
    );
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
    await local.pg
      .exec(`INSERT INTO memos(user_id,id,name) VALUES ('targeted','a','a'),('targeted','b','b'),('targeted','c','c');
      INSERT INTO memo_versions(user_id,memo_id,version,description,body,reason,actor_json)
        SELECT user_id,id,1,'Instruction '||id,'Preserve '||id||' exactly.','Fixture','{}' FROM memos;`);
    let calls = 0;
    const store = fixtureStore(
      betweenPhases(local.db, async () => calls++),
      "targeted",
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
    for (const m of sources) {
      await local.db.query(
        sql`INSERT INTO memos(user_id,id,name) VALUES ('exact',${m.id},${m.id})`,
      );
      await local.db.query(
        sql`INSERT INTO memo_versions(user_id,memo_id,version,description,body,reason,actor_json) VALUES ('exact',${m.id},1,${"Instruction " + m.id},${m.body},'Fixture','{}')`,
      );
    }
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

test("Postgres enforces separate UTF-8 field caps, no memo count, and counts recovery bytes", async () => {
  const local = await localStore();
  try {
    await seedUsers(local.pg, "m_caps");
    await local.pg.exec(
      `UPDATE store_config SET limits_json=limits_json || '{"memos":1}'::jsonb;`,
    );
    // limits_json.memos is unread since 0021: memos have no count limit.
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
    await local.pg.query(
      "INSERT INTO memos (user_id,id,name) VALUES ('m_caps','second','second')",
    );
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
    await local.pg.query(
      "INSERT INTO memos (user_id,id,name) VALUES ('m_caps','third','third')",
    );
  } finally {
    await local.dispose();
  }
}, 30000);

test("Postgres version conflicts and history-cap refusals return typed errors", async () => {
  const local = await localStore();
  const userId = "m_00000000-0000-4000-8000-000000000001";
  try {
    await seedUsers(local.pg, userId);
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
    const history = await local.db
      .query(
        sql`INSERT INTO memo_versions (user_id,memo_id,version,description,body,reason,actor_json)
      VALUES (${userId},'memo',2,'Sample.','# Imported','edit','{}')`,
      )
      .catch(databaseFailure);
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

test("instruction cards edit independently inside a memo, keep write-once grouping, and fence stale changes", async () => {
  const local = await localStore();
  try {
    await seedUsers(local.pg, "cards");
    await local.pg
      .exec(`INSERT INTO memos(user_id,id,name) VALUES ('cards','a','writing'),('cards','b','actions');
      INSERT INTO memo_versions(user_id,memo_id,version,description,body,reason,actor_json) VALUES
      ('cards','a',1,'Writing','When comparing products, include units.','Fixture','{}'),
      ('cards','b',1,'Actions','Ask before sending.','Fixture','{}');`);
    const store = fixtureStore(local.db, "cards", "assistant");
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

test("accepted change evidence replays once and rolls back with an over-quota save", async () => {
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

test("a conflict or refusal in the claim phase stores a receipt and replays like one found in the apply phase", async () => {
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
    await expect(
      store.saveMemo({ ...stale, text: "Different input." }),
    ).rejects.toMatchObject({ code: "request_id_reused" });
    // A refusal decided against the request replays the same way.
    const oversized = {
      ...rule("Large.", (await store.getTpsReport()).version),
      rules: ["a", "b", "c"].map((c) => ({
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
          "SELECT result_json->>'status' AS status FROM save_requests WHERE user_id='replay' AND completed ORDER BY created_at",
        )
      ).rows.map((row) => row.status),
    ).toEqual(["saved", "conflict", "saved", "failed"]);
  } finally {
    await local.dispose();
  }
});
