import { z } from "zod";

const toolNames = [
  "get_cover_sheet",
  "get_report",
  "list_reports",
  "create_memo",
] as const;
export type ToolCall = {
  tool: (typeof toolNames)[number] | "unknown";
  outcome: "read" | "saved" | "unchanged" | "conflict" | "refused" | "failed";
  elapsed_ms: number;
  error_code?: string;
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
// Logged by name.
export const loggedErrorCodes = new Set([
  "rate_limited",
  "store_unavailable",
  "configuration",
  "account_unavailable",
  "subscription_required",
  "invalid_input",
  "request_too_large",
  "memo_body_limit",
  "request_id_reused",
  "save_outcome_unknown",
  "assistant_required",
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
