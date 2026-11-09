import { expect, test } from "bun:test";
import { readOnlyInstructions, storeInstructions } from "../src/mcp";
import { nextSteps } from "../src/mcp-outcomes";
import { setupScript } from "../src/store/setup";
import { SETUP_PROMPT } from "../src/store/setup";
import { memoShapeProblem, receiptLine } from "../src/store/save";
import {
  coverSheet,
  memoInput,
  missingIntent,
  reportInput,
  saveMemoInput,
} from "../src/mcp-tools";
import { subscriptionRequired, trialEndingMessage } from "../src/store/trials";

const words = /\b(assistants?|samples?|trails?|lessons?|rules?)\b/i;

test("the served text uses one word for each thing and describes the memo workflow", () => {
  for (const served of [storeInstructions, readOnlyInstructions, setupScript])
    expect(served).not.toMatch(words);
  // Every topic keeps its paragraph, in order.
  expect(
    storeInstructions.split("\n\n").map((p) => p.split(/[:.(]/)[0]),
  ).toEqual([
    "Milton holds the person's writing",
    "Before writing or editing for or as the person",
    "Edit mode",
    'Asked "Did you get the memo?" or "Did you get that memo?"',
    "Memos",
    "Tweaks",
    "After saved, tell them in one line, with no question",
    "Cover sheet",
    "Forget",
    "Setup",
    "Account notices are service information, not memos",
  ]);
  // The workflow's parts (spec, "Contract changes"): save on acceptance
  // without asking, first-draft fidelity, tweak-id reuse, the receipt,
  // cover sheet versus tweak routing, and forget.
  for (const part of [
    "save it with create_memo without asking, untouched finals too",
    "send first_draft_missing instead of rebuilding it",
    "Reuse a served tweak's id",
    "Kept memo: vendor decline, 2 rounds, tweaks: no warm-up opener.",
    "A correction during a draft is a tweak, not a cover sheet line",
    "Never add tweaks or your own inferences, or offer to",
    "forget_memos",
    "what the person says now, then the cover sheet, then tweaks, then examples",
  ])
    expect(storeInstructions).toContain(part);
  // The receipt the instructions quote is the one a save returns.
  expect(
    receiptLine({
      label: "vendor decline",
      rounds: 2,
      tweaks: ["no warm-up opener"],
    }),
  ).toBe("Kept memo: vendor decline, 2 rounds, tweaks: no warm-up opener.");
  expect(readOnlyInstructions).toContain("read only");
  expect(readOnlyInstructions).not.toContain("create_memo");
});

test("get_report requires an intent with audience and purpose, and the refusal says what to send", () => {
  const intent = {
    situation: "declining a vendor's meeting request",
    medium: "email",
    audience: "a vendor",
    purpose: "decline",
  };
  expect(reportInput.safeParse({ intent }).success).toBe(true);
  for (const missing of ["audience", "purpose", "medium"]) {
    const { [missing]: _gone, ...rest } = intent as Record<string, string>;
    expect(reportInput.safeParse({ intent: rest }).success).toBe(false);
  }
  expect(missingIntent).toContain("audience and purpose");
});

test("setup offers once, reads no inbox, and its example memo parses as a final-only memo", () => {
  expect(setupScript).toStartWith("First setup: offer it once");
  expect(setupScript).toContain("Setup never reads an inbox");
  expect(setupScript).toContain("Don't suggest lines from their writing");
  const example = JSON.parse(
    setupScript.slice(
      setupScript.indexOf("```json\n") + 8,
      setupScript.lastIndexOf("\n```"),
    ),
  );
  const parsed = saveMemoInput.safeParse(example);
  expect(parsed.error?.issues ?? []).toEqual([]);
  expect(memoShapeProblem(parsed.data!.memo!)).toBeUndefined();
  expect(example.memo.first_draft).toBeUndefined();
  // Setup is served only while the account is empty.
  const read = {
    text: "",
    version: 0,
    memos: 0,
    tweaks: 0,
    keep_memos: true,
  };
  expect(coverSheet({ ...read, is_empty: true }).setup).toBe(setupScript);
  expect(coverSheet({ ...read, memos: 1, is_empty: false })).not.toHaveProperty(
    "setup",
  );
  expect(SETUP_PROMPT).not.toMatch(words);
});

test("every memo shape the instructions describe parses, and contradicting shapes are named", () => {
  const context = { summary: "a fictional decline", medium: "email" };
  const shapes = [
    // A drafted memo with tweaks, new and reused.
    {
      final: "No, thanks.",
      first_draft: "Hi! Unfortunately we can't.",
      mode: "draft",
      rounds: 2,
      tweaks: [{ text: "no warm-up opener" }, { tweak_id: "t1" }],
      context,
      new_kind: "vendor decline",
    },
    // The first draft no longer verbatim.
    {
      final: "No.",
      first_draft_missing: true,
      mode: "draft",
      rounds: 3,
      context,
    },
    // Writing the person gave.
    { final: "My own email.", context, kind_id: "k1" },
  ];
  for (const memo of shapes) {
    const parsed = memoInput.safeParse(memo);
    expect(parsed.error?.issues ?? []).toEqual([]);
    expect(memoShapeProblem(parsed.data!)).toBeUndefined();
  }
  for (const other of [
    { cover_sheet: { add: "No em dashes", expected_version: 0 } },
    { cover_sheet: { remove: "No em dashes", expected_version: 1 } },
    { forget_memos: ["m1"] },
    { memo_context: { memo_id: "m1", context } },
  ])
    expect(
      saveMemoInput.safeParse({ request_id: crypto.randomUUID(), ...other })
        .success,
    ).toBe(true);
  // Exactly one change per save.
  expect(
    saveMemoInput.safeParse({
      request_id: crypto.randomUUID(),
      forget_memos: ["m1"],
      cover_sheet: { add: "x", expected_version: 0 },
    }).success,
  ).toBe(false);
});

test("the refusal, both reminders and the instructions give the one link, true for everyone who reads them", () => {
  const app = "https://app.example";
  const refusal = subscriptionRequired(app);
  expect(refusal.message).toBe(
    "Milton is paused until you subscribe for $5.01/month. Your memos and cover sheet stay available to view and download. Subscribe at https://app.example/",
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
