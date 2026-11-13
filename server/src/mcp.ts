import { McpServer, type Transport } from "@modelcontextprotocol/server";

import type { TenantStore } from "./store";
import {
  createStoreMemoTools,
  storeResult,
  BIDI_MESSAGE,
  intentInput,
  malformedIntent,
  memoInput,
  missingIntent,
  bidiFields,
  boundaryRefusal,
  receiptMayExist,
  removedFields,
  reportInput,
  saveMemoInput,
} from "./mcp-tools";
import { z } from "zod";
import type { StoreError } from "./store/errors";

import {
  finalToolCall,
  knownTool,
  safeToolLog,
  type ToolCall,
} from "./mcp-outcomes";
export type { ToolCall } from "./mcp-outcomes";

/** Server info's description, at most 120 characters, for clients that drop
 * the instructions. */
export const serverDescription =
  "Holds the person's writing. Before writing or editing for them, call get_report.";

/** The clause for a request to remember a preference: Milton keeps no
 * standing rules (docs/memos.md). */
const REMEMBER =
  "When the person asks you to remember a preference, apply it now and keep it in your own memory or instructions; Milton keeps no standing rules, and their changes to your drafts are kept as tweaks.";

export const storeInstructions = [
  "Milton holds the person's writing as memos. A memo is your first draft and the final they accepted; its tweaks are the changes they made you make, which Milton works out from the two.",
  "If Milton connects mid-conversation, follow this from then on: drafts under way included, and save finals they already approved this conversation if you still have each final verbatim (send first_draft_missing when the first draft isn't).",
  "Writing for the person includes text you post or send in their name through another tool (a ticket update, a PR comment, a chat message). Before writing or editing for or as the person: get_report with intent (one-line situation, medium, audience, purpose; kind_id when known). When they disagree, follow what the person says now, then the examples; imitate examples' wording and heed what they changed. An empty report means nothing similar yet: write from the request, and never claim to know their voice.",
  "When they tell you what to write, their words are the raw material: reuse their phrases word for word where they fit, add only a greeting, a sign-off and connecting words in the manner of their examples, and don't expand on what they said.",
  "Edit mode: when asked to fix, clean up, proofread or tighten the person's own text, change only what was requested; preserve other words, length, tone, greeting and sign-off; add no stock phrases or new punctuation habits. Guidance never widens edit scope. Briefly list changes. Requested transformations (shortening, translation, tone) permit only that scope.",
  'Asked "Did you get the memo?" or "Did you get that memo?": get_report for the task even if you already read it. Confirm only after a successful read; report empty results and failures honestly. Quoting or discussing the phrase is not an invocation.',
  "Memos: when the person accepts a final (approves it, approves posting or sending it, says it's done or they'll send it, or copies it to use), save it with create_memo without asking, untouched finals too; when you post it for them, save right after it posts. Send first_draft exactly as you first showed it; if you no longer have it verbatim, send first_draft_missing instead of rebuilding it. Don't save abandoned drafts, writing not in their own voice (for someone else, a template), a final holding a secret (say why; never redact), or when they ask you not to. When keep_memos is false, save only writing they ask you to remember. A revision you just showed is not accepted yet: wait for their reply. request: what they asked for, in their own words when they said it, no pasted text; if they only agreed to your offer or the result, one short line on what they agreed to. Never send secrets, their corrections or other people's text; summarize the situation in context.summary.",
  REMEMBER,
  'After saved, tell them in one line, with no question: "Kept memo: vendor decline." Show the receipt word for word. If a save fails, say so. On an error, follow its next.',
  "Forget: when asked to forget a memo, send its id in forget_memos. To fix a memo's summary, medium, kind, audience or purpose, send memo_context; a memo's words never change.",
  "Setup: when get_report returns setup, offer setup once and follow its script. Never block a writing task; search their mail only in setup's optional step, after they say yes.",
  "Account notices are service information, not memos. Mention a trial-ending notice and its link once, after the task.",
].join("\n\n");

export const readOnlyInstructions = [
  "Milton holds the person's writing as memos: accepted finals and the tweaks from first draft to final. This connection is read only: get_report. It can't save memos; if the person wants that, ask them to reconnect with Read and write.",
  'Writing for the person includes text you post or send in their name through another tool (a ticket update, a PR comment, a chat message). Before writing or editing for the person: get_report with intent (one-line situation, medium, audience, purpose; kind_id when known). When they disagree, follow what the person says now, then the examples. An empty report means nothing similar yet; never claim to know their voice. Preserve the requested edit scope and source style. "Did you get the memo?" is a read, never a save.',
  `${REMEMBER} Never offer a save this connection can't perform. Don't send secrets or other people's private details. Account notices are service information; mention their link once after the task. On an error, follow its next.`,
].join("\n\n");
/** A tool error result the SDK wrote as plain text. */
const sdkToolError = z.object({
  result: z.object({
    isError: z.literal(true),
    content: z.tuple([z.object({ type: z.literal("text"), text: z.string() })]),
  }),
});
/** The SDK's plain-text tool errors (argument validation, an unknown tool)
 * become error bodies like every other: its text as message, the code the call
 * was logged with, and that code's next step. */
