import { expect, test } from "bun:test";
import { storeInstructions } from "../src/mcp";
import { saveMemoInput } from "../src/store/compiled";
import { parseReport } from "../../packages/agent-kit/src/report";
import type { CardHead } from "../src/store/cards";
import { assembleDocuments, FILINGS, type Filing } from "../src/store/reports";
import { SETUP_MARKER, setupCatalog } from "../src/store/setup";
import { coverSheet, reportEnvelope, reportList } from "../src/store/tools";

// Fields every save carries, as the instructions name them.
const envelope = () => ({
  text: "A fictional purpose.",
  request_id: crypto.randomUUID(),
  expected_version: "a".repeat(64),
});
const parses = (input: object) => {
  const result = saveMemoInput.safeParse(input);
  expect(result.error?.issues ?? []).toEqual([]);
};
// The text between `start` and the next `end`, so a served example that
// drifts from its schema, or disappears, fails here.
const between = (text: string, start: string, end: string) => {
  const at = text.indexOf(start);
  expect(at).toBeGreaterThanOrEqual(0);
  return text.slice(at + start.length, text.indexOf(end, at + start.length));
};

// A rule as a test fixture: an active card head.
const head = (report: Filing, body: string, id = body): CardHead => ({
  id,
  version: 1,
  description: body,
  body,
  archived: false,
  report,
});

test("setup renders from its catalog, per report while empty, under the agent kit cap", () => {
  const version = "a".repeat(64);
  const empty = { ...assembleDocuments([], []), version };
  const sheet = coverSheet(empty);
  // The cover sheet serves the opening lines and email's block, cover questions included.
  expect(sheet.setup).toBe(reportEnvelope(empty, "email").setup!);
  expect(sheet.setup).toContain('Then say: "First, paste one email');
  expect(sheet.setup).toContain(`[cover] ${SETUP_MARKER}`);
  const served = [
    sheet.setup!,
    ...reportList(empty).reports.map((r) => r.setup!),
  ];
  const offered = new Set<string>();
  for (const setup of served) {
    // The agent kit accepts each served string (it caps setup at 32 KB).
    expect(parseReport({ ...sheet, setup }).setup).toBe(setup);
    const questions = setup
      .split("\n\n")
      .filter((block) => /^[A-Z]\d\. /.test(block));
    expect(questions.length).toBeGreaterThan(1);
    for (const block of questions) {
      const lines = block.split("\n");
      // One quoted line: any quote inside it is single.
      expect(lines[1]).toMatch(/^Ask: "[^"]+"$/);
      expect(lines[2]).toBe("Show exactly:");
      const at = lines.findIndex((line) => line.startsWith("Files"));
      const shown = lines.slice(3, at);
      const files = lines.slice(at + 1);
      // Every option shown has one Files line; a tells list files one rule per item.
      const letters = shown.filter((line) => /^\([a-z]\)$/.test(line));
      if (letters.length)
        expect(files.map((line) => line.slice(0, 3))).toEqual(letters);
      else expect(files.length).toBe(shown.length);
      for (const line of files)
        for (const rule of line.replace(/^\([a-z]\) /, "").split(" | ")) {
          const [, report, text] = /^\[(\w+)\] (.+)$/.exec(rule)!;
          expect(FILINGS).toContain(report as Filing);
          expect(text).toStartWith("Baseline: ");
          expect(setupCatalog).toContain(text!);
          offered.add(text!);
        }
    }
  }
  // Every catalog baseline is offered, and only those.
  expect([...offered].sort()).toEqual(
    setupCatalog.filter((rule) => rule !== SETUP_MARKER).sort(),
  );
  // The scripted saves parse against saveMemoInput.
  expect(between(sheet.setup!, "rules [{ ", " }]").split(", ")).toEqual([
    "report",
    "text",
  ]);
  parses({
    ...envelope(),
    text: between(sheet.setup!, 'create_memo once: text "', '"'),
    rules: [
      { report: "cover", text: SETUP_MARKER },
      ...setupCatalog.slice(1, 20).map((text) => ({ report: "email", text })),
    ],
  });
  // The approved paste is filed first, so an abandoned block keeps it.
  expect(sheet.setup!.indexOf("sample { ")).toBeLessThan(
    sheet.setup!.indexOf("rules [{ "),
  );
  const sample = between(sheet.setup!, "sample { ", " }");
  expect([...sample.matchAll(/(\w+):/g)].map((m) => m[1]!)).toEqual([
    "report",
    "new_kind",
    "context",
    "text",
  ]);
  parses({
    ...envelope(),
    text: between(sheet.setup!, 'its own create_memo: text "', '"'),
    sample: {
      report: /report: "(\w+)"/.exec(sample)![1],
      new_kind: /such as "([^"]+)"/.exec(sample)![1],
      context: "A fictional situation.",
      text: "A fictional email.",
    },
  });
  // After a save, a filled report serves no setup; email's block alone loses
  // the cover questions, and the marker already on file leaves the save.
  const filed = {
    ...assembleDocuments(
      [
        head("cover", SETUP_MARKER),
        head("chat", "Baseline: No emoji in chat."),
      ],
      [],
    ),
    version,
  };
  expect(coverSheet(filed).setup).toBeUndefined();
  expect(reportEnvelope(filed, "chat").setup).toBeUndefined();
  const email = reportEnvelope(filed, "email").setup!;
  expect(email).toStartWith("Setup: Email. Offer it once");
  expect(email).not.toContain("[cover]");
  // Only email's confirmation example names an email.
  expect(reportEnvelope(filed, "post").setup).toContain(
    "name the habit you saw in the post and ask whether it is usual.",
  );
  expect(reportEnvelope(filed, "post").setup).not.toContain("Your email");
  expect(email).toContain("Next: Post, Document, Speech, or stop here?");
  expect(reportList(filed).reports.map((r) => r.setup === undefined)).toEqual([
    false,
    true,
    false,
    false,
    false,
  ]);
});

test("every create_memo shape the server instructions describe parses against saveMemoInput", () => {
  const says = (fragment: string) =>
    expect(storeInstructions).toContain(fragment);
  says("Pass the cover sheet version as expected_version and a new request_id");
  says("Send each new rule in rules: its report (or cover)");
  parses({
    ...envelope(),
    rules: [
      { report: "cover", text: "A fictional rule." },
      { report: "email", text: "A fictional email rule." },
    ],
  });
  says(
    "call create_memo with sample (report; kind_id from get_report, or new_kind only if none fits; context; text exactly as approved)",
  );
  for (const kind of [{ kind_id: "fictional-kind" }, { new_kind: "follow-up" }])
    parses({
      ...envelope(),
      sample: {
        report: "email",
        ...kind,
        context: "A fictional situation.",
        text: "A fictional email.",
      },
    });
  says("Replace or remove a sample on request with replaces or retire_samples");
  parses({
    ...envelope(),
    sample: {
      report: "email",
      kind_id: "fictional-kind",
      replaces: "fictional-sample",
      context: "A fictional situation.",
      text: "A fictional email.",
    },
  });
  parses({ ...envelope(), retire_samples: ["fictional-sample"] });
  says(
    "change a rule only with exact_edits, never by adding one: before verbatim, occurring once, within one rule; after the replacement, or empty to remove",
  );
  parses({
    ...envelope(),
    exact_edits: [
      { before: "A fictional rule.", after: "A corrected rule." },
      { before: "Another fictional rule.", after: "" },
    ],
  });
  says("pass moves: before verbatim from the rule and its new report");
  parses({
    ...envelope(),
    moves: [{ before: "A fictional rule.", report: "cover" }],
  });
});
