import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

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
