// The rollback property (rule, section 6): the code running before this
// release, read from a git ref (default origin/main) into a scratch folder,
// against rows this branch's code writes, on a local PGlite migrated by this
// branch (0016 included). Every reader passes except the two accepted limits,
// which are reproduced as expected failures. Model-free, no network.
//
//   bun scripts/check-compatibility.ts [ref]
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strict as assert } from "node:assert";
import { sql } from "drizzle-orm";
import { localStore } from "../test/local-store";
import { pageFixture, issuer } from "../test/auth-fixtures";
import { fixtureStore, memoSave, vendorIntent } from "../test/store-fixtures";
import { lookupIdentityAccount, resolveIdentityAccount } from "../src/store";

const ref = process.argv[2] ?? "origin/main";
const repo = new URL("../../", import.meta.url).pathname;
const scratch = mkdtempSync(join(tmpdir(), "milton-compat-"));
const results: string[] = [];
const pass = (line: string) => {
  results.push(`PASS ${line}`);
  console.log(`PASS ${line}`);
};

try {
  // Today's code, as the ref holds it, with this checkout's installed
  // dependencies; its workspace links resolve inside the scratch copy.
  // No shell: the ref is one argument, resolved to a commit first (a ref
  // starting with "-" is never read as an option), and the archive's bytes
  // go to tar on its standard input.
  const sha = execFileSync(
    "git",
    [
      "-C",
      repo,
      "rev-parse",
      "--verify",
      "--end-of-options",
      `${ref}^{commit}`,
    ],
    { encoding: "utf8" },
  ).trim();
  const archive = execFileSync(
    "git",
    ["-C", repo, "archive", sha, "server", "packages", "package.json"],
    { maxBuffer: 1 << 30 },
  );
  execFileSync("tar", ["-x", "-C", scratch], { input: archive });
  symlinkSync(join(repo, "node_modules"), join(scratch, "node_modules"));
  const modules = join(repo, "server/node_modules");
  mkdirSync(join(scratch, "server/node_modules"));
  for (const entry of readdirSync(modules))
    if (entry === "@milton")
      cpSync(
        join(modules, entry),
        join(scratch, "server/node_modules", entry),
        {
          recursive: true,
          verbatimSymlinks: true,
        },
      );
    else
      symlinkSync(
        join(modules, entry),
        join(scratch, "server/node_modules", entry),
      );
  const old = (path: string) => import(join(scratch, "server", path));
  const { compiledMemos } = await old("src/store/compiled.ts");
  const { tpsStore } = await old("src/store/tps.ts");
  const { createMiltonApp } = await old("src/index.ts");
  console.log(`today's code: ${ref} at ${sha.slice(0, 12)}`);

  // One account with the app's session, so today's browser handler serves
  // its TPS page.
  const local = await pageFixture();
  await resolveIdentityAccount(local.env, {
    provider: issuer,
    subject: "page-fixes",
  });
  const { userId } = await lookupIdentityAccount(local.env, {
    provider: issuer,
    subject: "page-fixes",
  });
  const fresh = fixtureStore(local.db, userId, "https://ai.example/client");
  const today = compiledMemos(local.db, userId, {
    issuer: "fixture",
    clientId: "https://ai.example/client",
  });
  const app = createMiltonApp(local.config);
  const page = async (path = "/") =>
    app(
      new Request(local.config.appOrigin + path, {
        headers: {
          Host: "localhost:3001",
          Cookie: `milton-session=${local.token}`,
        },
      }),
    ) as Promise<Response>;
  const refusal = async (work: Promise<unknown>) => {
    try {
      const value = (await work) as { status?: string; error?: string };
      return value.status === "failed" ? value.error : value.status;
    } catch (error) {
      return (error as { code?: string }).code ?? String(error);
    }
  };

  // 1. New-shape rows through every reader of today's code.
  const draft = "Hi there! Hope you're well. We can't make Thursday, sorry.";
  const final = "We'll pass on Thursday.\n\n–P";
  const writes = {
    own: memoSave({
      final: "My own fictional words.",
      new_kind: "vendor decline",
    }),
    kept: memoSave({ first_draft: draft, final, mode: "draft" }),
    untouched: memoSave({
      first_draft: "As is.",
      final: "As is.",
      mode: "draft",
    }),
    missing: memoSave({
      final: "No draft kept.",
      first_draft_missing: true,
      mode: "draft",
    }),
    edit: memoSave({
      first_draft: "See you **Friday**.",
      final: "See you Friday!",
      mode: "edit",
    }),
    named: {
      ...memoSave({ final: "Saved under a named id." }),
      request_id: "save-vendor-decline-1",
    },
  };
  const saved: Record<string, string> = {};
  for (const [name, input] of Object.entries(writes)) {
    const outcome = await fresh.saveMemo(input);
    assert.equal(outcome.status, "saved", name);
    saved[name] = outcome.memo!.memo_id;
  }
  const correction = {
    request_id: crypto.randomUUID(),
    memo_context: {
      memo_id: saved.own!,
      context: {
        summary: "a corrected fictional note",
        medium: "chat" as const,
      },
    },
  };
  assert.equal((await fresh.saveMemo(correction)).status, "saved");
  const forgetting = memoSave({ final: "Forget me, fictional." });
  const gone = (await fresh.saveMemo(forgetting)).memo!.memo_id;
  const forget = { request_id: crypto.randomUUID(), forget_memos: [gone] };
  assert.equal((await fresh.saveMemo(forget)).status, "saved");
  const kindRefusal = memoSave({ kind_id: "not-a-kind" });
  assert.equal((await fresh.saveMemo(kindRefusal)).error, "invalid_kind");
  const shape = (
    await local.pg.query<{
      state: string;
      rounds: number | null;
      served: string[];
    }>(
      "SELECT first_draft_state AS state,rounds,served_tweak_ids AS served FROM memos WHERE user_id=$1",
      [userId],
    )
  ).rows;
  assert(shape.every((r) => r.rounds === null && r.served.length === 0));
  const cover = await today.readCoverSheet();
  assert.equal(cover.memos, 6);
  const report = await today.readReport(vendorIntent);
  assert(report.examples.length > 0 && report.text.includes("# Examples"));
  const view = await tpsStore(local.db, userId).read();
  assert.equal(view.memos.length, 6);
  for (const id of Object.values(saved)) {
    const memo = await tpsStore(local.db, userId).readMemo(id);
    assert(memo && memo.rounds === undefined, `memo detail ${id}`);
    assert.equal((await page(`/tps/memo/${id}`)).status, 200);
  }
  const md = await tpsStore(local.db, userId).exportTps();
  assert(md.includes("> We'll pass on Thursday."));
  assert.equal((await page("/")).status, 200);
  // Today's save path still works on the account: a report_id check, a
  // drafted save with rounds, a forget.
  const served = await today.readReport(vendorIntent);
  assert.equal(
    (
      await today.saveMemo(
        memoSave({
          first_draft: "Old code's fictional draft.",
          final: "Old code's fictional final.",
          mode: "draft",
          rounds: 1,
          report_id: served.report_id,
        } as never),
      )
    ).status,
    "saved",
  );
  assert.equal(
    (
      await today.saveMemo({
        request_id: crypto.randomUUID(),
        forget_memos: [saved.untouched],
      })
    ).status,
    "saved",
  );
  pass(
    "new rows (NULL rounds with kept and missing drafts, no served report, a non-UUID request id, a corrected context) pass today's report, cover sheet, TPS read, memo detail and page, TPS.md and saves",
  );

  // 2. Rollback limit 2: today's replay and preflight against what the new
  // code stored. The cases the rule names, exactly.
  const replays: [string, unknown, string][] = [
    ["a non-UUID request id", writes.named, "invalid_input"],
    ["a drafted save without rounds", writes.kept, "invalid_input"],
    ["a final-only save", writes.own, "save_outcome_unknown"],
    ["a context correction", correction, "save_outcome_unknown"],
    ["a forget", forget, "saved"],
    ["a durable refusal without memo", kindRefusal, "invalid_kind"],
  ];
  for (const [name, input, expected] of replays)
    assert.equal(await refusal(today.saveMemo(input)), expected, name);
  // A client still holding the new contract makes a fresh drafted save.
  assert.equal(
    await refusal(
      today.saveMemo(
        memoSave({
          first_draft: "A stale client's draft.",
          final: "Fine.",
          mode: "draft",
        }),
      ),
    ),
    "invalid_input",
  );
  pass(
    "rollback limit 2 as stated: a non-UUID id and a drafted save without rounds refuse before lookup; final-only and correction outcomes without memo.tweaks are save_outcome_unknown; a forget and a memo-less refusal replay; a stale client's fresh drafted save refuses",
  );

  // 3. Rollback limit 1: today's scoreboard on scored memos, some without
  // rounds. The rule's predicate, written out here, against what today's
  // page answers, and the release query.
  const DAY = 86_400_000;
  const predicate = (
    rows: { rounds: number | null; at: number }[],
    now: number,
  ) => {
    const sorted = rows.toSorted((a, b) => a.at - b.at);
    if (sorted.length < 10) return false;
    const windows =
      sorted.length >= 60
        ? [
            sorted.filter((r) => r.at >= now - 30 * DAY),
            sorted.filter(
              (r) => r.at >= now - 60 * DAY && r.at < now - 30 * DAY,
            ),
          ]
        : [sorted.slice(0, 5), sorted.slice(-5)];
    return windows.some((w) => {
      if (!w.length || w.length % 2 === 0) return false;
      const byRounds = w.toSorted((a, b) => (a.rounds ?? 0) - (b.rounds ?? 0));
      return byRounds[w.length >> 1]!.rounds === null;
    });
  };
  const listed = async () =>
    (
      await local.pg.query(
        `SELECT user_id, mode, count(*) AS scored,
            count(*) FILTER (WHERE rounds IS NULL) AS without_rounds
         FROM memos
         WHERE first_draft_state = 'kept' AND change IS NOT NULL
         GROUP BY user_id, mode
         HAVING count(*) >= 10 AND count(*) FILTER (WHERE rounds IS NULL) > 0`,
      )
    ).rows.length > 0;
  const reset = () =>
    local.pg.query("DELETE FROM memos WHERE user_id=$1", [userId]);
  let n = 0;
  const insert = (rounds: number | null, at: number, mode = "draft") =>
    local.pg.query(
      `INSERT INTO memos(user_id,id,medium,summary,mode,first_draft,first_draft_state,final,rounds,change,tier,client_json,request_id,created_at)
       VALUES ($1,$2,'email','a fictional note',$3,'Draft.','kept',$4,$5,0.5,'steered','{}',$6,$7)`,
      [
        userId,
        crypto.randomUUID(),
        mode,
        `Final ${++n}.`,
        rounds,
        crypto.randomUUID(),
        new Date(at),
      ],
    );
  const observe = async (rows: { rounds: number | null; at: number }[]) => {
    await reset();
    for (const r of rows) await insert(r.rounds, r.at);
    const response = await page("/");
    const html = await response.text();
    assert([200, 503].includes(response.status), "the page renders or breaks");
    if (response.status === 503)
      assert(
        html.includes("Sign-in is unavailable"),
        "the browser error handler",
      );
    return { crashed: response.status === 503, listed: await listed(), html };
  };
  const now = Date.now();
  const series = (rounds: (number | null)[], start = now - 20 * DAY) =>
    rounds.map((r, i) => ({ rounds: r, at: start + i * 60_000 }));
  const named: [string, (number | null)[], boolean, boolean][] = [
    // [case, rounds oldest first, crashes, listed]
    [
      "9 scored, one without rounds",
      [1, 1, 1, 1, 1, 1, 1, 1, null],
      false,
      false,
    ],
    [
      "10 scored, latest [0,0,1,1,NULL]",
      [1, 1, 1, 1, 1, 0, 0, 1, 1, null],
      true,
      true,
    ],
    [
      "10 scored, latest [1,1,1,1,NULL]",
      [1, 1, 1, 1, 1, 1, 1, 1, 1, null],
      false,
      true,
    ],
    // Zero and NULL tie and keep input order.
    [
      "10 scored, latest [2,0,0,NULL,2]",
      [1, 1, 1, 1, 1, 2, 0, 0, null, 2],
      true,
      true,
    ],
    [
      "10 scored, latest [0,NULL,0,2,2]",
      [1, 1, 1, 1, 1, 0, null, 0, 2, 2],
      false,
      true,
    ],
    [
      "59 scored, first five [0,0,NULL,1,1]",
      [0, 0, null, 1, 1, ...Array(54).fill(1)],
      true,
      true,
    ],
  ];
  for (const [name, rounds, crashes, list] of named) {
    const seen = await observe(series(rounds));
    assert.deepEqual(
      [name, seen.crashed, seen.listed, predicate(series(rounds), now)],
      [name, crashes, list, crashes],
    );
  }
  // 60 or more: day windows. An odd window with a NULL middle crashes; an
  // even one averages and stays a number, misstating rounds (two NULLs
  // give 0).
  const days = (latest: (number | null)[], before: (number | null)[]) => [
    ...before.map((r, i) => ({ rounds: r, at: now - 45 * DAY + i * 60_000 })),
    ...latest.map((r, i) => ({ rounds: r, at: now - 10 * DAY + i * 60_000 })),
    // Older than 60 days: outside both windows.
    ...Array.from({ length: 60 }, (_, i) => ({
      rounds: 1,
      at: now - 90 * DAY + i * 60_000,
    })),
  ];
  const odd = await observe(days([1, null, null], [1, 1]));
  assert.deepEqual([odd.crashed, odd.listed], [true, true]);
  const even = await observe(days([null, null], [3, 3]));
  assert.deepEqual([even.crashed, even.listed], [false, true]);
  assert(
    even.html.includes("last 30 days: 0 rounds"),
    "two NULLs read as 0 rounds",
  );
  pass(
    "rollback limit 1 reproduced through today's browser error handler: HTTP 503 exactly when an odd window's middle is NULL (9/10 and 59/60 boundaries, zero/NULL ties, odd and even day windows; an even window misstates rounds), and the release query lists every such account",
  );
  // Generated: the predicate and today's page agree, and every crash is
  // listed.
  let seed = 3;
  const random = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  let crashes = 0;
  for (let i = 0; i < 120; i++) {
    const count = [8, 9, 10, 11, 12, 15, 58, 59, 60, 61][i % 10]!;
    const rows = Array.from({ length: count }, (_, k) => ({
      rounds: random() < 0.3 ? null : Math.floor(random() * 3),
      at:
        count >= 60
          ? now - Math.floor(random() * 70 * DAY) - k * 1000
          : now - 40 * DAY + k * 60_000,
    }));
    const seen = await observe(rows);
    const expected = predicate(rows, now);
    assert.equal(seen.crashed, expected, `generated case ${i}`);
    if (seen.crashed) assert(seen.listed, `generated crash ${i} is listed`);
    if (seen.crashed) crashes++;
  }
  assert(crashes > 0, "the generated cases include crashes");
  pass(
    `120 generated scoreboards: today's page matches the rule's predicate (${crashes} crash), and the query lists every crash`,
  );
  // Ties: equal created_at values have no guaranteed order; the query lists
  // the account whichever order the page reads.
  const tied = await observe(
    [1, 1, 1, 1, 1, 0, 0, 1, 1, null].map((r) => ({
      rounds: r,
      at: now - 5 * DAY,
    })),
  );
  assert(tied.listed, "a tied account is listed");
  pass(
    `timestamp ties: listed; today's page ${tied.crashed ? "crashed" : "rendered"} on this order`,
  );
  // The race: the query runs at nine scored memos and lists nothing; one
  // save by the new code after it makes a tenth whose latest five are
  // [0,0,1,1,NULL], and today's page then breaks. Hence the order: old MCP
  // first, drain, then the query, then the old app.
  await reset();
  for (const [i, r] of [1, 1, 1, 1, 1, 0, 0, 1, 1].entries())
    await insert(r, now - 3 * DAY + i * 60_000);
  assert.equal(await listed(), false);
  assert.equal((await page("/")).status, 200);
  assert.equal(
    (
      await fresh.saveMemo(
        memoSave({
          first_draft: "Racing draft.",
          final: "Racing final.",
          mode: "draft",
        }),
      )
    ).status,
    "saved",
  );
  assert.equal(await listed(), true);
  assert.equal((await page("/")).status, 503);
  pass(
    "the rollback-query race: nine scored memos list nothing; one later save by the new code brings the account into the 503",
  );
  await local.dispose();
  console.log(`${results.length} compatibility checks passed against ${ref}`);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
