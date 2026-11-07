import { cardFingerprint } from "../src/store/cards";
import type { ReportIntent } from "../src/store/reports";
import type { SaveMemoInput } from "../src/store/compiled";
import { expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { localStore } from "./local-store";
import {
  cardHeads,
  fixtureStore,
  seedRule,
  seedUsers,
  seedSample,
} from "./store-fixtures";
import { coverSheet, reportEnvelope } from "../src/mcp-tools";

test("rules are stored byte for byte, one card each", async () => {
  const local = await localStore();
  try {
    await seedUsers(local.pg, "rules");
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
    expect(saved.status).toBe("saved");
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

test("a read that rebuilds a lagging snapshot serves it whatever the save-time cap", async () => {
  const local = await localStore();
  try {
    await seedUsers(local.pg, "lagging");
    const store = fixtureStore(local.db, "lagging");
    const rule = "Keep it short. ".repeat(20).trim();
    expect(
      await store.saveMemo({
        text: "Fictional change.",
        request_id: crypto.randomUUID(),
        expected_version: (await store.getTpsReport()).version,
        rules: [{ report: "cover", text: rule }],
      }),
    ).toMatchObject({ status: "saved" });
    // The cap drops below the stored report, then the sources move on
    // without a save (as an administrative fix would), so the next read rebuilds.
    await local.pg.exec(
      `UPDATE store_config SET limits_json=limits_json || '{"report_body_bytes":16}'::jsonb;
      INSERT INTO instruction_card_versions(user_id,card_id,version,description,body,report,reason,actor_json)
        SELECT user_id,card_id,2,description,body || ' Always.',report,'Fixture','{}' FROM instruction_card_versions WHERE user_id='lagging';`,
    );
    const read = await store.getTpsReport();
    expect(read.text).toBe("- " + rule + " Always.");
    expect((await store.readDocuments()).cover).toBe(read.text);
    // Saves still enforce the cap.
    expect(
      await store.saveMemo({
        text: "Fictional change.",
        request_id: crypto.randomUUID(),
        expected_version: read.version,
        rules: [{ report: "cover", text: "Another rule." }],
      }),
    ).toMatchObject({ status: "failed", error: "tps_body_limit" });
  } finally {
    await local.dispose();
  }
});

test("an exact duplicate rule is skipped as unchanged", async () => {
  const local = await localStore();
  try {
    await seedUsers(local.pg, "dupes");
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
      Array.from({ length: 101 }, (_, i) => ({ ...rule, text: `Rule ${i}.` })),
      [],
      [{ ...rule, report: "linkedin" }],
      [{ ...rule, text: " \n " }],
    ])
      await expect(
        store.saveMemo({ ...base, rules } as SaveMemoInput),
      ).rejects.toMatchObject({
        code: "invalid_input",
        message:
          "rules takes 1–100 entries, each with a report (one of the five, doc or cover) and non-blank text. Nothing was changed.",
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

test("reports print a heading, when line, the newest eight samples and rules; card text cannot add headings", async () => {
  const local = await localStore();
  try {
    await seedUsers(local.pg, "reports");
    await seedRule(local.pg, "reports", "w", "- No em dashes.");
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
    // Cover-sheet rules print their exact text.
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
          context: { version: 1 as const, summary: `${kind} context` },
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
    // A third sample of one kind stays on file and is served: without an
    // intent a report serves its newest eight, whatever their kinds.
    expect(await sample("follow-up", "Third follow-up")).toMatchObject({
      status: "saved",
    });
    expect(
      (await store.readDocuments()).reports
        .find((r) => r.id === "email")!
        .samples.map((s) => s.body),
    ).toEqual(["Third follow-up", "Second follow-up", "Hi [name],\n\nThanks!"]);
    expect(
      (
        await local.pg.query(
          "SELECT body,NOT retired AS live FROM sample_versions WHERE user_id='reports' AND kind_id IN (SELECT id FROM sample_kinds WHERE label='follow-up') ORDER BY created_at,sample_id",
        )
      ).rows,
    ).toEqual([
      { body: "Hi [name],\n\nThanks!", live: true },
      { body: "Second follow-up", live: true },
      { body: "Third follow-up", live: true },
    ]);
    await expect(
      local.pg.query(
        "UPDATE sample_versions SET body='Edited' WHERE user_id='reports' AND body='Third follow-up'",
      ),
    ).rejects.toThrow("sample_version_is_immutable");
    await expect(
      local.pg.query("DELETE FROM sample_versions WHERE user_id='reports'"),
    ).rejects.toThrow("sample_version_is_immutable");
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

test("a reused kind_id shares one kind; every sample stays and is served, and a save replays identically", async () => {
  const f = await filingFixture("kinds-keep");
  try {
    const sample = (text: string, kind: object) => ({
      sample: {
        report: "email",
        context: { version: 1 as const, summary: "after a call" },
        text,
        ...kind,
      },
    });
    await f.save(sample("One", { new_kind: "Follow-up" }));
    const kind = (await f.report("email")).samples[0]!;
    expect(kind.kind).toBe("Follow-up");
    await expect(
      f.local.pg.query(
        "UPDATE sample_kinds SET label='Other' WHERE user_id='kinds-keep'",
      ),
    ).rejects.toThrow("sample_kind_is_immutable");

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
          context: { version: 1 as const, summary: "after a call" },
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
    expect(saved.status).toBe("saved");
    expect(saved.samples_retired).toBeUndefined();
    expect(await f.store.saveMemo(input)).toEqual(saved);
    expect((await f.report("email")).samples.map((s) => s.body)).toEqual([
      "Three",
      "Two",
      "One",
    ]);
    expect(
      (
        await f.local.pg.query(
          "SELECT body FROM sample_versions WHERE user_id='kinds-keep' AND NOT retired ORDER BY created_at",
        )
      ).rows,
    ).toEqual([{ body: "One" }, { body: "Two" }, { body: "Three" }]);
  } finally {
    await f.local.dispose();
  }
});

test("sample revisions keep identity and immutable complete snapshots, replay and retire explicitly", async () => {
  const f = await filingFixture("sample-revisions");
  try {
    const context = { version: 1 as const, summary: "First fictional launch." };
    const first = {
      report: "post" as const,
      new_kind: "launch post",
      context,
      text: "  Old\r\n😀  ",
    };
    // Valid uppercase request UUIDs retain their exact bytes through save and replay.
    const creationRequest = "A1C13E43-10F9-47CE-98D9-C8B23A102DC5";
    expect(
      await f.save({ sample: first, request_id: creationRequest }),
    ).toMatchObject({ status: "saved", request_id: creationRequest });
    const original = (await f.report("post")).samples[0]!;
    const next = {
      report: "post" as const,
      kind_id: original.kind_id,
      sample_id: original.id,
      context: {
        version: 1 as const,
        summary: "Second fictional launch.",
        purposes: ["announce"],
      },
      text: "  New\r\n😀  ",
    };
    const input = {
      text: "Revise the approved example.",
      request_id: "9AA52382-1122-4F71-A44A-B4E848EA8347",
      expected_version: (await f.store.getTpsReport()).version,
      sample: next,
    };
    const saved = await f.store.saveMemo(input);
    await expect(
      f.local.pg.query(
        "UPDATE samples SET created_at=now() WHERE user_id='sample-revisions'",
      ),
    ).rejects.toThrow("sample_identity_is_immutable");
    await expect(
      f.local.pg
        .query(`INSERT INTO sample_versions(user_id,sample_id,version,report,kind_id,context,body,actor_json,request_id)
      SELECT user_id,sample_id,4,report,kind_id,context,body,actor_json,request_id FROM sample_versions WHERE user_id='sample-revisions' AND version=2`),
    ).rejects.toThrow("sample_version_conflict");

    expect(saved).toMatchObject({
      status: "saved",
      request_id: input.request_id,
    });
    expect(saved.samples_retired).toBeUndefined();
    expect(await f.store.saveMemo(input)).toEqual(saved);
    expect(await f.save({ sample: next })).toMatchObject({
      status: "unchanged",
      version: saved.version,
    });
    expect(
      await f.save({ ...input, request_id: crypto.randomUUID() }),
    ).toMatchObject({ status: "conflict" });
    const current = (await f.report("post")).samples[0]!;
    expect(current).toMatchObject({
      id: original.id,
      revision: 2,
      body: next.text,
      context: next.context,
      created_at: original.created_at,
    });
    expect(current.revised_at > original.revised_at).toBe(true);
    expect(
      reportEnvelope(await f.store.readDocuments(), "post").samples[0],
    ).toMatchObject({ id: original.id, revision: 2 });
    expect(await f.store.exportTpsReport()).toContain("  New\r\n> 😀  ");
    expect(await f.store.exportTpsReport()).not.toContain("Old");
    await expect(
      f.save({ sample: { ...next, replaces: original.id } }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    expect(
      await f.save({
        rules: [{ report: "cover", text: "Must not land." }],
        sample: { ...next, sample_id: "missing" },
      }),
    ).toMatchObject({ status: "failed", error: "sample_conflict" });
    expect((await f.store.readDocuments()).cover).not.toContain(
      "Must not land.",
    );
    const foreign = fixtureStore(f.local.db, "foreign-revision");
    await seedUsers(f.local.pg, "foreign-revision");
    expect(
      await foreign.saveMemo({
        ...input,
        expected_version: (await foreign.getTpsReport()).version,
        sample: { ...next, new_kind: "launch", kind_id: undefined },
      }),
    ).toMatchObject({ status: "failed", error: "sample_conflict" });
    expect(await f.save({ retire_samples: [original.id] })).toMatchObject({
      status: "saved",
      samples_retired: [{ id: original.id, reason: "removed" }],
    });
    expect(await f.save({ sample: next })).toMatchObject({
      status: "failed",
      error: "sample_conflict",
    });
    expect((await f.report("post")).samples).toEqual([]);
    expect(await f.store.exportTpsReport()).not.toContain("New");
    const versions = (
      await f.local.pg.query(
        "SELECT version,body,context,retired,request_id FROM sample_versions WHERE user_id='sample-revisions' ORDER BY version",
      )
    ).rows;
    expect(versions).toMatchObject([
      {
        version: 1,
        body: first.text,
        context,
        retired: false,
        request_id: creationRequest,
      },
      {
        version: 2,
        body: next.text,
        context: next.context,
        retired: false,
        request_id: input.request_id,
      },
      { version: 3, body: next.text, context: next.context, retired: true },
    ]);
    await expect(
      f.local.pg.query(
        "UPDATE sample_versions SET body='Edited' WHERE user_id='sample-revisions'",
      ),
    ).rejects.toThrow("sample_version_is_immutable");
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
        context: { version: 1 as const, summary: "a fictional toast" },
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
        context: { version: 1 as const, summary: "a fictional toast" },
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
      context: { version: 1 as const, summary: "weekly update" },
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

test("a sample identical to an active one of its kind is unchanged: no copy", async () => {
  const f = await filingFixture("same-sample");
  try {
    const sample = (text: string, kind: object) => ({
      sample: {
        report: "email",
        context: { version: 1 as const, summary: "after a call" },
        text,
        ...kind,
      },
    });
    await f.save(sample("One", { new_kind: "Follow-up" }));
    const kind = (await f.report("email")).samples[0]!;
    await f.save(sample("Two", { kind_id: kind.kind_id }));
    const before = (await f.report("email")).samples;
    const version = (await f.store.getTpsReport()).version;
    for (const repeat of [
      sample("One", { kind_id: kind.kind_id }),
      sample("One", { new_kind: "follow-UP" }),
    ])
      expect(await f.save(repeat)).toMatchObject({
        status: "unchanged",
      });
    expect((await f.report("email")).samples).toEqual(before);
    expect((await f.store.getTpsReport()).version).toBe(version);
    // Bytes, not meaning: any other text still files.
    const filed = await f.save(sample("One.", { kind_id: kind.kind_id }));
    expect(filed.status).toBe("saved");
    expect(filed.samples_retired).toBeUndefined();
  } finally {
    await f.local.dispose();
  }
});

test("retiring a sample and re-adding its text in one save keeps one active copy", async () => {
  const f = await filingFixture("readd-sample");
  try {
    await f.save({
      sample: {
        report: "email",
        new_kind: "Follow-up",
        context: { version: 1 as const, summary: "after a call" },
        text: "One",
      },
    });
    const [old] = (await f.report("email")).samples;
    expect(
      await f.save({
        retire_samples: [old!.id],
        sample: {
          report: "email",
          kind_id: old!.kind_id,
          context: { version: 1 as const, summary: "after a call" },
          text: "One",
        },
      }),
    ).toMatchObject({
      status: "saved",
      samples_retired: [{ id: old!.id, reason: "removed" }],
    });
    const samples = (await f.report("email")).samples;
    expect(samples.map((s) => s.body)).toEqual(["One"]);
    expect(samples[0]!.id).not.toBe(old!.id);
  } finally {
    await f.local.dispose();
  }
});

test("context guards preserve retirement and ranking uses purposes, dimensions, text and recency", async () => {
  const local = await localStore();
  const pg = local.pg;
  try {
    await seedUsers(pg, "ranked", "ranked-other");
    await pg.exec(`INSERT INTO sample_kinds(user_id,id,report,label) VALUES
      ('ranked','k','email','note'), ('ranked','c','chat','note'),
      ('ranked','older','email','Quiet check-in'), ('ranked','empty','email','Empty kind'),
      ('ranked','retired-only','email','Retired kind'), ('ranked-other','foreign','email','Foreign kind');`);
    const context = { version: 1 as const, summary: "A fictional note." };
    await seedSample(
      pg,
      "ranked",
      "old",
      "email",
      "k",
      { ...context, summary: "A fictional budget decline." },
      "Budget numbers attached.",
      { createdAt: "2026-02-01" },
    );
    await seedSample(
      pg,
      "ranked",
      "new",
      "email",
      "k",
      {
        ...context,
        summary: "A fictional decline.",
        audience: { relationship: "client" },
        purposes: ["follow up"],
        register: "plain",
      },
      "No, thank you.",
    );
    await expect(
      pg.query(
        `INSERT INTO sample_versions(user_id,sample_id,version,report,kind_id,context,body,actor_json,request_id)
      VALUES ('ranked','new',2,'email','k','{"version":1,"summary":"A fictional note.","arbitrary":"x"}','Hello.','{}',$1)`,
        [crypto.randomUUID()],
      ),
    ).rejects.toThrow("sample_versions_context");
    await expect(
      pg.query(
        `INSERT INTO sample_versions(user_id,sample_id,version,report,kind_id,context,body,actor_json,request_id,retired,retire_reason)
      VALUES ('ranked','new',2,'email','k','{"version":1,"summary":"Changed while retiring."}','No, thank you.','{}',$1,true,'removed')`,
        [crypto.randomUUID()],
      ),
    ).rejects.toThrow("sample_version_conflict");
    // Explicit ranking tiers, followed by latest approval time; inactive versions never compete.
    for (const [id, day, relationship, purposes, body] of [
      ["a", 1, "client", ["thank"], "See you soon."],
      ["b", 2, "client", ["thank"], "Budget numbers attached."],
      ["c", 3, "boss", ["thank"], "Budget numbers attached."],
      ["d", 4, "client", ["decline"], "No budget this year."],
      ["f", 5, undefined, undefined, "Budget."],
      ["h", 7, undefined, undefined, "Hello."],
      ["g", 8, "other", ["other"], "Lunch?"],
      ["e", 9, "friend", ["announce"], "We moved house."],
      ["x", 9, "client", ["thank"], "Budget numbers attached."],
      ["r", 6, "client", ["thank"], "Budget numbers attached."],
    ] as const)
      await seedSample(
        pg,
        "ranked",
        id,
        id === "x" ? "chat" : "email",
        id === "x" ? "c" : "k",
        {
          ...context,
          ...(relationship ? { audience: { relationship } } : {}),
          ...(purposes ? { purposes: [...purposes] } : {}),
        },
        body,
        { createdAt: `2026-01-0${day}`, retired: id === "r" },
      );
    await seedSample(
      pg,
      "ranked",
      "quiet",
      "email",
      "older",
      { ...context, summary: "A quiet check-in." },
      "Checking in.",
      { createdAt: "2025-01-01" },
    );
    await seedSample(
      pg,
      "ranked-other",
      "foreign",
      "email",
      "foreign",
      context,
      "Foreign example.",
      { createdAt: "2025-01-01" },
    );
    await seedSample(
      pg,
      "ranked",
      "retired-kind",
      "email",
      "retired-only",
      context,
      "Retired example.",
      { retired: true },
    );
    const store = fixtureStore(local.db, "ranked", "assistant");
    const served = async (intent?: ReportIntent) => {
      const documents = await store.readDocuments(intent);
      const email = documents.reports.find((r) => r.id === "email")!;
      return {
        version: documents.version,
        ids: email.samples.map((s) => s.id),
        kinds: reportEnvelope(documents, "email").kinds,
      };
    };
    const intent: ReportIntent = {
      report: "email",
      situation: "budget numbers for the client",
      context: { audience: { relationship: "client" }, purposes: ["thank"] },
    };
    const ranked = await served(intent);
    expect(ranked.ids).toEqual(["b", "a", "c", "d", "new", "old", "f", "e"]);
    // Without labels, full-text rank then recency decide: two matching words
    // outrank one, and equal ranks go newest first.
    expect(
      (await served({ report: "email", situation: intent.situation })).ids,
    ).toEqual(["old", "c", "b", "f", "d", "new", "e", "g"]);
    // Without an intent, the newest eight; the version is the same either way.
    const newest = await served();
    expect(newest.ids).toEqual(["new", "old", "e", "g", "h", "f", "d", "c"]);
    expect(newest.version).toBe(ranked.version);
    expect(newest.kinds).toEqual([
      { kind_id: "k", kind: "note" },
      { kind_id: "older", kind: "Quiet check-in" },
    ]);
    expect(ranked.kinds).toEqual(newest.kinds);
    const discovered = newest.kinds.find((k) => k.kind === "Quiet check-in")!;
    const requested = await served({ ...intent, kind_id: discovered.kind_id });
    expect(requested.ids).toHaveLength(8);
    expect(requested.ids[0]).toBe("quiet");
    expect(requested.kinds).toEqual(newest.kinds);
    expect(requested.version).toBe(newest.version);
    expect(
      await store.saveMemo({
        text: "Reuse the discovered fictional kind.",
        request_id: crypto.randomUUID(),
        expected_version: newest.version,
        sample: {
          report: "email",
          kind_id: discovered.kind_id,
          context: { version: 1, summary: "Another quiet check-in." },
          text: "Checking in again.",
        },
      }),
    ).toMatchObject({ status: "saved" });
    expect(
      (await served({ ...intent, kind_id: discovered.kind_id })).ids[1],
    ).toBe("quiet");
  } finally {
    await local.dispose();
  }
});

test("approved context replacement preserves writing, clears metadata, fences old samples and replays", async () => {
  const local = await localStore();
  try {
    await seedUsers(local.pg, "context-owner", "context-other");
    const store = fixtureStore(local.db, "context-owner");
    const save = async (change: Partial<SaveMemoInput>) =>
      store.saveMemo({
        text: "Correct fictional sample context.",
        request_id: crypto.randomUUID(),
        expected_version: (await store.getTpsReport()).version,
        ...change,
      });
    const context = {
      version: 1 as const,
      summary: "A Slack task request to a colleague.",
      purposes: ["request", "coordinate"],
      medium: "slack",
      audience: {
        relationship: "colleague",
        role: "peer",
        familiarity: "ongoing",
        expertise: "specialist",
        group: "one",
      },
      interaction: "standalone",
      scope: { unit: "whole" as const },
      language: "en",
    };
    const body = "  Could you check the example?\r\n\nThanks. 😀  ";
    expect(
      await save({
        sample: { report: "chat", new_kind: "Relay note", context, text: body },
      }),
    ).toMatchObject({ status: "saved" });
    const original = (await store.readDocuments()).reports.find(
      (r) => r.id === "chat",
    )!.samples[0]!;
    for (let i = 0; i < 8; i++)
      expect(
        await save({
          sample: {
            report: "chat",
            new_kind: "relay NOTE",
            context: {
              version: 1,
              summary: "An async mini-standup.",
              purposes: ["update"],
            },
            text: `Done: example ${i}. Next: review.`,
          },
        }),
      ).toMatchObject({ status: "saved" });
    expect(
      (await store.readDocuments()).reports
        .find((r) => r.id === "chat")!
        .samples.map((s) => s.id),
    ).not.toContain(original.id);
    const before = (await store.getTpsReport()).version;
    const corrected = {
      version: 1 as const,
      summary: "An excerpt asking an expert for help.",
      purposes: ["ask_expert"],
      scope: { unit: "excerpt" as const, role: "closing" },
    };
    const input: SaveMemoInput = {
      text: "Approve corrected context.",
      request_id: crypto.randomUUID(),
      expected_version: before,
      rules: [{ report: "cover", text: "Lead with the question." }],
      sample_context: {
        report: "chat",
        sample_id: original.id,
        context: corrected,
      },
    };
    const outcome = await store.saveMemo(input);
    expect(outcome.status).toBe("saved");
    expect(outcome.version).not.toBe(before);
    const latest = (await store.readDocuments()).reports.find(
      (r) => r.id === "chat",
    )!.samples[0]!;
    expect(latest).toMatchObject({
      id: original.id,
      revision: 2,
      created_at: original.created_at,
      body,
    });
    expect(latest.revised_at > original.revised_at).toBe(true);
    expect((await store.readDocuments()).cover_rules).toEqual([
      "Lead with the question.",
    ]);
    expect(await store.saveMemo(input)).toEqual(outcome);
    await expect(
      store.saveMemo({ ...input, text: "Different request." }),
    ).rejects.toMatchObject({ code: "request_id_reused" });
    expect(await save({ sample_context: input.sample_context })).toMatchObject({
      status: "unchanged",
      version: outcome.version,
    });
    expect(
      await save({
        expected_version: before,
        rules: [{ report: "cover", text: "Be brief." }],
      }),
    ).toMatchObject({ status: "conflict" });
    const row = (
      await local.pg.query(
        "SELECT s.id,v.body,s.created_at,v.context,v.version AS revision FROM samples s JOIN sample_versions v ON v.user_id=s.user_id AND v.sample_id=s.id WHERE s.id=$1 ORDER BY v.version DESC LIMIT 1",
        [original.id],
      )
    ).rows[0] as Record<string, unknown>;
    expect(row).toMatchObject({
      id: original.id,
      body,
      context: corrected,
      revision: 2,
    });
    expect(new Date(row.created_at as string).toISOString().slice(0, 10)).toBe(
      original.date,
    );
    expect(new Date(row.created_at as string).toISOString()).toBe(
      new Date(original.created_at).toISOString(),
    );
    const exportText = await store.exportTpsReport();
    expect(exportText).toContain("ask_expert");
    expect(exportText).toContain("excerpt");
    expect(exportText).toContain("closing");
    expect(exportText).toContain(
      "  Could you check the example?\r\n>\n> Thanks. 😀  ",
    );
    const foreign = fixtureStore(local.db, "context-other");
    expect(
      await foreign.saveMemo({
        ...input,
        request_id: crypto.randomUUID(),
        expected_version: (await foreign.getTpsReport()).version,
      }),
    ).toMatchObject({ status: "failed", error: "sample_conflict" });
    const beforeRefusal = await store.readDocuments();
    expect(
      await save({
        rules: [{ report: "cover", text: "Keep the closing brief." }],
        sample_context: { ...input.sample_context!, report: "email" },
      }),
    ).toMatchObject({ status: "failed", error: "sample_conflict" });
    const afterRefusal = await store.readDocuments();
    expect(afterRefusal.version).toBe(beforeRefusal.version);
    expect(afterRefusal.cover_rules).toEqual(beforeRefusal.cover_rules);
    expect(afterRefusal.full).not.toContain("Keep the closing brief.");
    expect(await save({ retire_samples: [original.id] })).toMatchObject({
      status: "saved",
    });
    expect(await save({ sample_context: input.sample_context })).toMatchObject({
      status: "failed",
      error: "sample_conflict",
    });
    expect(
      (
        await local.pg.query(
          "SELECT count(*)::int AS n FROM samples WHERE user_id='context-owner'",
        )
      ).rows,
    ).toEqual([{ n: 9 }]);
    // Reclassification and later text revisions keep the identity and history.
    const parent = (await store.readDocuments()).reports.find(
      (r) => r.id === "chat",
    )!.samples[0]!;
    expect(
      await save({
        sample: {
          report: "chat",
          new_kind: "Expert request",
          sample_id: parent.id,
          context,
          text: "An expert request example.",
        },
      }),
    ).toMatchObject({ status: "saved" });
    const expert = (await store.readDocuments()).reports.find(
      (r) => r.id === "chat",
    )!.samples[0]!;
    expect(expert).toMatchObject({
      id: parent.id,
      revision: 2,
      created_at: parent.created_at,
    });
    expect(
      await save({
        sample: {
          report: "document",
          new_kind: "Expert memo",
          sample_id: parent.id,
          context,
          text: "A subsequent revision.",
        },
      }),
    ).toMatchObject({ status: "saved" });
    expect(
      (await store.readDocuments()).reports.find((r) => r.id === "document")!
        .samples[0],
    ).toMatchObject({
      id: parent.id,
      revision: 3,
      body: "A subsequent revision.",
    });
    expect(
      (
        await local.pg.query(
          "SELECT version,report FROM sample_versions WHERE sample_id=$1 ORDER BY version",
          [parent.id],
        )
      ).rows,
    ).toEqual([
      { version: 1, report: "chat" },
      { version: 2, report: "chat" },
      { version: 3, report: "document" },
    ]);
  } finally {
    await local.dispose();
  }
});

test("kind and contextual reads prefer concrete situations and fill sparse matches honestly", async () => {
  const local = await localStore();
  try {
    await seedUsers(local.pg, "situations", "foreign-situation");
    const store = fixtureStore(local.db, "situations");
    const contexts = [
      {
        summary: "Slack task request to a colleague.",
        purposes: ["request"],
        medium: "slack",
        audience: { relationship: "colleague" },
        interaction: "standalone",
      },
      {
        summary: "Async mini-standup.",
        purposes: ["update"],
        medium: "slack",
        audience: { group: "team" },
        interaction: "standalone",
      },
      {
        summary: "Status reply to a manager who knows the background.",
        purposes: ["update", "answer"],
        medium: "chat",
        audience: { role: "manager", familiarity: "ongoing" },
        interaction: "reply",
      },
      {
        summary: "Asking an expert for help.",
        purposes: ["request"],
        medium: "chat",
        audience: { expertise: "specialist" },
        interaction: "first_contact",
      },
      {
        summary: "Ticket comment updates and asks for review.",
        purposes: ["update", "request_review"],
        medium: "ticket_comment",
        interaction: "reply",
      },
    ];
    for (const [i, context] of contexts.entries())
      expect(
        await store.saveMemo({
          text: "Keep fictional approved example.",
          request_id: crypto.randomUUID(),
          expected_version: (await store.getTpsReport()).version,
          sample: {
            report: "chat",
            new_kind: i === 1 ? "mini-standup" : "note",
            context: { version: 1, ...context },
            text: `Fictional example ${i}.`,
          },
        }),
      ).toMatchObject({ status: "saved" });
    const all = (await store.readDocuments()).reports.find(
      (r) => r.id === "chat",
    )!.samples;
    const standup = all.find((s) => s.body === "Fictional example 1.")!;
    for (const [i, context] of contexts.entries()) {
      const read = await store.readDocuments({
        report: "chat",
        situation: "Writing a message.",
        context: {
          purposes: context.purposes,
          medium: context.medium,
          audience: context.audience,
          interaction: context.interaction,
        },
      });
      expect(read.reports.find((r) => r.id === "chat")!.samples[0]!.body).toBe(
        `Fictional example ${i}.`,
      );
    }
    const tools = (await import("../src/mcp-tools")).createStoreMemoTools;
    const tenant: import("../src/store").TenantStore = {
      ...store,
      appOrigin: "http://localhost:3001",
      readTpsReport: store.getTpsReport,
      chargeToolCall: async () => ({
        allowed: true,
        limit: 10000,
        retry_at_ms: 0,
      }),
    };
    const result = JSON.parse(
      (
        await tools(tenant).get_report({
          report_id: "chat",
          intent: {
            situation: "Writing an update.",
            kind_id: standup.kind_id,
            context: { purposes: ["update", "request_review"] },
          },
        })
      ).content[0].text,
    );
    expect(result.samples).toHaveLength(5);
    expect(result.samples[0].id).toBe(standup.id);
    expect(result.samples[0].match.kind).toBe(true);
    expect(
      result.samples
        .slice(1)
        .every((s: { match: { kind: boolean } }) => s.match.kind === false),
    ).toBe(true);
    expect(result.selection).toContain("broader");
    await expect(
      store.readDocuments({
        report: "email",
        situation: "Read.",
        kind_id: standup.kind_id,
      }),
    ).rejects.toMatchObject({ code: "invalid_kind" });
    await expect(
      store.readDocuments({
        report: "chat",
        situation: "Read.",
        kind_id: "foreign-or-missing",
      }),
    ).rejects.toMatchObject({ code: "invalid_kind" });
    const foreign = fixtureStore(local.db, "foreign-situation");
    expect(
      await foreign.saveMemo({
        text: "Keep a fictional foreign sample.",
        request_id: crypto.randomUUID(),
        expected_version: (await foreign.getTpsReport()).version,
        sample: {
          report: "chat",
          new_kind: "Foreign note",
          context: { version: 1, summary: "A fictional note." },
          text: "Foreign fictional writing.",
        },
      }),
    ).toMatchObject({ status: "saved" });
    const foreignKind = (await foreign.readDocuments()).reports.find(
      (r) => r.id === "chat",
    )!.samples[0]!.kind_id;
    const before = (await store.getTpsReport()).version;
    await expect(
      store.readDocuments({
        report: "chat",
        situation: "Read.",
        kind_id: foreignKind,
      }),
    ).rejects.toMatchObject({ code: "invalid_kind" });
    expect(
      await store.saveMemo({
        text: "Refuse foreign classification.",
        request_id: crypto.randomUUID(),
        expected_version: before,
        sample_context: {
          report: "chat",
          sample_id: standup.id,
          kind_id: foreignKind,
          context: standup.context,
        },
      }),
    ).toMatchObject({ status: "failed", error: "sample_conflict" });
    expect((await store.getTpsReport()).version).toBe(before);
    await local.pg.exec(
      "UPDATE users SET status='deleting' WHERE id='situations'",
    );
    await expect(
      store.readDocuments({
        report: "chat",
        situation: "Read.",
        kind_id: "missing",
      }),
    ).rejects.toMatchObject({ code: "account_unavailable" });
  } finally {
    await local.dispose();
  }
});

test("reclassification and matching text never merge stable identities; new examples dedup only complete matches", async () => {
  const f = await filingFixture("sample-dedup");
  try {
    const context = { version: 1 as const, summary: "A fictional note." };
    const example = {
      report: "chat" as const,
      new_kind: "Source note",
      context,
      text: "Please check the example.",
    };
    expect(await f.save({ sample: example })).toMatchObject({
      status: "saved",
    });
    const original = (await f.report("chat")).samples[0]!;
    expect(
      await f.save({
        sample: {
          ...example,
          context: { summary: context.summary, version: 1 },
        },
      }),
    ).toMatchObject({ status: "unchanged" });
    expect(
      await f.save({
        sample: { ...example, context: { ...context, medium: "slack" } },
      }),
    ).toMatchObject({ status: "saved" });
    expect((await f.report("chat")).samples).toHaveLength(2);
    expect(
      await f.save({ sample: { ...example, new_kind: "Target note" } }),
    ).toMatchObject({ status: "saved" });
    const target = (await f.report("chat")).samples[0]!;
    expect(
      await f.save({
        sample_context: {
          report: "chat",
          sample_id: original.id,
          kind_id: target.kind_id,
          context,
        },
      }),
    ).toMatchObject({ status: "saved" });
    expect((await f.report("chat")).samples).toHaveLength(3);
    expect(
      await f.save({
        sample: {
          ...example,
          new_kind: undefined,
          kind_id: target.kind_id,
          sample_id: original.id,
          text: "Different bytes.",
        },
      }),
    ).toMatchObject({ status: "saved" });
    expect(
      await f.save({
        sample: {
          ...example,
          new_kind: undefined,
          kind_id: target.kind_id,
          sample_id: original.id,
        },
      }),
    ).toMatchObject({ status: "saved" });
    expect((await f.report("chat")).samples.map((s) => s.id)).toContain(
      target.id,
    );
    expect(
      (await f.report("chat")).samples.find((s) => s.id === original.id),
    ).toMatchObject({ revision: 4, body: example.text });
  } finally {
    await f.local.dispose();
  }
});
