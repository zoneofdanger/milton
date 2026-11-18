import { expect, test } from "bun:test";
import { localStore } from "./local-store";
import {
  fixtureStore,
  memoSave,
  seedLegacy,
  seedUsers,
} from "./store-fixtures";
import { checkMemo, hash, REPLAYED, type Evidence } from "../src/store/save";
import { change, tier } from "../src/store/score";
import { nextSteps, withNext } from "../src/mcp-outcomes";
import { EMPTY_REPORT, readReport } from "../src/store/memos";
import type { SQL } from "drizzle-orm";
import type { MemoInput, SaveMemoInput } from "../src/mcp-tools";

test("a refusal stores a receipt with its outcome and replays it; a pre-release receipt replays verbatim, labelled, and an old-shape retry is refused without touching it", async () => {
  const local = await localStore();
  try {
    await seedUsers(local.pg, "replay");
    const store = fixtureStore(local.db, "replay");
    // A refusal decided against the request replays the same way.
    const unknownKind = memoSave({ kind_id: "not-a-kind" });
    const refused = await store.saveMemo(unknownKind);
    expect(refused).toMatchObject({ status: "failed", error: "invalid_kind" });
    expect(await store.saveMemo(unknownKind)).toEqual({
      ...refused,
      replayed: REPLAYED,
    });
    // A changed retry under the same ID is told to take a new one.
    await expect(
      store.saveMemo({
        ...unknownKind,
        memo: { ...unknownKind.memo!, kind_id: "k2" },
      }),
    ).rejects.toMatchObject({
      code: "request_id_reused",
      message:
        "This request ID belongs to different input. A changed save needs a new request_id; the original arguments replay the same outcome.",
    });
    // A refusal wrote nothing else.
    expect((await local.pg.query("SELECT 1 FROM memos")).rows).toEqual([]);
    // Receipts written before this release hold fields it no longer writes.
    // An exact replay returns them as stored, beside the one label.
    const receipt = async (input: object, outcome: object) =>
      local.pg.query(
        "INSERT INTO save_requests(user_id,request_id,input_hash,result_json) VALUES ('replay',$1,$2,$3::jsonb)",
        [
          (input as { request_id: string }).request_id,
          hash(input),
          JSON.stringify(outcome),
        ],
      );
    const given = memoSave({ final: "Kept before the release." });
    const old = {
      status: "saved",
      request_id: given.request_id,
      memo: { memo_id: "m-old", tier: "own", tweaks: [] },
      receipt: "Kept memo: email, your words.",
    };
    await receipt(given, old);
    const coverInput = {
      request_id: crypto.randomUUID(),
      forget_memos: ["m-gone"],
    };
    const oldCover = {
      status: "conflict",
      request_id: coverInput.request_id,
      cover_sheet: { version: 2, text: "No em dashes" },
    };
    await receipt(coverInput, oldCover);
    expect((await store.saveMemo(given)) as unknown).toEqual({
      ...old,
      replayed: REPLAYED,
    });
    expect((await store.saveMemo(coverInput)) as unknown).toEqual({
      ...oldCover,
      replayed: REPLAYED,
    });
    // A drafted save from before the release carried rounds: its retry is
    // refused before the lookup, saying it can't recover the outcome, and
    // the stored receipt is untouched.
    const drafted = {
      request_id: crypto.randomUUID(),
      memo: {
        ...memoSave().memo!,
        first_draft: "A first draft.",
        mode: "draft" as const,
        rounds: 1,
      },
    };
    const draftedOutcome = {
      status: "saved",
      request_id: drafted.request_id,
      memo: {
        memo_id: "m-drafted",
        tier: "steered",
        rounds: 1,
        tweaks: [{ tweak_id: "t", text: "no warm-up opener" }],
      },
      receipt: "Kept memo: email, 1 round, tweaks: no warm-up opener.",
    };
    await receipt(drafted, draftedOutcome);
    await expect(store.saveMemo(drafted as never)).rejects.toMatchObject({
      code: "invalid_input",
      message: expect.stringContaining(
        "Milton can't recover an earlier outcome for this request.",
      ),
    });
    expect(
      (
        await local.pg.query<{ result: unknown }>(
          "SELECT result_json AS result FROM save_requests WHERE request_id=$1",
          [drafted.request_id],
        )
      ).rows,
    ).toEqual([{ result: draftedOutcome }]);
  } finally {
    await local.dispose();
  }
});

