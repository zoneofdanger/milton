// The tool contract served to AIs beside mcp.ts: every input schema, the read
// envelopes and refusals, and the tool runner over a TenantStore.
import { z } from "zod";
import type { TenantStore } from "./store";
import { withNext } from "./mcp-outcomes";
import { StoreError } from "./store/errors";
import { utf8Bytes } from "./store/limits";
import { subscriptionRequired } from "./store/trials";
import { usageWithin, type CallUsage, type ToolName } from "./store/usage";
import { joinSeparators, MEDIA, type ReportRead } from "./store/memos";
import { setupScript } from "./store/setup";

/** The bidirectional controls that open an embedding, override or isolate
 * span (U+202A–U+202E, U+2066–U+2069). A one-line field holding one is
 * refused, never stripped; U+200E, U+200F and U+061C open no span and stay
 * accepted (docs/memos.md, "Bounds"). */
export const BIDI_CONTROL = /[\u202A-\u202E\u2066-\u2069]/;
/** The refusal's text for a one-line field holding one of them. */
export const BIDI_MESSAGE = "holds a bidirectional control character";
/** One line of at most `max` characters (docs/memos.md, "Bounds"): each run
 * of U+2028 and U+2029 becomes one space, then the value is trimmed and must
 * hold no control character and no BIDI_CONTROL. The input is hashed after
 * this. */
export const oneLine = (max: number) =>
  z
    .string()
    .overwrite(joinSeparators)
    .trim()
    .min(1)
    .max(max)
    .refine((v) => v.isWellFormed() && !/[\p{Cc}]/u.test(v))
    .refine((v) => !BIDI_CONTROL.test(v), { message: BIDI_MESSAGE });
const id = z.string().min(1).max(64);
const medium = z
  .enum(MEDIA)
  .describe("email, chat (DMs, texts, Slack), post, document or speech.");

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
    "What this report is for. Audience and purpose are required: a vague intent gets worse examples.",
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
      // A report is a read: no save guidance, only what to remove.
      if (issue.message === BIDI_MESSAGE)
        return `${field} holds a text-direction control character (U+202A to U+202E or U+2066 to U+2069); remove it and resend`;
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
    request: z
      .string()
      .trim()
      .optional()
      .describe(
        "Only with first_draft or first_draft_missing: what the person typed to ask for this writing, exactly as typed, at most 600 characters and 12 lines. Cut pasted or quoted text (an email, a thread, a document) and anything secret, marking each cut […]; change nothing else. In edit mode, their instruction, never the text to edit. Never their later corrections.",
      ),
    context: memoContextInput,
    ...kindFields,
    // null, as some clients send for none, is read as omitted.
    kind_id: id
      .nullable()
      .transform((kind) => kind ?? undefined)
      .optional()
      .describe(kindFields.kind_id.description!),
  })
  .describe(
    'One accepted final. Omit first_draft, first_draft_missing, mode and request for writing the person gave you to keep (setup, "remember this email").',
  );
export const memoContextChangeInput = z.strictObject({
  memo_id: id,
  context: memoContextInput,
  ...kindFields,
});

export const oneChange =
  "Send exactly one of memo, forget_memos or memo_context.";
/** A save's request_id (docs/saves.md, "Request ids"): 1 to 64 of these
 * characters, compared byte for byte; a UUID passes. */
export const REQUEST_ID = /^[A-Za-z0-9._:-]{1,64}$/;
export const saveMemoInput = z
  .strictObject({
    request_id: z
      .string()
      .regex(REQUEST_ID)
      .describe(
        "Any new id for each save, up to 64 letters, digits, dots, dashes, underscores or colons; resend the same one only to recover an uncertain outcome.",
      ),
    memo: memoInput.optional(),
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
      [v.memo, v.forget_memos, v.memo_context].filter(
        (part) => part !== undefined,
      ).length === 1,
    { message: oneChange },
  );
export type SaveMemoInput = z.infer<typeof saveMemoInput>;
/** What is wrong with create_memo arguments whose one-line fields hold a
 * bidirectional span control (rule B), or undefined. Like a removed field,
 * it is a rollout boundary (docs/saves.md): never replayed, so its words
 * follow boundaryRefusal. */
export function bidiFields(args: unknown): string | undefined {
  const issues = (saveMemoInput.safeParse(args).error?.issues ?? []).filter(
    (i) => i.message === BIDI_MESSAGE,
  );
  if (!issues.length) return;
  return `${[...new Set(issues.map((i) => i.path.join(".")))].join(", ")} ${BIDI_MESSAGE} (U+202A to U+202E or U+2066 to U+2069); send it without them.`;
}
export type MemoInput = z.infer<typeof memoInput>;
export type MemoContextInput = z.infer<typeof memoContextInput>;

type ToolResult = {
  content: [{ type: "text"; text: string }];
  isError?: boolean;
};

/** Every tool result. An error result carries its code and next step from the
 * one table in mcp-outcomes. U+2028 and U+2029, which JSON.stringify leaves
 * literal, are escaped, so a value stored before the one-line rule breaks no
 * line of the result; JSON.parse returns it unchanged. */
export function storeResult(value: object, isError = false): ToolResult {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(
          isError ? withNext(value as Record<string, unknown>) : value,
        ).replace(
          /[\p{Zl}\p{Zp}]/gu,
          (c) => `\\u${c.charCodeAt(0).toString(16)}`,
        ),
      },
    ],
    ...(isError ? { isError } : {}),
  };
}
/** The report envelope (docs/reports.md): the text and what it served, the
 * account's total memo count and keep_memos; setup carries the first-setup
 * script while the account has no memo. */
