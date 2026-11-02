import { sql, type SQL } from "drizzle-orm";
import { expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { checkMcp } from "../scripts/check-mcp";
import { loadMemos } from "../src/memos";
import {
  createMiltonServer,
  storeInstructions,
  type ToolCall,
} from "../src/mcp";
import { saveMemoInput } from "../src/store/compiled";
import { createMiltonHandler } from "../src/handler";
import { createAccessTokenVerifier } from "../src/token";
import { deleteAccount, resolveIdentityAccount } from "../src/store";
import { localStore } from "./local-store";
import { z } from "zod";
import { createMcpApp } from "../src/index";
import { mcpRuntimeConfig } from "../src/config";

test("standalone MCP needs no browser secret and refuses noncanonical hosts", async () => {
  const config = mcpRuntimeConfig({
    APP_ORIGIN: "https://app.example",
    MCP_RESOURCE: "https://mcp.example/mcp",
    NEON_AUTH_BASE_URL: "https://auth.example/auth",
    NODE_ENV: "production",
    // Retired feature flags are ignored, never validated.
    MILTON_TASK_RETRIEVAL_ENABLED: "yes",
    MILTON_GARDENING_ENABLED: "yes",
    MILTON_DERIVATIONS_ENABLED: "yes",
  });
  const app = createMcpApp(config);
  const request = (host: string, path: string) =>
    app(new Request(`https://${host}${path}`, { headers: { Host: host } }));
  expect((await request("mcp.example", "/health")).status).toBe(200);
  expect(
    (await request("mcp.example", "/.well-known/oauth-protected-resource"))
      .status,
  ).toBe(200);
  expect((await request("mcp.example", "/login")).headers.get("location")).toBe(
    "https://app.example/login",
  );
  for (const host of ["app.example", "revision.run.app"])
    expect((await request(host, "/mcp")).status).toBe(403);
});

const issuer = "https://auth.example/milton/auth";
const origin = "http://localhost:3001";
const resource = origin + "/mcp";
async function tokenFixture(target = resource) {
  const key = await generateKeyPair("EdDSA");
  const jwk = {
    ...(await exportJWK(key.publicKey)),
    kid: "fixture",
    alg: "EdDSA",
  };
  return {
    verify: createAccessTokenVerifier({ issuer, resource: target }, async () =>
      Response.json({ keys: [jwk] }),
    ),
    token: (subject: string, clientId = "verified-client") =>
      new SignJWT({
        sub: subject,
        client_id: clientId,
        scope: "openid",
      })
        .setProtectedHeader({ alg: "EdDSA", kid: "fixture" })
        .setIssuer(issuer)
        .setAudience(target)
        .setExpirationTime("1h")
        .sign(key.privateKey),
  };
}

test("server instructions fit within Claude Code's 4,096-character limit", () => {
  // Claude Code truncates MCP server instructions at 4,096 characters.
  expect(storeInstructions.length).toBeLessThanOrEqual(4096);
});

test("an SDK client receives instructions, discovers the four tools, and reads the cover sheet", async () => {
  const calls: string[] = [];
  const server = createMiltonServer(
    await loadMemos(new URL("../../templates/", import.meta.url)),
    () => "sdk-test",
    (call) => calls.push(call.tool),
  );
  const client = new Client({ name: "sdk-test", version: "0.0.0" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    expect(await checkMcp(client)).toContain("exactly four");
    expect(calls).toEqual(["get_cover_sheet"]);
    const tools = (await client.listTools()).tools;
    const guidance = [
      client.getInstructions(),
      tools.find((tool) => tool.name === "get_cover_sheet")?.description,
    ];
    for (const text of guidance) {
      expect(text).toContain('"Did you get the memo?"');
      expect(text).toContain('"Did you get that memo?"');
      expect(text).toContain("even if you already read it");
      expect(text).toContain("conditions and exceptions");
      expect(text).toContain("Confirm receipt only after a successful read");
      expect(text).toContain(
        "Quoting or discussing the phrase is not an invocation",
      );
      expect(text).toContain("does not authorize saving or session capture");
    }
  } finally {
    await client.close();
    await server.close();
  }
});

test("two authenticated clients isolate tenants, save once and reject retired tools", async () => {
  const local = await localStore();
  const clients: Client[] = [];
  try {
    await local.db.query(sql`UPDATE store_config SET signup_mode='open'`);
    for (const subject of ["alpha", "beta"])
      await resolveIdentityAccount(local.env, { provider: "neon", subject });
    const fixture = await tokenFixture();
    const handler = createMiltonHandler(
      {
        ...local.env,
        issuer,
        resource,
        appOrigin: origin,
      },
      fixture.verify,
    );
    for (const subject of ["alpha", "beta"]) {
      const client = new Client({ name: "claimed-client", version: "0.0.0" });
      clients.push(client);
      await client.connect(
        new StreamableHTTPClientTransport(new URL(resource), {
          fetch: (input, init) => {
            const request = new Request(input, init);
            request.headers.set("Host", new URL(request.url).host);
            request.headers.set("X-Milton-User-Id", "another-account");
            return handler(request);
          },
          requestInit: {
            headers: {
              Authorization: `Bearer ${await fixture.token(subject)}`,
            },
          },
        }),
      );
    }
    const call = async (
      i: number,
      name: string,
      args: Record<string, unknown> = {},
    ) => {
      const reply = await clients[i]!.callTool({ name, arguments: args });
      const content = z
        .object({
          content: z.array(
            z.object({ type: z.literal("text"), text: z.string() }),
          ),
        })
        .parse(reply);
      return {
        value: z
          .record(z.string(), z.unknown())
          .parse(JSON.parse(content.content[0]!.text)),
        isError: reply.isError,
      };
    };
    const discovered = (await clients[0]!.listTools()).tools;
    expect(
      discovered.find((t) => t.name === "get_cover_sheet")?.annotations,
    ).toMatchObject({
      readOnlyHint: true,
      idempotentHint: false,
      openWorldHint: true,
    });
    expect(discovered.map((t) => t.name).sort()).toEqual([
      "create_memo",
      "get_cover_sheet",
      "get_report",
      "list_reports",
    ]);
    expect(
      discovered.find((t) => t.name === "create_memo")?.annotations
        ?.idempotentHint,
    ).toBe(true);
    const instructions = clients[0]!.getInstructions();
    expect(instructions).not.toContain("update_memo");
    for (const phrase of [
      "instructions",
      "unchanged confirms no write",
      "Session capture is off by default",
      "current conversation only",
      "Stop capture immediately",
      // Step 3 of the product note: offer a sample on approval, a rule on repetition.
      "Save this as a sample?",
      "same correction twice",
    ])
      expect(instructions).toContain(phrase);
    expect(
      discovered.find((t) => t.name === "create_memo")?.description,
    ).toContain("explicitly opted into session capture");
    expect(
      discovered.find((t) => t.name === "create_memo")?.description,
    ).toContain("approves a sample you offered");
    const first = (await call(0, "get_cover_sheet")).value;
    const second = (await call(1, "get_cover_sheet")).value;
    expect(first.text).toBe("");
    expect(second.text).toBe("");
    // An empty account carries the first-setup script; it leaves after the first save.
    expect(first.is_empty).toBe(true);
    expect(String(first.setup)).toContain("Which sign-off is yours?");
    // The scripted sample names only fields that form a valid sample.
    const scripted = /sample \{ ([^}]*) \}/.exec(String(first.setup))![1]!;
    const fields = [...scripted.matchAll(/(\w+):/g)].map((m) => m[1]!);
    expect(fields).toEqual(["report", "new_kind", "context", "text"]);
    expect(
      saveMemoInput.shape.sample.safeParse(
        Object.fromEntries(
          fields.map((f) => [f, f === "report" ? "email" : "Fictional value"]),
        ),
      ).success,
    ).toBe(true);
    // So does the scripted rules entry, under each report the script names.
    const ruleShape = /rules \[\{ ([^}]*) \}\]/.exec(String(first.setup))![1]!;
    expect(ruleShape.split(", ")).toEqual(["report", "text"]);
    for (const report of [
      "cover",
      "email",
      "chat",
      "post",
      "document",
      "speech",
    ]) {
      expect(String(first.setup)).toContain(report);
      expect(
        saveMemoInput.shape.rules.safeParse([
          { report, text: "Fictional value" },
        ]).success,
      ).toBe(true);
    }
    const input = {
      text: "Lead with the answer.",
      rules: [{ report: "cover", text: "Lead with the answer." }],
      request_id: crypto.randomUUID(),
      expected_version: first.version,
    };
    const saved = await call(0, "create_memo", input);
    expect(saved.value.status).toBe("saved");
    expect(await call(0, "create_memo", input)).toEqual(saved);
    const filed = (await call(0, "get_cover_sheet")).value;
    expect(filed.text).toBe(input.text);
    expect(filed.setup).toBeUndefined();
    const lifecycle = await call(0, "get_cover_sheet", {
      hook_event: "UserPromptSubmit",
    });
    expect(lifecycle.isError).not.toBe(true);
    expect(lifecycle.value.hookSpecificOutput).toMatchObject({
      hookEventName: "UserPromptSubmit",
    });
    expect(JSON.stringify(lifecycle.value.hookSpecificOutput)).toContain(
      input.text,
    );
    // The index rides along with the cover sheet, so hooks deliver it too.
    expect(JSON.stringify(lifecycle.value.hookSpecificOutput)).toContain(
      "drafting an email I'll send",
    );
    // Reports read by id (doc is an alias); an empty one is a heading and a when line.
    const document = (await call(0, "get_report", { report_id: "doc" })).value;
    expect(document).toMatchObject({
      report_id: "document",
      is_empty: true,
      version: saved.value.version,
    });
    expect(document.text).toStartWith("# Document\n\nApplies when ");
    const listed = (await call(0, "list_reports")).value as {
      reports: { report_id: string }[];
    };
    expect(listed.reports.map((r) => r.report_id)).toEqual([
      "email",
      "chat",
      "post",
      "document",
      "speech",
    ]);
    expect(
      (
        await clients[0]!.callTool({
          name: "get_report",
          arguments: { report_id: "memo" },
        })
      ).isError,
    ).toBe(true);
    expect((await call(1, "get_cover_sheet")).value.text).toBe("");
    expect(
      (
        await call(1, "create_memo", {
          ...input,
          request_id: crypto.randomUUID(),
        })
      ).value.status,
    ).toBe("conflict");
    for (const name of [
      "list_memos",
      "get_memo",
      "search",
      "update_memo",
      "archive_memo",
      "update_tps_report",
      "tps_check",
      "check_draft",
    ]) {
      const refusal = await clients[0]!
        .callTool({ name, arguments: {} })
        .catch(() => ({ isError: true }));
      expect(refusal.isError).toBe(true);
    }
    expect(
      (await call(0, "create_memo", { ...input, text: "different" })).value
        .error,
    ).toBe("request_id_reused");
    const exact = {
      text: "Use conclusion instead of answer.",
      request_id: crypto.randomUUID(),
      expected_version: (await call(0, "get_cover_sheet")).value.version,
      exact_edits: [{ before: "the answer", after: "the conclusion" }],
    };
    const exactResult = await call(0, "create_memo", exact);
    expect(exactResult.value.status).toBe("saved");
    expect(await call(0, "create_memo", exact)).toEqual(exactResult);
    expect((await call(0, "get_cover_sheet")).value.text).toBe(
      "Lead with the conclusion.",
    );
    expect((await call(1, "get_cover_sheet")).value.text).toBe("");
    const rejected = await handler(
      new Request(resource, {
        method: "POST",
        headers: {
          Host: "localhost:3001",
          Authorization: "Bearer legacy-worker-token",
          "Content-Type": "application/json",
        },
        body: "{}",
      }),
    );
    expect(rejected.status).toBe(401);
    await local.db.query(
      sql`UPDATE store_config SET limits_json=limits_json || '{"daily_calls":1}'::jsonb`,
    );
    expect((await call(0, "get_cover_sheet")).value.error).toBe("rate_limited");
  } finally {
    await Promise.all(clients.map((c) => c.close()));
    await local.dispose();
  }
}, 30000);