test("a save and its receipt commit together: a lost acknowledgment replays the outcome, a failed lookup answers save_outcome_unknown, and an uncommitted save leaves no receipt", async () => {
  const local = await localStore();
  try {
    await seedUsers(local.pg, "uncertain");
    // Each transaction takes the next cue: "early" fails it before its first
    // statement, "abort" fails it before commit, "ack" loses the
    // acknowledgment of its commit, "lookup" fails it unrun.
    const cues: ("early" | "abort" | "ack" | "lookup" | undefined)[] = [];
    const flaky = {
      ...local.db,
      async transaction<T>(
        work: Parameters<typeof local.db.transaction<T>>[0],
      ) {
        const cue = cues.shift();
        if (cue === "lookup") throw new Error("Fictional unavailable lookup");
        const result = await local.db.transaction(async (tx) => {
          if (cue === "early")
            throw new Error("Fictional connection lost before the lookup");
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
    const count = async (table: string) =>
      (
        await local.pg.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM ${table} WHERE user_id='uncertain'`,
        )
      ).rows[0]!.n;
    // Rolled back before commit: the lookup finds no receipt, so nothing was
    // written and the same request runs again.
    const aborted = memoSave({ final: "Aborted memo." });
    cues.push("abort");
    await expect(store.saveMemo(aborted)).rejects.toMatchObject({
      code: "store_unavailable",
    });
    expect([await count("save_requests"), await count("memos")]).toEqual([
      0, 0,
    ]);
    expect((await store.saveMemo(aborted)).status).toBe("saved");
    // Committed without its acknowledgment: the lookup returns the outcome.
    const lost = memoSave({ final: "Acknowledged late." });
    cues.push("ack");
    const recovered = await store.saveMemo(lost);
    expect(recovered.status).toBe("saved");
    // Recovered outcomes are labelled: the recovery can't tell this
    // invocation's commit from an earlier one's.
    expect(recovered.replayed).toBe(REPLAYED);
    expect(await store.saveMemo(lost)).toEqual(recovered);
    // A receipt from before the release, recovered after a transient failure
    // before the lookup, or after a lost acknowledgment while replaying it,
    // comes back as stored, old fields included, and labelled.
    const historical = memoSave({ final: "Kept before the release." });
    const old = {
      status: "saved",
      request_id: historical.request_id,
      memo: {
        memo_id: "m-old",
        tier: "own",
        rounds: 2,
        tweaks: [{ tweak_id: "t-old", text: "no warm-up opener" }],
      },
      receipt: "Kept memo: email, 2 rounds, tweaks: no warm-up opener.",
    };
    await local.pg.query(
      "INSERT INTO save_requests(user_id,request_id,input_hash,result_json) VALUES ('uncertain',$1,$2,$3::jsonb)",
      [historical.request_id, hash(historical), JSON.stringify(old)],
    );
    for (const cue of ["early", "ack"] as const) {
      cues.push(cue);
      expect([cue, (await store.saveMemo(historical)) as unknown]).toEqual([
        cue,
        { ...old, replayed: REPLAYED },
      ]);
    }
    // When the lookup fails too, the outcome is unknown until the same
    // request replays it.
    const unknown = memoSave({ final: "Unknown until replayed." });
    cues.push("ack", "lookup");
    await expect(store.saveMemo(unknown)).rejects.toMatchObject({
      code: "save_outcome_unknown",
      details: { request_id: unknown.request_id },
    });
    expect((await store.saveMemo(unknown)).status).toBe("saved");
    expect([await count("save_requests"), await count("memos")]).toEqual([
      4, 3,
    ]);
  } finally {
    await local.dispose();
  }
});

test("fresh outcomes carry no replayed label: a save, a dedupe unchanged, a context correction, a forget and a durable refusal", async () => {
  const local = await localStore();
  try {
    await seedUsers(local.pg, "fresh");
    const store = fixtureStore(local.db, "fresh");
    const saved = await store.saveMemo(
      memoSave({
        first_draft: "Hi! A draft.",
        final: "A final.",
        mode: "draft",
      }),
    );
    const fresh = [
      saved,
      await store.saveMemo(
        memoSave({
          first_draft: "Hi! A draft.",
          final: "A final.",
          mode: "draft",
        }),
      ),
      await store.saveMemo({
        request_id: crypto.randomUUID(),
        memo_context: {
          memo_id: saved.memo!.memo_id,
          context: { summary: "a corrected note", medium: "chat" },
        },
      }),
      await store.saveMemo({
        request_id: crypto.randomUUID(),
        forget_memos: [saved.memo!.memo_id],
      }),
      await store.saveMemo(memoSave({ kind_id: "not-a-kind" })),
    ];
    expect(fresh.map((o) => o.status)).toEqual([
      "saved",
      "unchanged",
      "saved",
      "saved",
      "failed",
    ]);
    for (const outcome of fresh) expect(outcome).not.toHaveProperty("replayed");
  } finally {
    await local.dispose();
  }
});

test("a rollout-boundary refusal's receipt lookup is the account's own: the same request_id held by another account reads as none", async () => {
  const local = await localStore();
  try {
    await seedUsers(local.pg, "holder", "other");
    const holder = fixtureStore(local.db, "holder");
    const other = fixtureStore(local.db, "other");
    const shared = memoSave({ final: "Held by the holder." });
    expect((await holder.saveMemo(shared)).status).toBe("saved");
    const stale = {
      ...memoSave({ first_draft: "A draft.", mode: "draft" }),
      request_id: shared.request_id,
    };
    stale.memo = { ...stale.memo!, rounds: 1 } as never;
    expect(await other.requestReceipt(shared.request_id)).toBe(false);
    await expect(other.saveMemo(stale)).rejects.toMatchObject({
      details: { field: "removed_unsaved" },
    });
    // The holder's own lookup finds it.
    expect(await holder.requestReceipt(shared.request_id)).toBe(true);
    await expect(holder.saveMemo(stale)).rejects.toMatchObject({
      details: { field: "removed" },
    });
  } finally {
    await local.dispose();
  }
});

// A replace (docs/saves.md, "Replacing a final"): the person's AI updates a
// final it saved with their newer version, under the same id.
const draft =
  "Hi Dana! Thanks so much for the invite. Sadly we can't make Thursday.";
const replaceOf = (
  memo_id: string,
  final: string,
  memo: Partial<MemoInput> = {},
): SaveMemoInput =>
  memoSave({
    first_draft: draft,
    mode: "draft",
    final,
    replaces: memo_id,
    ...memo,
  });

test("a replace deletes the old memo and inserts the new final under the same id and creation time, with its own changes, silently; retries replay", async () => {
  const local = await localStore();
  try {
    await seedUsers(local.pg, "replacer");
    const store = fixtureStore(local.db, "replacer");
    const original = memoSave({
      first_draft: draft,
      final: "Dana, thanks for the invite. We can't make Thursday.",
      mode: "draft",
      new_kind: "vendor decline",
    });
    const saved = await store.saveMemo(original);
    const id = saved.memo!.memo_id;
    // A legacy note citing only this memo goes with it, as on a forget.
    await seedLegacy(local.pg, "replacer", {
      notes: ["no exclamation marks"],
      citedBy: id,
    });
    const row = async () =>
      (
        await local.pg.query<{
          id: string;
          at: string;
          final: string;
          first_draft: string;
          tier: string;
          change: number;
          kind_id: string | null;
          request_id: string;
          changes_state: string | null;
        }>(
          "SELECT id,created_at::text AS at,final,first_draft,tier,change,kind_id,request_id,changes_state FROM memos WHERE user_id='replacer'",
        )
      ).rows;
    const changes = async () =>
      (
        await local.pg.query(
          `SELECT n,"before","after" FROM memo_changes WHERE user_id='replacer' AND memo_id=$1 ORDER BY n`,
          [id],
        )
      ).rows;
    const count = async (table: string) =>
      (
        await local.pg.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM ${table} WHERE user_id='replacer'`,
        )
      ).rows[0]!.n;
    const [before] = await row();
    expect(await changes()).not.toEqual([]);
    // Three replaces in a row: untouched (the final is the first draft), then
    // two hand edits. Each keeps the id and creation time, and its changes
    // are exactly code's list for the new final.
    const finals = [
      draft,
      "Dana, thanks for the invite. Thursday doesn't work for us.",
      "Dana, thanks. Thursday doesn't work; next week?",
    ];
    for (const final of finals) {
      const input = replaceOf(id, final, { new_kind: "vendor note" });
      const outcome = await store.saveMemo(input);
      const evidence = (checkMemo(input.memo!) as { evidence: Evidence })
        .evidence;
      expect(outcome).toEqual({
        status: "saved",
        request_id: input.request_id,
        memo: {
          memo_id: id,
          tier: final === draft ? "untouched" : "steered",
          kind_id: expect.any(String),
          kind: "vendor note",
          change: expect.any(Number),
          changes: {
            state: "itemized",
            found: evidence.rows.filter((r) => r.about !== "format").length,
          },
        },
        replaced: true,
      });
      expect(outcome).not.toHaveProperty("receipt");
      const [now] = await row();
      expect(now).toMatchObject({
        id,
        at: before!.at,
        final,
        first_draft: draft,
        tier: outcome.memo!.tier,
        kind_id: outcome.memo!.kind_id!,
        request_id: input.request_id,
        changes_state: "itemized",
      });
      expect(now!.change).toBeCloseTo(change(draft, final)!, 9);
      expect(await changes()).toEqual(
        evidence.rows.map((r) => ({
          n: r.n,
          before: r.before,
          after: r.after,
        })),
      );
      // Retries replay; a changed retry under the same id is refused.
      expect(await store.saveMemo(input)).toEqual({
        ...outcome,
        replayed: REPLAYED,
      });
      await expect(
        store.saveMemo({
          ...input,
          memo: { ...input.memo!, final: `${final} Changed.` },
        }),
      ).rejects.toMatchObject({ code: "request_id_reused" });
    }
    // One memo throughout; the orphaned note went with the first replace.
    expect([
      await count("memos"),
      await count("tweaks"),
      await count("tweak_citations"),
    ]).toEqual([1, 0, 0]);
    // The original save still replays its own stored outcome, receipt and all.
    expect(await store.saveMemo(original)).toEqual({
      ...saved,
      replayed: REPLAYED,
    });
    // The new kind exists once; the old one stays, as kinds do.
    expect(await count("memo_kinds")).toBe(2);
    // replaces is part of the hashed input.
    const plain = replaceOf(id, "Another final.");
    const { replaces: _gone, ...rest } = plain.memo!;
    expect(hash(plain)).not.toBe(hash({ ...plain, memo: rest }));
  } finally {
    await local.dispose();
  }
});

test("a replace is refused, saving nothing, for an unknown or forgotten memo, or, on a memo with a kept first draft, a first draft that differs or isn't sent; refusals replay; another connection may replace", async () => {
  const local = await localStore();
  try {
    await seedUsers(local.pg, "refuser");
    const store = fixtureStore(local.db, "refuser");
    const other = fixtureStore(local.db, "refuser", "another-ai");
    const id = (
      await store.saveMemo(
        memoSave({ first_draft: draft, mode: "draft", final: "Dana, no." }),
      )
    ).memo!.memo_id;
    const given = (await store.saveMemo(memoSave({ final: "Given." }))).memo!
      .memo_id;
    const forgotten = (
      await store.saveMemo(
        memoSave({ first_draft: draft, mode: "draft", final: "Forgotten." }),
      )
    ).memo!.memo_id;
    await store.saveMemo({
      request_id: crypto.randomUUID(),
      forget_memos: [forgotten],
    });
    const words = async () =>
      (
        await local.pg.query(
          "SELECT id,final,request_id FROM memos WHERE user_id='refuser' ORDER BY id",
        )
      ).rows;
    const kept = await words();
    const finalOnly = (memo_id: string) =>
      memoSave({ final: "New.", replaces: memo_id });
    const refusals: [SaveMemoInput, string, ReturnType<typeof fixtureStore>][] =
      [
        [replaceOf(crypto.randomUUID(), "New."), "replace_unknown", store],
        [replaceOf(forgotten, "New."), "replace_unknown", store],
        // A kept first draft is never contradicted or dropped.
        [
          replaceOf(id, "New.", { first_draft: `${draft} ` }),
          "replace_first_draft",
          store,
        ],
        [finalOnly(id), "replace_first_draft", store],
      ];
    for (const [input, error, by] of refusals) {
      const outcome = await by.saveMemo(input);
      expect([error, outcome]).toEqual([
        error,
        {
          status: "failed",
          request_id: input.request_id,
          error,
          message: expect.stringContaining("Nothing was saved."),
        },
      ]);
      expect(await by.saveMemo(input)).toEqual({
        ...outcome,
        replayed: REPLAYED,
      });
    }
    expect(await words()).toEqual(kept);
    // The next steps: never resave a gone memo as new; a kept first draft is
    // resent as is or as missing. Read
    // without toMatchObject, which writes its matchers into the shared
    // nextSteps table (Bun 1.4.4).
    const unknown = withNext({ error: "replace_unknown", message: "m" }).next;
    expect(unknown.action).toBe("tell_user");
    expect(unknown.text).toContain("Don't save this again as a new memo");
    const firstDraft = withNext({
      error: "replace_first_draft",
      message: "m",
    }).next;
    expect(firstDraft.action).toBe("fix_input");
    expect(firstDraft.text).toContain("first_draft_missing");
    expect(nextSteps).not.toHaveProperty("replace_refused");
    // Any of the account's connections may replace a memo by id (Peter,
    // 2026-11-17): another AI replaces both memos, with their own rules.
    expect(await other.saveMemo(finalOnly(given))).toMatchObject({
      status: "saved",
      memo: { memo_id: given },
      replaced: true,
    });
    expect(
      await other.saveMemo(
        replaceOf(id, "New.", {
          first_draft: undefined,
          first_draft_missing: true,
        }),
      ),
    ).toMatchObject({ status: "saved", memo: { memo_id: id }, replaced: true });
  } finally {
    await local.dispose();
  }
});

test("a memo saved without a kept first draft can be replaced, saved exactly as sent under the same id: a missing draft replaced by a missing draft, writing the person gave, and a first draft sent where none was kept", async () => {
  const local = await localStore();
  try {
    await seedUsers(local.pg, "nodraft");
    const store = fixtureStore(local.db, "nodraft");
    const intent = {
      situation: "declining a vendor's meeting request",
      medium: "email" as const,
      audience: "a vendor",
      purpose: "decline",
    };
    const rows = async () =>
      (
        await local.pg.query<
          Record<string, unknown> & { id: string; at: string }
        >(
          `SELECT m.id,m.created_at::text AS at,m.final,m.first_draft,m.first_draft_state,m.mode,m.tier,
            (SELECT count(*)::int FROM memo_changes c WHERE c.user_id=m.user_id AND c.memo_id=m.id) AS changes
          FROM memos m WHERE m.user_id='nodraft' ORDER BY m.created_at`,
        )
      ).rows;
    // The reviewer's sequence: A saved with first_draft_missing, then
    // replaced with first_draft_missing and a new final.
    const a = (
      await store.saveMemo(
        memoSave({
          first_draft_missing: true,
          mode: "draft",
          final: "Dana, no Thursday.",
        }),
      )
    ).memo!.memo_id;
    const [before] = await rows();
    const replaced = await store.saveMemo(
      memoSave({
        first_draft_missing: true,
        mode: "draft",
        final: "Dana, Thursday is out, sorry.",
        replaces: a,
      }),
    );
    expect(replaced).toMatchObject({
      status: "saved",
      memo: { memo_id: a, tier: "steered" },
      replaced: true,
    });
    expect(await rows()).toEqual([
      {
        id: a,
        at: before!.at,
        final: "Dana, Thursday is out, sorry.",
        first_draft: null,
        first_draft_state: "missing",
        mode: "draft",
        tier: "steered",
        changes: 0,
      },
    ]);
    const report = await readReport(local.db, "nodraft", intent);
    expect(report.examples.map((e) => e.memo_id)).toEqual([a]);
    expect(report.text).toContain("> Dana, Thursday is out, sorry.");
    expect(report.text).not.toContain("Dana, no Thursday.");
    // Writing the person gave, replaced by their newer version.
    const given = (await store.saveMemo(memoSave({ final: "My own note." })))
      .memo!.memo_id;
    expect(
      await store.saveMemo(
        memoSave({ final: "My own note, edited.", replaces: given }),
      ),
    ).toMatchObject({
      status: "saved",
      memo: { memo_id: given, tier: "own" },
      replaced: true,
    });
    // The same writing again: unchanged.
    expect(
      await store.saveMemo(
        memoSave({ final: "My own note, edited.", replaces: given }),
      ),
    ).toMatchObject({ status: "unchanged", memo: { memo_id: given } });
    // A first draft sent where none was kept is the AI's best copy: stored
    // as sent, with its changes, though the final is the one on file.
    expect(
      await store.saveMemo(replaceOf(given, "My own note, edited.")),
    ).toMatchObject({
      status: "saved",
      memo: { memo_id: given, tier: "steered", changes: { state: "itemized" } },
      replaced: true,
    });
    expect((await rows()).find((r) => r.id === given)).toMatchObject({
      final: "My own note, edited.",
      first_draft: draft,
      first_draft_state: "kept",
      mode: "draft",
    });
    expect((await rows()).length).toBe(2);
    // With Keep memos off, a replace stores no first draft its memo didn't
    // already hold: writing the person gave stays final-only, a missing
    // draft stays missing; a memo with a kept draft keeps it.
    await local.pg.query(
      "INSERT INTO memo_settings(user_id,keep_memos) VALUES ('nodraft',false)",
    );
    const own = (await store.saveMemo(memoSave({ final: "Another note." })))
      .memo!.memo_id;
    for (const shape of [
      { first_draft: draft, mode: "draft" as const },
      { first_draft_missing: true as const, mode: "draft" as const },
    ])
      expect(
        (
          await store.saveMemo(
            memoSave({
              ...shape,
              final: "Another note, edited.",
              replaces: own,
            }),
          )
        ).error,
      ).toBe("memos_off");
    expect(
      (
        await store.saveMemo(
          memoSave({ final: "Another note, edited.", replaces: own }),
        )
      ).replaced,
    ).toBe(true);
    expect(
      (
        await store.saveMemo(
          memoSave({
            first_draft: draft,
            mode: "draft",
            final: "Dana, sorry.",
            replaces: a,
          }),
        )
      ).error,
    ).toBe("memos_off");
    expect(
      (
        await store.saveMemo(
          memoSave({
            first_draft_missing: true,
            mode: "draft",
            final: "Dana, sorry.",
            replaces: a,
          }),
        )
      ).replaced,
    ).toBe(true);
  } finally {
    await local.dispose();
  }
});

test("a replace may send first_draft_missing: Milton keeps the stored first draft and works out the changes, tier and change from it and the new final; retries replay as sent", async () => {
  const local = await localStore();
  try {
    await seedUsers(local.pg, "compacted", "sent");
    // The same memo replaced twice, once with first_draft_missing and once
    // with the first draft sent: both store the same words, changes and tier.
    const run = async (user: string, missing: boolean) => {
      const store = fixtureStore(local.db, user);
      const id = (
        await store.saveMemo(
          memoSave({ first_draft: draft, mode: "draft", final: "Dana, no." }),
        )
      ).memo!.memo_id;
      const input = replaceOf(
        id,
        "Dana, thanks, but Thursday doesn't work.",
        missing ? { first_draft: undefined, first_draft_missing: true } : {},
      );
      const outcome = await store.saveMemo(input);
      const rows = (
        await local.pg.query(
          `SELECT m.first_draft,m.first_draft_state,m.final,m.tier,m.change,m.changes_state,
            (SELECT json_agg(json_build_object('n',c.n,'before',c."before",'after',c."after",
              'draft_start',c.draft_start,'final_start',c.final_start) ORDER BY c.n)
              FROM memo_changes c WHERE c.user_id=m.user_id AND c.memo_id=m.id) AS changes
          FROM memos m WHERE m.user_id=$1`,
          [user],
        )
      ).rows;
      return { store, id, input, outcome, rows };
    };
    const compacted = await run("compacted", true);
    const sent = await run("sent", false);
    expect(compacted.rows).toEqual(sent.rows);
    expect(compacted.rows).toMatchObject([
      { first_draft: draft, first_draft_state: "kept", tier: "steered" },
    ]);
    const { request_id: _a, ...a } = compacted.outcome;
    const { request_id: _b, ...b } = sent.outcome;
    expect({ ...a, memo: { ...a.memo, memo_id: "" } }).toEqual({
      ...b,
      memo: { ...b.memo, memo_id: "" },
    });
    expect(compacted.outcome).toMatchObject({
      status: "saved",
      memo: { memo_id: compacted.id, changes: { state: "itemized" } },
      replaced: true,
    });
    // Hashed as sent: the exact retry replays; a changed one under the same
    // id is refused.
    expect(await compacted.store.saveMemo(compacted.input)).toEqual({
      ...compacted.outcome,
      replayed: REPLAYED,
    });
    await expect(
      compacted.store.saveMemo({
        ...compacted.input,
        memo: {
          ...compacted.input.memo!,
          first_draft_missing: undefined,
          first_draft: draft,
        },
      }),
    ).rejects.toMatchObject({ code: "request_id_reused" });
    // The final it already holds, with first_draft_missing: unchanged.
    expect(
      await compacted.store.saveMemo(
        replaceOf(compacted.id, "Dana, thanks, but Thursday doesn't work.", {
          first_draft: undefined,
          first_draft_missing: true,
        }),
      ),
    ).toMatchObject({ status: "unchanged", memo: { memo_id: compacted.id } });
  } finally {
    await local.dispose();
  }
});

test("a replace with the final its memo holds is unchanged; when another memo holds the words, the replaced memo goes and that one is unchanged; Keep memos off allows a replace", async () => {
  const local = await localStore();
  try {
    await seedUsers(local.pg, "dupes");
    const store = fixtureStore(local.db, "dupes");
    const save = async (final: string) =>
      (
        await store.saveMemo(
          memoSave({ first_draft: draft, mode: "draft", final }),
        )
      ).memo!.memo_id;
    const ids = async () =>
      (
        await local.pg.query<{ id: string }>(
          "SELECT id FROM memos WHERE user_id='dupes' ORDER BY created_at",
        )
      ).rows.map((r) => r.id);
    const a = await save("Dana, no.");
    const b = await save("Dana, not this time.");
    // The same final: nothing changes, and no replaced flag.
    const same = await store.saveMemo(replaceOf(a, "Dana, no."));
    expect(same).toMatchObject({ status: "unchanged", memo: { memo_id: a } });
    expect(same).not.toHaveProperty("replaced");
    expect(await ids()).toEqual([a, b]);
    // B already holds the new words: A goes, B is the outcome.
    const onFile = await store.saveMemo(replaceOf(a, "Dana, not this time."));
    expect(onFile).toMatchObject({
      status: "unchanged",
      memo: { memo_id: b },
    });
    expect(await ids()).toEqual([b]);
    // Keep memos turned off since: a replace corrects, adding nothing.
    await local.pg.query(
      "INSERT INTO memo_settings(user_id,keep_memos) VALUES ('dupes',false)",
    );
    expect(
      (await store.saveMemo(memoSave({ first_draft: draft, mode: "draft" })))
        .error,
    ).toBe("memos_off");
    expect(
      await store.saveMemo(replaceOf(b, "Dana, sorry, not this time.")),
    ).toMatchObject({ status: "saved", memo: { memo_id: b }, replaced: true });
    expect(await ids()).toEqual([b]);
  } finally {
    await local.dispose();
  }
});

test("a report serves a memo only in the version it ranked: one replaced between its two statements is left out with its changes, as a forgotten one is", async () => {
  const local = await localStore();
  try {
    await seedUsers(local.pg, "interleave");
    const store = fixtureStore(local.db, "interleave");
    const intent = {
      situation: "declining a vendor's meeting request",
      medium: "email" as const,
      audience: "a vendor",
      purpose: "decline",
    };
    // Each case: a steered memo, ranked by the first statement; then, before
    // the second, a replace with an untouched final (it would be labelled
    // steered), a final past the 128 KiB cap (it would bypass it), or a
    // same-size steered final (only the version differs).
    for (const final of [draft, "X".repeat(140000), "Dana, not thursday."]) {
      await local.pg.query("DELETE FROM memos WHERE user_id='interleave'");
      const id = (
        await store.saveMemo(
          memoSave({
            first_draft: draft,
            mode: "draft",
            final: "Dana, not Thursday.",
          }),
        )
      ).memo!.memo_id;
      let statements = 0;
      const pausing = {
        ...local.db,
        async query<Row extends Record<string, unknown>>(statement: SQL) {
          const rows = await local.db.query<Row>(statement);
          if (++statements === 1)
            expect((await store.saveMemo(replaceOf(id, final))).replaced).toBe(
              true,
            );
          return rows;
        },
      };
      const report = await readReport(pausing, "interleave", intent);
      expect([final.length, report]).toMatchObject([
        final.length,
        { is_empty: true, examples: [], memos: 1, text: EMPTY_REPORT },
      ]);
      // Read again, the new version is ranked and served by its own rules:
      // never an untouched or oversized final.
      const after = await readReport(local.db, "interleave", intent);
      expect(after.examples.map((e) => [e.memo_id, e.tier])).toEqual(
        final === "Dana, not thursday." ? [[id, "steered"]] : [],
      );
      if (final === "Dana, not thursday.")
        expect(after.text).toContain("> Dana, not thursday.");
    }
  } finally {
    await local.dispose();
  }
});

test("whichever AI saved the memo on file, the person's later edit replaces it: a replace or a save meeting another connection's identical memo, then a replace of that id, leaves one final, the newest", async () => {
  const local = await localStore();
  try {
    await seedUsers(local.pg, "crossing");
    const a = fixtureStore(local.db, "crossing", "ai-a");
    const b = fixtureStore(local.db, "crossing", "ai-b");
    const intent = {
      situation: "declining a vendor's meeting request",
      medium: "email" as const,
      audience: "a vendor",
      purpose: "decline",
    };
    const missing = (final: string, replaces?: string) =>
      memoSave({
        first_draft_missing: true,
        mode: "draft",
        final,
        ...(replaces ? { replaces } : {}),
      });
    const finals = async () =>
      (
        await local.pg.query<{ id: string; final: string }>(
          "SELECT id,final FROM memos WHERE user_id='crossing' ORDER BY created_at",
        )
      ).rows;
    const served = async () =>
      (await readReport(local.db, "crossing", intent)).text;
    // Third review's sequence: A's memo, B's newer words, A's replace meets
    // them (A's memo goes, B's is the outcome), then A replaces B's memo.
    const mine = (await a.saveMemo(missing("Dana, Thursday is out."))).memo!
      .memo_id;
    const theirs = (await b.saveMemo(missing("Dana, Friday works."))).memo!
      .memo_id;
    expect(
      await a.saveMemo(missing("Dana, Friday works.", mine)),
    ).toMatchObject({ status: "unchanged", memo: { memo_id: theirs } });
    expect(
      await a.saveMemo(missing("Dana, Monday works.", theirs)),
    ).toMatchObject({
      status: "saved",
      memo: { memo_id: theirs },
      replaced: true,
    });
    expect(await finals()).toEqual([
      { id: theirs, final: "Dana, Monday works." },
    ]);
    expect(await served()).toContain("> Dana, Monday works.");
    for (const gone of ["Thursday", "Friday"])
      expect(await served()).not.toContain(gone);
    // Fourth review's sequence: B saves, A's ordinary save of the same words
    // returns B's memo, and A replaces that id.
    await local.pg.query("DELETE FROM memos WHERE user_id='crossing'");
    const bs = (await b.saveMemo(missing("Dana, Friday works."))).memo!.memo_id;
    expect(await a.saveMemo(missing("Dana, Friday works."))).toMatchObject({
      status: "unchanged",
      memo: { memo_id: bs },
    });
    expect(await a.saveMemo(missing("Dana, Monday works.", bs))).toMatchObject({
      status: "saved",
      memo: { memo_id: bs },
      replaced: true,
    });
    expect(await finals()).toEqual([{ id: bs, final: "Dana, Monday works." }]);
    expect(await served()).toContain("> Dana, Monday works.");
    expect(await served()).not.toContain("Friday");
  } finally {
    await local.dispose();
  }
});

// docs/saves.md, "Starting text": the invariant on generated inputs. Each case
// seeds the same memos into two accounts, then sends one save to the first
// with started_from and to the second without it.
test("generated: a save carrying started_from changes an existing memo only when it is an edit or writing the person gave and exactly one memo's final is byte-identical; otherwise the store ends as the same save without the field leaves it", async () => {
  const local = await localStore();
  try {
    // mulberry32, seeded: the same 60 cases every run.
    let seed = 0x20261118;
    const random = () => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const pick = <T>(items: readonly T[]) =>
      items[Math.floor(random() * items.length)]!;
    // Fictional finals, with the near misses exact matching must refuse.
    const texts = [
      draft,
      "Dana, not Thursday.",
      "Dana, not Thursday.\n",
      "Dana,\r\nnot Thursday.",
      "Dana,\nnot Thursday.",
      "Dana, the café is booked.",
      "Dana, the café is booked.",
    ];
    const shapes = {
      given: (): Partial<MemoInput> => ({}),
      kept: (): Partial<MemoInput> => ({
        first_draft: pick([draft, ...texts]),
        mode: pick(["draft", "edit"] as const),
      }),
      missing: (): Partial<MemoInput> => ({
        first_draft_missing: true,
        mode: pick(["draft", "edit"] as const),
      }),
    };
    type Row = {
      id: string;
      at: string;
      final: string;
      first_draft: string | null;
      state: string;
      mode: string | null;
      tier: string;
      request: string | null;
      summary: string;
      medium: string;
      audience: string | null;
      purpose: string | null;
      changes: number;
    };
    const rows = async (user: string) =>
      (
        await local.pg.query<Row>(
          `SELECT m.id,m.created_at::text AS at,m.final,m.first_draft,m.first_draft_state AS state,
            m.mode,m.tier,m.request,m.summary,m.medium,m.audience,m.purpose,
            (SELECT count(*)::int FROM memo_changes c WHERE c.user_id=m.user_id AND c.memo_id=m.id) AS changes
          FROM memos m WHERE m.user_id=$1 ORDER BY m.created_at,m.id`,
          [user],
        )
      ).rows;
    const outcomeOf = async (
      store: ReturnType<typeof fixtureStore>,
      input: SaveMemoInput,
    ) => {
      try {
        return await store.saveMemo(input);
      } catch (error) {
        return { refused: (error as { code: string }).code };
      }
    };
    const seen = new Map<string, number>();
    const saw = (branch: string) =>
      seen.set(branch, (seen.get(branch) ?? 0) + 1);
    for (let n = 0; n < 60; n++) {
      const [a, b] = [`gen-a-${n}`, `gen-b-${n}`];
      await seedUsers(local.pg, a, b);
      const [withField, without] = [
        fixtureStore(local.db, a),
        fixtureStore(local.db, b),
      ];
      // The same memos, in the same order and under the same request ids.
      const seeded: string[] = [];
      for (let s = Math.floor(random() * 5); s > 0; s--) {
        const seedSave = memoSave({
          final: pick(texts),
          ...pick(Object.values(shapes))(),
        });
        seeded.push(seedSave.memo!.final);
        await withField.saveMemo(seedSave);
        await without.saveMemo(seedSave);
      }
      if (random() < 0.2)
        await local.pg.query(
          "INSERT INTO memo_settings(user_id,keep_memos) VALUES ($1,false),($2,false)",
          [a, b],
        );
      const shape = pick([
        ...Object.values(shapes),
        (): Partial<MemoInput> => ({ first_draft: draft, mode: "edit" }),
      ])();
      // Mostly a final on file, so a match, and two holders, are common.
      const started_from =
        seeded.length && random() < 0.7 ? pick(seeded) : pick(texts);
      // Every other case another context, with purpose omitted, so a match
      // must take the save's context.
      const sentContext =
        n % 2
          ? memoSave().memo!.context
          : {
              summary: "a fictional counteroffer",
              medium: "chat" as const,
              audience: "a supplier",
            };
      const sent = memoSave({
        final: pick(texts),
        context: sentContext,
        ...shape,
        ...(shape.first_draft || shape.first_draft_missing
          ? { request: "Tighten it." }
          : {}),
      });
      const before = await rows(a);
      const seededB = await rows(b);
      const outcome = await outcomeOf(withField, {
        ...sent,
        memo: { ...sent.memo!, started_from },
      });
      const plain = await outcomeOf(without, sent);
      const after = await rows(a);
      const holders = before.filter((r) => r.final === started_from);
      // Ids differ between the accounts: a seeded memo is named by its place.
      const label = (seeded: Row[], id: string | undefined) => {
        const i = seeded.findIndex((r) => r.id === id);
        return i < 0 ? "new" : `seed ${i}`;
      };
      const normal = (
        o: Awaited<ReturnType<typeof outcomeOf>>,
        seeded: Row[],
      ) =>
        "memo" in o && o.memo
          ? {
              ...o,
              request_id: "",
              memo: { ...o.memo, memo_id: label(seeded, o.memo.memo_id) },
            }
          : { ...o, request_id: "" };
      const content = (list: Row[], seeded: Row[]) =>
        list.map(({ id, at: _at, ...r }) => ({ ...r, id: label(seeded, id) }));
      const context = { n, started_from, sent: sent.memo, before, outcome };
      if (shape.mode === "draft") {
        // Refused before any database work; nothing changes.
        expect([context, outcome]).toEqual([
          context,
          { refused: "invalid_input" },
        ]);
        expect(after).toEqual(before);
        saw("draft refused");
        continue;
      }
      if (holders.length !== 1) {
        // An ordinary save: the same outcome and store as without the field.
        const b4 = await rows(b);
        expect([context, normal(outcome, before)]).toEqual([
          context,
          normal(plain, seededB),
        ]);
        expect(content(after, before)).toEqual(content(b4, seededB));
        saw(holders.length ? "two or more hold it" : "none holds it");
        continue;
      }
      const target = holders[0]!;
      const others = before.filter((r) => r !== target);
      const final = sent.memo!.final;
      const twin = others.find(
        (r) =>
          r.final === final &&
          r.state === target.state &&
          r.first_draft === target.first_draft,
      );
      // Every other memo stays exactly as it was.
      expect([context, after.filter((r) => r.id !== target.id)]).toEqual([
        context,
        others,
      ]);
      if (final === target.final) {
        expect([context, outcome]).toMatchObject([
          context,
          { status: "unchanged", memo: { memo_id: target.id } },
        ]);
        expect(after).toEqual(before);
        saw("unchanged");
      } else if (twin) {
        expect([context, outcome]).toMatchObject([
          context,
          { status: "unchanged", memo: { memo_id: twin.id } },
        ]);
        expect(after.some((r) => r.id === target.id)).toBe(false);
        saw("collision");
      } else {
        expect([context, outcome]).toMatchObject([
          context,
          { status: "saved", memo: { memo_id: target.id }, replaced: true },
        ]);
        const updated = after.find((r) => r.id === target.id)!;
        expect([context, updated]).toEqual([
          context,
          {
            ...target,
            final,
            tier: updated.tier,
            changes: updated.changes,
            summary: sentContext.summary,
            medium: sentContext.medium,
            audience: sentContext.audience ?? null,
            purpose: sentContext.purpose ?? null,
            request:
              target.state === "none" ? null : (sent.memo!.request ?? null),
          },
        ]);
        expect(updated.tier).toBe(
          tier({
            state: target.state as "kept" | "missing" | "none",
            mode: (target.mode ?? undefined) as "draft" | "edit" | undefined,
            firstDraft: target.first_draft ?? undefined,
            final,
          }),
        );
        saw("updated");
      }
    }
    // Each branch of the rule met at least once.
    expect([...seen.keys()].sort()).toEqual(
      [
        "draft refused",
        "two or more hold it",
        "none holds it",
        "unchanged",
        "collision",
        "updated",
      ].sort(),
    );
  } finally {
    await local.dispose();
  }
}, 60000);
