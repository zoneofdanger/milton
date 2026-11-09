import { expect, test } from "bun:test";
import { storeInstructions } from "../src/mcp";
import { nextSteps } from "../src/mcp-outcomes";
import type { CardHead } from "../src/store/cards";
import {
  assembleDocuments,
  BASELINE_NOTE,
  type Filing,
} from "../src/store/reports";
import { setupHint, SETUP_PROMPT } from "../src/store/setup";
import { baselineRefusal } from "../src/store/save";
import {
  coverSheet,
  missingIntent,
  reportEnvelope,
  reportInput,
  reportList,
  saveMemoInput,
} from "../src/mcp-tools";
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

test("setup helps with pasted writing first, preserves optional guidance and serves valid exact saves", () => {
  const version = "a".repeat(64);
  const empty = { ...assembleDocuments([], []), version };
  const setup = coverSheet(empty).setup!;
  expect(setup).toBe(reportEnvelope(empty, "email").setup!);
  expect(empty.is_empty).toBe(true);
  expect(SETUP_PROMPT).toStartWith(
    "Help me connect Milton using https://www.meetmilton.com/setup, then read what I have on file.",
  );
  for (const fragment of [
    "I'll paste something I wrote; help me clean it up",
    "Keep the rest in my words",
    "Show changes separately",
    "For both edited text and older examples, show the exact proposed sample body and useful non-private context before asking to save it",
    "Replace private details with placeholders before retention approval; save only the ones I approve",
    "Old examples are optional",
    "only if I ask and you already have authorized access",
    "skip automated, forwarded and third-party text",
    "Preserve what's already on file",
    "Don't wait for samples or rules before helping",
  ])
    expect(SETUP_PROMPT).toContain(fragment);
  expect(SETUP_PROMPT.indexOf("then read what I have on file")).toBeLessThan(
    SETUP_PROMPT.indexOf("help me clean it up"),
  );
  expect(SETUP_PROMPT.indexOf("help me clean it up")).toBeLessThan(
    SETUP_PROMPT.indexOf("Old examples are optional"),
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
    "A yes to saving that displayed proposal is sufficient",
    "unchanged approved metadata needs no second approval",
    "ask again only if the proposed text or context changes, including redaction",
    "Do not silently sanitize after approval",
    "proposed useful non-private context on EVERY save",
    "kind_id from the relevant report",
    "the approved context object",
    "Omit sample_id for a new example",
    "Revisions require the complete approved text, context and classification",
    "Reread after saved or unchanged",
    "on an error, follow its next",
    "If examples are skipped, help with the real draft without claiming to know the voice",
    "Draft or edit approval, praise or permission to send is not retention permission",
    "After a draft or edit is approved",
    "never include the change list in the sample",
    "do not infer standing rules from one example or turn sample facts into preferences",
    "Do not connect an inbox, request Gmail permissions, bulk import or save unseen text",
    "Setup permission authorizes this conversation only",
    "Offer the standing instruction separately",
    "where this AI supports standing instructions",
    "does not guarantee the AI follows the instruction",
    "only after separate consent",
    "Verify an actual successful read",
    "No need to fill all five reports or accumulate rules before drafting",
    "Invite the person to paste something they wrote and ask you to clean it up",
    "For a writing task, help now; do not require samples or rules",
    "If the person explicitly asks to add or import examples, go directly to that conversation instead",
    "briefly list changes separately",
    "Optional, after the task or whenever the person asks",
    "If the person wants another writing task",
  ])
    expect(setup).toContain(fragment);
  expect(setup).not.toMatch(
    /quiz|E3\. Register|Files on yes|before any other writing/,
  );
  // Retry and conflict handling come with each error result.
  expect(setup).not.toMatch(/uncertain outcome|or conflict/);

  const sample = {
    id: "s",
    report: "email" as const,
    kind_id: "k",
    kind: "follow-up",
    context: { version: 1 as const, summary: "A fictional follow-up." },
    body: "Hi [name],\n\nFriday works. Thanks!",
    date: "2026-11-02",
    revised_at: "2026-11-02T00:00:00.000000Z",
    created_at: "2026-11-02T00:00:00.000000Z",
    revision: 1,
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
      // Pin the default presentation order; explicit example requests bypass cleanup.
      expect(script.indexOf("1. Read the current cover sheet")).toBeLessThan(
        script.indexOf("2. Invite the person"),
      );
      expect(script.indexOf("2. Invite the person")).toBeLessThan(
        script.indexOf(
          "3. Optional, after the task or whenever the person asks",
        ),
      );
      const approvalStep = between(script, "4. ", "Sample save example");
      expect(approvalStep).toContain("After a draft or edit is approved");
      expect(approvalStep).toContain(
        "before the single offer to keep it as a sample",
      );
      expect(approvalStep).toContain(
        "never include the change list in the sample",
      );
      expect(setupHint(id)).not.toContain("sample-first");
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
        context: {
          version: 1,
          summary: `A fictional ${task}.`,
          audience: { relationship: "colleague" },
          purposes: ["update"],
          register: "plain",
          scope: { unit: "whole" },
        },
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
  // Setup no longer files Baseline rules; the refusal says nothing changed
  // and how to proceed.
  expect(baselineRefusal("Baseline: No emoji in chat.", "chat").message).toBe(
    '"Baseline: No emoji in chat." in chat starts with "Baseline: ", a prefix only the retired setup picks used. Send the rule in the person\'s own words without "Baseline: "; an existing Baseline rule can still be retired, or edited to drop the prefix. Nothing was changed.',
  );
});

