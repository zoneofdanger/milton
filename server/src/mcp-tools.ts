// The tool contract served to AIs beside mcp.ts: every input schema, the read
// envelopes and refusals, and the tool runner over a TenantStore.
import { z } from "zod";
import type { TenantStore } from "./store";
import { withNext } from "./mcp-outcomes";
import { StoreError } from "./store/errors";
import { utf8Bytes } from "./store/limits";
import { subscriptionRequired } from "./store/trials";
import { usageWithin, type CallUsage, type ToolName } from "./store/usage";
import { MEDIA, type CoverSheetRead, type ReportRead } from "./store/memos";
import { setupScript } from "./store/setup";

/** One trimmed line of at most `max` characters, with no control characters. */
export const oneLine = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .refine((v) => v.isWellFormed() && !/[\p{Cc}]/u.test(v));
const id = z.string().min(1).max(64);
const medium = z
  .enum(MEDIA)
  .describe("email, chat (DMs, texts, Slack), post, document or speech.");

export const coverSheetInput = z.strictObject({});
export const intentInput = z
  .strictObject({
    situation: oneLine(200).describe(
      'One line on what you are writing, to whom and why, such as "declining a vendor\'s meeting request". When not drafting, why you are reading, such as "confirming what is on file".',
    ),
    medium,
    audience: oneLine(100).describe(
      'Who it is for, in generic words, such as "a vendor" or "my team".',
    ),
    purpose: oneLine(100).describe(
      'What it should do, such as "decline" or "ask for a review".',
    ),
    kind_id: id
      .optional()
      .describe(
        "A kind_id from get_report's kinds when one fits. Never invent one on read.",
      ),
  })
  .describe(
    "What this report is for. Audience and purpose are required: a vague intent gets worse examples and tweaks.",
  );
export const reportInput = z.strictObject({ intent: intentInput });
/** The refusal for a get_report call with no intent, as from a client still
 * holding an older schema. */
export const missingIntent =
  "get_report needs intent: situation (one line on what you are writing, to whom and why), medium, audience and purpose, plus kind_id when known; reconnect your AI if it has no intent field. Nothing was read.";
/** The refusal for a get_report intent that is present but malformed: each
 * limit it broke, and no reconnect hint, since the client has the field. */
export function malformedIntent(intent: unknown) {
  const issues = intentInput.safeParse(intent).error?.issues ?? [];
  const broken = new Set(
    issues.map((issue) => {
      const field = String(issue.path[0] ?? "");
      return field === "situation"
        ? "situation must be one line of at most 200 characters"
        : field === "medium"
          ? "medium is one of email, chat, post, document or speech"
          : field === "audience" || field === "purpose"
            ? `${field} is required: one line of at most 100 characters`
            : "intent takes situation, medium, audience, purpose and an optional kind_id";
    }),
  );
  return `get_report intent: ${[...broken].join("; ")}. Nothing was read.`;
}

/** A memo's words: up to the 256 KiB request cap, well formed, with no NUL. */
const words = z
  .string()
  .max(262144)
  .refine(
    (v) =>
      v.trim().length > 0 &&
      v.isWellFormed() &&
      !v.includes("\0") &&
      utf8Bytes(v) <= 262144,
  );
export const memoContextInput = z
  .strictObject({
    summary: oneLine(200).describe(
      'One placeholder-safe line on the situation and the text being replied to, such as "decline Thursday meeting from a vendor; their email asked for a 30-min call". Never the quoted text itself.',
    ),
    medium,
    audience: oneLine(100).optional().describe('Generic, such as "a vendor".'),
    purpose: oneLine(100).optional().describe('Such as "decline".'),
  })
  .describe("The memo's context. Omitted optional fields stay empty.");
