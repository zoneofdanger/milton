import { expect, test } from "bun:test";
import { storeInstructions } from "../src/mcp";
import { saveMemoInput } from "../src/store/compiled";
import type { CardHead } from "../src/store/cards";
import {
  assembleDocuments,
  BASELINE_NOTE,
  FILINGS,
  type Filing,
} from "../src/store/reports";
import { setupCatalog, setupHint } from "../src/store/setup";
import { coverSheet, reportEnvelope, reportList } from "../src/store/tools";
import { subscriptionRequired, trialEndingMessage } from "../src/store/trials";

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

test("setup renders from its catalog, per report while empty, within 32 KB", () => {
  const version = "a".repeat(64);
  const empty = { ...assembleDocuments([], []), version };
  const sheet = coverSheet(empty);
  // The cover sheet serves the opening lines and email's block, cover questions included.
  expect(sheet.setup).toBe(reportEnvelope(empty, "email").setup!);
  expect(sheet.setup).toContain('Then say: "First, paste one email');
  // The first block ends by offering the standing line, after the save.
  const stick = [
    "7. Before the next report or stopping, make it stick: offer to keep this line in your own standing instructions, so you read Milton without being asked:",
    "Show exactly: Before writing anything for me, call Milton's get_cover_sheet, then get_report for the matching report.",
    "Where you can edit a startup instructions file, add it there after the person approves: ~/.claude/CLAUDE.md for Claude Code, ~/.codex/AGENTS.md for Codex, User Rules in Cursor's settings. Where you have custom instructions, project instructions or memory, keep it there instead. If you have none of these, show the line and say where the person can paste it. Then, on a pick, run that report's setup; otherwise say setup is complete.",
  ].join("\n");
  expect(between(sheet.setup!, "\n6. End. ", "\n\n")).toEndWith("\n" + stick);
  // Nothing to file explains the prefix: the cover sheet prints a fixed note
  // while any baseline is active.
  expect(sheet.setup).not.toContain("Rules marked Baseline:");
  // Setup keys on rules: samples alone keep every block, and the cover
  // questions ride with whichever block runs while the cover sheet has none.
  const sampled = {
    ...assembleDocuments(
      [],
      [
        {
          id: "s",
          report: "email",
          kind_id: "k",
          kind: "follow-up email",
          context: "A fictional follow-up.",
          body: "A fictional email.",
          date: "2026-11-02",
          created_at: "2026-11-02T00:00:00.000000Z",
        },
      ],
    ),
    version,
  };
  expect(sampled.is_empty).toBe(false);
  expect(coverSheet(sampled).setup).toBe(
    reportEnvelope(sampled, "email").setup!,
  );
  expect(coverSheet(sampled).setup).toContain("E3. Register");
  const chat = reportEnvelope(empty, "chat").setup!;
  expect(chat).toContain('grouped under "All writing" (cover) and "Chat"');
  for (const id of ["E3", "E5", "E8"]) expect(chat).toContain(`\n\n${id}. `);
  expect(chat).toContain("[cover] Baseline: Use contractions.");
  expect(chat).not.toContain("[email]");
  // After a first save, each empty report serves its full block.
  const started = {
    ...assembleDocuments([head("cover", "Lead with the answer.")], []),
    version,
  };
  const served = [
    sheet.setup!,
    ...(["email", "chat", "post", "document", "speech"] as const).map(
      (id) => reportEnvelope(started, id).setup!,
    ),
  ];
  // Later blocks, on request only, never repeat it.
  expect(served.filter((setup) => setup.includes("make it stick"))).toEqual([
    sheet.setup!,
  ]);
  const offered = new Set<string>();
  for (const setup of served) {
    // Each served script is well-formed text of at most 32 KB.
    expect(setup.isWellFormed() && !setup.includes("\0")).toBe(true);
    expect(Buffer.byteLength(setup)).toBeLessThanOrEqual(32768);
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
          // Served with the report the catalog files it to.
          expect(setupCatalog).toContainEqual({
            report: report as Filing,
            text: text!,
          });
          offered.add(JSON.stringify([report, text]));
        }
    }
  }
  // Every catalog baseline is offered, and only those.
  expect([...offered].sort()).toEqual(
    setupCatalog.map((b) => JSON.stringify([b.report, b.text])).sort(),
  );
  // The scripted saves parse against saveMemoInput.
  expect(between(sheet.setup!, "rules [{ ", " }]").split(", ")).toEqual([
    "report",
    "text",
  ]);
  parses({
    ...envelope(),
    text: between(sheet.setup!, 'create_memo once: text "', '"'),
    rules: [...setupCatalog.slice(0, 20)],
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
  // Once rules exist, a report with rules serves no setup; with cover rules on
  // file, email's block loses the cover questions.
  const filed = {
    ...assembleDocuments(
      [
        head("cover", "Lead with the answer."),
        head("chat", "Baseline: No emoji in chat."),
      ],
      [],
    ),
    version,
  };
  expect(coverSheet(filed).setup).toBeUndefined();
  expect(filed.cover).toBe(BASELINE_NOTE + "\n\n- Lead with the answer.");
  expect(started.cover).toBe("- Lead with the answer.");
  expect(reportEnvelope(filed, "chat").setup).toBeUndefined();
  const email = reportEnvelope(filed, "email").setup!;
  expect(email).toStartWith("Setup for Email, on request only: ");
  expect(email).not.toContain("[cover]");
  // Only email's confirmation example names an email.
  expect(reportEnvelope(filed, "post").setup).toContain(
    "name the habit you saw in the post and ask whether it is usual.",
  );
  expect(reportEnvelope(filed, "post").setup).not.toContain("Your email");
  expect(email).toContain("Next: Post, Document, Speech, or stop here?");
  // list_reports carries one line per empty report, never a block.
  expect(reportList(filed).reports.map((r) => r.setup)).toEqual([
    setupHint("email"),
    undefined,
    setupHint("post"),
    setupHint("document"),
    setupHint("speech"),
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

test("the refusal, both reminders and the instructions give the one link, true for everyone who reads them", () => {
  const app = "https://app.example";
  const refusal = subscriptionRequired(app);
  expect(refusal.message).toBe(
    "Milton is paused until you subscribe for $5.01/month. Your rules and samples stay available to view and download. Subscribe at https://app.example/",
  );
  expect(refusal.details).toEqual({ retryable: false });
  // A paying person past grace reads this too.
  expect(refusal.message).not.toContain("trial");
  // The two reminders share one text, and someone who added a card reads it.
  expect(trialEndingMessage("2026-12-03T00:00:00.000Z", app)).toBe(
    "Your Milton trial ends 2026-12-03 (UTC), then it's $5.01/month. Unless you've already added a card, add one by then to keep using Milton: https://app.example/",
  );
  const account = storeInstructions.split("\n\n").at(-1)!;
  expect(account).toContain(
    "Mention a trial-ending notice and its link once, after the task.",
  );
  expect(account).toContain(
    "On subscription_required, say so and give its link once, do not retry, continue other work.",
  );
  expect(account).not.toContain("no link");
  // No memo-update allowance remains to mention.
  expect(storeInstructions).not.toMatch(/memo.update/i);
});
