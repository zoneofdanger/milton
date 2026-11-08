import { expect, test } from "bun:test";
import { Glob } from "bun";
import {
  loggedErrorCodes,
  nextActions,
  nextSteps,
  withNext,
} from "../src/mcp-outcomes";
import { triggerRefusals } from "../src/store/database";
import { localStore } from "./local-store";

const src = new URL("../src/", import.meta.url).pathname;

// Every code an MCP error result or refusal can carry has its own next step in
// the one table, from the closed set, as one short line.
test("every MCP error code has its own next step from the closed set", async () => {
  const codes = new Set<string>([
    ...triggerRefusals.keys(),
    // Codes the MCP layer names itself: a stale version, the SDK's argument
    // refusals, and anything else unstructured.
    "version_conflict",
    "invalid_arguments",
    "unknown_tool",
    "tool_error",
  ]);
  for (const file of new Glob("**/*.{ts,tsx}").scanSync(src)) {
    const text = await Bun.file(src + file).text();
    const patterns = [
      /new StoreError\(\s*"([a-z_]+)"/g,
      /result\(\s*"failed",\s*\{\s*error:\s*"([a-z_]+)"/g,
    ];
    // The MCP request path: its auth refusals and literal error bodies.
    if (/^(mcp[-.]|handler\.|http\.|token\.|auth-authority\.)/.test(file))
      patterns.push(
        /AuthError\(\s*"([a-z_]+)"/g,
        /super\(\s*"([a-z_]+)"/g,
        /error: "([a-z_]+)"/g,
      );
    for (const pattern of patterns)
      for (const match of text.matchAll(pattern)) codes.add(match[1]!);
  }
  expect(codes.size).toBeGreaterThan(30);
  for (const code of [
    "insufficient_scope",
    "invalid_token",
    "rate_limited",
    "server_busy",
    "request_too_large",
    "subscription_required",
    "edit_conflict",
  ])
    expect(codes).toContain(code);
  expect([...codes].filter((code) => !Object.hasOwn(nextSteps, code))).toEqual(
    [],
  );
  for (const [code, next] of Object.entries(nextSteps)) {
    expect({ code, known: nextActions.includes(next.action) }).toEqual({
      code,
      known: true,
    });
    expect({ code, text: next.text }).toEqual({
      code,
      text: expect.stringMatching(/^[^\n]{20,160}$/),
    });
  }
  // A result carries its code and next; a conflict names its code; an unknown
  // code still gets a next step.
  expect(withNext({ error: "edit_conflict", message: "m" })).toEqual({
    error: "edit_conflict",
    message: "m",
    code: "edit_conflict",
    next: nextSteps.edit_conflict!,
  });
  expect(withNext({ status: "conflict", request_id: "r" })).toMatchObject({
    code: "version_conflict",
    next: { action: "reread" },
  });
  expect(withNext({ error: "never_seen" })).toMatchObject({
    code: "never_seen",
    next: nextSteps.tool_error!,
  });
});

// Safety-critical steps, stated independently of the table.
test("recovery steps that protect a save's identity or the person say so", () => {
  const unknown = nextSteps.save_outcome_unknown!;
  expect(unknown.action).toBe("retry");
  expect(unknown.text).toContain("exactly the same arguments and request_id");
  expect(unknown.text).not.toMatch(/new (request_id|request ID|UUID)/);
  const paused = nextSteps.subscription_required!;
  expect(paused.action).toBe("tell_user");
  expect(paused.text).toContain("don't retry");
  expect(paused.text).toContain("link once");
  // An unknown code, or an error with no code at all, retries at most once
  // with identical arguments and never changes a save's identity.
  for (const body of [{ error: "never_seen" }, {}]) {
    const { next } = withNext(body);
    expect(next.action).toBe("retry");
    expect(next.text).toContain("Retry once with exactly the same arguments");
    expect(next.text).toContain("a save keeps its request_id");
    expect(next.text).not.toMatch(/new request_id/);
  }
});

// Every StoreError code in src is logged by name or mapped from a trigger, and
// every installed trigger refusal is one or the other, so none surfaces as
// store_unavailable. A code that is only mapped still logs as tool_error.
test("every StoreError code and every live trigger refusal is logged or mapped", async () => {
  const known = (code: string) =>
    loggedErrorCodes.has(code) || triggerRefusals.has(code);
  const codes = new Set<string>();
  for (const file of new Glob("**/*.{ts,tsx}").scanSync(src)) {
    const text = await Bun.file(src + file).text();
    for (const pattern of [
      /new StoreError\(\s*"([a-z_]+)"/g,
      /result\(\s*"failed",\s*\{\s*error:\s*"([a-z_]+)"/g,
    ])
      for (const match of text.matchAll(pattern)) codes.add(match[1]!);
  }
  expect(codes.size).toBeGreaterThan(10);
  expect([...codes].filter((code) => !known(code))).toEqual([]);
  // The trigger functions the migrations leave installed, as Postgres holds them
  // (not the maintenance job's prune, which no request runs).
  const local = await localStore();
  try {
    const messages = new Set<string>();
    for (const { definition } of (
      await local.pg.query<{ definition: string }>(
        "SELECT pg_get_functiondef(oid) AS definition FROM pg_proc WHERE pronamespace='public'::regnamespace AND prorettype='trigger'::regtype",
      )
    ).rows)
      for (const match of definition.matchAll(/MESSAGE\s*=\s*'([a-z_]+)'/g))
        messages.add(match[1]!);
    expect(messages.size).toBeGreaterThan(10);
    expect([...messages].filter((code) => !known(code))).toEqual([]);
  } finally {
    await local.dispose();
  }
});
