// One list of requests run against both of the typed request's rules (#38):
// the code's (memoInput's trim, then checkMemo) and the database's
// (memos_request and memos_request_typed, read from pg_constraint). Peter's
// rule, 2026-11-18: the database is never stricter than the code, so every
// request the code accepts must pass it. test/store-migrations.test.ts runs
// it on PGlite under Bun; scripts/auth-integration.ts on PostgreSQL 18 under
// Node 26, production's engines.
import { memoInput } from "../src/mcp-tools";
import { checkMemo } from "../src/store/save";

type Rows = { rows: unknown[] };
export type Query = (text: string, params?: unknown[]) => Promise<Rows>;

const lines = (n: number, end = "") =>
  Array.from({ length: n }, (_, i) => `line ${i + 1}`).join("\n") + end;

// [what it shows, the request as the AI sends it, the code's verdict, the
// database's]. Every case today has both verdicts equal: the one deliberate
// looseness (schema.ts) is a space a later Unicode adds to JavaScript's \s.
export const REQUEST_CASES: [string, string, boolean, boolean][] = [
  ["a typed ask", "Decline their call, short and kind.", true, true],
  ["two lines", "Line one\nLine two", true, true],
  ["empty", "", false, false],
  ["only spaces, trimmed to empty", " \n  ", false, false],
  // Lines: split on \n alone.
  ["exactly 12 lines", lines(12), true, true],
  ["13 lines", lines(13), false, false],
  ["12 lines and a trailing newline, trimmed", lines(12, "\n"), true, true],
  ["12 lines, then a blank 13th, trimmed", lines(12, "\n  "), true, true],
  [
    "13 lines, the middle one blank",
    lines(6) + "\n\n" + lines(6),
    false,
    false,
  ],
  ["U+2028 is no line break to the count", lines(12, " more"), true, true],
  // Characters: code points, as Array.from counts them.
  ["600 characters", "x".repeat(600), true, true],
  ["601 characters", "x".repeat(601), false, false],
  ["600 after the trim", "  " + "x".repeat(600) + "\n", true, true],
  ["600 astral characters", "\u{1F600}".repeat(600), true, true],
  ["601 astral characters", "\u{1F600}".repeat(601), false, false],
  // Control characters.
  ["\\r\\n", "Reply to this\r\nplease", false, false],
  ["\\r\\n before a quote", "Reply\r\n> Can we meet?", false, false],
  ["a tab", "Reply\twith a tab", false, false],
  ["NEL (U+0085)", "Reply\u0085please", false, false],
  // A line starting >.
  ["a quote line", "Reply to this:\n> Can we meet Friday?", false, false],
  ["a quote first, after the trim", "  > Can we meet?", false, false],
  ["a quote after spaces", "Reply:\n   > Can we meet?", false, false],
  ["a quote after a tab", "Reply:\n\t> Can we meet?", false, false],
  ["a quote after U+00A0", "Reply:\n > Can we meet?", false, false],
  ["a quote after U+2003", "Reply:\n > Can we meet?", false, false],
  ["a quote after U+3000 and U+FEFF", "Reply:\n　﻿> Hi", false, false],
  ["a quote after U+2028", "Reply: > Can we meet?", false, false],
  ["a quote after U+2029 and spaces", "Reply:   > Hi", false, false],
  ["U+180E is not a space", "Reply:\n᠎> Can we meet?", true, true],
  ["U+200B is not a space", "Reply:\n​> Can we meet?", true, true],
  ["> mid-line", "Say a > b, kindly.", true, true],
  ["fullwidth >", "＞ not a quote", true, true],
  // An "On … wrote:" line.
  ["On … wrote:", "Answer it.\nOn Tue, Sam wrote:", false, false],
  ["on … WROTE:", "on monday they WROTE:", false, false],
  ["On … wrote: and spaces", "On Tue, Sam wrote:   ", false, false],
  ["On … wrote: then a line", "On Tue, Sam wrote: \nThanks", false, false],
  ["On … wrote: U+00A0 then a line", "On x wrote: \nok", false, false],
  ["On … wrote: U+2028 then text", "On x wrote: ok", false, false],
  ["On, one space, wrote:", "On wrote:", false, false],
  ["On, then an emoji", "On \u{1F600}wrote:", false, false],
  ["On, then é (no word character)", "Oné x wrote:", false, false],
  ["Onward we wrote:", "Onward we wrote:", true, true],
  ["On_x wrote:", "On_x wrote:", true, true],
  ["On xwrote:", "On xwrote:", true, true],
  ["On … wrote: more", "On Tue, Sam wrote: more", true, true],
  ["On mid-line", "We met. On Tue, Sam wrote:", true, true],
  ["On … wrote, no colon", "On Tue, Sam wrote", true, true],
  // A From or Subject header.
  ["From:", "Reply.\nFrom: Sam", false, false],
  ["subject: lowercase", "subject: lunch", false, false],
  ["SUBJECT:", "Fix the\nSUBJECT: line", false, false],
  ["From: after U+3000", "ok\n　From: Sam", false, false],
  ["From: mid-line", "Reply to the From: line", true, true],
  ["From, space, colon", "From : Sam", true, true],
  ["Fromage:", "Fromage: brie", true, true],
  ["long s (U+017F) in Subject", "ſubject: lunch", true, true],
  ["Kelvin sign is no k", "FromK: x", true, true],
];

