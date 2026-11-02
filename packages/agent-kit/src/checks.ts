import { randomUUID } from "node:crypto";
import { parseReport } from "./report";
export const scopes = [
  "general",
  "routine_email",
  "formal_letter",
  "slack_update",
  "coding",
] as const;
export type Scope = (typeof scopes)[number];
export type Constraint =
  | { scope: Scope; kind: "max_words" | "min_words"; value: number }
  | {
      scope: Scope;
      kind: "forbidden_literal" | "required_literal";
      value: string;
    };
type CheckResult = {
  status: "pass" | "fail" | "not_configured";
  checked: number;
  violations: string[];
};
export function checkDraft(
  text: string,
  scope: Scope,
  constraints: Constraint[],
): CheckResult {
  if (
    typeof text !== "string" ||
    !text.isWellFormed() ||
    Buffer.byteLength(text) > 262144 ||
    !scopes.includes(scope) ||
    !Array.isArray(constraints) ||
    constraints.length > 64
  )
    throw new Error("Invalid local check input.");
  const violations: string[] = [];
  let checked = 0;
  for (const c of constraints) {
    if (
      !c ||
      !scopes.includes(c.scope) ||
      ![
        "max_words",
        "min_words",
        "forbidden_literal",
        "required_literal",
      ].includes(c.kind)
    )
      throw new Error("Invalid local constraint.");
    if (c.kind === "max_words" || c.kind === "min_words") {
      if (!Number.isSafeInteger(c.value) || c.value < 0 || c.value > 100000)
        throw new Error("Invalid word limit.");
      if (c.scope !== "general" && c.scope !== scope) continue;
      checked++;
      const words = text.trim() ? text.trim().split(/\s+/u).length : 0;
      if (c.kind === "max_words" ? words > c.value : words < c.value)
        violations.push(c.kind);
    } else {
      if (
        typeof c.value !== "string" ||
        !c.value ||
        !c.value.isWellFormed() ||
        Buffer.byteLength(c.value) > 1024
      )
        throw new Error("Invalid literal constraint.");
      if (c.scope !== "general" && c.scope !== scope) continue;
      checked++;
      if (
        c.kind === "forbidden_literal"
          ? text.includes(c.value)
          : !text.includes(c.value)
      )
        violations.push(c.kind);
    }
  }
  return {
    status: !checked ? "not_configured" : violations.length ? "fail" : "pass",
    checked,
    violations,
  };
}
type Manifest = {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
};
export function checkDependencies(
  before: Manifest,
  after: Manifest,
  allowedAdditions?: string[],
): CheckResult {
  if (allowedAdditions === undefined)
    return { status: "not_configured", checked: 0, violations: [] };
  const names = (m: Manifest) =>
    new Set(
      [
        m.dependencies,
        m.devDependencies,
        m.optionalDependencies,
        m.peerDependencies,
      ].flatMap((x) => Object.keys(x ?? {})),
    );
  const prior = names(before);
  const additions = [...names(after)].filter(
    (n) => !prior.has(n) && !allowedAdditions.includes(n),
  );
  return {
    status: additions.length ? "fail" : "pass",
    checked: 1,
    violations: additions.map(() => "dependency_addition"),
  };
}
export function checkPackageManager(
  choice: string,
  policy: { standingDefault?: string; projectRequired?: string },
): CheckResult {
  const required = policy.projectRequired ?? policy.standingDefault;
  return {
    status: !required
      ? "not_configured"
      : choice === required
        ? "pass"
        : "fail",
    checked: required ? 1 : 0,
    violations: required && choice !== required ? ["package_manager"] : [],
  };
}
export function prepareCorrection(
  raw: unknown,
  edit: { before: string; after: string; userDirected: boolean },
) {
  const r = parseReport(raw);
  if (
    edit.userDirected !== true ||
    !edit.before ||
    !r.text.includes(edit.before) ||
    r.text.indexOf(edit.before) !== r.text.lastIndexOf(edit.before) ||
    !edit.after.isWellFormed() ||
    edit.after.includes("\0") ||
    Buffer.byteLength(edit.after) > 32768
  )
    throw new Error(
      "A correction needs explicit user direction and a unique current instruction anchor.",
    );
  return {
    tool: "create_memo" as const,
    arguments: {
      text: "Apply the user's explicit instruction correction.",
      request_id: randomUUID(),
      expected_version: r.version,
      exact_edits: [{ before: edit.before, after: edit.after }],
    },
  };
}
