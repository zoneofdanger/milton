import { expect, test } from "bun:test";
import { storeInstructions } from "../src/mcp";
import { saveMemoInput } from "../src/store/compiled";
import { setupScript } from "../src/store/setup";

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

test("the setup script's create_memo examples parse against saveMemoInput", () => {
  // "rules [{ report, text }]": one entry per rule, report cover or a block's report.
  expect(between(setupScript, "rules [{ ", " }]").split(", ")).toEqual([
    "report",
    "text",
  ]);
  const reports = [
    "cover",
    ...between(setupScript, "the block's report (", ")")
      .split(/, | or /)
      .map((r) => r.trim()),
  ];
  expect(reports).toEqual([
    "cover",
    "email",
    "chat",
    "post",
    "document",
    "speech",
  ]);
  parses({
    ...envelope(),
    text: between(setupScript, 'create_memo: text "', '"'),
    rules: reports.map((report) => ({ report, text: "A fictional rule." })),
  });
  // "sample { report: "email", new_kind: ..., context: ..., text: ... }".
  const sample = between(setupScript, "sample { ", " }");
  const fields = [...sample.matchAll(/(\w+):/g)].map((m) => m[1]!);
  expect(fields).toEqual(["report", "new_kind", "context", "text"]);
  parses({
    ...envelope(),
    sample: {
      report: /report: "(\w+)"/.exec(sample)![1],
      new_kind: /such as "([^"]+)"/.exec(sample)![1],
      context: "A fictional situation.",
      text: "A fictional email.",
    },
  });
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
