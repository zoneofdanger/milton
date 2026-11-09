import { expect, test } from "bun:test";
import { localStore } from "./local-store";
import {
  fixtureStore,
  memoSave,
  seedUsers,
  vendorIntent,
} from "./store-fixtures";
import { change, scoreboard, tier } from "../src/store/score";
import type { MemoInput } from "../src/mcp-tools";

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
      tweaks: [
        { text: "Vendor replies: no warm-up opener." },
        { text: "declines: 2–3 sentences" },
      ],
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
      [{ mode: "draft" }, /takes no mode, rounds or tweaks/],
      [{ first_draft: draft }, /send mode/],
      [
        {
          first_draft: final,
          final,
          mode: "draft",
          rounds: 0,
          tweaks: [{ text: "x" }],
        },
        /teaches no tweaks/,
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
        tweaks: [{ text: "No warm-up opener" }],
      }),
    );
    const opener = first.memo!.tweaks[0]!.tweak_id;
    const second = await store.saveMemo(
      memoSave({
        first_draft: draft + " Best!",
        final: final + " ",
        mode: "draft",
        rounds: 1,
        tweaks: [{ text: "no  warm-up opener." }, { text: "Sign off –P" }],
      }),
    );
    expect(second.memo!.tweaks.map((t) => t.tweak_id)).toContain(opener);
    const third = await store.saveMemo(
      memoSave({
        first_draft: draft,
        final: "Thanks. Not this time.\n\n–P",
        mode: "draft",
        rounds: 1,
        tweaks: [{ tweak_id: opener }],
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
        tweaks: [{ text: "Shorter" }],
      }),
    );
    expect(
      await store.saveMemo(
        memoSave({
          first_draft: draft,
          final: "No.",
          mode: "draft",
          rounds: 1,
          tweaks: [{ tweak_id: foreign.memo!.tweaks[0]!.tweak_id }],
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
          tweaks: [{ text: `tweak ${i}` }, { text: "shared tweak" }],
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

test("the cover sheet takes whole lines from an AI, fenced by version, capped and never emptied", async () => {
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
    expect(
      await cover({ remove: "Sign off –P", expected_version: 3 }),
    ).toMatchObject({ status: "failed", error: "cover_sheet_empty" });
    let version = 3;
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