test("disconnected assistants and assistants of a deleted account are refused, even after re-signup; others keep working", async () => {
  const local = await localStore();
  try {
    await local.db.query(sql`UPDATE store_config SET signup_mode='open'`);
    for (const subject of ["alpha", "beta"])
      await resolveIdentityAccount(local.env, { provider: "neon", subject });
    const fixture = await tokenFixture();
    const handler = createMiltonHandler(
      {
        ...local.env,
        issuer,
        resource,
        appOrigin: origin,
      },
      fixture.verify,
    );
    const tokens = {
      alphaC: await fixture.token("alpha", "client-c"),
      alphaD: await fixture.token("alpha", "client-d"),
      betaC: await fixture.token("beta", "client-c"),
    };
    const rpc = (token: string, name: string, args = {}) =>
      handler(
        new Request(resource, {
          method: "POST",
          headers: {
            Host: "localhost:3001",
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
            Accept: "application/json, text/event-stream",
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "tools/call",
            params: { name, arguments: args },
          }),
        }),
      );
    const cover = await rpc(tokens.alphaC, "get_cover_sheet");
    expect(cover.status).toBe(200);
    const version = /\\"version\\":\\"([^"\\]+)\\"/.exec(
      await cover.text(),
    )![1]!;
    const save = {
      text: "Lead with the answer.",
      rules: [{ report: "cover", text: "Lead with the answer." }],
      request_id: crypto.randomUUID(),
      expected_version: version,
    };
    const saved = await rpc(tokens.alphaC, "create_memo", save);
    expect(saved.status).toBe(200);
    expect(await saved.text()).toContain("saved");
    await local.db.query(
      sql`INSERT INTO assistant_disconnects (provider,subject,client_id) VALUES ('neon','alpha','client-c')`,
    );
    for (const [name, args] of [
      ["get_cover_sheet", {}],
      ["create_memo", save],
    ] as const) {
      const refused = await rpc(tokens.alphaC, name, args);
      expect(refused.status).toBe(401);
      expect(refused.headers.get("WWW-Authenticate")).toContain(
        'error="invalid_token"',
      );
      expect(await refused.json()).toEqual({
        error: "invalid_token",
        message:
          "This assistant was disconnected from Milton. Reconnect it from your assistant.",
      });
    }
    expect((await rpc(tokens.alphaD, "get_cover_sheet")).status).toBe(200);
    expect((await rpc(tokens.betaC, "get_cover_sheet")).status).toBe(200);
    // Deleting alpha's account disconnects its consented client D; a client
    // that never had consent finds no account until alpha signs up again.
    const alphaE = await fixture.token("alpha", "client-e");
    await deleteAccount(local.env, { provider: "neon", subject: "alpha" }, [
      "client-d",
    ]);
    const status = async (token: string) => {
      const response = await rpc(token, "get_cover_sheet");
      return [
        response.status,
        ((await response.json()) as { error: string }).error,
      ];
    };
    expect(await status(tokens.alphaD)).toEqual([401, "invalid_token"]);
    expect(await status(alphaE)).toEqual([403, "account_unavailable"]);
    await resolveIdentityAccount(local.env, {
      provider: "neon",
      subject: "alpha",
    });
    expect(await status(tokens.alphaD)).toEqual([401, "invalid_token"]);
    expect(await status(tokens.alphaC)).toEqual([401, "invalid_token"]);
    expect((await rpc(alphaE, "get_cover_sheet")).status).toBe(200);
    expect((await rpc(tokens.betaC, "get_cover_sheet")).status).toBe(200);
  } finally {
    await local.dispose();
  }
}, 30000);