export const reportEnvelope = (report: ReportRead) => ({
  text: report.text,
  is_empty: report.is_empty,
  examples: report.examples,
  kinds: report.kinds,
  memos: report.memos,
  keep_memos: report.keep_memos,
  ...(report.memos === 0 ? { setup: setupScript } : {}),
});

/** Rule A4's sentence (docs/saves.md, "Rollout boundary"): a request refused
 * before its receipt is looked up says nothing about an earlier attempt. */
export const NO_RECOVERY =
  "Milton can't recover an earlier outcome for this request. Before saving again with a new request_id, ask the person to check their TPS page and, if it isn't there, the full TPS.md export (the page lists the latest 200 memos), for this memo.";
/** Fields create_memo no longer takes, each with its guidance, in the order a
 * refusal names them: cover_sheet beside the change, the rest in the memo
 * (or beside a flattened one). Never shimmed. */
const REMOVED = [
  [
    "cover_sheet",
    "There is no cover sheet. When the person asks you to remember a preference, keep it in your own memory or instructions; Milton keeps their changes as tweaks.",
  ],
  [
    "tweaks",
    "tweaks are no longer sent: Milton works out the person's changes from first_draft and final.",
  ],
  ["rounds", "rounds is no longer sent."],
  ["report_id", "report_id is no longer sent."],
] as const;
/** The guidance for create_memo arguments holding a removed field at its
 * documented position, or undefined. `args` is already decoded (a memo sent
 * as a JSON-object string is an object here). Only key names are looked at,
 * never the words of a final, first draft or request. */
export function removedFields(args: unknown): string | undefined {
  if (typeof args !== "object" || args === null || Array.isArray(args)) return;
  const top = args as Record<string, unknown>;
  const memo =
    typeof top.memo === "object" &&
    top.memo !== null &&
    !Array.isArray(top.memo)
      ? (top.memo as Record<string, unknown>)
      : {};
  const found = REMOVED.filter(([key]) =>
    key === "cover_sheet"
      ? Object.hasOwn(top, key)
      : Object.hasOwn(memo, key) || Object.hasOwn(top, key),
  );
  if (!found.length) return;
  return found.map(([, guidance]) => guidance).join(" ");
}

/** A rollout-boundary refusal (docs/saves.md, "Rollout boundary"): a removed
 * field or a bidi control. Whether a receipt exists under the request id
 * decides its words: with none, no save under it has finished, so the AI
 * resends fixed under the same id (a delayed attempt that then commits meets
 * the resend as request_id_reused, not a second memo); with one, or when the
 * lookup failed, an earlier save may have committed, so the person checks
 * first. Nothing of a receipt is returned. */
export function boundaryRefusal(
  kind: "removed" | "bidi",
  detail: string,
  held: boolean,
) {
  return held
    ? {
        error: "invalid_input",
        field: kind,
        message: `create_memo: ${detail} Nothing was changed. ${NO_RECOVERY}`,
      }
    : {
        error: "invalid_input",
        field: `${kind}_unsaved`,
        message: `create_memo: ${detail} No save under this request_id has finished. Send it again without ${kind === "removed" ? "those fields" : "those characters"}, with the same request_id.`,
      };
}

/** Whether a receipt may exist under this call's request id: false only
 * when it provably doesn't (an id the database's checks refuse holds none,
 * or the lookup found none); true when one exists or the lookup failed.
 * A closing account's refusal is thrown. */
export async function receiptMayExist(
  store: Pick<TenantStore, "requestReceipt">,
  args: unknown,
) {
  const id =
    typeof args === "object" && args !== null
      ? (args as { request_id?: unknown }).request_id
      : undefined;
  if (typeof id !== "string" || !REQUEST_ID.test(id)) return false;
  try {
    return await store.requestReceipt(id);
  } catch (error) {
    if (error instanceof StoreError && error.code === "account_unavailable")
      throw error;
    return true;
  }
}

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
    get_report: (input: z.infer<typeof reportInput>) =>
      run("get_report", async (call) =>
        storeResult(
          await withNotice(
            permission(
              reportEnvelope(await store.readReport(input.intent, call)),
            ),
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