const drafted = {
  final: "Fictional final.",
  first_draft_missing: true as const,
  mode: "draft" as const,
  context: { summary: "a fictional reply", medium: "email" as const },
};

/** The code's verdict on a request as sent, and what it would store. */
export function codeVerdict(request: string) {
  const parsed = memoInput.safeParse({ ...drafted, request });
  if (!parsed.success) return { ok: false, stored: request };
  return {
    ok: checkMemo(parsed.data).ok,
    stored: parsed.data.request ?? "",
  };
}

/** The database's verdict on each stored request: both of its checks on
 * memos.request, exactly as pg_constraint holds them, on a drafted memo. */
export async function sqlVerdicts(query: Query, requests: string[]) {
  const defs = (
    await query(
      "SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid='memos'::regclass AND conname IN ('memos_request','memos_request_typed') ORDER BY conname",
    )
  ).rows as { def: string }[];
  if (defs.length !== 2) throw new Error("request checks missing");
  const tests = defs
    .map(({ def }) => `(${def.replace(/^CHECK /, "")}) IS NOT FALSE`)
    .join(" AND ");
  const { rows } = await query(
    `SELECT ${tests} AS ok FROM (SELECT r AS request, 'kept'::text AS first_draft_state, n FROM unnest($1::text[]) WITH ORDINALITY AS u(r, n)) AS memos ORDER BY n`,
    [requests],
  );
  return (rows as { ok: boolean }[]).map((row) => row.ok);
}

// Generated requests: short runs of the pieces the rules turn on, from a
// seeded generator so a failure repeats.
const PIECES = [
  ...["\n", "\r", "\t", " ", "  ", " ", " ", "　", "﻿"],
  ...[" ", " ", "᠎", "​", "\u0085", "ſ"],
  ...[">", "On", "on", "ON", "oN", "Onward", " wrote:", "WROTE:", "wrote"],
  ...["From:", "from", "FROM:", "Subject:", "subject", ":", "x", "é", "_"],
  ...["1", ",", "\u{1F600}", "＞", "Tue", " Sam", "ok"],
];
export function generatedRequests(count: number, seed = 38) {
  let state = seed;
  const next = () => {
    state = (Math.imul(state, 1103515245) + 12345) >>> 0;
    return state / 2 ** 32;
  };
  return Array.from({ length: count }, () =>
    Array.from(
      { length: 1 + Math.floor(next() * 10) },
      () => PIECES[Math.floor(next() * PIECES.length)],
    ).join(""),
  );
}

/** Every case's two verdicts, and the generated requests where the two
 * differ: the caller asserts the cases' verdicts and no difference. */
export async function compareRequestRules(query: Query, generated = 4000) {
  const named = REQUEST_CASES.map(([, request]) => codeVerdict(request));
  const sql = await sqlVerdicts(
    query,
    named.map((v) => v.stored),
  );
  const cases = REQUEST_CASES.map(([name, , code, database], i) => ({
    name,
    expected: { code, sql: database },
    actual: { code: named[i]!.ok, sql: sql[i]! },
  }));
  const requests = generatedRequests(generated);
  const verdicts = requests.map(codeVerdict);
  const generatedSql = await sqlVerdicts(
    query,
    verdicts.map((v) => v.stored),
  );
  const differ = requests
    .map((request, i) => ({
      request,
      code: verdicts[i]!.ok,
      sql: generatedSql[i]!,
    }))
    .filter((v) => v.code !== v.sql);
  return {
    cases,
    differ,
    accepted: verdicts.filter((v) => v.ok).length,
    generated,
  };
}
