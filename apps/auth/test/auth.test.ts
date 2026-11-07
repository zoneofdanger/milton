import { describe, expect, test } from "bun:test";
import { validPassword } from "../src/password.ts";
import { readConfig } from "../src/config.ts";
describe("auth product boundaries", () => {
  test("native NFKC policy has predictable Unicode bounds without trimming", () => {
    expect(validPassword(" password with spaces ")).toBe(true);
    expect(validPassword("a".repeat(14))).toBe(false);
    expect(validPassword("a".repeat(129))).toBe(false);
    expect(validPassword("𝔄".repeat(128))).toBe(false);
    expect(validPassword("🔒🌲".repeat(64))).toBe(true);
    expect(validPassword("ｐａｓｓｗｏｒｄ123456789")).toBe(false);
    expect(validPassword("㍿".repeat(40))).toBe(false);
  });
  test("missing production capabilities fail startup without secret output", () => {
    expect(() => readConfig({})).toThrow("invalid_auth_configuration");
  });
  test("client metadata URLs need an https DNS host without credentials", async () => {
    const { metadataDocumentUrlAllowed: allowed } =
      await import("../src/provider.ts");
    expect(allowed("https://claude.ai/oauth/claude-code-client-metadata")).toBe(
      true,
    );
    expect(allowed("https://platform.muse.ai/oauth/client-metadata.json")).toBe(
      true,
    );
    for (const url of [
      "http://claude.ai/oauth/claude-code-client-metadata",
      "https://user:pass@claude.ai/oauth/claude-code-client-metadata",
      "https://claude.ai/oauth/claude-code-client-metadata#x",
      "https://8.8.8.8/oauth/client-metadata.json",
      "https://[2606:4700::1]/oauth/client-metadata.json",
      "https://localhost/oauth/client-metadata.json",
      "https://app.localhost./oauth/client-metadata.json",
      "not a url",
    ])
      expect(allowed(url)).toBe(false);
  });
});

test("canonical auth HTTP boundary rejects alternate host, missing Origin, and deferred mutations", async () => {
  const { guardRequest } = await import("../src/http.ts");
  expect(
    guardRequest(
      new Request("https://app.meetmilton.com/api/auth/sign-up/email", {
        method: "POST",
      }),
    )?.status,
  ).toBe(421);
  expect(
    guardRequest(
      new Request("https://auth.meetmilton.com/api/auth/sign-up/email", {
        method: "POST",
      }),
    )?.status,
  ).toBe(403);
  expect(
    guardRequest(
      new Request("https://auth.meetmilton.com/api/auth/change-email", {
        method: "POST",
        headers: { origin: "https://auth.meetmilton.com" },
      }),
    )?.status,
  ).toBe(403);
});

test("startup role check retries connection failures only, within its budget", async () => {
  const { retryStartupCheck } = await import("../src/roles.ts");
  let clock = 0;
  const sleeps: number[] = [];
  const logged: unknown[] = [];
  const options = {
    now: () => clock,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      clock += ms;
    },
    log: (fields: unknown) => logged.push(fields),
  };
  const timeout = new Error("Connection terminated due to connection timeout", {
    cause: new Error("Connection terminated unexpectedly"),
  });
  const failures: Error[] = [
    timeout,
    Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }),
    Object.assign(new Error("the database system is starting up"), {
      code: "57P03",
    }),
  ];
  let calls = 0;
  const ok = async () => {
    calls++;
    const failure = failures.shift();
    if (failure) throw failure;
    return "checked";
  };
  expect(await retryStartupCheck(ok, options)).toBe("checked");
  expect(calls).toBe(4);
  expect(sleeps).toEqual([500, 1000, 2000]);
  expect(logged).toEqual([
    { attempt: 1, delayMs: 500, class: "Error", code: "UNCLASSIFIED" },
    { attempt: 2, delayMs: 1000, class: "Error", code: "ECONNRESET" },
    { attempt: 3, delayMs: 2000, class: "Error", code: "57P03" },
  ]);

  for (const refusal of [
    new Error("unsafe_runtime_role"),
    Object.assign(new Error("permission denied"), { code: "42501" }),
  ]) {
    calls = 0;
    sleeps.length = 0;
    const refuse = async () => {
      calls++;
      throw refusal;
    };
    await expect(retryStartupCheck(refuse, options)).rejects.toBe(refusal);
    expect(calls).toBe(1);
    expect(sleeps).toEqual([]);
  }

  clock = 0;
  sleeps.length = 0;
  const down = Object.assign(new Error("connect ECONNREFUSED"), {
    code: "ECONNREFUSED",
  });
  await expect(
    retryStartupCheck(async () => {
      throw down;
    }, options),
  ).rejects.toBe(down);
  expect(sleeps).toEqual([500, 1000, 2000, 4000, 4000]);
});
