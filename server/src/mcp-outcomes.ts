import { z } from "zod";

export const toolNames = [
  "get_cover_sheet",
  "get_report",
  "list_reports",
  "create_memo",
] as const;
export type ToolCall = {
  tool: (typeof toolNames)[number] | "unknown";
  outcome:
    | "read"
    | "saved"
    | "unchanged"
    | "needs_clarification"
    | "conflict"
    | "in_progress"
    | "refused"
    | "failed";
  elapsed_ms: number;
  memo_update:
    "none" | "held" | "charged" | "released" | "replayed" | "unknown";
  error_code?: string;
};
export const knownTool = (name: unknown): ToolCall["tool"] =>
  toolNames.find((tool) => tool === name) ?? "unknown";
const statuses = z.enum([
  "saved",
  "unchanged",
  "needs_clarification",
  "conflict",
  "in_progress",
  "failed",
]);
const payload = z.object({
  status: statuses.optional(),
  error: z.string().max(64).optional(),
  memo_update: z
    .object({
      state: z.enum(["none", "held", "charged", "released"]),
      replayed: z.boolean(),
    })
    .optional(),
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
// Logged by name. memo_count_limit is retired but may sit in stored receipts.
export const loggedErrorCodes = new Set([
  "rate_limited",
  "store_unavailable",
  "configuration",
  "account_unavailable",
  "subscription_required",
  "invalid_input",
  "request_too_large",
  "memo_body_limit",
  "memo_history_limit",
  "memo_count_limit",
  "request_id_reused",
  "request_expired",
  "request_unavailable",
  "save_outcome_unknown",
  "assistant_required",
  "memo_updates_exhausted",
  "memo_updates_pending",
  "edit_conflict",
  "move_conflict",
  "sample_conflict",
  "baseline_unknown",
  "card_heading",
  "tps_body_limit",
  "card_version_conflict",
  "unique_violation",
  "check_violation",
  "invalid_token",
  "session_required",
  "auth_unavailable",
  "server_unavailable",
  "protocol_error",
]);
const refusals = new Set([
  "rate_limited",
  "account_unavailable",
  "subscription_required",
  "invalid_input",
  "request_too_large",
  "request_id_reused",
  "assistant_required",
  "memo_updates_exhausted",
  "memo_updates_pending",
  "invalid_token",
  "session_required",
]);
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
    memo_update: "none",
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
    if (details.error === "save_outcome_unknown") event.memo_update = "unknown";
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
  if (details?.memo_update)
    event.memo_update = details.memo_update.replayed
      ? "replayed"
      : details.memo_update.state;
  return event;
}
