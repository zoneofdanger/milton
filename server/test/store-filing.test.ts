import { cardHeads, cardFingerprint } from "../src/store/cards";
import type { SaveMemoInput } from "../src/store/compiled";
import { expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { localStore } from "./local-store";
import { fixtureStore, seedUsers } from "./store-fixtures";
import { coverSheet, reportEnvelope } from "../src/store/tools";

const enableMemoUpdates =
  "UPDATE store_config SET global_spend_policy='alerts_only',foreground_accounting_ready=true,memo_updates_enabled=true";

test("rules are stored byte for byte, one card each, with one charge", async () => {
  const local = await localStore();
  try {
    await seedUsers(local.pg, "rules");
    await local.pg.exec(enableMemoUpdates);
    const store = fixtureStore(local.db, "rules");
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
          "SELECT count(*)::int AS n FROM accepted_changes WHERE user_id='rules'",
        )
      ).rows,
    ).toEqual([{ n: 1 }]);
  } finally {
    await local.dispose();
  }
});

test("every rule reads as one bullet, whether stored with the compiler's leading dash or as sent", async () => {
  const local = await localStore();
  try {
    await seedUsers(local.pg, "bullets");
    const store = fixtureStore(local.db, "bullets");
    // The retired compiler stored "- " before each rule; saves since store the rule as sent.
    const rules = [
      { report: "cover" as const, text: "- Never use em dashes." },
      { report: "cover" as const, text: "Use the Oxford comma." },
      { report: "email" as const, text: "- Sign off with Best." },
      { report: "email" as const, text: "Open with Hi and a first name." },
    ];
    expect(
      await store.saveMemo({
        text: "Add four fictional rules.",
        request_id: crypto.randomUUID(),
        expected_version: (await store.getTpsReport()).version,
        rules,
      }),
    ).toMatchObject({ status: "saved" });
    const documents = await store.readDocuments();
    expect(documents.cover).toBe(
      "- Never use em dashes.\n\n- Use the Oxford comma.",
    );
    expect(
      reportEnvelope(documents, "email").text.split("\n\n").slice(2),
    ).toEqual(["- Sign off with Best.", "- Open with Hi and a first name."]);
    expect(coverSheet(documents).text).toBe(documents.cover);
    // Assembly is presentation only: the stored cards keep their exact bytes.
    expect(
      (
        await local.pg.query(
          "SELECT body FROM instruction_card_versions WHERE user_id='bullets' ORDER BY body",
        )
      ).rows.map((r) => (r as { body: string }).body),
    ).toEqual(rules.map((r) => r.text).sort());
  } finally {
    await local.dispose();
  }
});

test("edits and moves accept a quoted bullet for rules stored with or without the dash", async () => {
  const local = await localStore();
  try {
    await seedUsers(local.pg, "anchors");
    const store = fixtureStore(local.db, "anchors");
    const save = async (change: Partial<SaveMemoInput>) =>
      store.saveMemo({
        text: "Fictional change.",
        request_id: crypto.randomUUID(),
        expected_version: (await store.getTpsReport()).version,
        ...change,
      });
    const bodies = async () =>
      (
        await local.pg.query(
          `SELECT DISTINCT ON (card_id) report,body FROM instruction_card_versions
          WHERE user_id='anchors' AND NOT archived ORDER BY card_id,version DESC`,
        )
      ).rows
        .map((r) => r as { report: string; body: string })
        .sort((a, b) => a.body.localeCompare(b.body));
    expect(
      await save({
        rules: [
          { report: "cover", text: "- Old rule here." },
          { report: "cover", text: "New rule here." },
          { report: "cover", text: "Shared phrase one." },
          { report: "cover", text: "Shared phrase two." },
        ],
      }),
    ).toMatchObject({ status: "saved" });
    // Both quoted as printed: the old one matches verbatim, the new one without
    // its printed dash, and a copied bullet in after is not doubled.
    expect(
      await save({
        exact_edits: [
          { before: "- Old rule here.", after: "- Old rule changed." },
          { before: "- New rule here.", after: "- New rule changed." },
        ],
      }),
    ).toMatchObject({ status: "saved" });
    expect(
      await save({
        moves: [
          { before: "- Old rule changed.", report: "email" },
          { before: "- New rule changed.", report: "email" },
        ],
      }),
    ).toMatchObject({ status: "saved" });
    // The new-style rule still matches without the dash.
    expect(
      await save({
        exact_edits: [
          { before: "New rule changed.", after: "New rule edited." },
        ],
        moves: [{ before: "New rule changed.", report: "chat" }],
      }),
    ).toMatchObject({ status: "saved" });
    expect(await bodies()).toEqual([
      { report: "email", body: "- Old rule changed." },
      { report: "chat", body: "New rule edited." },
      { report: "cover", body: "Shared phrase one." },
      { report: "cover", body: "Shared phrase two." },
    ]);
    // Ambiguity is unchanged: a bullet-stripped anchor in two rules conflicts.
    const before = await bodies();
    expect(
      await save({ exact_edits: [{ before: "- Shared phrase", after: "x" }] }),
    ).toMatchObject({ status: "failed", error: "edit_conflict" });
    expect(
      await save({ moves: [{ before: "- Shared phrase", report: "post" }] }),
    ).toMatchObject({ status: "failed", error: "move_conflict" });
    expect(await bodies()).toEqual(before);
  } finally {
    await local.dispose();
  }
});

