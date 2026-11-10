import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { PRICE_USD, STANDING_LINE, TRIAL_DAYS } from "@milton/theme/facts";

// Copy drifts wherever no test reads it. These checks read the copy people see.
const root = new URL("../../", import.meta.url).pathname;
const tracked = (...pathspecs: string[]) =>
  execFileSync("git", ["-C", root, "ls-files", "-z", "--", ...pathspecs], {
    encoding: "utf8",
  })
    .split("\0")
    .filter(Boolean);
const read = (path: string) => readFileSync(root + path, "utf8");
const lineOf = (text: string, index: number) =>
  text.slice(0, index).split("\n").length;

/** The site, the consent screen, the app's pages and the docs read first. */
const COPY = [
  ":(glob)apps/site/src/**/*.astro",
  "apps/auth/src/screens.tsx",
  ":(glob)server/src/*.tsx",
  "README.md",
  "TODO.md",
  "AGENTS.md",
];

/** Words #76 retired: memos replaced rules, samples, list_reports and exact
 * edits, and copy says "AI", not "assistant". Words may wrap across lines. */
const RETIRED =
  /list_reports|exact[\s_-]+edits?|instruction\s+cards?|writing\s+rules|your\s+rules|rules\s+and\s+samples|samples?|assistants?/gi;

/** A match inside code is not copy: part of a longer word, identifier, path,
 * tag or call (`AssistantSetup`, `/assistants`, `.samples`, `assistants(`); a
 * word quoted on its own, which is a key, a class or a mention ("assistant");
 * or a declared or imported name. */
const inCode = (text: string, start: number, end: number) =>
  /[-_/.<\w]/.test(text[start - 1] ?? "") ||
  /[-_(\w]/.test(text[end] ?? "") ||
  (text[start - 1] === '"' && text[end] === '"') ||
  /(?:\bconst|\bimport\s*\{)\s*$/.test(text.slice(0, start));

/** Lines from one containing `retired-words: off` through one containing
 * `retired-words: on` are historical and skipped; each marker says why. */
const historical = (text: string) => {
  let off = false;
  return text.split("\n").map((line) => {
    if (line.includes("retired-words: off")) off = true;
    const skip = off;
    if (line.includes("retired-words: on")) off = false;
    return skip;
  });
};

test("user copy uses none of the retired product words", () => {
  const hits: string[] = [];
  for (const file of tracked(...COPY)) {
    const text = read(file);
    const skip = historical(text);
    for (const match of text.matchAll(RETIRED)) {
      const line = lineOf(text, match.index);
      if (
        skip[line - 1] ||
        inCode(text, match.index, match.index + match[0].length)
      )
        continue;
      hits.push(`${file}:${line}: ${match[0].replace(/\s+/g, " ")}`);
    }
  }
  expect(hits).toEqual([]);
});

/** Trial-length claims; the scoreboard's "the 30 days before" is a window, not
 * the trial. Claims may wrap and use curly apostrophes. */
const TRIAL_CLAIMS = [
  /(\d+)[\s‑-]+day(?:\s+\w+)?\s+trial/gi,
  /free\s+for\s+(\d+)\s+days/gi,
  /first\s+(\d+)\s+days[’']?\s+are\s+free/gi,
  /\bthe\s+(\d+)\s+days\b(?![’']?\s+before)/gi,
];
const PRICES = /\$(\d+\.\d{2})(?!\d)/g;

test("copy states the standing line, trial length and price that code uses", () => {
  expect(read("README.md")).toContain(STANDING_LINE);
  const wrong: string[] = [];
  let trials = 0;
  let prices = 0;
  for (const file of tracked(
    ":(glob)apps/site/src/pages/*.astro",
    ":(glob)server/src/*.tsx",
  )) {
    const text = read(file);
    for (const claim of TRIAL_CLAIMS)
      for (const match of text.matchAll(claim)) {
        trials++;
        if (Number(match[1]) !== TRIAL_DAYS)
          wrong.push(`${file}:${lineOf(text, match.index)}: ${match[0]}`);
      }
    for (const match of text.matchAll(PRICES)) {
      prices++;
      if (match[1] !== PRICE_USD)
        wrong.push(`${file}:${lineOf(text, match.index)}: ${match[0]}`);
    }
  }
  expect(wrong).toEqual([]);
  // The patterns still find the claims they guard.
  expect(trials).toBeGreaterThan(5);
  expect(prices).toBeGreaterThan(5);
});

/** Agent notes live in the ignored .agents folder, so a tracked link into its
 * tmp notes is dead for everyone else. Known links, with why each stays. */
const TMP_LINKS: Record<string, string> = {
  ".github/workflows/checks.yml": "names the folder the agent-docs step guards",
  "docs/how-milton-works.md": "describes these checks",
  "scripts/agent-docs.ts": "the vendored checker matches the folder it guards",
  "docs/research/derived-systems-2026.md":
    "its source reports; moves with the held docs restructure",
};

test("no tracked file links into untracked agent notes", () => {
  const linking = tracked().filter((file) => {
    let bytes: Buffer;
    try {
      bytes = readFileSync(root + file);
    } catch {
      return false; // deleted in the working tree
    }
    return !bytes.includes(0) && /\.agents\/tmp/.test(bytes.toString("utf8"));
  });
  expect(linking.sort()).toEqual(Object.keys(TMP_LINKS).sort());
});
