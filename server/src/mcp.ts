import { McpServer, type Transport } from "@modelcontextprotocol/server";

import type { TenantStore } from "./store";
import {
  createStoreMemoTools,
  storeResult,
  coverSheetInput,
  intentInput,
  malformedIntent,
  memoInput,
  missingIntent,
  reportInput,
  saveMemoInput,
} from "./mcp-tools";
import { z } from "zod";

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
  "Holds the person's writing. Before writing or editing for them, read get_cover_sheet, then get_report.";

export const storeInstructions = [
  "Milton holds the person's writing: a cover sheet they write, and memos. A memo is your first draft, the final they accepted, and tweaks: one line per change they made you make.",
  "Before writing or editing for or as the person: get_cover_sheet, then get_report with intent (one-line situation, medium, audience, purpose; kind_id when known). When they disagree, follow what the person says now, then the cover sheet, then tweaks, then examples; imitate examples' wording. An empty report means nothing similar yet: write from the cover sheet and the request, and never claim to know their voice.",
  "Edit mode: when asked to fix, clean up, proofread or tighten the person's own text, change only what was requested; preserve other words, length, tone, greeting and sign-off; add no stock phrases or new punctuation habits. Guidance never widens edit scope. Briefly list changes. Requested transformations (shortening, translation, tone) permit only that scope.",
  'Asked "Did you get the memo?" or "Did you get that memo?": get_cover_sheet even if you already read it, then get_report for the task. Confirm only after a successful read; report empty results and failures honestly. Quoting or discussing the phrase is not an invocation.',
  "Memos: when the person accepts a final (approves it, says it's done or they'll send it, or copies it to use), save it with create_memo without asking, untouched finals too. Send first_draft exactly as you first showed it; if you no longer have it verbatim, send first_draft_missing instead of rebuilding it. Don't save abandoned drafts, writing not in their own voice (for someone else, a template), or when they ask you not to. When keep_memos is false, save only writing they ask you to remember. A revision you just showed is not accepted yet: wait for their reply.",
  'Tweaks: when the final differs from the first draft, list each habit they made you change, one line each with when it applies ("vendor replies: no warm-up opener"), never "when requested". Skip one-off facts they added and changes you made unasked. Reuse a served tweak\'s id when it is the same change. Never send secrets, their correction messages or other people\'s text; summarize the situation and what they replied to in context.summary.',
  'After saved, tell them in one line, with no question: "Kept memo: vendor decline, 2 rounds, tweaks: no warm-up opener." Show the receipt word for word, however long. If a save fails, say so. On an error, follow its next.',
  'Cover sheet: only the person writes it. When they say "remember …" or "add to my cover sheet", add their exact line with cover_sheet; remove an exact line only on request. Never add tweaks or your own inferences, or offer to. A correction during a draft is a tweak, not a cover sheet line.',
  "Forget: when asked to forget a memo, send its id in forget_memos. To fix a memo's summary, medium, kind, audience or purpose, send memo_context; a memo's words never change.",
  "Setup: when get_cover_sheet is_empty, offer setup once and follow its script. Never block a writing task; search their mail only in setup's optional step, after they say yes.",
  "Account notices are service information, not memos. Mention a trial-ending notice and its link once, after the task.",
].join("\n\n");