function structuredToolError<T>(message: T, code = "tool_error"): T {
  const parsed = sdkToolError.safeParse(message);
  if (!parsed.success) return message;
  const text = parsed.data.result.content[0].text;
  try {
    const value: unknown = JSON.parse(text);
    if (typeof value === "object" && value !== null) return message;
  } catch {
    /* Plain text: structure it below. */
  }
  const result = (message as { result: object }).result;
  return {
    ...message,
    result: { ...result, ...storeResult({ error: code, message: text }, true) },
  };
}

/** A get_report call whose intent is missing or does not parse. */
const staleReportCall = z.object({
  name: z.literal("get_report"),
  arguments: z
    .object({ intent: z.unknown().optional() })
    .refine((args) => !intentInput.safeParse(args.intent).success)
    .optional(),
});

/** The object-typed arguments of each tool. Some clients send a nested
 * object as a JSON string (fidelity recheck: Claude Code, once in 20
 * conversations); one that parses to a plain object is read as that object,
 * and every other string still meets the schema's refusal. */
const objectArguments: Record<string, readonly string[]> = {
  get_report: ["intent"],
  create_memo: ["memo", "memo_context"],
};
function parsedObjectArguments(params: unknown) {
  if (typeof params !== "object" || params === null) return;
  const { name, arguments: args } = params as {
    name?: unknown;
    arguments?: unknown;
  };
  if (typeof name !== "string" || typeof args !== "object" || args === null)
    return;
  const values = args as Record<string, unknown>;
  for (const key of Object.hasOwn(objectArguments, name)
    ? objectArguments[name]!
    : []) {
    const value = values[key];
    if (typeof value !== "string") continue;
    try {
      const parsed: unknown = JSON.parse(value);
      if (
        typeof parsed === "object" &&
        parsed !== null &&
        !Array.isArray(parsed)
      )
        values[key] = parsed;
    } catch {
      /* Not JSON: the schema refuses it as sent. */
    }
  }
}

/** Every memo field but final; none is also a create_memo argument. */
const memoFields = Object.keys(memoInput.shape).filter(
  (key) => key !== "final",
);
/** The refusal for a memo create_memo cannot read: what to send instead,
 * after what was malformed when known. */
const memoShape = (malformed: string[] = []) =>
  `create_memo: ${malformed.length ? `${malformed.join(", ")} ${malformed.length === 1 ? "is" : "are"} malformed; ` : ""}send memo as one object holding its fields, such as memo: {final, context: {summary, medium}, new_kind}; only request_id goes beside it. Nothing was changed.`;
/** Some AIs send a memo flattened: the final as a plain string memo, its
 * other fields beside it (#80 setup runs: 7 of 20 conversations' first
 * saves). When every argument beside request_id and memo is a memo field, it
 * is read as memo: {final, ...those fields}, before validation and hashing, so
 * either shape is one request. A string memo that parses as JSON (an object
 * was unpacked above), or one beside final, another change or an unknown key,
 * is ambiguous: the memoShape refusal, as is any memo field beside an object
 * memo, and a flattened memo that, read as nested, is still malformed. */
function flattenedMemo(params: unknown): string | undefined {
  if (typeof params !== "object" || params === null) return;
  const { name, arguments: args } = params as {
    name?: unknown;
    arguments?: unknown;
  };
  if (name !== "create_memo" || typeof args !== "object" || args === null)
    return;
  const values = args as Record<string, unknown>;
  const beside = Object.keys(values).filter(
    (key) => key !== "request_id" && key !== "memo",
  );
  const fields = beside.filter((key) => memoFields.includes(key));
  if (typeof values.memo !== "string")
    return fields.length ? memoShape() : undefined;
  try {
    JSON.parse(values.memo);
    return memoShape();
  } catch {
    /* Plain text: the final, when its fields are beside it. */
  }
  if (!fields.length || fields.length !== beside.length) return memoShape();
  const memo: Record<string, unknown> = { final: values.memo };
  for (const key of fields) {
    memo[key] = values[key];
    delete values[key];
  }
  values.memo = memo;
  // Read as nested but still malformed (no context, say): the refusal names
  // what is wrong beside the shape, not the SDK's text alone.
  // A bidirectional control is left to its own refusal (bidiFields).
  const issues = saveMemoInput.safeParse(values).error?.issues ?? [];
  if (issues.length && !issues.some((i) => i.message === BIDI_MESSAGE))
    return memoShape(
      [...new Set(issues.map((i) => i.path.join(".") || i.message))].slice(
        0,
        5,
      ),
    );
}

