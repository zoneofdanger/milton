import { expect, test } from "bun:test";
import { localStore } from "./local-store";
import {
  fixtureStore,
  memoSave,
  seedUsers,
  teach,
  vendorIntent,
} from "./store-fixtures";
import { change, scoreboard, tier } from "../src/store/score";
import { tpsStore } from "../src/store/tps";
import type { ChangeInput, MemoInput } from "../src/mcp-tools";
import { changeList, exampleLine } from "../src/store/changes";
import { checkMemo } from "../src/store/save";
import { selectTweakExamples } from "../src/store/memos";

const draft =
  "Hi there! Hope your week is going well. Thanks so much for reaching out about a call. Unfortunately we won't be able to make Thursday work, but we'd love to stay in touch.";
const final = "Thanks for reaching out. We'll pass on Thursday.\n\n–P";

test("a memo keeps both drafts word for word, scores the change, sets its tier and replays", async () => {
  const local = await localStore();
  try {
    await seedUsers(local.pg, "u");
    const store = fixtureStore(local.db, "u");
    const input = memoSave({
      first_draft: draft,
      final,
      mode: "draft",
      rounds: 2,
      new_kind: "vendor decline",
      changes: teach(
        "Hi there!",
        { text: "Vendor replies: no warm-up opener." },
        { text: "declines: 2–3 sentences" },
      ),
    });
    const saved = await store.saveMemo(input);
    expect(saved).toMatchObject({
      status: "saved",
      memo: { tier: "steered", kind: "vendor decline", rounds: 2 },
      receipt:
        "Kept memo: vendor decline, 2 rounds, tweaks: Vendor replies: no warm-up opener; declines: 2–3 sentences.",
    });
    expect(saved.memo!.change).toBeGreaterThan(0.5);
    const row = (
      await local.pg.query<{
        first_draft: string;
        final: string;
        tier: string;
      }>("SELECT first_draft,final,tier FROM memos WHERE user_id='u'")
    ).rows;
    expect(row).toEqual([{ first_draft: draft, final, tier: "steered" }]);
    // The same request replays its outcome; a different input under it is refused.
    expect(await store.saveMemo(input)).toEqual(saved);
    await expect(
      store.saveMemo({ ...input, memo: { ...input.memo!, rounds: 3 } }),
    ).rejects.toMatchObject({ code: "request_id_reused" });
    // The same words saved again keep one memo.
    expect(
      await store.saveMemo({ ...input, request_id: crypto.randomUUID() }),
    ).toMatchObject({
      status: "unchanged",
      memo: { memo_id: saved.memo!.memo_id },
    });
    expect((await local.pg.query("SELECT 1 FROM memos")).rows.length).toBe(1);
  } finally {
    await local.dispose();
  }
});

test("a resave of words already on file is unchanged, keeps the first memo's kind and adds no kind", async () => {
  const local = await localStore();
  try {
    await seedUsers(local.pg, "resave");
    const store = fixtureStore(local.db, "resave");
    const first = await store.saveMemo(
      memoSave({ new_kind: "vendor decline" }),
    );
    expect(first.memo!.kind).toBe("vendor decline");
    const again = await store.saveMemo(
      memoSave({ new_kind: "fictional relabel" }),
    );
    expect(again).toMatchObject({
      status: "unchanged",
      memo: {
        memo_id: first.memo!.memo_id,
        kind_id: first.memo!.kind_id,
        kind: "vendor decline",
      },
    });
    expect((await store.readReport(vendorIntent)).kinds).toEqual([
      { kind_id: first.memo!.kind_id!, kind: "vendor decline" },
    ]);
    // An unknown kind_id is still refused, even with words already on file.
    expect(
      await store.saveMemo(memoSave({ kind_id: crypto.randomUUID() })),
    ).toMatchObject({ status: "failed", error: "invalid_kind" });
  } finally {
    await local.dispose();
  }
});

