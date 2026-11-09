import { expect, test } from "bun:test";
import { localStore } from "./local-store";
import { fixtureStore, memoSave, seedUsers } from "./store-fixtures";

test("a conflict or refusal stores a receipt with its outcome and replays it", async () => {
  const local = await localStore();
  try {
    await seedUsers(local.pg, "replay");
    const store = fixtureStore(local.db, "replay");
    const line = (add: string, expected_version: number) => ({
      request_id: crypto.randomUUID(),
      cover_sheet: { add, expected_version },
    });
    expect((await store.saveMemo(line("First.", 0))).status).toBe("saved");
    const stale = line("Stale.", 0);
    const conflict = await store.saveMemo(stale);
    expect(conflict).toMatchObject({ status: "conflict" });
    // The account moves on; the same request still replays its first outcome.
    expect((await store.saveMemo(line("Second.", 1))).status).toBe("saved");
    expect(await store.saveMemo(stale)).toEqual(conflict);
    // A refreshed retry under the same ID is told to take a new one.
    await expect(
      store.saveMemo({
        ...stale,
        cover_sheet: { add: "Stale.", expected_version: 2 },
      }),
    ).rejects.toMatchObject({
      code: "request_id_reused",
      message:
        "This request ID belongs to different input. A changed save needs a new request_id; the original arguments replay the same outcome.",
    });
    // A refusal decided against the request replays the same way.
    const unknownKind = memoSave({ kind_id: "not-a-kind" });
    const refused = await store.saveMemo(unknownKind);
    expect(refused).toMatchObject({ status: "failed", error: "invalid_kind" });
    expect(await store.saveMemo(unknownKind)).toEqual(refused);
    expect(
      (
        await local.pg.query<{ status: string }>(
          "SELECT result_json->>'status' AS status FROM save_requests WHERE user_id='replay' ORDER BY created_at",
        )
      ).rows.map((row) => row.status),
    ).toEqual(["saved", "conflict", "saved", "failed"]);
    // A refusal wrote nothing else.
    expect((await local.pg.query("SELECT 1 FROM memos")).rows).toEqual([]);
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
    expect(await store.saveMemo(lost)).toEqual(recovered);
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
      3, 3,
    ]);
  } finally {
    await local.dispose();
  }
});
