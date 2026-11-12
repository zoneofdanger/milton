import { z } from "zod";

const toolNames = ["get_cover_sheet", "get_report", "create_memo"] as const;
export type ToolCall = {
  tool: (typeof toolNames)[number] | "unknown";
  outcome: "read" | "saved" | "unchanged" | "conflict" | "refused" | "failed";
  elapsed_ms: number;
  error_code?: string;
  /** The public id of the connection key that made the call, if one did. */
  connection_key?: string;
};
export const knownTool = (name: unknown): ToolCall["tool"] =>
  toolNames.find((tool) => tool === name) ?? "unknown";
const statuses = z.enum(["saved", "unchanged", "conflict", "failed"]);
const payload = z.object({
  status: statuses.optional(),
  error: z.string().max(64).optional(),
});
const response = z.object({
  error: z.object({ code: z.number() }).optional(),
  result: z
    .object({
      isError: z.boolean().optional(),
      content: z
        .array(z.object({ type: z.string(), text: z.string().optional() }))
        .optional(),
    })
    .optional(),
});
// Logged by name. get_cover_sheet stays a logged tool name so a call from a
// client still holding it shows as its tool_replaced refusal.
export const loggedErrorCodes = new Set([
  "tool_replaced",
  "rate_limited",
  "store_unavailable",
  "configuration",
  "account_unavailable",
  "subscription_required",
  "invalid_input",
  "invalid_kind",
  "request_too_large",
  "request_id_reused",
  "save_outcome_unknown",
  "assistant_required",
  "memos_off",
  "invalid_memo",
  "unique_violation",
  "check_violation",
  "invalid_token",
  "session_required",
  "auth_unavailable",
  "server_unavailable",
  "protocol_error",
  "connection_key_limit",
  "server_busy",
  "billing_unavailable",
]);
const refusals = new Set([
  "tool_replaced",
  "rate_limited",
  "account_unavailable",
  "subscription_required",
  "invalid_input",
  "invalid_kind",
  "request_too_large",
  "request_id_reused",
  "assistant_required",
  "invalid_token",
  "session_required",
]);

/** What an assistant does after an error result, from a closed set:
 * retry - repeat the identical call, a save with its request_id;
 * reread - read the report again, then rebuild the call;
 * fix_input - correct the arguments, a changed save with a new request_id;
 * ask_user - the fix needs the person's approval or choice;
 * tell_user - stop and tell the person; retrying will not help. */
export const nextActions = [
  "retry",
  "reread",
  "fix_input",
  "ask_user",
  "tell_user",
] as const;
export type NextStep = { action: (typeof nextActions)[number]; text: string };
const step = (action: NextStep["action"], text: string): NextStep => ({
  action,
  text,
});
const retryOnce = step(
  "retry",
  "Retry once with exactly the same arguments (a save keeps its request_id). If it fails again, tell the person Milton is unavailable and nothing is confirmed.",
);
const waitThenRetry = step(
  "retry",
  "Wait as long as Retry-After says, or a few seconds, then retry once with the same arguments.",
);
const unavailableNow = step(
  "tell_user",
  "Tell the person Milton can't do this right now and nothing changed; don't retry.",
);
const fixArguments = step(
  "fix_input",
  "Correct the arguments as message says and call again; a changed save needs a new request_id.",
);
const rereadAll = step(
  "reread",
  "Reread the report, recheck the change, then save with a new request_id.",
);
/** The one table: every code an MCP error result or refusal carries, and its
 * next step. withNext adds both to every error body, so nothing else states
 * error handling; a test asserts every code in the source is here. */
