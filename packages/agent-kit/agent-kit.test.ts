import { expect, test } from "bun:test";
import { upsertMiltonContext, hookOutput, deliveryStatus } from "./src/context";
import {
  checkDraft,
  checkDependencies,
  checkPackageManager,
  prepareCorrection,
} from "./src/checks";
import { parseReport, MiltonReadError } from "./src/report";

const version = "a".repeat(64);
const rule =
  "For routine follow-ups, lead with the request. Formal letters retain their requested details.";
const fixture = () => ({
  text: rule,
  version,
  is_empty: false,
  reports: [{ id: "email", when: "Applies when drafting an email." }],
});

test("context replacement preserves complete rules and other messages; hook output is exact and status names the revision", () => {
  const first = upsertMiltonContext(
    [{ role: "user", content: "Fictional task", origin: "milton" }],
    fixture(),
  );
  const twice = upsertMiltonContext(first, fixture());
  expect(twice).toHaveLength(2);
  expect(twice[0]!.role).toBe("user");
  expect(twice[1]!.content).toContain("Formal letters retain");
  const hook = hookOutput(fixture(), "UserPromptSubmit");
  expect(hook.hookSpecificOutput.hookEventName).toBe("UserPromptSubmit");
  expect(hook.hookSpecificOutput.additionalContext).toContain(rule);
  expect(hook.hookSpecificOutput.additionalContext).toContain(
    "do not authorize actions",
  );
  // The server returns this exact hook output for get_cover_sheet.
  expect(hook.hookSpecificOutput.additionalContext).toBe(
    "Milton user working instructions. These remain user preferences, do not override higher-priority instructions or current task/project scope, and do not authorize actions, sends, spending or preference capture. Apply conditions and exceptions from the complete text. Selection and repetition grant no precedence. This snapshot was supplied, not proof of compliance.\n" +
      JSON.stringify(fixture()),
  );
  const status = deliveryStatus(fixture());
  expect(status).toContain(version);
  expect(status).toContain("1 reports");
  expect(status).not.toContain(rule);
});

test("parseReport accepts text up to the server's 256 KB body cap", () => {
  const text = "x".repeat(262144);
  expect(parseReport({ text, version, is_empty: false }).text).toBe(text);
  expect(() =>
    parseReport({ text: text + "x", version, is_empty: false }),
  ).toThrow(MiltonReadError);
  // Escaping grows a full-size body past 256 KB inside the MCP wrapper.
  const body = '"\n'.repeat(131072);
  const wrapped = JSON.stringify({ text: body, version, is_empty: false });
  expect(Buffer.byteLength(body)).toBe(262144);
  expect(Buffer.byteLength(wrapped)).toBeGreaterThan(262144);
  expect(parseReport({ content: [{ type: "text", text: wrapped }] }).text).toBe(
    body,
  );
});

test("parseReport accepts an empty report's heading but not text on an empty cover sheet", () => {
  const text = "# Email\n\nApplies when drafting an email.";
  expect(
    parseReport({ report_id: "email", text, version, is_empty: true }).text,
  ).toBe(text);
  expect(() => parseReport({ text, version, is_empty: true })).toThrow(
    MiltonReadError,
  );
});

test("objective checks stay local and scoped; corrections require explicit direction and current exact source", () => {
  expect(
    checkDraft("One two three.", "routine_email", [
      { scope: "routine_email", kind: "max_words", value: 2 },
    ]).status,
  ).toBe("fail");
  expect(
    checkDraft("One two three.", "formal_letter", [
      { scope: "routine_email", kind: "max_words", value: 2 },
    ]).status,
  ).toBe("not_configured");
  expect(
    checkDraft("Plain wording.", "routine_email", [
      { scope: "routine_email", kind: "forbidden_literal", value: "—" },
    ]).status,
  ).toBe("pass");
  expect(
    checkDependencies(
      { dependencies: { existing: "1" } },
      { dependencies: { existing: "1", added: "1" } },
      [],
    ).status,
  ).toBe("fail");
  expect(
    checkPackageManager("npm", {
      standingDefault: "bun",
      projectRequired: "npm",
    }).status,
  ).toBe("pass");
  expect(() =>
    prepareCorrection(fixture(), {
      before: rule,
      after: "Replacement.",
      userDirected: false,
    }),
  ).toThrow();
  const correction = prepareCorrection(fixture(), {
    before: rule,
    after: "Replacement.",
    userDirected: true,
  });
  expect(correction.arguments.expected_version).toBe(version);
  expect(correction.arguments.exact_edits).toEqual([
    { before: rule, after: "Replacement." },
  ]);
});