test("anchors resolve against the printed rules, so a quote never lands on a rule the person did not see it in", async () => {
  const local = await localStore();
  try {
    await seedUsers(local.pg, "printed");
    const store = fixtureStore(local.db, "printed");
    const save = async (change: Partial<SaveMemoInput>) =>
      store.saveMemo({
        text: "Fictional change.",
        request_id: crypto.randomUUID(),
        expected_version: (await store.getTpsReport()).version,
        ...change,
      });
    const bodies = async () =>
      (
        await local.pg.query(
          `SELECT DISTINCT ON (card_id) report,body FROM instruction_card_versions
          WHERE user_id='printed' AND NOT archived ORDER BY card_id,version DESC`,
        )
      ).rows
        .map((r) => r as { report: string; body: string })
        .sort((a, b) => a.body.localeCompare(b.body));
    expect(
      await save({
        rules: [
          { report: "cover", text: "Be concise" },
          { report: "cover", text: "In email:\n- Be concise" },
          { report: "cover", text: "- Be concise when replying" },
          { report: "cover", text: "Avoid jargon and filler." },
          { report: "cover", text: "Short." },
        ],
      }),
    ).toMatchObject({ status: "saved" });
    const filed = await bodies();
    // "- Be concise" is printed in three rules: the bare one, the multi-line
    // one's second line and the compiler-era one. Each quote is refused, as are
    // quotes that appear nowhere in the printed text.
    for (const before of [
      "- Be concise",
      "-  ",
      "- \t",
      "- jargon",
      "- ",
      "-",
    ]) {
      expect(
        await save({ exact_edits: [{ before, after: "- Be brief" }] }),
      ).toMatchObject({ status: "failed", error: "edit_conflict" });
      expect(
        await save({ moves: [{ before, report: "email" }] }),
      ).toMatchObject({ status: "failed", error: "move_conflict" });
    }
    expect(await bodies()).toEqual(filed);
    // Quotes unique in the printed text land on the rule they were copied from.
    expect(
      await save({
        exact_edits: [
          {
            before: "- Be concise when replying",
            after: "- Be brief when replying",
          },
          { before: "In email:\n- Be concise", after: "In email:\n- Be brief" },
          { before: "- Avoid jargon and filler.", after: "- Avoid filler." },
        ],
        moves: [{ before: "- Short.", report: "chat" }],
      }),
    ).toMatchObject({ status: "saved" });
    expect(await bodies()).toEqual([
      { report: "cover", body: "- Be brief when replying" },
      { report: "cover", body: "Avoid filler." },
      { report: "cover", body: "Be concise" },
      { report: "cover", body: "In email:\n- Be brief" },
      { report: "chat", body: "Short." },
    ]);
    expect((await store.readDocuments()).cover).toBe(
      "- Be concise\n\n- In email:\n- Be brief\n\n- Be brief when replying\n\n- Avoid filler.",
    );
  } finally {
    await local.dispose();
  }
});

test("duplicate checks compare printed rules, so a bare rule beside its compiler-era twin is skipped or refused", async () => {
  const local = await localStore();
  try {
    await seedUsers(local.pg, "twins");
    const store = fixtureStore(local.db, "twins");
    const save = async (change: Partial<SaveMemoInput>) =>
      store.saveMemo({
        text: "Fictional change.",
        request_id: crypto.randomUUID(),
        expected_version: (await store.getTpsReport()).version,
        ...change,
      });
    expect(
      await save({
        rules: [
          { report: "cover", text: "- Be concise." },
          { report: "cover", text: "Be brief." },
        ],
      }),
    ).toMatchObject({ status: "saved" });
    // "Be concise." prints exactly as the compiler-era "- Be concise.".
    expect(
      await save({ rules: [{ report: "cover", text: "Be concise." }] }),
    ).toMatchObject({ status: "unchanged" });
    expect(
      await save({
        exact_edits: [{ before: "Be brief.", after: "Be concise." }],
      }),
    ).toMatchObject({ status: "failed", error: "edit_conflict" });
    expect((await store.readDocuments()).cover).toBe(
      "- Be concise.\n\n- Be brief.",
    );
  } finally {
    await local.dispose();
  }
});

