import { expect, test } from "bun:test";
import { storeInstructions } from "../src/mcp";
import { saveMemoInput } from "../src/store/compiled";
import type { CardHead } from "../src/store/cards";
import {
  assembleDocuments,
  BASELINE_NOTE,
  type Filing,
} from "../src/store/reports";
import {
  setupCatalog,
  setupHint,
  knownBaseline,
  SETUP_PROMPT,
} from "../src/store/setup";
import {
  coverSheet,
  missingIntent,
  reportEnvelope,
  reportInput,
  reportList,
} from "../src/store/tools";
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

test("sample-first setup is optional, preserves guidance and serves valid exact saves", () => {
  const version = "a".repeat(64);
  const empty = { ...assembleDocuments([], []), version };
  const setup = coverSheet(empty).setup!;
  expect(setup).toBe(reportEnvelope(empty, "email").setup!);
  expect(empty.is_empty).toBe(true);
  expect(SETUP_PROMPT).toBe(
    "Help me connect Milton using https://www.meetmilton.com/setup, then read what I have on file. Help me choose a few messages that sound like me. If you already have access to my sent messages, find a few candidates; otherwise I'll paste them. Use only my own writing; skip automated, forwarded and third-party text. Show me the exact examples with private details removed, and save only the ones I approve. Preserve what's already on file. Then help me write my next email or DM.",
  );
  for (const fragment of [
    "offer setup once",
    "never block an explicit writing task",
    "Read the current cover sheet and relevant reports; preserve all existing rules and samples",
    "Do not rerun setup because rules are absent",
    "If the person asks you to find candidates and you already have authorized access",
    "otherwise accept pasted examples",
    "Exclude automated, forwarded and third-party text",
    "Do not assume a sent item represents the person's voice",
    "private details replaced by placeholders",
    "make excerpts explicit",
    "exact retention approval",
    "A yes to saving that exact displayed text is sufficient",
    "ask again only if the proposed text changes, including redaction",
    "Do not silently sanitize after approval",
    "minimal non-private context",
    "kind_id from the relevant report",
    "supported labels",
    "same request_id and exact input",
    "Reread after saved, unchanged or conflict",
    "If examples are skipped, help with the real draft without claiming to know the voice",
    "Praise or permission to send is not retention permission",
    "do not infer standing rules from one example or turn sample facts into preferences",
    "Do not connect an inbox, request Gmail permissions, bulk import or save unseen text",
    "Setup permission authorizes this conversation only",
    "Offer the standing instruction separately",
    "only after separate consent",
    "Verify an actual successful read",
    "No need to fill all five reports or accumulate rules before drafting",
  ])
    expect(setup).toContain(fragment);
  expect(setup).not.toMatch(
    /quiz|E3\. Register|Files on yes|before any other writing/,
  );

  const sample = {
    id: "s",
    report: "email" as const,
    kind_id: "k",
    kind: "follow-up",
    context: "A fictional follow-up.",
    body: "Hi [name],\n\nFriday works. Thanks!",
    date: "2026-11-02",
    created_at: "2026-11-02T00:00:00.000000Z",
    audience: null,
    purpose: null,
    register: null,
  };
  const sampled = { ...assembleDocuments([], [sample]), version };
  expect(sampled.is_empty).toBe(false);
  expect(coverSheet(sampled).setup).toBeUndefined();
  expect(reportEnvelope(sampled, "email").setup).toBeUndefined();
  expect(reportList(sampled).reports[0]!.setup).toBeUndefined();
  expect(sampled.reports[0]!.samples).toEqual([sample]);
  expect(sampled.cover_rules).toEqual([]);
  expect(sampled.reports[0]!.rules).toEqual([]);
  // Other empty reports offer optional help, never a forced restart.
  expect(reportEnvelope(sampled, "chat").setup).toStartWith(
    "Optional setup for Chat",
  );
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
  expect(reportEnvelope(filed, "chat").setup).toBeUndefined();
  expect(filed.cover).toBe(BASELINE_NOTE + "\n\n- Lead with the answer.");
  expect(reportList(filed).reports.map((r) => r.setup)).toEqual([
    setupHint("email"),
    undefined,
    setupHint("post"),
    setupHint("document"),
    setupHint("speech"),
  ]);
  const before = JSON.stringify([empty, sampled, filed]);
  const writing = {
    email: ["emails", "email", "Hi [name],\n\nFriday works. Thanks!"],
    chat: ["DMs or texts", "DM", "Friday works. Thanks!"],
    post: [
      "posts",
      "post",
      "A small update: the guide is ready. Thanks for your feedback.",
    ],
    document: [
      "documents or excerpts",
      "document",
      "The guide is ready for review. Next, we will check the examples.",
    ],
    speech: [
      "speeches or excerpts",
      "speech",
      "Thanks for joining us today. Let’s start with what changed and what comes next.",
    ],
  };
  for (const documents of [empty, sampled, filed]) {
    for (const id of ["email", "chat", "post", "document", "speech"] as const) {
      const script = reportEnvelope(documents, id).setup;
      if (script === undefined) continue;
      expect(script.isWellFormed() && !script.includes("\0")).toBe(true);
      expect(Buffer.byteLength(script)).toBeLessThanOrEqual(32768);
      const shape = JSON.parse(
        between(
          script,
          "Sample save example (fictional, replace with the approved sample):\n```json\n",
          "\n```",
        ),
      );
      expect(shape.sample.report).toBe(id);
      const [examples, task, text] = writing[id];
      const firstEmail = documents.is_empty && id === "email";
      expect(script).toContain(
        `Ask for a few ${firstEmail ? "emails or DMs" : examples} the person likes`,
      );
      expect(script).toContain(
        `Ask what the next real ${firstEmail ? "email or DM" : task} should accomplish`,
      );
      const filing =
        "File emails under email, and DMs, texts or Slack messages under chat.";
      expect(script.includes(filing)).toBe(firstEmail);
      if (id !== "email" && id !== "chat") {
        expect(script).not.toContain("emails or DMs");
        expect(script).not.toContain("next real email");
      }
      expect(shape.sample).toEqual({
        report: id,
        new_kind: `${task} example`,
        context: `A fictional ${task}.`,
        audience: "colleague",
        purpose: "update",
        register: "plain",
        text,
      });
      parses(shape);
      expect(script.indexOf("exact retention approval")).toBeLessThan(
        script.indexOf("Sample save example"),
      );
      expect(
        reportList(documents).reports.find((r) => r.report_id === id)!.setup,
      ).toBe(setupHint(id));
    }
  }
  // Reads and setup text do not save, import or reset anything.
  expect(JSON.stringify([empty, sampled, filed])).toBe(before);
  // Historical approved Baseline rules remain canonical, even though setup no longer generates them.
  expect(setupCatalog.length).toBeGreaterThan(0);
  for (const rule of setupCatalog) {
    expect(knownBaseline(rule.text, rule.report)).toBe(true);
    expect(knownBaseline(rule.text + " altered", rule.report)).toBe(false);
    parses({ ...envelope(), rules: [rule] });
  }
});