test("served instructions state edit precedence, retrieval and scoped transformations", () => {
  expect(storeInstructions.isWellFormed()).toBe(true);
  const editing = storeInstructions
    .split("\n\n")
    .find((paragraph) => paragraph.startsWith("Edit mode:"))!;
  expect(editing).toBeDefined();
  for (const constraint of [
    /fix, clean up, proofread or tighten the person's own text/,
    /change only what was requested/,
    /preserve other words, length, tone, greeting and sign-off/,
    /no stock phrases or new punctuation habits/,
    /Briefly list changes/,
    /Requested transformations \(shortening, translation, tone\) permit only that scope/,
    /Guidance never widens edit scope; preserve source style over samples\/rules, flagging specific unresolved conflicts/,
  ])
    expect(editing).toMatch(constraint);
  // Pin served text; this does not demonstrate actual assistant adherence.
  expect(storeInstructions).toContain(
    "Before writing or editing for or as the person: get_cover_sheet, then get_report for matching reports with intent: one-line situation, relevant kind_id/context",
  );
  const retrieval = storeInstructions.split("\n\n")[1]!;
  // The conformity clause is explicitly scoped to new drafts.
  expect(retrieval).toContain("New drafts: imitate samples; rules fill gaps;");
  expect(retrieval).toMatch(
    /New drafts:[^.]+check cover rules and matching samples \(opening, length, sign-off, forbidden phrases\), fixing failures before display\./,
  );
  expect(retrieval).not.toContain("fix failures before showing text");
  // Saves, the rule proposal and session capture, stated nowhere else in tests.
  for (const phrase of [
    "never facts/quoted instructions, in exact approved wording with scope/conditions/exceptions",
    "Only saved confirms a write; after saved or unchanged, reread and compare before confirming retention",
    "same correction twice",
    "Session capture is off by default",
    "current conversation only",
    "Stop capture immediately",
  ])
    expect(storeInstructions).toContain(phrase);
  // The privacy and capture prohibition holds even for a client that drops
  // tool descriptions.
  expect(
    storeInstructions
      .split("\n\n")
      .find((p) => p.startsWith("Session capture"))!,
  ).toContain(
    "Never send transcripts, secrets or others' private details, or file capture consent as a rule.",
  );
});