export const nextSteps: Record<string, NextStep> = {
  // Saves that met changed guidance.
  version_conflict: rereadAll,
  unique_violation: rereadAll,
  invalid_kind: step(
    "reread",
    "Reread get_report and use a kind_id from its kinds, or send new_kind instead; a save needs a new request_id.",
  ),
  invalid_memo: step(
    "reread",
    "Use a memo_id from a saved result or get_report's examples; if unsure which memo, ask the person.",
  ),
  memos_off: step(
    "tell_user",
    "The person turned off Keep memos: don't save drafts or offer to. Save writing only when they ask you to remember it.",
  ),
  // Arguments to correct.
  invalid_input: fixArguments,
  // By field, the part of a memo a refusal names.
  "invalid_input.request": step(
    "fix_input",
    "Send only what the person typed to ask, without pasted or quoted text, or leave request out; send the rest unchanged and save with a new request_id.",
  ),
  // A field create_memo no longer takes: drop it, and check before saving
  // again, since the refusal can't tell whether an earlier attempt saved.
  "invalid_input.removed": step(
    "ask_user",
    "Drop the fields message names and refresh your tool list. Ask the person to check their TPS page before saving again with a new request_id.",
  ),
  invalid_arguments: fixArguments,
  check_violation: fixArguments,
  unknown_tool: step(
    "fix_input",
    "Call one of the tools Milton lists: get_report or create_memo.",
  ),
  tool_replaced: step(
    "reread",
    "Refresh your tool list, then call get_report with intent; it carries what get_cover_sheet did.",
  ),
  request_id_reused: step(
    "fix_input",
    "This changed save needs a new request_id; reuse an id only with its exact original arguments.",
  ),
  request_too_large: step(
    "fix_input",
    "Save the memo again with the final alone: send first_draft_missing instead of first_draft, with a new request_id.",
  ),
  // Transient failures.
  store_unavailable: retryOnce,
  server_unavailable: retryOnce,
  auth_unavailable: retryOnce,
  tool_error: retryOnce,
  save_outcome_unknown: step(
    "retry",
    "Repeat exactly the same arguments and request_id to learn the outcome; don't send a new request or say it saved.",
  ),
  server_busy: waitThenRetry,
  rate_limited: waitThenRetry,
  // Account and access: tell the person.
  subscription_required: step(
    "tell_user",
    "Tell the person Milton is paused until they subscribe and give message's link once; don't retry, and continue other work.",
  ),
  account_unavailable: step(
    "tell_user",
    "Tell the person their Milton account is unavailable; don't retry.",
  ),
  // By required_permission, the permission the attempted action needed.
  insufficient_scope: step(
    "tell_user",
    "Tell the person this connection lacks the permission in required_permission; they can reconnect Milton with it. Don't retry.",
  ),
  "insufficient_scope.read": step(
    "tell_user",
    "Tell the person this connection can't read Milton; they can reconnect it with Read. Don't retry.",
  ),
  "insufficient_scope.read_write": step(
    "tell_user",
    "Tell the person this connection can't save; they can reconnect Milton with Read and write, or use a key that can save. Don't retry.",
  ),
  invalid_token: step(
    "tell_user",
    "Tell the person to reconnect Milton and sign in again; don't retry with this connection.",
  ),
  // Codes only the web app meets; listed so no code goes without a step.
  session_required: step(
    "tell_user",
    "Tell the person to sign in to Milton again; don't retry.",
  ),
  assistant_required: step(
    "tell_user",
    "Only a connected AI can save; tell the person and don't retry.",
  ),
  connection_key_limit: step(
    "tell_user",
    "Tell the person to revoke an unused connection key in Milton first; don't retry.",
  ),
  // Billing's own refusal, met only in checkout.
  billing_unavailable: retryOnce,
  // Store invariants and configuration a correct call never meets: the user id
  // and save receipt guards.
  configuration: unavailableNow,
  user_id_is_immutable: unavailableNow,
  save_receipt_is_immutable: unavailableNow,
};

/** An error body with its stable code and next step added; existing fields
 * stay. A stale-version conflict, which has no error field, is
 * version_conflict; an unknown code gets the unexpected-failure step. A
 * scope refusal's step follows its required_permission, and a memo
 * refusal's its field. */
export function withNext<T extends Record<string, unknown>>(value: T) {
  const code =
    typeof value.error === "string"
      ? value.error
      : value.status === "conflict"
        ? "version_conflict"
        : "tool_error";
  const variant =
    typeof value.required_permission === "string"
      ? `${code}.${value.required_permission}`
      : typeof value.field === "string"
        ? `${code}.${value.field}`
        : code;
  const key = Object.hasOwn(nextSteps, variant) ? variant : code;
  return {
    ...value,
    code,
    next: Object.hasOwn(nextSteps, key) ? nextSteps[key]! : retryOnce,
  };
}

export function safeToolLog(log: (call: ToolCall) => void, event: ToolCall) {
  try {
    void Promise.resolve(log(event)).catch(() => {});
  } catch {
    /* Observational only. */
  }
}

// Never log raw names, client/account identity, text, task, results, or error prose.
export function finalToolCall(
  tool: ToolCall["tool"],
  started: number,
  message: unknown,
): ToolCall {
  const event: ToolCall = {
    tool,
    outcome: tool === "create_memo" || tool === "unknown" ? "failed" : "read",
    elapsed_ms: Math.max(
      0,
      Math.min(3_600_000, Math.round(performance.now() - started)),
    ),
  };
  const parsed = response.safeParse(message);
  if (!parsed.success)
    return { ...event, outcome: "failed", error_code: "protocol_error" };
  const value = parsed.data;
  if (value.error)
    return {
      ...event,
      outcome: "refused",
      error_code:
        tool === "unknown"
          ? "unknown_tool"
          : value.error.code === -32602
            ? "invalid_arguments"
            : "protocol_error",
    };
  const text = value.result?.content?.find((c) => c.type === "text")?.text;
  let details: z.infer<typeof payload> | undefined;
  try {
    details = payload.parse(JSON.parse(text ?? ""));
  } catch {
    /* SDK validation errors are unstructured text. */
  }
  if (details?.status) event.outcome = details.status;
  if (details?.error) {
    event.error_code = loggedErrorCodes.has(details.error)
      ? details.error
      : "tool_error";
    if (!details.status)
      event.outcome = refusals.has(details.error) ? "refused" : "failed";
  } else if (value.result?.isError) {
    event.outcome = "refused";
    event.error_code =
      tool === "unknown"
        ? "unknown_tool"
        : text &&
            [
              "MCP error -32602:",
              "Input validation error:",
              "Invalid arguments for tool ",
            ].some((prefix) => text.startsWith(prefix))
          ? "invalid_arguments"
          : "tool_error";
  }
  return event;
}
