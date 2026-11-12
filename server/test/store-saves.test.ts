import { expect, test } from "bun:test";
import { localStore } from "./local-store";
import { fixtureStore, memoSave, seedUsers } from "./store-fixtures";
import { hash, REPLAYED } from "../src/store/save";

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