test("the report cap measures the printed text, bullets included", async () => {
  const local = await localStore();
  try {
    await seedUsers(local.pg, "capped");
    const store = fixtureStore(local.db, "capped");
    // Long enough that the cover sheet, not an empty report's heading, binds.
    const rule = "Keep it short. ".repeat(20).trim();
    // The stored rule fits the cap; printed with its bullet it is one byte over.
    await local.pg.exec(
      `UPDATE store_config SET limits_json=limits_json || '{"report_body_bytes":${rule.length + 1}}'::jsonb`,
    );
    const save = async (text: string) =>
      store.saveMemo({
        text: "Fictional change.",
        request_id: crypto.randomUUID(),
        expected_version: (await store.getTpsReport()).version,
        rules: [{ report: "cover", text }],
      });
    expect(await save(rule)).toMatchObject({
      status: "failed",
      error: "tps_body_limit",
    });
    expect((await store.readDocuments()).cover).toBe("");
    await local.pg.exec(
      `UPDATE store_config SET limits_json=limits_json || '{"report_body_bytes":${rule.length + 2}}'::jsonb`,
    );
    expect(await save(rule)).toMatchObject({ status: "saved" });
    expect((await store.readDocuments()).cover).toBe("- " + rule);
  } finally {
    await local.dispose();
  }
});

test("an exact duplicate rule is skipped as unchanged without a charge", async () => {
  const local = await localStore();
  try {
    await seedUsers(local.pg, "dupes");
    await local.pg.exec(enableMemoUpdates);
    const store = fixtureStore(local.db, "dupes");
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
          "SELECT count(*)::int AS n FROM accepted_changes WHERE user_id='dupes'",
        )
      ).rows,
    ).toEqual([{ n: 2 }]);
  } finally {
    await local.dispose();
  }
});

test("a save that would leave two identical rules in one report is refused; re-adding a removed rule saves it", async () => {
  const local = await localStore();
  try {
    await seedUsers(local.pg, "collide");
    const store = fixtureStore(local.db, "collide");
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
    await seedUsers(local.pg, "bad-rules");
    const store = fixtureStore(local.db, "bad-rules");
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
    await seedUsers(local.pg, "prose");
    const store = fixtureStore(local.db, "prose");
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

test("reports print a heading, when line, samples newest first and rules; samples replace per kind; card text cannot add headings", async () => {
  const local = await localStore();
  try {
    await seedUsers(local.pg, "reports");
    await local.pg
      .exec(`INSERT INTO memos(user_id,id,name) VALUES ('reports','w','working');
      INSERT INTO memo_versions(user_id,memo_id,version,description,body,reason,actor_json) VALUES
      ('reports','w',1,'One','- No em dashes.','Fixture','{}');`);
    const store = fixtureStore(local.db, "reports", "assistant");
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
  await seedUsers(local.pg, userId);
  const store = fixtureStore(local.db, userId, "assistant");
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

test("an account has no card count limit: 120 creates and 60 removals all save", async () => {
  const local = await localStore();
  try {
    await seedUsers(local.pg, "many");
    const store = fixtureStore(local.db, "many");
    const rule = (n: number) => `Fictional rule ${n}.`;
    const save = async (change: Partial<SaveMemoInput>) =>
      (
        await store.saveMemo({
          text: "A fictional change.",
          request_id: crypto.randomUUID(),
          expected_version: (await store.getTpsReport()).version,
          ...change,
        })
      ).status;
    for (let batch = 0; batch < 6; batch++)
      expect(
        await save({
          rules: Array.from({ length: 20 }, (_, i) => ({
            report: "cover" as const,
            text: rule(batch * 20 + i),
          })),
        }),
      ).toBe("saved");
    for (let batch = 0; batch < 3; batch++)
      expect(
        await save({
          exact_edits: Array.from({ length: 20 }, (_, i) => ({
            before: rule(batch * 20 + i),
            after: "",
          })),
        }),
      ).toBe("saved");
    expect(
      (
        await local.pg.query(
          "SELECT count(*)::int AS cards, count(*) FILTER (WHERE NOT archived)::int AS active FROM (SELECT DISTINCT ON (card_id) archived FROM instruction_card_versions WHERE user_id='many' ORDER BY card_id,version DESC) h",
        )
      ).rows,
    ).toEqual([{ cards: 120, active: 60 }]);
  } finally {
    await local.dispose();
  }
}, 30000);