const kindFields = {
  kind_id: id
    .optional()
    .describe("A kind_id from get_report's kinds when one fits."),
  new_kind: oneLine(60)
    .optional()
    .describe(
      "Only when no listed kind fits: a short label such as vendor decline. A label already on file, in any letter case, reuses that kind.",
    ),
};
export const memoInput = z
  .strictObject({
    final: words.describe(
      "The version the person accepted, exactly, hand edits included.",
    ),
    first_draft: words
      .optional()
      .describe(
        "Your first version exactly as you showed it; in edit mode, your first edit of their text. Never rebuilt.",
      ),
    first_draft_missing: z
      .literal(true)
      .optional()
      .describe(
        "Send instead of first_draft when you no longer have it verbatim.",
      ),
    mode: z
      .enum(["draft", "edit"])
      .optional()
      .describe(
        "draft when you wrote it, edit when you edited the person's text. Required with a first draft.",
      ),
    rounds: z
      .number()
      .int()
      .min(0)
      .max(1000)
      .optional()
      .describe(
        "How many times you redrafted after the first draft. Required with a first draft.",
      ),
    tweaks: z
      .array(
        z.union([
          z.strictObject({ tweak_id: id }),
          z.strictObject({ text: oneLine(200) }),
        ]),
      )
      .max(10)
      // An empty list, as some clients send for none, is read as omitted.
      .transform((tweaks) => (tweaks.length ? tweaks : undefined))
      .optional()
      .describe(
        'Only when the final differs from the first draft: each habit the person made you change, one line each with when it applies ("vendor replies: no warm-up opener"). Skip one-off facts they added. When it is the same change, reuse a served tweak\'s id with {tweak_id}; {text} adds one only when none fits.',
      ),
    context: memoContextInput,
    ...kindFields,
    // null, as some clients send for none, is read as omitted.
    kind_id: id
      .nullable()
      .transform((kind) => kind ?? undefined)
      .optional()
      .describe(kindFields.kind_id.description!),
    report_id: id
      .optional()
      .describe("The report_id of the get_report read before this draft."),
  })
  .describe(
    'One accepted final. Omit first_draft, first_draft_missing, mode, rounds and tweaks for writing the person gave you to keep (setup pastes, "remember this email").',
  );
export const coverSheetChangeInput = z
  .strictObject({
    add: oneLine(300)
      .optional()
      .describe("One exact line the person asked you to add."),
    remove: z
      .string()
      .min(1)
      .max(1500)
      .optional()
      .describe(
        "One exact existing line the person asked you to remove, copied verbatim.",
      ),
    expected_version: z
      .number()
      .int()
      .min(0)
      .describe("The version from the latest get_cover_sheet."),
  })
  .refine((v) => (v.add === undefined) !== (v.remove === undefined), {
    message: "cover_sheet takes add or remove, not both.",
  });
export const memoContextChangeInput = z.strictObject({
  memo_id: id,
  context: memoContextInput,
  ...kindFields,
});

export const oneChange =
  "Send exactly one of memo, cover_sheet, forget_memos or memo_context.";
export const saveMemoInput = z
  .strictObject({
    request_id: z
      .uuid()
      .describe(
        "A new UUID for each new save. Reuse it with exactly the same arguments only to recover an uncertain outcome.",
      ),
    memo: memoInput.optional(),
    cover_sheet: coverSheetChangeInput.optional(),
    forget_memos: z
      .array(id)
      .min(1)
      .max(100)
      .optional()
      .describe("Ids of memos the person asked you to forget."),
    memo_context: memoContextChangeInput
      .optional()
      .describe(
        "A corrected context and kind for one memo; its words never change.",
      ),
  })
  .refine(
    (v) =>
      [v.memo, v.cover_sheet, v.forget_memos, v.memo_context].filter(
        (part) => part !== undefined,
      ).length === 1,
    { message: oneChange },
  );
export type SaveMemoInput = z.infer<typeof saveMemoInput>;
export type MemoInput = z.infer<typeof memoInput>;
export type MemoContextInput = z.infer<typeof memoContextInput>;