test("MCP refuses unsafe transports and oversized bodies before database access", async () => {
  const resource = "https://mcp.meetmilton.com/mcp";
  let queries = 0;
  const local = await localStore();
  try {
    const db = new Proxy(local.db, {
      get(target, key) {
        if (key === "query")
          return (statement: SQL) => {
            queries++;
            return target.query(statement);
          };
        return Reflect.get(target, key);
      },
    });
    const fixture = await tokenFixture(resource);
    const handler = createMiltonHandler(
      {
        storeDatabase: db,
        issuer,
        resource,
        appOrigin: "https://mcp.meetmilton.com",
      },
      fixture.verify,
    );
    for (const [method, host, origin, expected] of [
      ["GET", "mcp.meetmilton.com", "https://claude.ai", 405],
      ["DELETE", "mcp.meetmilton.com", "https://claude.ai", 405],
      ["POST", "untrusted.example", "https://claude.ai", 403],
      ["POST", "localhost:3001", "https://claude.ai", 403],
      ["POST", "mcp.meetmilton.com", "https://untrusted.example", 403],
      ["OPTIONS", "mcp.meetmilton.com", "https://claude.ai", 200],
      ["POST", "mcp.meetmilton.com", "https://chatgpt.com", 401],
    ] as const) {
      const reply = await handler(
        new Request(resource, {
          method,
          headers: {
            Host: host,
            Origin: origin,
            "Content-Type": "application/json",
          },
          ...(method === "POST" ? { body: "{}" } : {}),
        }),
      );
      expect(reply.status).toBe(expected);
      expect(reply.headers.get("Access-Control-Expose-Headers")).toContain(
        "WWW-Authenticate",
      );
      expect(queries).toBe(0);
      if (expected === 401) {
        expect(reply.headers.get("WWW-Authenticate")).toContain(
          "resource_metadata=",
        );
        expect(reply.headers.get("WWW-Authenticate")).not.toContain("scope=");
      }
    }
    const oversized = await handler(
      new Request(resource, {
        method: "POST",
        headers: { Host: "mcp.meetmilton.com" },
        body: new ReadableStream({
          start(c) {
            c.enqueue(new Uint8Array(65537));
            c.close();
          },
        }),
      }),
    );
    expect(oversized.status).toBe(413);
    expect(queries).toBe(0);
  } finally {
    await local.dispose();
  }
}, 30000);