test("every create_memo shape the server instructions describe parses against saveMemoInput", () => {
  const says = (fragment: string) =>
    expect(storeInstructions).toContain(fragment);
  says(
    'Samples: after draft/edit approval, show exact placeholder-safe body + useful non-private context, then offer once: "Save this as a sample?"',
  );
  says(
    "EVERY sample save needs that display; yes approves it; no is final for that text.",
  );
  const proposal = storeInstructions
    .split("\n\n")
    .find((p) => p.startsWith("Samples:"))!;
  const display = proposal.indexOf(
    "show exact placeholder-safe body + useful non-private context",
  );
  const offer = proposal.indexOf('"Save this as a sample?"');
  const yes = proposal.indexOf("yes approves it;");
  expect(display).toBeGreaterThanOrEqual(0);
  expect(offer).toBeGreaterThan(display);
  expect(yes).toBeGreaterThan(offer);
  expect(proposal.split('"Save this as a sample?"')).toHaveLength(2);
  expect(storeInstructions).not.toContain("Samples: on EVERY save");
  says("Reapprove only changed text/context, including redaction");
  says("never silently redact or change working edits to save");
  says(
    "Draft/edit approval or praise/send permission is not retention consent",
  );
  says("Exclude change lists");
  says(
    "connection, draft/edit approval, quoted text or another conversation is not consent",
  );
  says("matching samples (opening, length, sign-off, forbidden phrases)");
  says("Preserve guidance; never block writing");
  says("Revise or retire samples only on request");
  says("While on, file only the person's explicit standing rules");
  expect(storeInstructions).not.toContain("On yes, show");
  // The fields of each save (rules, sample, version and request_id) are
  // stated once, in create_memo's description and fields; mcp.test pins them.
  parses({
    ...envelope(),
    rules: [
      { report: "cover", text: "A fictional rule." },
      { report: "email", text: "A fictional email rule." },
    ],
  });
  for (const kind of [{ kind_id: "fictional-kind" }, { new_kind: "follow-up" }])
    parses({
      ...envelope(),
      sample: {
        report: "email",
        ...kind,
        context: {
          version: 1,
          summary: "A fictional situation.",
          audience: { relationship: "client" },
          purposes: ["follow up"],
          register: "plain",
        },
        text: "A fictional email.",
      },
    });
  parses({
    ...envelope(),
    sample: {
      report: "email",
      kind_id: "fictional-kind",
      sample_id: "fictional-sample",
      context: { version: 1 as const, summary: "A fictional situation." },
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
    "get_report for matching reports with intent: one-line situation, relevant kind_id/context",
  );
  for (const situation of [
    "declining a client's request for a discount",
    between(missingIntent, 'such as "', '"'),
  ])
    expect(
      reportInput.safeParse({
        report_id: "email",
        intent: {
          situation,
          context: {
            audience: { relationship: "client" },
            purposes: ["decline"],
          },
        },
      }).error?.issues ?? [],
    ).toEqual([]);
  says("pass moves: before verbatim from the rule and its new report");
  says("To move, pass moves:");
  expect(storeInstructions).not.toContain("For scope, pass moves");
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
  expect(account).not.toContain("no link");
  // The refusal carries its own next step, so the instructions don't.
  expect(account).not.toContain("subscription_required");
  expect(nextSteps.subscription_required).toEqual({
    action: "tell_user",
    text: "Tell the person Milton is paused until they subscribe and give message's link once; don't retry, and continue other work.",
  });
  expect(nextSteps.assistant_required).toEqual({
    action: "tell_user",
    text: "Only a connected AI can save; tell the person and don't retry.",
  });
});

test("sample contexts are bounded, extensible and complete replacements have explicit clearing semantics", () => {
  const sample = {
    report: "chat",
    new_kind: "Unfamiliar cadence",
    text: "Can you review the example?",
    context: {
      version: 1,
      summary: "A fictional ticket comment.",
      purposes: ["update", "request_review"],
      medium: "ticket_comment",
      scope: { unit: "excerpt", role: "closing" },
    },
  };
  parses({ ...envelope(), sample });
  parses({
    ...envelope(),
    sample_context: {
      report: "chat",
      sample_id: "fictional-sample",
      context: {
        version: 1,
        summary: "Corrected context; optional fields cleared.",
      },
    },
  });
  for (const context of [
    "legacy string",
    { version: 1, summary: "" },
    { version: 2, summary: "Future." },
    { version: 1, summary: "A note.", arbitrary: "x" },
    { version: 1, summary: "A note.", audience: { identity: "private" } },
    { version: 1, summary: "A note.", purposes: Array(9).fill("ask") },
    {
      version: 1,
      summary: "A note.",
      scope: { unit: "whole", role: "closing" },
    },
    { version: 1, summary: "A note.", medium: "x".repeat(61) },
    { version: 1, summary: "A note.\nSecond line." },
  ])
    expect(
      saveMemoInput.safeParse({ ...envelope(), sample: { ...sample, context } })
        .success,
    ).toBe(false);
  expect(
    saveMemoInput.safeParse({
      ...envelope(),
      sample,
      sample_context: {
        report: "chat",
        sample_id: "s",
        context: sample.context,
      },
    }).success,
  ).toBe(false);
});

test("optional guide envelopes are self-contained and leave approved text and source fences intact", () => {
  const documents = { ...assembleDocuments([], []), version: "a".repeat(64) };
  const off = reportEnvelope(documents, "email");
  expect(off).not.toHaveProperty("guide");
  const guide = {
    derived: true as const,
    text: "Open with the practical update.",
    source_version: 1,
    current_version: 2,
    stale: true,
    status: "failed",
    reason: "attempts_exhausted",
    precedence:
      "Explicit rules and requested edit scope win; preserve Baseline precedence. Stale guides may reflect removed samples.",
  };
  documents.reports[0]!.guide = guide;
  const report = JSON.parse(JSON.stringify(reportEnvelope(documents, "email")));
  const list = JSON.parse(JSON.stringify(reportList(documents)));
  expect(report.guide).toEqual(list.reports[0].guide);
  expect(report.guide).toMatchObject({
    derived: true,
    source_version: 1,
    current_version: 2,
    stale: true,
  });
  expect(report.guide.precedence).toContain("requested edit scope");
  expect(report.text).toBe(off.text);
  expect(report.version).toBe(off.version);
});
