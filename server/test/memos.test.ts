import { expect, test } from "bun:test";
import { loadMemos, parseMemo } from "../src/memos";

test("loads frontmatter and preserves the complete memo without a duplicate body", async () => {
  const memos = await loadMemos(new URL("./fixtures/memos/", import.meta.url));
  expect(memos).toHaveLength(1);
  expect(memos[0]?.name).toBe("sample");
  expect(memos[0]?.description).toBe("A fixture: plain text with punctuation.");
  expect(memos[0]).not.toHaveProperty("body");
  expect(memos[0]?.text).toEndWith(
    "\n# Sample\n\nWrite plainly. Keep the details useful.\n",
  );
  expect(memos[0]?.text).toStartWith("---\nname: sample\n");
  expect(() => parseMemo("sample", "No frontmatter")).toThrow("frontmatter");
  expect(() => parseMemo("other", memos[0]!.text)).toThrow("name");
});

test("frontmatter rejects block scalars and unclosed quoted fields, and preserves plain trailing quotes", () => {
  const source = (description: string) =>
    `---\nname: sample\ndescription: ${description}\n---\nBody\n`;
  for (const value of [
    ">",
    "|",
    ">-",
    "|-",
    ">+",
    "|+",
    ">2",
    "|2-",
    ">+2",
    "|-2",
    "'unclosed",
    '"unclosed',
    '"bad\\q"',
  ]) {
    expect(() => parseMemo("sample", source(value))).toThrow(/sample:/);
  }
  expect(
    parseMemo("sample", source('"A quoted description."')).description,
  ).toBe("A quoted description.");
  expect(parseMemo("sample", source("'Peter''s memo'")).description).toBe(
    "Peter's memo",
  );
  for (const value of [
    "unopened'",
    'unopened"',
    'Use the sign-off "Best,"',
    "Use the sign-off 'Best,'",
  ]) {
    expect(parseMemo("sample", source(value)).description).toBe(value);
  }
});