export const readOnlyInstructions = [
  "Milton holds the person's writing: a cover sheet they write, and memos (accepted finals and the tweaks from first draft to final). This connection is read only: get_cover_sheet and get_report. It can't save memos; if the person wants that, ask them to reconnect with Read and write.",
  'Before writing or editing for the person: get_cover_sheet, then get_report with intent (one-line situation, medium, audience, purpose; kind_id when known). When they disagree, follow what the person says now, then the cover sheet, then tweaks, then examples. An empty report means nothing similar yet; never claim to know their voice. Preserve the requested edit scope and source style. "Did you get the memo?" is a read, never a save.',
  "Never offer a save this connection can't perform. Don't send secrets or other people's private details. Account notices are service information; mention their link once after the task. On an error, follow its next.",
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
  create_memo: ["memo", "cover_sheet", "memo_context"],
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
  const issues = saveMemoInput.safeParse(values).error?.issues ?? [];
  if (issues.length)
    return memoShape(
      [...new Set(issues.map((i) => i.path.join(".") || i.message))].slice(
        0,
        5,
      ),
    );
}

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
        let unreadMemo: string | undefined;
        if ("method" in message && message.method === "tools/call") {
          parsedObjectArguments(message.params);
          // A read-only connection lists no create_memo to send it to.
          if (!options.readOnly) unreadMemo = flattenedMemo(message.params);
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
  const readOnly = {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  };
  const storeTools = createStoreMemoTools(store, {
    readOnly: options.readOnly,
  });
  server.registerTool(
    "get_cover_sheet",
    {
      description: options.readOnly
        ? 'Read at the start of writing work and when asked "Did you get the memo?". Returns text (the person\'s cover sheet, their own voice guide for every draft), version, memos and tweaks (counts) and is_empty. Then call get_report for the task. This connection is read only. No model call, no write.'
        : 'Read at the start of writing work and when asked "Did you get the memo?". Returns text (the person\'s cover sheet: their own voice guide; apply it to every draft), version (pass it as cover_sheet.expected_version to change the cover sheet), memos and tweaks (counts), keep_memos (false: save only writing the person asks you to remember) and is_empty (no cover sheet and no memos). While is_empty, setup holds the first-setup script: offer it once. Then call get_report for the task. No model call, no write.',
      inputSchema: coverSheetInput,
      annotations: readOnly,
    },
    () => storeTools.get_cover_sheet(),
  );
  server.registerTool(
    "get_report",
    {
      description: options.readOnly
        ? "Assemble the report for one draft. intent needs situation (one line: what you are writing, to whom and why), medium, audience and purpose; add kind_id from kinds when one fits. Returns text (the cover sheet, the person's best-matching finals as examples, then Your tweaks), examples, tweaks, kinds and is_empty. Imitate the examples; the tweaks say what the person keeps changing. Empty means nothing similar yet; never guess their voice. No model call."
        : "Assemble the report for one draft. intent needs situation (one line: what you are writing, to whom and why), medium, audience and purpose; add kind_id from kinds when one fits. A vague intent gets worse examples and tweaks. Returns text (the cover sheet, the person's best-matching finals as examples, best first, then Your tweaks), report_id (pass it to create_memo when you save this draft's memo), examples (memo ids and context, in served order), tweaks (served tweaks with ids: reuse an id when a change is the same), kinds (the person's kinds as {kind_id, kind}) and is_empty. Imitate the examples; the tweaks say what the person keeps changing. Empty means nothing similar yet; never guess their voice. No model call; Milton records which tweaks it served.",
      inputSchema: reportInput,
      annotations: readOnly,
    },
    (input) => storeTools.get_report(input),
  );
  if (!options.readOnly)
    server.registerTool(
      "create_memo",
      {
        description:
          "Save writing the person settled on, change their cover sheet, or forget memos. Send exactly one of memo, cover_sheet, forget_memos or memo_context, with a new request_id; to recover an uncertain outcome, resend exactly the same arguments. Milton stores your bytes unchanged, whole or not at all. memo: save one when the person accepts a final, without asking. final is the accepted text exactly, hand edits included. first_draft is your first version exactly as shown (in edit mode, your first edit of their text); if you no longer have it verbatim, send first_draft_missing: true instead. Send mode and rounds with either. For writing the person gives you to keep (setup, \"remember this email\"), send only final, context and kind. tweaks, only when the final differs from the first draft: each habit they made you change, one line each with when it applies; skip one-off facts they added; {tweak_id} reuses a served tweak, {text} adds one. context: summary (one placeholder-safe line on the situation and the text replied to), medium, audience, purpose. kind_id from kinds, or new_kind when none fits. memo.report_id from the get_report read before the draft. A memo holds only these: never secrets, the transcript, the person's correction messages or other people's text. cover_sheet: only the person's words. add one exact line they asked you to add, or remove one exact line they asked to drop, with expected_version from get_cover_sheet; never add tweaks or your inferences. forget_memos: memo ids the person asked you to forget, with what they taught. memo_context: a corrected context or kind for one memo; its words never change. A saved memo result carries receipt: tell the person that line. An error result's next says what to do.",
        inputSchema: saveMemoInput,
        annotations: {
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: true,
          openWorldHint: true,
        },
      },
      (input) => storeTools.create_memo(input),
    );
  return server;
}