test("tiers come from the memo's source; shapes that contradict it are refused before any write", async () => {
  expect(tier({ state: "none", final })).toBe("own");
  expect(tier({ state: "kept", mode: "edit", firstDraft: draft, final })).toBe(
    "own",
  );
  expect(tier({ state: "kept", mode: "draft", firstDraft: final, final })).toBe(
    "untouched",
  );
  expect(tier({ state: "missing", mode: "draft", final, rounds: 1 })).toBe(
    "steered",
  );
  expect(tier({ state: "missing", mode: "draft", final, rounds: 0 })).toBe(
    "untouched",
  );
  expect(change("a b c d", "a b c d")).toBe(0);
  expect(change("a b c d", "a x c d")).toBe(0.25);
  expect(change("", "one two")).toBe(1);
  const local = await localStore();
  try {
    await seedUsers(local.pg, "u");
    const store = fixtureStore(local.db, "u");
    const cases: [Partial<MemoInput>, RegExp][] = [
      [{ mode: "draft" }, /takes no mode, rounds or changes/],
      [{ first_draft: draft }, /send mode/],
      [
        {
          first_draft: final,
          final,
          mode: "draft",
          rounds: 0,
          changes: teach("Thanks", { text: "x" }),
        },
        /nothing changed; omit changes/,
      ],
      [
        {
          first_draft: draft,
          first_draft_missing: true,
          mode: "draft",
          rounds: 1,
        },
        /not both/,
      ],
    ];
    for (const [memo, message] of cases)
      await expect(store.saveMemo(memoSave(memo))).rejects.toMatchObject({
        code: "invalid_input",
        message: expect.stringMatching(message),
      });
    await expect(
      store.saveMemo({
        ...memoSave(),
        cover_sheet: { add: "x", expected_version: 0 },
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    expect(
      (await local.pg.query("SELECT 1 FROM save_requests")).rows.length,
    ).toBe(0);
  } finally {
    await local.dispose();
  }
});

test("tweaks reuse ids and exact wordings, count citations, and forgetting a memo takes what it taught", async () => {
  const local = await localStore();
  try {
    await seedUsers(local.pg, "u", "other");
    const store = fixtureStore(local.db, "u");
    const first = await store.saveMemo(
      memoSave({
        first_draft: draft,
        mode: "draft",
        rounds: 1,
        changes: teach("Hi there!", { text: "No warm-up opener" }),
      }),
    );
    const opener = first.memo!.tweaks[0]!.tweak_id;
    const second = await store.saveMemo(
      memoSave({
        first_draft: draft + " Best!",
        final: final + " ",
        mode: "draft",
        rounds: 1,
        changes: teach(
          "Hi there!",
          { text: "no  warm-up opener." },
          { text: "Sign off –P" },
        ),
      }),
    );
    expect(second.memo!.tweaks.map((t) => t.tweak_id)).toContain(opener);
    const third = await store.saveMemo(
      memoSave({
        first_draft: draft,
        final: "Thanks. Not this time.\n\n–P",
        mode: "draft",
        rounds: 1,
        changes: teach("Hi there!", { tweak_id: opener }),
      }),
    );
    expect(third.memo!.tweaks).toEqual([
      { tweak_id: opener, text: "No warm-up opener" },
    ]);
    // Another account's tweak id is not this one's.
    const foreign = await fixtureStore(local.db, "other").saveMemo(
      memoSave({
        first_draft: draft,
        mode: "draft",
        rounds: 1,
        changes: teach("Hi there!", { text: "Shorter" }),
      }),
    );
    expect(
      await store.saveMemo(
        memoSave({
          first_draft: draft,
          final: "No.",
          mode: "draft",
          rounds: 1,
          changes: teach("Hi there!", {
            tweak_id: foreign.memo!.tweaks[0]!.tweak_id,
          }),
        }),
      ),
    ).toMatchObject({ status: "failed", error: "invalid_tweak" });
    const report = await store.readReport(vendorIntent);
    expect(report.tweaks.find((t) => t.tweak_id === opener)).toMatchObject({
      memos: 3,
    });
    expect(report.text).toContain("- No warm-up opener (3 memos)");
    // Forgetting the memo that alone cites "Sign off –P" deletes that tweak.
    expect(
      await store.saveMemo({
        request_id: crypto.randomUUID(),
        forget_memos: [second.memo!.memo_id, "unknown"],
      }),
    ).toMatchObject({ status: "saved", forgotten: [second.memo!.memo_id] });
    expect(
      (
        await local.pg.query<{ text: string; n: number }>(
          "SELECT t.text,count(c.*)::int n FROM tweaks t LEFT JOIN tweak_citations c ON c.user_id=t.user_id AND c.tweak_id=t.id WHERE t.user_id='u' GROUP BY t.text",
        )
      ).rows,
    ).toEqual([{ text: "No warm-up opener", n: 2 }]);
  } finally {
    await local.dispose();
  }
});

test("an empty changes list and a null kind_id save as if omitted, and a retry sending them replays the omitted save", async () => {
  const local = await localStore();
  try {
    await seedUsers(local.pg, "u");
    const store = fixtureStore(local.db, "u");
    // Sent by AI clients in testing (corpus-test, learning-test reports).
    const lenient = { changes: [], kind_id: null as unknown as string };
    const drafted = memoSave({ first_draft: draft, mode: "draft", rounds: 1 });
    const saved = await store.saveMemo(drafted);
    expect(saved).toMatchObject({ status: "saved", memo: { tweaks: [] } });
    expect(saved.memo!.kind_id).toBeUndefined();
    // The same request with [] and null is the same input: it replays.
    expect(
      await store.saveMemo({
        ...drafted,
        memo: { ...drafted.memo!, ...lenient },
      }),
    ).toEqual(saved);
    // Shapes that refuse changes accept [] as none: writing the person gave,
    // and a final equal to its first draft.
    expect(
      await store.saveMemo(memoSave({ final: "My own words.", ...lenient })),
    ).toMatchObject({ status: "saved", memo: { tier: "own", tweaks: [] } });
    expect(
      await store.saveMemo(
        memoSave({
          first_draft: final,
          final,
          mode: "draft",
          rounds: 0,
          ...lenient,
        }),
      ),
    ).toMatchObject({ status: "saved", memo: { tier: "untouched" } });
    expect(
      (await local.pg.query("SELECT 1 FROM memos WHERE kind_id IS NULL")).rows,
    ).toHaveLength(3);
    // memo_context keeps refusing a null kind_id.
    await expect(
      store.saveMemo({
        request_id: crypto.randomUUID(),
        memo_context: {
          memo_id: saved.memo!.memo_id,
          context: { summary: "decline a vendor", medium: "email" },
          kind_id: lenient.kind_id,
        },
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  } finally {
    await local.dispose();
  }
});

test("a report ranks by kind, medium and tier, serves no untouched finals and at most three steered, within its budget", async () => {
  const local = await localStore();
  try {
    await seedUsers(local.pg, "u");
    const store = fixtureStore(local.db, "u");
    expect(await store.readReport(vendorIntent)).toMatchObject({
      is_empty: true,
      examples: [],
      text: expect.stringContaining("Nothing similar is on file yet"),
    });
    const save = async (
      text: string,
      memo: Parameters<typeof memoSave>[0] = {},
    ) =>
      (await store.saveMemo(memoSave({ final: text, ...memo }))).memo!.memo_id;
    const chat = await save("chat: own words", {
      context: { summary: "a DM", medium: "chat" },
    });
    const pasted = await save("email: own words", {
      new_kind: "vendor decline",
    });
    const steered: string[] = [];
    for (let i = 0; i < 4; i++)
      steered.push(
        await save(`email: steered ${i}`, {
          first_draft: `first ${i}`,
          mode: "draft",
          rounds: 1,
        }),
      );
    const untouched = await save("email: untouched", {
      first_draft: "email: untouched",
      mode: "draft",
      rounds: 0,
    });
    const huge = await save("x ".repeat(70000));
    const report = await store.readReport(vendorIntent);
    const ids = report.examples.map((e) => e.memo_id);
    expect(ids[0]).toBe(pasted);
    expect(ids).not.toContain(untouched);
    expect(ids).not.toContain(huge);
    expect(ids.filter((id) => steered.includes(id))).toHaveLength(3);
    expect(ids.at(-1)).toBe(chat);
    expect(report.text.indexOf("email: own words")).toBeLessThan(
      report.text.indexOf("email: steered"),
    );
    // A requested kind ranks first.
    const kind = report.kinds[0]!.kind_id;
    expect(
      (
        await store.readReport({
          ...vendorIntent,
          medium: "chat",
          kind_id: kind,
        })
      ).examples[0]!.memo_id,
    ).toBe(pasted);
    await expect(
      store.readReport({ ...vendorIntent, kind_id: "nope" }),
    ).rejects.toMatchObject({ code: "invalid_kind" });
    // The budget: a top example over it is still served, and alone.
    const long = await save("y ".repeat(20000), { new_kind: "vendor decline" });
    const tight = await store.readReport({ ...vendorIntent, kind_id: kind });
    expect(tight.examples.map((e) => e.memo_id)).toEqual([long]);
  } finally {
    await local.dispose();
  }
});

test("a report ranks matching memos above unrelated pasted ones, and your words only win ties", async () => {
  const ask = {
    situation: "declining a software vendor's renewal quote",
    medium: "email" as const,
    audience: "a software vendor",
    purpose: "decline the renewal",
  };
  // Five setup pastes on other topics, then three steered matches, best first.
  const pastes = [
    ["thanking a friend for dinner", "a friend", "thank"],
    [
      "asking the landlord to fix the heater",
      "my landlord",
      "ask for a repair",
    ],
    ["accepting a talk invitation", "an organizer", "accept an invitation"],
    ["planning a family visit", "my sister", "plan a visit"],
    ["signing up for the school fair", "a coordinator", "volunteer"],
  ];
  const matches = [
    [
      "declining a software vendor's renewal quote",
      "a software vendor",
      "decline the renewal",
    ],
    [
      "declining a vendor's upsell offer",
      "a software vendor",
      "decline an upsell",
    ],
    ["declining a vendor's meeting request", "a vendor", "decline a meeting"],
  ];
  for (const size of [600, 6000]) {
    const local = await localStore();
    try {
      await seedUsers(local.pg, "u");
      const store = fixtureStore(local.db, "u");
      const save = async (
        [summary, audience, purpose]: string[],
        steered: boolean,
      ) => {
        const final = `About ${summary}.\n`.repeat(size / 40);
        return (
          await store.saveMemo(
            memoSave({
              final,
              context: {
                summary: summary!,
                medium: "email",
                audience,
                purpose,
              },
              ...(steered
                ? { first_draft: `Hello,\n${final}`, mode: "draft", rounds: 1 }
                : {}),
            }),
          )
        ).memo!.memo_id;
      };
      const own: string[] = [];
      for (const p of pastes) own.push(await save(p, false));
      const steered: string[] = [];
      for (const m of matches) steered.push(await save(m, true));
      const ids = (await store.readReport(ask)).examples.map((e) => e.memo_id);
      expect(ids.slice(0, 3)).toEqual(steered);
      if (size === 600) {
        expect(ids.slice(3).sort()).toEqual([...own].sort());
        // Same overlap as the best match, a weaker situation match: your words
        // still come first.
        const tie = await save(
          ["a short note", ask.audience, ask.purpose],
          false,
        );
        expect(
          (await store.readReport(ask)).examples
            .slice(0, 4)
            .map((e) => e.memo_id),
        ).toEqual([tie, ...steered]);
      } else {
        // About 6 KB each: the budget runs out on pastes, not on matches.
        expect(ids.length).toBeLessThan(8);
      }
    } finally {
      await local.dispose();
    }
  }
});

test("a report serves tweaks from the ten best-matching memos that cite one, and a memo saved after it records them", async () => {
  const local = await localStore();
  try {
    await seedUsers(local.pg, "u");
    const store = fixtureStore(local.db, "u");
    for (let i = 0; i < 12; i++)
      await store.saveMemo(
        memoSave({
          first_draft: `first ${i}`,
          final: `final ${i}`,
          mode: "draft",
          rounds: 1,
          context: {
            summary: `memo ${i}`,
            medium: i < 11 ? "email" : "post",
          },
          changes: teach(
            "first",
            { text: `tweak ${i}` },
            { text: "shared tweak" },
          ),
        }),
      );
    const report = await store.readReport(vendorIntent);
    expect(report.tweaks).toHaveLength(10);
    expect(report.tweaks.map((t) => t.text)).not.toContain("tweak 11");
    const saved = await store.saveMemo(
      memoSave({
        first_draft: "a",
        final: "b",
        mode: "draft",
        rounds: 1,
        report_id: report.report_id,
      }),
    );
    expect(
      (
        await local.pg.query<{ served: string[] }>(
          "SELECT served_tweak_ids served FROM memos WHERE id=$1",
          [saved.memo!.memo_id],
        )
      ).rows[0]!.served,
    ).toEqual(report.tweaks.map((t) => t.tweak_id));
    expect(
      await store.saveMemo(
        memoSave({ final: "c", report_id: crypto.randomUUID() }),
      ),
    ).toMatchObject({ status: "failed", error: "invalid_report" });
  } finally {
    await local.dispose();
  }
});

test("a tweak's served and needed-again counts come from kept-draft memos of its account, in report text, the TPS read and TPS.md", async () => {
  const local = await localStore();
  try {
    await seedUsers(local.pg, "u", "other");
    const store = fixtureStore(local.db, "u");
    const drafted = (memo: Partial<MemoInput>) =>
      store.saveMemo(
        memoSave({ first_draft: draft, mode: "draft", rounds: 1, ...memo }),
      );
    const first = await drafted({
      changes: teach(
        "Hi there!",
        { text: "No warm-up opener" },
        { text: "Sign off –P" },
      ),
    });
    const opener = first.memo!.tweaks[0]!.tweak_id;
    // Served both and cited neither.
    await drafted({
      final: "Not this time.",
      report_id: (await store.readReport(vendorIntent)).report_id,
    });
    // Served both and cited the opener: needed again.
    await drafted({
      final: "Thanks, no.",
      report_id: (await store.readReport(vendorIntent)).report_id,
      changes: teach("Hi there!", { tweak_id: opener }),
    });
    // Without a kept first draft, a served and cited memo does not count
    // (saves no longer let one cite a tweak; older memos may).
    const missing = await store.saveMemo(
      memoSave({
        first_draft_missing: true,
        mode: "draft",
        rounds: 1,
        final: "We'll pass.",
        report_id: (await store.readReport(vendorIntent)).report_id,
      }),
    );
    await local.pg.query(
      "INSERT INTO tweak_citations(user_id,memo_id,tweak_id) VALUES ('u',$1,$2)",
      [missing.memo!.memo_id, opener],
    );
    // Cited but not served.
    await drafted({
      final: "No, thanks.",
      changes: teach(
        "Hi there!",
        { tweak_id: opener },
        { text: "Short paragraphs" },
      ),
    });
    // Another account's memo naming this tweak id is not counted.
    const foreign = await fixtureStore(local.db, "other").saveMemo(
      memoSave({ first_draft: draft, mode: "draft", rounds: 1 }),
    );
    await local.pg.query(
      "UPDATE memos SET report_id=$1,served_tweak_ids=ARRAY[$2] WHERE id=$3",
      [crypto.randomUUID(), opener, foreign.memo!.memo_id],
    );
    const report = await store.readReport(vendorIntent);
    expect(report.text).toContain(
      'What the person made an AI change in similar memos, best match first. "was → now" shows a change the person made; "needed again" counts drafts that were given the tweak and still needed it.',
    );
    expect(report.text).toContain(
      "- No warm-up opener (4 memos; needed again 1 of 2)",
    );
    expect(report.text).toMatch(/^- Sign off –P \(1 memo\)$/m);
    expect(report.text).toContain("- Short paragraphs (1 memo)");
    expect(report.tweaks.find((t) => t.tweak_id === opener)).toEqual({
      tweak_id: opener,
      text: "No warm-up opener",
      memos: 4,
    });
    const tps = tpsStore(local.db, "u");
    expect(
      (await tps.read()).tweaks.map(({ text, memos, served, needed_again }) => [
        text,
        memos,
        served,
        needed_again,
      ]),
    ).toEqual([
      ["No warm-up opener", 4, 2, 1],
      ["Short paragraphs", 1, 0, 0],
      ["Sign off –P", 1, 2, 0],
    ]);
    expect(await tps.exportTps()).toContain(
      '## Tweaks\n\n- No warm-up opener (4 memos; served 2, needed again 1)\n  cut: "Hi there!"\n- Short paragraphs (1 memo)\n  cut: "Hi there!"\n- Sign off –P (1 memo; served 2, needed again 0)\n  cut: "Hi there!"\n',
    );
  } finally {
    await local.dispose();
  }
});

test("the cover sheet takes whole lines from an AI, fenced by version and capped, and removing the last line empties it", async () => {
  const local = await localStore();
  try {
    await seedUsers(local.pg, "u");
    const store = fixtureStore(local.db, "u");
    const cover = (change: {
      add?: string;
      remove?: string;
      expected_version: number;
    }) =>
      store.saveMemo({ request_id: crypto.randomUUID(), cover_sheet: change });
    expect(await store.readCoverSheet()).toMatchObject({
      text: "",
      version: 0,
      is_empty: true,
      keep_memos: true,
    });
    expect(
      await cover({ add: "No em dashes", expected_version: 0 }),
    ).toMatchObject({
      status: "saved",
      cover_sheet: { version: 1, text: "No em dashes" },
    });
    expect(
      await cover({ add: "Sign off –P", expected_version: 0 }),
    ).toMatchObject({
      status: "conflict",
      cover_sheet: { version: 1 },
    });
    await cover({ add: "Sign off –P", expected_version: 1 });
    expect(
      await cover({ add: "Sign off –P", expected_version: 2 }),
    ).toMatchObject({
      status: "unchanged",
    });
    expect(
      await cover({ remove: "Sign off", expected_version: 2 }),
    ).toMatchObject({
      status: "failed",
      error: "line_not_found",
    });
    expect(
      await cover({ remove: "No em dashes", expected_version: 2 }),
    ).toMatchObject({ status: "saved", cover_sheet: { text: "Sign off –P" } });
    // Removing the last line empties it, as a new version.
    expect(
      await cover({ remove: "Sign off –P", expected_version: 3 }),
    ).toMatchObject({ status: "saved", cover_sheet: { version: 4, text: "" } });
    expect(await store.readCoverSheet()).toMatchObject({
      text: "",
      version: 4,
      is_empty: true,
    });
    let version = 4;
    let last;
    for (let i = 0; i < 6; i++)
      last = await cover({
        add: `${i}${"z".repeat(290)}`,
        expected_version: version++,
      });
    expect(last).toMatchObject({
      status: "failed",
      error: "cover_sheet_limit",
    });
    expect((await store.readCoverSheet()).text.length).toBeLessThanOrEqual(
      1500,
    );
    expect((await store.readCoverSheet()).is_empty).toBe(false);
  } finally {
    await local.dispose();
  }
});

test("memo_context corrects context and kind but never words; Keep memos off refuses drafts, not writing the person gives", async () => {
  const local = await localStore();
  try {
    await seedUsers(local.pg, "u");
    const store = fixtureStore(local.db, "u");
    const saved = await store.saveMemo(memoSave());
    const fix = {
      request_id: crypto.randomUUID(),
      memo_context: {
        memo_id: saved.memo!.memo_id,
        context: {
          summary: "decline a vendor's demo",
          medium: "chat" as const,
        },
        new_kind: "vendor decline",
      },
    };
    expect(await store.saveMemo(fix)).toMatchObject({
      status: "saved",
      memo: { kind: "vendor decline" },
    });
    expect(
      await store.saveMemo({ ...fix, request_id: crypto.randomUUID() }),
    ).toMatchObject({ status: "unchanged" });
    expect(
      (
        await local.pg.query(
          "SELECT medium,summary,audience,purpose,final FROM memos",
        )
      ).rows,
    ).toEqual([
      {
        medium: "chat",
        summary: "decline a vendor's demo",
        audience: null,
        purpose: null,
        final: memoSave().memo!.final,
      },
    ]);
    await local.pg.query(
      "INSERT INTO memo_settings(user_id,keep_memos) VALUES ('u',false)",
    );
    expect((await store.readCoverSheet()).keep_memos).toBe(false);
    expect(
      await store.saveMemo(
        memoSave({ first_draft: "a", final: "b", mode: "draft", rounds: 1 }),
      ),
    ).toMatchObject({ status: "failed", error: "memos_off" });
    expect(
      await store.saveMemo(memoSave({ final: "remember this one" })),
    ).toMatchObject({ status: "saved", memo: { tier: "own" } });
  } finally {
    await local.dispose();
  }
});

test("the scoreboard appears at ten scored memos, compares first five with latest five, and keeps edit memos apart", () => {
  const at = (day: number) => new Date(Date.UTC(2026, 10, day));
  const memos = Array.from({ length: 10 }, (_, i) => ({
    mode: "draft" as const,
    rounds: i < 5 ? 3 : 1,
    change: i < 5 ? 0.5 : 0.1,
    untouched: i >= 8,
    at: at(i + 1),
  }));
  const [drafts, edits] = scoreboard(
    [
      ...memos,
      { mode: "edit", rounds: 0, change: 0, untouched: true, at: at(1) },
    ],
    at(20),
  );
  expect(drafts).toEqual({
    mode: "draft",
    count: 10,
    basis: "first-five",
    latest: { rounds: 1, change: 0.1, accepted: 0.4 },
    earlier: { rounds: 3, change: 0.5, accepted: 0 },
  });
  expect(edits).toEqual({ mode: "edit", count: 1 });
  expect(scoreboard(memos.slice(0, 9))[0]).toEqual({ mode: "draft", count: 9 });
});

test("code lists what changed: merged spots, Markdown-only spots about format, insertions and deletions; past its bounds the list is too large", () => {
  const list = changeList(
    "Hi Dana, I hope you're well!\n\nWe can't meet Thursday.\n\nBest,\nAI",
    "Dana —\n\nWe can't meet **Thursday**.\n\nBest,\nAI\n–S",
  );
  expect(list.state).toBe("itemized");
  const spots = list.state === "itemized" ? list.spots : [];
  const first =
    "Hi Dana, I hope you're well!\n\nWe can't meet Thursday.\n\nBest,\nAI";
  const final = "Dana —\n\nWe can't meet **Thursday**.\n\nBest,\nAI\n–S";
  expect(
    spots.map((s) => [
      first.slice(s.draftStart, s.draftEnd),
      final.slice(s.finalStart, s.finalEnd),
      s.format,
    ]),
  ).toEqual([
    // Edits within two unchanged tokens on one line are one spot.
    ["Hi Dana, I hope you're well!", "Dana —", false],
    // Bold added around a word: only Markdown marks differ.
    ["Thursday", "**Thursday**", true],
    // An insertion has an empty first-draft side.
    ["", "–S", false],
  ]);
  // Case counts; identical tokens are no change.
  expect(changeList("hi there", "Hi there")).toMatchObject({
    spots: [{ format: false }],
  });
  expect(changeList("a  b", "a b")).toEqual({ state: "itemized", spots: [] });
  // Over a hundred spots, or past the diff's bound, nothing is listed.
  const many = Array.from({ length: 101 }, (_, i) => `w${i} keep keep keep`);
  expect(
    changeList(many.join(" "), many.map((w) => `x${w}`).join(" ")),
  ).toEqual({ state: "too_large" });
  const words = (n: number, w: string) =>
    Array.from({ length: n }, (_, i) => `${w}${i}`).join(" ");
  expect(changeList(words(1500, "a"), words(1500, "b"))).toEqual({
    state: "too_large",
  });
  // An example line shows both sides on one line.
  expect(exampleLine({ before: "Hi!\nThanks", after: "Thanks" })).toBe(
    '"Hi! / Thanks" → "Thanks"',
  );
  expect(exampleLine({ before: "", after: "–S" })).toBe('added: "–S"');
  expect(exampleLine({ before: "Best,", after: "" })).toBe('cut: "Best,"');
});

test("a change's quotes are located where the texts differ, folded only to find them, and stored as code cuts them; every other spot stays unlabelled", async () => {
  const first =
    "Hi Dana, I hope you’re well!\n\nThanks so much for reaching out — we can't meet Thursday. Thanks again.\n\nBest,\nAI";
  const final =
    "Dana -\n\nThanks for the note, but we can't meet **Thursday**. Thanks again.\n\nBest,\n–S";
  const memo = (changes: ChangeInput[]): MemoInput => ({
    ...memoSave().memo!,
    first_draft: first,
    final,
    mode: "draft",
    rounds: 1,
    changes,
  });
  const change = (
    before: string,
    after: string,
    rest: Partial<ChangeInput> = {},
  ): ChangeInput => ({ before, after, about: "voice", by: "person", ...rest });
  const ok = checkMemo(
    memo([
      // Curly against straight, a dash typed as a hyphen, a line break as a
      // space: folded to locate, stored as written.
      change("Hi Dana, I hope you're well!", "Dana -", {
        tweak: { text: "no warm-up opener" },
      }),
      // Two changes on one spot are both kept.
      change("so much for reaching out -", "for the note, but", {
        about: "content",
        by: "asked",
      }),
      change("Thanks so much", "", { about: "voice", by: "unasked" }),
      // Markdown marks dropped to locate; an insertion quotes only after.
      change("", "–S", { tweak: { text: "sign off –S" } }),
    ]),
  );
  expect(ok.ok).toBe(true);
  const evidence = ok.ok ? ok.evidence! : undefined;
  expect(evidence?.state).toBe("itemized");
  expect(
    evidence?.rows.map((r) => [r.before, r.after, r.about, r.by, r.tweakOf]),
  ).toEqual([
    ["Hi Dana, I hope you’re well!", "Dana -", "voice", "person", 0],
    [
      "so much for reaching out —",
      "for the note, but",
      "content",
      "asked",
      undefined,
    ],
    ["Thanks so much", "", "voice", "unasked", undefined],
    ["", "–S", "voice", "person", 3],
    // A spot no change covers: Markdown only.
    ["Thursday", "**Thursday**", "format", null, undefined],
  ]);
  // Every refusal names the change; none is a database refusal.
  const refused = (changes: ChangeInput[], extra: Partial<MemoInput> = {}) => {
    const r = checkMemo({ ...memo(changes), ...extra });
    return r.ok
      ? undefined
      : [r.code, r.message, ...(r.field ? [r.field] : [])];
  };
  expect(refused([change("Hello Dana", "")])).toEqual([
    "invalid_change",
    "change 1: a quote is not in its text (before from the first draft, after from the final).",
  ]);
  expect(refused([change("", "meet Thursday")])).toMatchObject([
    "invalid_change",
    "change 1: the quote is in its text, but not where the two texts differ.",
  ]);
  // A quote twice in its text, once where the texts differ, is that one.
  // Markdown marks alone locate nothing.
  expect(
    checkMemo({
      ...memo([change("Yes.", "")]),
      first_draft: "Yes. Fine. Yes.",
      final: "Yes. Fine.",
    }),
  ).toMatchObject({
    ok: true,
    evidence: { rows: [{ before: "Yes.", draftStart: 11 }] },
  });
  expect(refused([change("", "**")])).toMatchObject([
    "invalid_change",
    expect.any(String),
  ]);
  // A quote at two changed places is ambiguous.
  const twice = checkMemo({
    ...memo([change("No", "")]),
    first_draft: "No. This is fine. No.",
    final: "This is fine.",
  });
  expect(twice).toMatchObject({
    ok: false,
    code: "invalid_change",
    message: expect.stringContaining("more than one changed place"),
  });
  // A moved, reworded sentence: the diff sees a cut at one spot and an
  // addition at another, and one change covering both is kept, both sides cut.
  const moved = checkMemo({
    ...memo([
      change(
        "Although it is relatively small, it is not entirely straightforward, and I thought you would be well placed to help.",
        "The estate is modest but not straightforward, so an hour should do.",
      ),
    ]),
    first_draft:
      "Dear Ms Rowe,\n\nI am writing about my late aunt's estate. Although it is relatively small, it is not entirely straightforward, and I thought you would be well placed to help. Could we speak next week?\n\nKind regards,\nSam",
    final:
      "Dear Ms Rowe,\n\nI am writing about my late aunt's estate, and I thought you would be well placed to help. Could we speak next week? The estate is modest but not straightforward, so an hour should do.\n\nKind regards,\nSam",
  });
  expect(
    moved.ok
      ? moved.evidence!.rows.map((r) => [r.before, r.after, r.by])
      : moved,
  ).toEqual([
    [
      "Although it is relatively small, it is not entirely straightforward, and I thought you would be well placed to help.",
      "The estate is modest but not straightforward, so an hour should do.",
      "person",
    ],
  ]);
  expect(refused([change(" ", "")])).toMatchObject([
    "invalid_input",
    "change 1: before and after can't both be empty.",
  ]);
  for (const label of [
    { about: "content" as const },
    { by: "unasked" as const },
  ])
    expect(
      refused([change("Hi Dana", "", { ...label, tweak: { text: "x" } })]),
    ).toMatchObject([
      "invalid_input",
      expect.stringContaining("a tweak goes only on a voice change"),
    ]);
  expect(
    refused([change("Hi Dana", "", { tweak: { text: "!!" } })]),
  ).toMatchObject([
    "invalid_input",
    "change 1: a tweak needs words, not only punctuation.",
  ]);
  // At most three distinct tweaks; a repeat of one (by id or wording) is one.
  const tweaks = ["one", "Two", "two.", "three"].map((text) =>
    change("Hi Dana", "", { tweak: { text } }),
  );
  expect(refused(tweaks)).toBeUndefined();
  expect(
    refused([...tweaks, change("Hi Dana", "", { tweak: { tweak_id: "t" } })]),
  ).toEqual([
    "invalid_input",
    "This memo names 4 tweaks; a memo teaches at most 3.",
    "changes.tweak",
  ]);
  // changes need a kept first draft that differs from the final.
  expect(
    refused([change("Hi", "")], {
      first_draft: undefined,
      first_draft_missing: true,
    }),
  ).toMatchObject([
    "invalid_input",
    expect.stringContaining("first_draft_missing"),
  ]);
  expect(refused([change("Hi", "")], { final: first })).toMatchObject([
    "invalid_input",
    expect.stringContaining("nothing changed"),
  ]);
  // Too large: each quote must occur once, and the sides differ unfolded.
  const long = Array.from({ length: 101 }, (_, i) => `w${i} keep keep keep`);
  const big = (changes: ChangeInput[]) =>
    checkMemo({
      ...memo(changes),
      first_draft: long.join(" ") + " Best, AI",
      final: long.map((w) => `x${w}`).join(" ") + " Best — S",
    });
  expect(big([change("Best, AI", "Best — S")])).toMatchObject({
    ok: true,
    evidence: {
      state: "too_large",
      rows: [{ before: "Best, AI", after: "Best — S" }],
    },
  });
  expect(big([change("keep keep", "")])).toMatchObject({
    ok: false,
    code: "invalid_change",
  });
  expect(big([change("Best", "Best")])).toMatchObject({
    ok: false,
    code: "invalid_change",
  });
  // A stored side is cut at 300 characters, marked truncated.
  const longDraft = "x".repeat(400);
  expect(
    checkMemo({ ...memo([]), first_draft: longDraft, final: "y" }),
  ).toMatchObject({
    ok: true,
    evidence: {
      rows: [{ before: "x".repeat(300), after: "y", truncated: true }],
    },
  });
});

test("a request is the person's typed ask on a drafted memo: trimmed, capped, never pasted mail, kept unserved, and removable on the TPS page", async () => {
  const drafted = (request: string, rest: Partial<MemoInput> = {}) =>
    checkMemo({
      ...memoSave().memo!,
      first_draft_missing: true,
      mode: "draft",
      rounds: 1,
      request,
      ...rest,
    });
  expect(drafted("Decline their call, short and kind.")).toEqual({ ok: true });
  expect(drafted("Line one\nLine two")).toEqual({ ok: true });
  const requests: [string, string][] = [
    ["", "request is empty"],
    ["x".repeat(601), "over 600 characters"],
    [Array(13).fill("line").join("\n"), "over 12 lines"],
    ["Reply to this\r\nplease", "control characters"],
    ["Reply to this:\n> Can we meet Friday?", "quoted or pasted mail"],
    ["Answer it.\nOn Tue, Sam wrote:", "quoted or pasted mail"],
    ["Reply.\nFrom: Sam", "quoted or pasted mail"],
    ["subject: lunch", "quoted or pasted mail"],
  ];
  for (const [request, says] of requests)
    expect(drafted(request)).toMatchObject({
      ok: false,
      code: "invalid_input",
      field: "request",
      message: expect.stringContaining(says),
    });
  // Writing the person gave takes none.
  expect(
    checkMemo({ ...memoSave().memo!, request: "Keep this." }),
  ).toMatchObject({ ok: false, field: "request" });
  const local = await localStore();
  try {
    await seedUsers(local.pg, "asker");
    const store = fixtureStore(local.db, "asker");
    const input = memoSave({
      first_draft: draft,
      mode: "draft",
      rounds: 1,
      request: "  Say no to the vendor's call, nicely.  ",
      changes: teach("Hi there!", { text: "no warm-up opener" }),
    });
    const saved = await store.saveMemo(input);
    // The result and its receipt hold counts, never the request or a quote.
    expect(saved.memo!.changes).toEqual({ found: 2, labelled: 1 });
    const receipt = (
      await local.pg.query<{ result: string }>(
        "SELECT result_json::text AS result FROM save_requests WHERE user_id='asker'",
      )
    ).rows[0]!.result;
    expect(receipt).not.toContain("vendor's call");
    expect(receipt).not.toContain("Hi there!");
    // Trimmed before hashing and storing; a resave of the same words is
    // unchanged, with the counts on file, and new labels are ignored.
    expect(
      (await local.pg.query("SELECT request FROM memos WHERE user_id='asker'"))
        .rows,
    ).toEqual([{ request: "Say no to the vendor's call, nicely." }]);
    expect(
      await store.saveMemo({
        ...input,
        request_id: crypto.randomUUID(),
        memo: { ...input.memo!, changes: undefined },
      }),
    ).toMatchObject({
      status: "unchanged",
      memo: { changes: { found: 2, labelled: 1 } },
    });
    // Never served.
    const report = await store.readReport(vendorIntent);
    expect(JSON.stringify(report)).not.toContain("vendor's call");
    // The TPS page shows it, with the changes and the typed share, and the
    // person can remove it.
    const tps = tpsStore(local.db, "asker");
    const shown = await tps.readMemo(saved.memo!.memo_id);
    expect(shown).toMatchObject({
      request: "Say no to the vendor's call, nicely.",
      changes_state: "itemized",
      changes: [
        {
          n: 0,
          before: "Hi there!",
          after: "",
          about: "voice",
          by: "person",
          tweak: { text: "no warm-up opener" },
        },
        { n: 1, about: null, by: null },
      ],
      typed_share: 0,
    });
    expect(await tps.removeRequest(saved.memo!.memo_id)).toBe(true);
    expect(await tps.readMemo(saved.memo!.memo_id)).not.toHaveProperty(
      "request",
    );
  } finally {
    await local.dispose();
  }
});

test("a report serves each served tweak's newest voice example within 3 KiB, needed-again tweaks first; a reword restarts the score, not the examples", async () => {
  expect(
    [
      ...selectTweakExamples(
        [
          { tweak_id: "a", needed_again: 0 },
          { tweak_id: "b", needed_again: 2 },
          { tweak_id: "c", needed_again: 0 },
        ],
        new Map([
          ["a", "x".repeat(2100)],
          ["b", "y".repeat(1000)],
          ["c", "z".repeat(50)],
        ]),
      ).keys(),
    ],
    // b first (needed again), then a would pass 3 KiB, so c.
  ).toEqual(["b", "c"]);
  const local = await localStore();
  try {
    await seedUsers(local.pg, "u");
    const store = fixtureStore(local.db, "u");
    const tps = tpsStore(local.db, "u");
    const save = (memo: Partial<MemoInput>) =>
      store.saveMemo(memoSave({ mode: "draft", rounds: 1, ...memo }));
    const taught = await save({
      first_draft: "Hi! Hope you're well. We'll pass.",
      final: "We'll pass.",
      changes: teach("Hi! Hope you're well.", { text: "no warm-up opener" }),
    });
    const opener = taught.memo!.tweaks[0]!.tweak_id;
    // A newer example in another medium, and a content change naming none.
    await save({
      first_draft: "Hello friend! We'll pass.",
      final: "We'll pass, friend.",
      context: { summary: "a fictional chat decline", medium: "chat" },
      changes: [
        {
          before: "Hello friend!",
          after: "",
          about: "voice",
          by: "asked",
          tweak: { tweak_id: opener },
        },
        { before: "", after: ", friend", about: "content", by: "person" },
      ],
    });
    const report = await store.readReport(vendorIntent);
    expect(report.text).toContain(
      '- no warm-up opener (2 memos)\n  cut: "Hi! Hope you\'re well."',
    );
    expect(report.tweaks).toEqual([
      { tweak_id: opener, text: "no warm-up opener", memos: 2 },
    ]);
    expect(
      (await store.readReport({ ...vendorIntent, medium: "chat" })).text,
    ).toContain('  cut: "Hello friend!"');
    // Needed again once, then reworded: the counts restart; the example stays.
    await save({
      first_draft: "Hi! Hope you're well. Not now.",
      final: "Not now.",
      report_id: report.report_id,
      changes: teach("Hi!", { tweak_id: opener }),
    });
    expect((await tps.read()).tweaks[0]).toMatchObject({
      served: 1,
      needed_again: 1,
    });
    expect(await tps.rewordTweak(opener, "No warm-up opener at all")).toBe(
      true,
    );
    expect((await tps.read()).tweaks[0]).toMatchObject({
      text: "No warm-up opener at all",
      served: 0,
      needed_again: 0,
    });
    expect((await store.readReport(vendorIntent)).text).toContain(
      '- No warm-up opener at all (3 memos)\n  cut: "Hi!"',
    );
  } finally {
    await local.dispose();
  }
});
