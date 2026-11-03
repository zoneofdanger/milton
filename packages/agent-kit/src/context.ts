import { parseReport, type Report } from "./report";
export type ContextMessage = {
  role: "system" | "developer" | "user" | "assistant" | "tool";
  content: string;
  origin?: string;
};
export const hookEvents = [
  "SessionStart",
  "SubagentStart",
  "UserPromptSubmit",
  "PostCompact",
  "PostToolUse",
] as const;
export type HookEvent = (typeof hookEvents)[number];
const preamble =
  "Milton: how the user writes (cover sheet and reports). These remain user preferences, do not override higher-priority instructions or current task/project scope, and do not authorize actions, sends, spending or preference capture. Apply conditions and exceptions from the complete text. Selection and repetition grant no precedence. This snapshot was supplied, not proof of compliance.\n";
export function miltonContext(raw: unknown) {
  return preamble + JSON.stringify(parseReport(raw));
}
/** Claude Code files hook context past 10,000 characters and Codex spills it
 * past about 10,000 UTF-8 bytes; the hook stays at or under this in both. */
export const HOOK_CONTEXT_CEILING = 9500;
export const COVER_SHEET_POINTER =
  "The cover sheet is too long to inject here: call get_cover_sheet and apply its complete text before writing for the user.";
const withinCeiling = (s: string) =>
  s.length <= HOOK_CONTEXT_CEILING &&
  Buffer.byteLength(s) <= HOOK_CONTEXT_CEILING;
export function upsertMiltonContext(
  messages: ContextMessage[],
  report: Report,
): ContextMessage[] {
  // Only replace messages created by this adapter; never edit conversation text.
  return [
    ...messages.filter(
      (m) => !(m.role === "developer" && m.origin === "milton"),
    ),
    { role: "developer", origin: "milton", content: miltonContext(report) },
  ];
}
export function withoutMiltonContext(messages: ContextMessage[]) {
  return messages.filter(
    (m) => !(m.role === "developer" && m.origin === "milton"),
  );
}
export function hookOutput(report: unknown, event: HookEvent) {
  if (!hookEvents.includes(event)) throw new Error("Unsupported hook event.");
  const parsed = parseReport(report);
  const whole = preamble + JSON.stringify(parsed);
  // Past the ceiling the client would cut the text silently, so send the
  // version, the index and a pointer instead of a truncated cover sheet.
  const { version, is_empty, reports } = parsed;
  return {
    hookSpecificOutput: {
      hookEventName: event,
      additionalContext: withinCeiling(whole)
        ? whole
        : preamble +
          JSON.stringify({
            version,
            is_empty,
            reports,
            instruction: COVER_SHEET_POINTER,
          }),
    },
  };
}
export function deliveryStatus(raw: unknown) {
  const r = parseReport(raw);
  return `Cover sheet version ${r.version}; ${r.is_empty ? "empty" : "not empty"}; ${r.reports?.length ?? 0} reports. Served/injected status does not establish behavior.`;
}