type ToolResult = {
  content: [{ type: "text"; text: string }];
  isError?: boolean;
};

/** Every tool result. An error result carries its code and next step from the
 * one table in mcp-outcomes. */
export function storeResult(value: object, isError = false): ToolResult {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(
          isError ? withNext(value as Record<string, unknown>) : value,
        ),
      },
    ],
    ...(isError ? { isError } : {}),
  };
}
/** The cover sheet envelope. While the account is empty, setup carries the
 * onboarding script. */
export function coverSheet(read: CoverSheetRead) {
  return {
    text: read.text,
    version: read.version,
    memos: read.memos,
    tweaks: read.tweaks,
    keep_memos: read.keep_memos,
    is_empty: read.is_empty,
    ...(read.is_empty ? { setup: setupScript } : {}),
  };
}
export const reportEnvelope = (report: ReportRead) => ({
  report_id: report.report_id,
  text: report.text,
  is_empty: report.is_empty,
  examples: report.examples,
  tweaks: report.tweaks,
  kinds: report.kinds,
});

export function createStoreMemoTools(
  store: TenantStore,
  options: { readOnly?: boolean } = {},
) {
  function permission<T extends { setup?: unknown }>(value: T) {
    if (!options.readOnly) return value;
    const { setup: _setup, ...read } = value;
    return {
      ...read,
      permission:
        "Read only. To save memos, the person reconnects with Read and write.",
    };
  }
  async function withNotice<T extends object>(value: T) {
    // A failed claim must never turn an accepted save into an apparent failure.
    // Claiming means offered in one response, not displayed/acknowledged by a user,
    // so a committed claim is always awaited and returned; the claim transaction's
    // own lock and statement timeouts bound how long it can take.
    try {
      const notice = await store.trialNotice?.();
      return notice ? { ...value, notice } : value;
    } catch {
      return value;
    }
  }
  // Each call has its own usage: a call the store admits appends its row
  // alongside the work, and the reply waits for it at most USAGE_WAIT_MS.
  async function run(
    tool: ToolName,
    operation: (call: CallUsage) => Promise<ToolResult>,
  ) {
    const call: CallUsage = { tool };
    try {
      return await operation(call);
    } catch (thrown) {
      const error =
        thrown instanceof StoreError && thrown.code === "subscription_required"
          ? subscriptionRequired(store.appOrigin)
          : thrown;
      return storeResult(
        {
          ...(error instanceof StoreError ? error.details : {}),
          error: error instanceof StoreError ? error.code : "store_unavailable",
          message:
            error instanceof StoreError
              ? error.message
              : "Milton is unavailable. No save outcome is confirmed.",
        },
        true,
      );
    } finally {
      await usageWithin(call);
    }
  }
  return {
    get_cover_sheet: () =>
      run("get_cover_sheet", async (call) =>
        storeResult(
          await withNotice(
            permission(coverSheet(await store.readCoverSheet(call))),
          ),
        ),
      ),
    get_report: (input: z.infer<typeof reportInput>) =>
      run("get_report", async (call) =>
        storeResult(
          await withNotice(
            reportEnvelope(await store.readReport(input.intent, call)),
          ),
        ),
      ),
    create_memo: (input: SaveMemoInput) =>
      run("create_memo", async (call) => {
        if (options.readOnly)
          return storeResult(
            {
              error: "insufficient_scope",
              required_permission: "read_write",
              message:
                "This connection is read only. Reconnect with Read and write to save memos.",
            },
            true,
          );
        const outcome = await store.saveMemo(input, call);
        if (outcome.error === "subscription_required") {
          const error = subscriptionRequired(store.appOrigin);
          return storeResult(
            { ...outcome, ...error.details, message: error.message },
            true,
          );
        }
        return storeResult(
          outcome.status === "saved" || outcome.status === "unchanged"
            ? await withNotice(outcome)
            : outcome,
          outcome.status === "failed" || outcome.status === "conflict",
        );
      }),
  };
}