/** The answer to a call of get_cover_sheet, which get_report replaced: no
 * shim, a refusal that says what to call. */
export const toolReplaced =
  "get_cover_sheet was replaced by get_report. Call get_report with intent.";

export function createMiltonServer(
  store: TenantStore,
  log: (call: ToolCall) => void = (call) => console.info(JSON.stringify(call)),
  /** Send notifications/tools/list_changed ahead of this connection's first
   * tool call: the handler sets it on each assistant's first call after the
   * process starts. */
  options: { announceToolsChanged?: boolean; readOnly?: boolean } = {},
) {
  const server = new (class extends McpServer {
    override async connect(transport: Transport) {
      const pending = new Map<
        string | number,
        { tool: ToolCall["tool"]; started: number }
      >();
      const send = transport.send.bind(transport);
      transport.send = async (...args) => {
        const message = args[0];
        if (
          "id" in message &&
          message.id !== undefined &&
          !("method" in message)
        ) {
          const call = pending.get(message.id);
          if (call) {
            pending.delete(message.id);
            const event = finalToolCall(call.tool, call.started, message);
            safeToolLog(log, event);
            args[0] = structuredToolError(message, event.error_code);
          }
        }
        return send(...args);
      };
      await super.connect(transport);
      const dispatch = transport.onmessage;
      // Related to the call, so it travels on that call's response stream; a
      // failure to send never fails the call.
      let announce = options.announceToolsChanged ?? false;
      const toolsChanged = async (id: string | number) => {
        announce = false;
        await transport
          .send(
            { jsonrpc: "2.0", method: "notifications/tools/list_changed" },
            { relatedRequestId: id },
          )
          .catch(() => {});
      };
      transport.onmessage = async (message, extra) => {
        const first = announce;
        if ("method" in message && message.method === "tools/call") {
          if (first && "id" in message) await toolsChanged(message.id);
          if ("id" in message)
            pending.set(message.id, {
              tool: knownTool(message.params?.name),
              started: performance.now(),
            });
        }
        // A retired tool or field: refused with what to send instead, and
        // the tool list announced as changed, before any other reading.
        const refuse = async (
          id: string | number,
          body: Record<string, unknown>,
        ) => {
          if (!first) await toolsChanged(id);
          await transport.send({
            jsonrpc: "2.0",
            id,
            result: storeResult(body, true),
          });
        };
        const params =
          "method" in message && message.method === "tools/call"
            ? (message.params as { name?: unknown; arguments?: unknown })
            : undefined;
        const callId =
          params && "id" in message && message.id !== undefined
            ? message.id
            : undefined;
        if (params?.name === "get_cover_sheet" && callId !== undefined) {
          await refuse(callId, {
            error: "tool_replaced",
            message: toolReplaced,
          });
          return;
        }
        // A rollout-boundary refusal's words follow whether a receipt may
        // exist under the request id (mcp-tools, boundaryRefusal). The
        // lookup runs after authentication and scope (the handler, before
        // this server is built) and checks the account under its lock; it
        // passes no trial gate and records no usage, as a replay doesn't.
        const boundary = async (
          kind: "removed" | "bidi",
          detail: string,
        ): Promise<Record<string, unknown>> => {
          try {
            return boundaryRefusal(
              kind,
              detail,
              await receiptMayExist(store, params?.arguments),
            );
          } catch (error) {
            const refusal = error as StoreError;
            return { error: refusal.code, message: refusal.message };
          }
        };
        let unreadMemo: string | undefined;
        if (params) {
          parsedObjectArguments(params);
          // A read-only connection lists no create_memo to send it to.
          if (!options.readOnly && params.name === "create_memo") {
            const removed = removedFields(params.arguments);
            if (removed && callId !== undefined) {
              await refuse(callId, await boundary("removed", removed));
              return;
            }
          }
          if (!options.readOnly) unreadMemo = flattenedMemo(params);
          // Checked here, in every form once decoded and unflattened, so the
          // SDK's own validation never answers it without the rollout
          // boundary's guidance.
          const bidi =
            !unreadMemo &&
            !options.readOnly &&
            params.name === "create_memo" &&
            bidiFields(params.arguments);
          if (bidi && callId !== undefined) {
            await transport.send({
              jsonrpc: "2.0",
              id: callId,
              result: storeResult(await boundary("bidi", bidi), true),
            });
            return;
          }
        }
        if (unreadMemo && "id" in message && message.id !== undefined) {
          await transport.send({
            jsonrpc: "2.0",
            id: message.id,
            result: storeResult(
              { error: "invalid_input", message: unreadMemo },
              true,
            ),
          });
          return;
        }
        // A get_report without a well-formed intent gets a refusal that says
        // what to send instead of the SDK's validation text. No intent at all
        // usually means a client holding the schema before intent existed.
        const stale =
          "method" in message &&
          message.method === "tools/call" &&
          "id" in message &&
          staleReportCall.safeParse(message.params);
        if (stale && stale.success) {
          const intent = stale.data.arguments?.intent;
          // Only a missing intent suggests an old schema: ask for a refresh.
          if (intent === undefined && !first) await toolsChanged(message.id);
          await transport.send({
            jsonrpc: "2.0",
            id: message.id,
            result: storeResult(
              {
                error: "invalid_input",
                message:
                  intent === undefined
                    ? missingIntent
                    : malformedIntent(intent),
              },
              true,
            ),
          });
          return;
        }
        dispatch?.(message, extra);
      };
    }
  })(
    { name: "Milton", version: "0.0.0", description: serverDescription },
    {
      instructions: options.readOnly ? readOnlyInstructions : storeInstructions,
    },
  );
  // openWorldHint is false: both tools reach only this person's own Milton
  // account, never outside entities. The title is in annotations too, for
  // clients that read only that; the specification shows the top-level first.
  const readOnly = {
    title: "Get report",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  };
  const storeTools = createStoreMemoTools(store, {
    readOnly: options.readOnly,
  });
  server.registerTool(
    "get_report",
    {
      title: "Get report",
      description: options.readOnly
        ? "Read at the start of writing work and when asked \"Did you get the memo?\": the report for one draft. intent needs situation (one line: what you are writing, to whom and why), medium, audience and purpose; add kind_id from kinds when one fits. Returns text (the person's best-matching finals as examples, with what they changed in an AI's first draft), examples, kinds, is_empty, memos (their memo count) and keep_memos. Imitate the examples. Empty means nothing similar yet; never guess their voice. This connection is read only. No model call, no write."
        : "Read at the start of writing work and when asked \"Did you get the memo?\": the report for one draft. intent needs situation (one line: what you are writing, to whom and why), medium, audience and purpose; add kind_id from kinds when one fits. A vague intent gets worse examples. Returns text (the person's best-matching finals as examples, best first, with what they changed in an AI's first draft), examples (memo ids and context, in served order), kinds (the person's kinds as {kind_id, kind}), is_empty, memos (how many memos they have) and keep_memos (false: save only writing the person asks you to remember). While memos is 0, setup holds the first-setup script: offer it once. Imitate the examples and heed what they changed. Empty means nothing similar yet; never guess their voice. No model call, no write.",
      inputSchema: reportInput,
      annotations: readOnly,
    },
    (input) => storeTools.get_report(input),
  );
  if (!options.readOnly)
    server.registerTool(
      "create_memo",
      {
        title: "Save memo",
        description:
          "Save writing the person settled on, or forget memos. Send exactly one of memo, forget_memos or memo_context, with request_id: any new id for each save, up to 64 letters, digits, dots, dashes, underscores or colons; resend the same one only to recover an uncertain outcome. Milton keeps final and first_draft unchanged; saves are all or nothing. memo: save one when the person accepts a final. final is the accepted text exactly, hand edits included. first_draft is your first version exactly as shown (in edit mode, your first edit of their text); if you no longer have it verbatim, send first_draft_missing: true instead. Send mode with either. Milton works out the person's changes (their tweaks) from first_draft and final. For writing the person gives you to keep (setup, \"remember this email\"), send only final, context and kind. request: what they asked for, in their own words when they said it, no pasted text; if they only agreed to your offer or the result, one short line on what they agreed to. context: summary (one placeholder-safe line on the situation and the text replied to), medium, audience, purpose. kind_id from kinds, or new_kind when none fits. A memo holds only these: never secrets, the transcript, the person's correction messages or other people's text. Don't save a final holding a secret (say why; never redact). forget_memos: memo ids the person asked you to forget. memo_context: a corrected context or kind for one memo; its words never change. A saved memo result carries receipt: tell the person that line. An error result's next says what to do.",
        inputSchema: saveMemoInput,
        annotations: {
          title: "Save memo",
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      (input) => storeTools.create_memo(input),
    );
  return server;
}