test("every create_memo shape the server instructions describe parses against saveMemoInput", () => {
  const says = (fragment: string) =>
    expect(storeInstructions).toContain(fragment);
  says('show the exact text, then offer once: "Save this as a sample?"');
  says("Yes authorizes saving that unchanged text");
  says("ask again only if it changes, including redaction");
  says("Praise or send permission alone is not retention approval");
  expect(storeInstructions).not.toContain("On yes, show");
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
    "call create_memo with sample (report; kind_id from get_report, or new_kind only if none fits; context; audience, purpose and register; text exactly as approved)",
  );
  for (const kind of [{ kind_id: "fictional-kind" }, { new_kind: "follow-up" }])
    parses({
      ...envelope(),
      sample: {
        report: "email",
        ...kind,
        context: "A fictional situation.",
        audience: "client",
        purpose: "follow up",
        register: "plain",
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
  // The read the instructions, the tool description and the refusal describe.
  says(
    "get_report for each matching report with intent: one line on the situation, plus audience and purpose",
  );
  for (const situation of [
    "declining a client's request for a discount",
    between(missingIntent, 'such as "', '"'),
  ])
    expect(
      reportInput.safeParse({
        report_id: "email",
        intent: { situation, audience: "client", purpose: "decline" },
      }).error?.issues ?? [],
    ).toEqual([]);
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