test("one code constant bounds requests: limits_json.request_bytes refuses nothing, and an oversized body is refused once", async () => {
  const local = await localStore();
  const logged: ToolCall[] = [];
  let client: Client | undefined;
  try {
    // A lowered stored value must not refuse a body within the code bound.
    await local.db.query(
      sql`UPDATE store_config SET signup_mode='open', limits_json = limits_json || '{"request_bytes":256}'::jsonb`,
    );
    await resolveIdentityAccount(local.env, {
      provider: "neon",
      subject: "bound",
    });
    const fixture = await tokenFixture();
    const authorization = `Bearer ${await fixture.token("bound")}`;
    const handler = createMiltonHandler(
      { ...local.env, issuer, resource, appOrigin: origin },
      fixture.verify,
      (call) => logged.push(call),
    );
    client = new Client({ name: "bound-client", version: "0.0.0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(resource), {
        fetch: (input, init) => {
          const request = new Request(input, init);
          request.headers.set("Host", new URL(request.url).host);
          return handler(request);
        },
        requestInit: { headers: { Authorization: authorization } },
      }),
    );
    const text = (reply: unknown) =>
      z
        .record(z.string(), z.unknown())
        .parse(
          JSON.parse(
            z
              .object({ content: z.array(z.object({ text: z.string() })) })
              .parse(reply).content[0]!.text,
          ),
        );
    const sheet = text(
      await client.callTool({ name: "get_cover_sheet", arguments: {} }),
    );
    const rule = "Keep every sentence short and plain. ".repeat(30).trim();
    const saved = await client.callTool({
      name: "create_memo",
      arguments: {
        text: "Bound check",
        request_id: crypto.randomUUID(),
        expected_version: sheet.version,
        rules: [{ report: "email", text: rule }],
      },
    });
    expect(saved.isError).not.toBe(true);
    expect(text(saved).status).toBe("saved");

    // Over the bound, the stream is refused once, before parsing, auth or a tool event.
    logged.length = 0;
    const oversized = await handler(
      new Request(resource, {
        method: "POST",
        headers: {
          Host: new URL(resource).host,
          Authorization: authorization,
          "Content-Type": "application/json",
        },
        body: new ReadableStream({
          start(c) {
            c.enqueue(new TextEncoder().encode('{"method":"tools/call",'));
            c.enqueue(new Uint8Array(65536).fill(32));
            c.close();
          },
        }),
      }),
    );
    expect(oversized.status).toBe(413);
    expect(await oversized.json()).toEqual({ error: "request_too_large" });
    expect(logged).toEqual([]);
  } finally {
    await client?.close();
    await local.dispose();
  }
}, 30000);

