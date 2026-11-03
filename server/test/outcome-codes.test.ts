import { expect, test } from "bun:test";
import { Glob } from "bun";
import { loggedErrorCodes } from "../src/mcp-outcomes";
import { triggerRefusals } from "../src/store/database";
import { localStore } from "./local-store";

const src = new URL("../src/", import.meta.url).pathname;

// Every code a save or read can return is either logged by name or mapped from
// the trigger that raises it; anything else would log as tool_error or surface
// as store_unavailable.
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
  // The trigger functions the migrations leave installed, as Postgres holds them.
  const local = await localStore();
  try {
    const messages = new Set<string>();
    for (const { definition } of (
      await local.pg.query<{ definition: string }>(
        "SELECT pg_get_functiondef(oid) AS definition FROM pg_proc WHERE pronamespace='public'::regnamespace",
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
