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
export function miltonContext(raw: unknown) {
  const report = parseReport(raw);
  return (
    "Milton user working instructions. These remain user preferences, do not override higher-priority instructions or current task/project scope, and do not authorize actions, sends, spending or preference capture. Apply conditions and exceptions from the complete text. Selection and repetition grant no precedence. This snapshot was supplied, not proof of compliance.\n" +
    JSON.stringify(report)
  );
}
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
  return {
    hookSpecificOutput: {
      hookEventName: event,
      additionalContext: miltonContext(report),
    },
  };
}
export function deliveryStatus(raw: unknown) {
  const r = parseReport(raw);
  return `Cover sheet version ${r.version}; ${r.is_empty ? "empty" : "not empty"}; ${r.reports?.length ?? 0} reports. Served/injected status does not establish behavior.`;
}