test("tool dispatch logs bounded final outcomes, invalid arguments, and unknown tools exactly once", async () => {
  const calls: unknown[] = [];
  const server = createMiltonServer(
    await loadMemos(new URL("../../templates/", import.meta.url)),
    () => "registered-client",
    (call) => calls.push(call),
  );
  const client = new Client({ name: "claimed-client", version: "0.0.0" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    await client.callTool({ name: "get_cover_sheet", arguments: {} });
    const invalid = await client.callTool({
      name: "create_memo",
      arguments: { text: 1 },
    });
    expect(invalid.isError).toBe(true);
    await client
      .callTool({ name: "unknown-tool", arguments: { private: "not logged" } })
      .catch(() => {});
    expect(calls).toEqual([
      {
        tool: "get_cover_sheet",
        outcome: "read",
        memo_update: "none",
        elapsed_ms: expect.any(Number),
      },
      {
        tool: "create_memo",
        outcome: "refused",
        error_code: "invalid_arguments",
        memo_update: "none",
        elapsed_ms: expect.any(Number),
      },
      {
        tool: "unknown",
        outcome: "refused",
        error_code: "unknown_tool",
        memo_update: "none",
        elapsed_ms: expect.any(Number),
      },
    ]);
  } finally {
    await client.close();
    await server.close();
  }
});

test("final outcomes include early refusal/read failure and advisory/logging failures cannot reverse a save", async () => {
  const { StoreError, lookupIdentityAccount, storeForCurrentRequest } =
    await import("../src/store");
  const local = await localStore(),
    events: import("../src/mcp").ToolCall[] = [];
  let server: ReturnType<typeof createMiltonServer> | undefined,
    client: Client | undefined;
  try {
    await local.pg.exec(
      "UPDATE store_config SET signup_mode='open',global_spend_policy='alerts_only',foreground_accounting_ready=true,memo_updates_enabled=true,memo_updates_daily_limit=2",
    );
    await resolveIdentityAccount(local.env, {
      provider: "neon",
      subject: "outcome-fixture",
    });
    const auth = await lookupIdentityAccount(local.env, {
      provider: "neon",
      subject: "outcome-fixture",
    });
    const store = await storeForCurrentRequest(local.env, auth, {
      issuer: "fixture",
      clientId: "private-client-must-not-appear",
    });
    const rules = [{ report: "cover", text: "Fictional instruction." }];
    const version = (await store.readTpsReport()).version,
      originalRead = store.readTpsReport.bind(store);
    let refuse = true,
      failRead = false,
      throwLog = false;
    store.chargeToolCall = async () =>
      refuse
        ? { allowed: false, retry_at_ms: Date.now() + 1000, limit: "day" }
        : { allowed: true };
    store.readTpsReport = async () => {
      if (failRead)
        throw new StoreError(
          "store_unavailable",
          "Fictional private error prose.",
        );
      return originalRead();
    };
    const originalDocuments = store.readDocuments.bind(store);
    store.readDocuments = async () => {
      if (failRead)
        throw new StoreError(
          "store_unavailable",
          "Fictional private error prose.",
        );
      return originalDocuments();
    };
    store.memoUpdates = async () => {
      throw new Error("Fictional balance failure");
    };
    server = createMiltonServer(
      [],
      () => "private-client-must-not-appear",
      (event) => {
        events.push(event);
        if (throwLog) throw new Error("Fictional logger failure");
      },
      store,
    );
    client = new Client({ name: "fixture", version: "1" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(b);
    await client.connect(a);
    expect(
      (await client.callTool({ name: "get_cover_sheet", arguments: {} }))
        .isError,
    ).toBe(true);
    refuse = false;
    failRead = true;
    expect(
      (await client.callTool({ name: "get_cover_sheet", arguments: {} }))
        .isError,
    ).toBe(true);
    failRead = false;
    const saved = await client.callTool({
      name: "create_memo",
      arguments: {
        text: "Fictional batch.",
        rules,
        request_id: crypto.randomUUID(),
        expected_version: version,
      },
    });
    const data = JSON.parse((saved.content as { text: string }[])[0]!.text);
    expect(data.status).toBe("saved");
    expect(data.memo_update.charged).toBe(1);
    expect(data.memo_updates).toBeUndefined();
    store.memoUpdates = () => new Promise(() => {});
    throwLog = true;
    const unchanged = await client.callTool({
      name: "create_memo",
      arguments: {
        text: "Already on file.",
        rules,
        request_id: crypto.randomUUID(),
        expected_version: (await originalRead()).version,
      },
    });
    expect(
      JSON.parse((unchanged.content as { text: string }[])[0]!.text).status,
    ).toBe("unchanged");
    expect(
      events.map((e) => [
        e.tool,
        e.outcome,
        e.error_code ?? null,
        e.memo_update,
      ]),
    ).toEqual([
      ["get_cover_sheet", "refused", "rate_limited", "none"],
      ["get_cover_sheet", "failed", "store_unavailable", "none"],
      ["create_memo", "saved", null, "charged"],
      ["create_memo", "unchanged", null, "released"],
    ]);
    expect(JSON.stringify(events)).not.toContain("private-client");
    expect(JSON.stringify(events)).not.toContain("Fictional");
    expect(events).toHaveLength(4);
    const fixture = await tokenFixture();
    const early: import("../src/mcp").ToolCall[] = [];
    const broken = {
      ...local.db,
      async query<Row extends Record<string, unknown>>(
        _q: SQL,
      ): Promise<Row[]> {
        throw new Error("Fictional early database failure");
      },
    };
    const handler = createMiltonHandler(
      {
        ...local.env,
        storeDatabase: broken,
        issuer,
        resource,
        appOrigin: origin,
      },
      fixture.verify,
      (event) => early.push(event),
    );
    const response = await handler(
      new Request(resource, {
        method: "POST",
        headers: {
          Host: "localhost:3001",
          Authorization: `Bearer ${await fixture.token("outcome-fixture")}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: "get_cover_sheet",
            arguments: { task: "Fictional private task." },
          },
        }),
      }),
    );
    expect(response.status).toBe(503);
    expect(early).toHaveLength(1);
    expect(early[0]).toMatchObject({
      tool: "get_cover_sheet",
      outcome: "failed",
      error_code: "store_unavailable",
    });
    expect(JSON.stringify(early)).not.toContain("Fictional");
  } finally {
    await client?.close();
    await server?.close();
    await local.dispose();
  }
});
