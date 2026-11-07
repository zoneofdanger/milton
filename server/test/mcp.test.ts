import { randomBytes } from "node:crypto";
import { sql, type SQL } from "drizzle-orm";
import { expect, setSystemTime, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { checkMcp, stubStore } from "../scripts/check-mcp";
import {
  createMiltonServer,
  storeInstructions,
  readOnlyInstructions,
  type ToolCall,
} from "../src/mcp";
import { createMiltonHandler, keyAttemptSource } from "../src/handler";
import { createAccessTokenVerifier } from "../src/token";
import {
  connectionKeysForAccount,
  lookupIdentityAccount,
  resolveIdentityAccount,
} from "../src/store";
import { localStore } from "./local-store";
import { z } from "zod";
import { createMcpApp } from "../src/index";
import { mcpRuntimeConfig } from "../src/config";

test("standalone MCP needs no browser secret and refuses noncanonical hosts", async () => {
  const config = mcpRuntimeConfig({
    APP_ORIGIN: "https://app.example",
    MCP_RESOURCE: "https://mcp.example/mcp",
    AUTH_ISSUER: "https://auth.example/auth",
    NODE_ENV: "production",
  });
  const app = createMcpApp(config);
  const request = (host: string, path: string) =>
    app(new Request(`https://${host}${path}`, { headers: { Host: host } }));
  expect((await request("mcp.example", "/health")).status).toBe(200);
  expect(
    (await request("mcp.example", "/.well-known/oauth-protected-resource"))
      .status,
  ).toBe(200);
  for (const host of ["app.example", "revision.run.app"])
    expect((await request(host, "/mcp")).status).toBe(403);
});

const issuer = "https://auth.example/milton/auth";
const origin = "http://localhost:3001";
const resource = origin + "/mcp";
async function tokenFixture(
  pg: Awaited<ReturnType<typeof localStore>>["pg"],
  target = resource,
) {
  await pg.exec(`CREATE SCHEMA IF NOT EXISTS milton_guard;
  CREATE TABLE IF NOT EXISTS milton_guard.fixture_binding(reference text PRIMARY KEY,subject text,client_id text,active boolean DEFAULT true);
  CREATE OR REPLACE FUNCTION milton_guard.binding_status(text,text,text,text[],text[]) RETURNS jsonb LANGUAGE SQL AS $$ SELECT jsonb_build_object('reference',reference,'miltonIdentityIncarnation','f:1','miltonSecurityGeneration','f:2') FROM milton_guard.fixture_binding WHERE reference=$1 AND subject=$2 AND client_id=$3 AND active $$;`);

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
    token: async (
      subject: string,
      clientId = "verified-client",
      scope = "openid milton:read milton:write",
    ) => {
      const binding = crypto.randomUUID();
      await pg.query(
        `INSERT INTO milton_guard.fixture_binding(reference,subject,client_id) VALUES($1,$2,$3)`,
        [binding, subject, clientId],
      );
      return new SignJWT({
        sub: subject,
        client_id: clientId,
        azp: clientId,
        scope,
        miltonBinding: binding,
        miltonIdentityIncarnation: "f:1",
        miltonSecurityGeneration: "f:2",
      })
        .setProtectedHeader({ alg: "EdDSA", kid: "fixture", typ: "at+jwt" })
        .setIssuer(issuer)
        .setAudience(target)
        .setExpirationTime("1h")
        .setIssuedAt()
        .setJti(crypto.randomUUID())
        .sign(key.privateKey);
    },
  };
}

test("server instructions fit within Claude Code's 4,096-character limit", () => {
  // Claude Code truncates MCP server instructions at 4,096 characters.
  expect(storeInstructions.length).toBeLessThanOrEqual(4096);
  expect(storeInstructions).toContain(
    "Setup: when get_cover_sheet is_empty, offer setup once.",
  );
});

test("an SDK client receives instructions, discovers the four tools, and reads the cover sheet", async () => {
  const calls: string[] = [];
  const server = createMiltonServer(stubStore(), (call) =>
    calls.push(call.tool),
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
    // Assistants see cover sheet and reports, never the retired TPS name.
    for (const served of [client.getInstructions(), ...tools])
      expect(JSON.stringify(served)).not.toMatch(/TPS|tps_report/);
    expect(
      tools.find((tool) => tool.name === "create_memo")?.description,
    ).toContain(
      "every approved sample stays, and a report read serves the eight that best fit its intent",
    );
    const save = tools.find((tool) => tool.name === "create_memo")!;
    expect(save.inputSchema.properties).toHaveProperty("sample_context");
    expect(save.description).toContain(
      "For EVERY approved sample save, display the exact text and useful non-private context together before one retention approval",
    );
    expect(save.description).toContain(
      "unchanged already-approved metadata needs no second approval",
    );
    expect(save.description).toContain("clearing omitted optional fields");
    expect(save.description).toContain(
      "Revisions preserve separate identities even if text matches another example",
    );
    expect(JSON.stringify(save.inputSchema.properties?.sample)).toContain(
      '"sample_id"',
    );
    expect(JSON.stringify(save.inputSchema.properties?.sample)).not.toContain(
      '"replaces"',
    );
    const read = tools.find((tool) => tool.name === "get_report")!;
    expect(read.description).toContain(
      "fill up to eight from broader examples",
    );
    expect(read.description).toContain(
      "kinds lists every personal kind with an active sample in this report as {kind_id, kind}, ordered by kind_id, independently of intent and the eight-sample selection",
    );
    expect(JSON.stringify(read.inputSchema.properties?.intent)).toContain(
      "get_report.kinds",
    );
    // The guide block carries its own precedence; descriptions do not repeat it.
    const list = tools.find((tool) => tool.name === "list_reports")!;
    for (const { description } of [read, list])
      expect(description).not.toMatch(/guide|Eligible opted-in/);
    expect(read.description).toEndWith(
      "do not guess at one. Reads make no model call or write.",
    );
    expect(list.description).toContain(
      "and version. For clients that want everything loaded after get_cover_sheet;",
    );
    const text = client.getInstructions();
    expect(text).toContain('"Did you get the memo?"');
    expect(text).toContain('"Did you get that memo?"');
    expect(text).toContain("even if you already read it");
    expect(text).toContain("conditions and exceptions");
    expect(text).toContain("Confirm receipt only after a successful read");
    expect(text).toContain(
      "Quoting or discussing the phrase is not an invocation",
    );
    expect(text).toContain("does not authorize saving or session capture");
    expect(
      tools.find((tool) => tool.name === "get_cover_sheet")?.description,
    ).toContain(
      "'Did you get the memo?' means reread the cover sheet and the matching reports: a read, never a save.",
    );
    // The memo cue and the correction rules are stated once across everything
    // served; tool and field descriptions point to the instructions.
    const served = JSON.stringify([client.getInstructions(), tools]);
    for (const once of [
      "even if you already read it",
      "Quoting or discussing the phrase is not an invocation",
      "before verbatim, occurring once, within one rule",
      "Edits cannot overlap",
    ])
      expect(served.split(once).length - 1).toBe(1);
  } finally {
    await client.close();
    await server.close();
  }
});

test("get_report requires an intent: without a well-formed one it refuses, saying what to send; with one the store ranks for it", async () => {
  const calls: ToolCall[] = [];
  const intents: unknown[] = [];
  const stub = stubStore();
  const server = createMiltonServer(
    {
      ...stub,
      readDocuments: (intent) => {
        intents.push(intent);
        return stub.readDocuments();
      },
    },
    (call) => calls.push(call),
  );
  const client = new Client({ name: "sdk-test", version: "0.0.0" });
  let changed = 0;
  client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
    changed++;
  });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const schema = (await client.listTools()).tools.find(
      (tool) => tool.name === "get_report",
    )!.inputSchema;
    expect(schema.required).toEqual(["report_id", "intent"]);
    const refused = async (args: Record<string, unknown>) => {
      const reply = await client.callTool({
        name: "get_report",
        arguments: args,
      });
      expect(reply.isError).toBe(true);
      const refusal = JSON.parse((reply.content as [{ text: string }])[0].text);
      expect(refusal.error).toBe("invalid_input");
      return String(refusal.message);
    };
    // A client holding the old schema sends no intent: say what to send and
    // to reconnect, and tell it the tool list changed.
    const missing = await refused({ report_id: "email" });
    expect(missing).toContain(
      "reconnect your assistant if it has no intent field",
    );
    expect(missing).toContain('"confirming what is on file"');
    expect(changed).toBe(1);
    // A malformed intent names the limit it broke, without the reconnect hint.
    for (const [intent, says] of [
      [
        { situation: " " },
        "situation must be one line of at most 200 characters",
      ],
      [
        { situation: "x".repeat(201) },
        "situation must be one line of at most 200 characters",
      ],
      [
        { situation: "a reply", audience: "investor" },
        "intent takes situation, optional kind_id and bounded context dimensions",
      ],
    ] as const) {
      const message = await refused({ report_id: "email", intent });
      expect(message).toBe(`get_report intent: ${says}. Nothing was read.`);
    }
    expect(intents).toEqual([]);
    expect(changed).toBe(1);
    expect(calls.map((c) => [c.outcome, c.error_code])).toEqual(
      Array(4).fill(["refused", "invalid_input"]),
    );
    const read = await client.callTool({
      name: "get_report",
      arguments: {
        report_id: "doc",
        intent: {
          situation: "declining a client's request for a discount",
          context: {
            audience: { relationship: "client" },
            purposes: ["decline"],
          },
        },
      },
    });
    expect(read.isError).toBeUndefined();
    expect(changed).toBe(1);
    expect(intents).toEqual([
      {
        report: "document",
        situation: "declining a client's request for a discount",
        context: {
          audience: { relationship: "client" },
          purposes: ["decline"],
        },
      },
    ]);
  } finally {
    await client.close();
    await server.close();
  }
});

test("two authenticated clients isolate tenants and save once", async () => {
  const local = await localStore();
  const clients: Client[] = [];
  try {
    for (const subject of ["alpha", "beta"])
      await resolveIdentityAccount(local.env, { provider: issuer, subject });
    const fixture = await tokenFixture(local.pg);
    const handler = createMiltonHandler(
      {
        ...local.env,
        issuer,
        resource,
        appOrigin: origin,
      },
      fixture.verify,
    );
    // tools/list_changed notifications each client received.
    const changed = [0, 0];
    for (const subject of ["alpha", "beta"]) {
      const client = new Client({ name: "claimed-client", version: "0.0.0" });
      const i = clients.length;
      client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
        changed[i]!++;
      });
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
    expect(
      discovered.find((t) => t.name === "create_memo")?.description,
    ).toContain("explicitly opted into session capture");
    expect(
      discovered.find((t) => t.name === "create_memo")?.description,
    ).toContain("approves a sample you offered");
    expect(
      discovered.find((t) => t.name === "create_memo")?.description,
    ).toContain("Change a rule only through exact_edits, never by adding one");
    // Connecting and listing tools announce nothing; each assistant's first
    // tool call after this process started does, and only that one.
    expect(changed).toEqual([0, 0]);
    const first = (await call(0, "get_cover_sheet")).value;
    const second = (await call(1, "get_cover_sheet")).value;
    expect(changed).toEqual([1, 1]);
    expect(first.text).toBe("");
    expect(second.text).toBe("");
    // An empty account carries the first-setup script; it leaves after the first save.
    expect(first.is_empty).toBe(true);
    expect(String(first.setup)).not.toContain("Baseline:");
    const input = {
      text: "Lead with the answer.",
      rules: [{ report: "cover", text: "Lead with the answer." }],
      request_id: crypto.randomUUID(),
      expected_version: first.version,
    };
    const saved = await call(0, "create_memo", input);
    expect(saved.value.status).toBe("saved");
    const filed = (await call(0, "get_cover_sheet")).value;
    expect(filed.text).toBe("- " + input.text);
    expect(filed.setup).toBeUndefined();
    // get_cover_sheet takes no arguments: any argument is refused.
    const stale = await clients[0]!.callTool({
      name: "get_cover_sheet",
      arguments: { event: "start" },
    });
    // The wording is the MCP SDK's; the refusal and the named key are ours to keep.
    expect(stale.isError).toBe(true);
    expect((stale.content as { text: string }[])[0]!.text).toContain('"event"');
    // Reports read by id (doc is an alias); an empty one is a heading and a when line.
    const document = (
      await call(0, "get_report", {
        report_id: "doc",
        intent: { situation: "confirming what is on file" },
      })
    ).value;
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
          arguments: {
            report_id: "memo",
            intent: { situation: "confirming what is on file" },
          },
        })
      ).isError,
    ).toBe(true);
    expect((await call(1, "get_cover_sheet")).value.text).toBe("");
    expect(changed).toEqual([1, 1]);
    // A get_report from a client holding the schema before intent is refused
    // and told again that the tool list changed.
    expect(
      (await call(0, "get_report", { report_id: "email" })).value.error,
    ).toBe("invalid_input");
    expect(changed).toEqual([2, 1]);
    expect(
      (
        await call(1, "create_memo", {
          ...input,
          request_id: crypto.randomUUID(),
        })
      ).value.status,
    ).toBe("conflict");
    await local.db.query(
      sql`UPDATE store_config SET limits_json=limits_json || '{"daily_calls":1}'::jsonb`,
    );
    expect((await call(0, "get_cover_sheet")).value.error).toBe("rate_limited");
  } finally {
    await Promise.all(clients.map((c) => c.close()));
    await local.dispose();
  }
}, 30000);

test("scopes control discovery and direct calls; original binding revocation survives reconnection and status outages stay 503", async () => {
  const local = await localStore();
  const clients: Client[] = [];
  try {
    await resolveIdentityAccount(local.env, {
      provider: issuer,
      subject: "alpha",
    });
    const fixture = await tokenFixture(local.pg);
    const handler = createMiltonHandler(
      { ...local.env, issuer, resource, appOrigin: origin },
      fixture.verify,
      () => {},
    );
    const readToken = await fixture.token(
      "alpha",
      "reader",
      "openid milton:read",
    );
    const connect = async (token: string) => {
      const client = new Client({ name: "scope-fixture", version: "0" });
      clients.push(client);
      await client.connect(
        new StreamableHTTPClientTransport(new URL(resource), {
          requestInit: {
            headers: {
              Authorization: "Bearer " + token,
              Host: "localhost:3001",
            },
          },
          fetch: (input, init) => handler(new Request(input, init)),
        }),
      );
      return client;
    };
    const reader = await connect(readToken);
    expect(reader.getInstructions()).toBe(readOnlyInstructions);
    expect(readOnlyInstructions.length).toBeLessThanOrEqual(4096);
    expect((await reader.listTools()).tools.map((t) => t.name)).toEqual([
      "get_cover_sheet",
      "get_report",
      "list_reports",
    ]);
    const cover = JSON.parse(
      (
        (await reader.callTool({ name: "get_cover_sheet", arguments: {} }))
          .content as { text: string }[]
      )[0]!.text,
    );
    expect(cover.setup).toBeUndefined();
    expect(cover.permission).toContain("Read only");
    await expect(
      reader.callTool({ name: "create_memo", arguments: {} }),
    ).rejects.toBeDefined();
    const writer = await connect(await fixture.token("alpha", "writer"));
    expect((await writer.listTools()).tools).toHaveLength(4);
    const request = (token: string) =>
      handler(
        new Request(resource, {
          method: "POST",
          headers: {
            Host: "localhost:3001",
            Authorization: "Bearer " + token,
            Accept: "application/json, text/event-stream",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
        }),
      );
    await local.pg.exec(
      `UPDATE milton_guard.fixture_binding SET active=false WHERE client_id='reader'`,
    );
    expect((await request(readToken)).status).toBe(401);
    expect(
      (await request(await fixture.token("alpha", "reader", "milton:read")))
        .status,
    ).toBe(200);
    expect((await request(readToken)).status).toBe(401);
    expect(
      (await request(await fixture.token("alpha", "identity-only", "openid")))
        .status,
    ).toBe(403);
    await local.pg.exec(
      `CREATE OR REPLACE FUNCTION milton_guard.binding_status(text,text,text,text[],text[]) RETURNS jsonb LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fictional status outage'; END $$`,
    );
    expect((await request(readToken)).status).toBe(503);
  } finally {
    await Promise.all(clients.map((c) => c.close()));
    await local.dispose();
  }
}, 30000);

test("a setup request makes one database round trip and a tool call four, by token or connection key", async () => {
  const local = await localStore();
  try {
    await resolveIdentityAccount(local.env, {
      provider: issuer,
      subject: "counted",
    });
    const auth = await lookupIdentityAccount(local.env, {
      provider: issuer,
      subject: "counted",
    });
    await local.pg.exec(`CREATE SCHEMA IF NOT EXISTS milton_guard;
      CREATE FUNCTION milton_guard.connection_key_status(text,text,text) RETURNS boolean
        LANGUAGE sql AS $$ SELECT true $$`);
    const { key } = await connectionKeysForAccount(local.env, auth, {
      issuer,
      subject: "counted",
      incarnation: "f:1",
      generation: "f:2",
    }).create({ name: "Counted", scope: "read_write", expiry: null });
    const fixture = await tokenFixture(local.pg);
    const token = await fixture.token("counted");
    // Each statement, BEGIN and COMMIT is one round trip.
    let trips = 0;
    const counted = {
      ...local.db,
      query: <Row extends Record<string, unknown>>(statement: SQL) => {
        trips++;
        return local.db.query<Row>(statement);
      },
      transaction: <T>(
        work: (tx: { query: typeof local.db.query }) => Promise<T>,
      ) => {
        trips += 2;
        return local.db.transaction((tx) =>
          work({
            query: (statement) => {
              trips++;
              return tx.query(statement);
            },
          }),
        );
      },
    };
    const handler = createMiltonHandler(
      { storeDatabase: counted, issuer, resource, appOrigin: origin },
      fixture.verify,
      () => {},
    );
    const trips_for = async (
      bearer: string,
      method: string,
      params?: unknown,
    ) => {
      trips = 0;
      const response = await handler(
        new Request(resource, {
          method: "POST",
          headers: {
            Host: "localhost:3001",
            Authorization: "Bearer " + bearer,
            Accept: "application/json, text/event-stream",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            ...(method.startsWith("notifications/") ? {} : { id: 1 }),
            method,
            ...(params ? { params } : {}),
          }),
        }),
      );
      const text = await response.text();
      expect(response.status).toBeLessThan(300);
      expect(text).not.toContain('"isError":true');
      return trips;
    };
    const cover = { name: "get_cover_sheet", arguments: {} };
    const initialize = {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "counted", version: "0" },
    };
    for (const bearer of [token, key]) {
      // The first call records the key's last use; later ones within a minute do not.
      await trips_for(bearer, "tools/call", cover);
      expect(await trips_for(bearer, "initialize", initialize)).toBe(1);
      expect(await trips_for(bearer, "notifications/initialized")).toBe(1);
      expect(await trips_for(bearer, "tools/list", {})).toBe(1);
      // Access, the trial gate, the charge and the snapshot.
      expect(await trips_for(bearer, "tools/call", cover)).toBe(4);
    }
  } finally {
    await local.dispose();
  }
}, 30000);

test("invalid store limits refuse a tool call without counting it", async () => {
  const local = await localStore();
  try {
    const { miltonUserId } = await resolveIdentityAccount(local.env, {
      provider: issuer,
      subject: "limited",
    });
    const fixture = await tokenFixture(local.pg);
    const token = await fixture.token("limited");
    const handler = createMiltonHandler(
      { ...local.env, issuer, resource, appOrigin: origin },
      fixture.verify,
      () => {},
    );
    const cover = async () =>
      (
        await handler(
          new Request(resource, {
            method: "POST",
            headers: {
              Host: "localhost:3001",
              Authorization: "Bearer " + token,
              Accept: "application/json, text/event-stream",
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              jsonrpc: "2.0",
              id: 1,
              method: "tools/call",
              params: { name: "get_cover_sheet", arguments: {} },
            }),
          }),
        )
      ).text();
    const used = async () =>
      (
        await local.db.query<{ n: number }>(
          sql`SELECT coalesce(sum(tool_calls),0)::int AS n FROM usage_daily WHERE user_id=${miltonUserId}`,
        )
      )[0]!.n;
    const valid = (
      await local.db.query<{ limits: unknown }>(
        sql`SELECT limits_json AS limits FROM store_config`,
      )
    )[0]!.limits;
    expect(await cover()).not.toContain('"isError":true');
    expect(await used()).toBe(1);
    for (const invalid of ['{"body_bytes":"large"}', '{"daily_calls":1.5}']) {
      await local.db.query(
        sql`UPDATE store_config SET limits_json=limits_json || ${invalid}::jsonb`,
      );
      expect(await cover()).toContain("configuration");
      expect(await used()).toBe(1);
      await local.db.query(
        sql`UPDATE store_config SET limits_json=${JSON.stringify(valid)}::jsonb`,
      );
    }
    expect(await cover()).not.toContain('"isError":true');
    expect(await used()).toBe(2);
  } finally {
    await local.dispose();
  }
}, 30000);

test("refused tool calls count nothing; a call is charged once its work starts", async () => {
  const local = await localStore();
  try {
    await local.db.query(sql`UPDATE store_config SET trials_enabled=true`);
    const { miltonUserId } = await resolveIdentityAccount(local.env, {
      provider: issuer,
      subject: "lapsed",
    });
    const fixture = await tokenFixture(local.pg);
    const token = await fixture.token("lapsed");
    const handler = createMiltonHandler(
      { ...local.env, issuer, resource, appOrigin: origin },
      fixture.verify,
      () => {},
    );
    const call = async (name: string, args: unknown) => {
      const reply = await handler(
        new Request(resource, {
          method: "POST",
          headers: {
            Host: "localhost:3001",
            Authorization: "Bearer " + token,
            Accept: "application/json, text/event-stream",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "tools/call",
            params: { name, arguments: args },
          }),
        }),
      );
      // The first call carries tools/list_changed, so it streams.
      const body = await reply.text();
      const result = JSON.parse(
        body.startsWith("{") ? body : body.split("data: ").at(-1)!,
      ).result;
      try {
        return JSON.parse(result.content[0].text);
      } catch {
        return { isError: result.isError };
      }
    };
    const used = async () =>
      (
        await local.db.query<{ n: number }>(
          sql`SELECT coalesce(sum(tool_calls),0)::int AS n FROM usage_daily WHERE user_id=${miltonUserId}`,
        )
      )[0]!.n;
    const version = (await call("get_cover_sheet", {})).version;
    expect(await used()).toBe(1);
    const save = {
      text: "Fictional rule.",
      rules: [{ report: "cover", text: "Keep fictional dates exact." }],
      request_id: crypto.randomUUID(),
      expected_version: version,
    };
    // The billing gate, for reads and saves.
    await local.db.query(
      sql`UPDATE trial_accounts SET subscription_status='canceled' WHERE user_id=${miltonUserId}`,
    );
    expect((await call("get_cover_sheet", {})).error).toBe(
      "subscription_required",
    );
    expect((await call("create_memo", save)).error).toBe(
      "subscription_required",
    );
    expect(await used()).toBe(1);
    await local.db.query(
      sql`UPDATE trial_accounts SET subscription_status='active' WHERE user_id=${miltonUserId}`,
    );
    // Input refusals: the SDK's schema check, a get_report without intent and
    // an unknown kind.
    expect((await call("get_cover_sheet", { event: "start" })).isError).toBe(
      true,
    );
    expect((await call("get_report", { report_id: "email" })).error).toBe(
      "invalid_input",
    );
    expect(
      (
        await call("get_report", {
          report_id: "email",
          intent: { situation: "confirming what is on file", kind_id: "none" },
        })
      ).error,
    ).toBe("invalid_kind");
    expect(await used()).toBe(1);
    // A save that ran is charged, whether it saved or met a stale version.
    expect((await call("create_memo", save)).status).toBe("saved");
    expect(await used()).toBe(2);
    expect(
      (
        await call("create_memo", {
          ...save,
          request_id: crypto.randomUUID(),
        })
      ).status,
    ).toBe("conflict");
    expect(await used()).toBe(3);
    // Over the allowance, calls stop; replaying a recorded save stays free.
    await local.db.query(
      sql`UPDATE store_config SET limits_json=limits_json || '{"daily_calls":3}'::jsonb`,
    );
    expect((await call("get_cover_sheet", {})).error).toBe("rate_limited");
    expect((await call("create_memo", save)).status).toBe("saved");
    expect(await used()).toBe(3);
  } finally {
    await local.dispose();
  }
}, 30000);

test("connection keys get exactly their scope's tools; revoked, expired, malformed and closed-account keys get the invalid-token 401; OAuth is unchanged", async () => {
  const local = await localStore();
  const clients: Client[] = [];
  try {
    await resolveIdentityAccount(local.env, {
      provider: issuer,
      subject: "keyed",
    });
    const auth = await lookupIdentityAccount(local.env, {
      provider: issuer,
      subject: "keyed",
    });
    // Unit stand-in for native 007; the real function runs in the PG18 rehearsal.
    await local.pg.exec(`CREATE SCHEMA IF NOT EXISTS milton_guard;
      CREATE FUNCTION milton_guard.connection_key_status(text,text,text) RETURNS boolean
        LANGUAGE sql AS $$ SELECT ($1,$2,$3)=('keyed','f:1','f:2') $$`);
    const keys = connectionKeysForAccount(local.env, auth, {
      issuer,
      subject: "keyed",
      incarnation: "f:1",
      generation: "f:2",
    });
    const reader = await keys.create({
      name: "Reader",
      scope: "read",
      expiry: 90,
    });
    const writer = await keys.create({
      name: "Writer",
      scope: "read_write",
      expiry: null,
    });
    const fixture = await tokenFixture(local.pg);
    const logs: ToolCall[] = [];
    const handler = createMiltonHandler(
      { ...local.env, issuer, resource, appOrigin: origin },
      fixture.verify,
      (call) => logs.push(call),
    );
    const connect = async (key: string) => {
      const client = new Client({ name: "key-fixture", version: "0" });
      clients.push(client);
      await client.connect(
        new StreamableHTTPClientTransport(new URL(resource), {
          requestInit: {
            headers: { Authorization: "Bearer " + key, Host: "localhost:3001" },
          },
          fetch: (input, init) => handler(new Request(input, init)),
        }),
      );
      return client;
    };
    const read = await connect(reader.key);
    expect(read.getInstructions()).toBe(readOnlyInstructions);
    expect((await read.listTools()).tools.map((t) => t.name)).toEqual([
      "get_cover_sheet",
      "get_report",
      "list_reports",
    ]);
    await read.callTool({ name: "get_cover_sheet", arguments: {} });
    const write = await connect(writer.key);
    expect(write.getInstructions()).toBe(storeInstructions);
    expect((await write.listTools()).tools).toHaveLength(4);
    const version = JSON.parse(
      (
        (await write.callTool({ name: "get_cover_sheet", arguments: {} }))
          .content as { text: string }[]
      )[0]!.text,
    ).version;
    const save = {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "create_memo",
        arguments: {
          text: "Add a fictional rule.",
          rules: [{ report: "cover", text: "Keep fictional notes short." }],
          expected_version: version,
          request_id: crypto.randomUUID(),
        },
      },
    };
    // Each request from its own source, so the per-source limit stays out of
    // the way of these validity checks.
    let sources = 0;
    const post = (authorization: string | null, body: unknown) =>
      handler(
        new Request(resource, {
          method: "POST",
          headers: {
            Host: "localhost:3001",
            ...(authorization ? { Authorization: authorization } : {}),
            Accept: "application/json, text/event-stream",
            "Content-Type": "application/json",
            "X-Forwarded-For": `198.51.100.${++sources}, 203.0.113.1`,
          },
          body: JSON.stringify(body),
        }),
      );
    // A direct save with a read key is refused before the tools run.
    const refusedSave = await post("Bearer " + reader.key, save);
    expect(refusedSave.status).toBe(403);
    expect((await refusedSave.json()).error).toBe("insufficient_scope");
    expect(await (await post("Bearer " + writer.key, save)).text()).toContain(
      '\\"status\\":\\"saved\\"',
    );
    const actors = await local.db.query<{ actor: string }>(
      sql`SELECT actor_json AS actor FROM instruction_card_versions`,
    );
    expect(actors.map((row) => JSON.parse(row.actor))).toEqual([
      {
        kind: "assistant",
        issuer: "connection_key",
        client_id: writer.record.id,
      },
    ]);
    // Logs name the key by its public id only.
    expect(logs.some((call) => call.connection_key === writer.record.id)).toBe(
      true,
    );
    expect(JSON.stringify(logs)).not.toContain(writer.key.slice(26));
    expect(JSON.stringify(logs)).not.toContain(reader.key.slice(26));
    // Every refusal answers exactly as an invalid OAuth token does.
    const list = { jsonrpc: "2.0", id: 2, method: "tools/list" };
    const shape = async (response: Response) => ({
      status: response.status,
      challenge: response.headers.get("WWW-Authenticate"),
      body: await response.json(),
    });
    const invalid = await shape(await post("Bearer not.a.token", list));
    expect(invalid.status).toBe(401);
    const expired = await keys.create({
      name: "Short",
      scope: "read",
      expiry: 30,
    });
    await local.pg.query(
      "UPDATE connection_keys SET created_at=now()-interval '31 days',expires_at=now()-interval '1 minute' WHERE id=$1",
      [expired.record.id],
    );
    const revoked = await keys.create({
      name: "Gone",
      scope: "read",
      expiry: 30,
    });
    await keys.revoke(revoked.record.id);
    for (const authorization of [
      "Bearer " + expired.key,
      "Bearer " + revoked.key,
      "Bearer " + reader.key.slice(0, -1),
      "Bearer " + reader.key + "A",
      "Bearer mk_",
      "Bearer mk_" + "A".repeat(22) + "_" + "A".repeat(43),
    ])
      expect([
        authorization,
        await shape(await post(authorization, list)),
      ]).toEqual([authorization, invalid]);
    await local.pg.query("UPDATE users SET status='deleting' WHERE id=$1", [
      auth.userId,
    ]);
    expect(await shape(await post("Bearer " + writer.key, list))).toEqual(
      invalid,
    );
    await local.pg.query("UPDATE users SET status='active' WHERE id=$1", [
      auth.userId,
    ]);
    expect((await post("Bearer " + writer.key, list)).status).toBe(200);
    // OAuth beside keys: same tools by scope, same challenge without a token.
    expect(
      (await post("Bearer " + (await fixture.token("keyed")), list)).status,
    ).toBe(200);
    const anonymous = await post(null, list);
    expect(anonymous.status).toBe(401);
    expect(anonymous.headers.get("WWW-Authenticate")).toBe(
      `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`,
    );
  } finally {
    await Promise.all(clients.map((c) => c.close()));
    await local.dispose();
  }
}, 30000);

test("key lookups are bounded before database access: 8 at once, then a quick 503", async () => {
  const local = await localStore();
  let queries = 0;
  let hold: Promise<void> | undefined;
  try {
    await local.pg.exec(`CREATE SCHEMA IF NOT EXISTS milton_guard;
      CREATE FUNCTION milton_guard.connection_key_status(text,text,text) RETURNS boolean
        LANGUAGE sql AS $$ SELECT ($1,$2,$3)=('bounded','f:1','f:2') $$`);
    await resolveIdentityAccount(local.env, {
      provider: issuer,
      subject: "bounded",
    });
    const real = await connectionKeysForAccount(
      local.env,
      await lookupIdentityAccount(local.env, {
        provider: issuer,
        subject: "bounded",
      }),
      { issuer, subject: "bounded", incarnation: "f:1", generation: "f:2" },
    ).create({ name: "Real", scope: "read", expiry: 30 });
    const db = new Proxy(local.db, {
      get(target, key) {
        if (key === "query")
          return async (statement: SQL) => {
            queries++;
            await hold;
            return target.query(statement);
          };
        return Reflect.get(target, key);
      },
    });
    const fixture = await tokenFixture(local.pg);
    const handler = createMiltonHandler(
      { storeDatabase: db, issuer, resource, appOrigin: origin },
      fixture.verify,
      () => {},
    );
    // Each request from its own source, so only the aggregate cap applies.
    let sources = 0;
    const post = (key: string) =>
      handler(
        new Request(resource, {
          method: "POST",
          headers: {
            Host: "localhost:3001",
            Authorization: "Bearer " + key,
            Accept: "application/json, text/event-stream",
            "Content-Type": "application/json",
            "X-Forwarded-For": `198.51.100.${++sources}, 203.0.113.1`,
          },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
        }),
      );
    const invented = (n: number) =>
      `mk_${randomBytes(16).toString("base64url")}_${"A".repeat(42)}${"AQgw"[n % 4]}`;
    let release!: () => void;
    hold = new Promise((resolve) => (release = resolve));
    const held = Array.from({ length: 8 }, (_, n) => post(invented(n)));
    while (queries < 8) await new Promise((r) => setTimeout(r, 5));
    const busy = await post(invented(8));
    expect(busy.status).toBe(503);
    expect(busy.headers.get("Retry-After")).toBe("1");
    expect((await busy.json()).error).toBe("server_busy");
    expect(queries).toBe(8);
    release();
    hold = undefined;
    for (const reply of await Promise.all(held)) expect(reply.status).toBe(401);
    // The slots are free again: the real key works.
    expect((await post(real.key)).status).toBe(200);
  } finally {
    await local.dispose();
  }
}, 30000);

test("key attempts are limited per load-balancer client before database access: one source's invented keys get 429, another source's real key still works, a forged first X-Forwarded-For entry changes nothing, and stalled lookups hold at most 3 per source across refills", async () => {
  const local = await localStore();
  let queries = 0,
    hold: Promise<void> | undefined,
    stalled = 0,
    peak = 0;
  try {
    await local.pg.exec(`CREATE SCHEMA IF NOT EXISTS milton_guard;
      CREATE FUNCTION milton_guard.connection_key_status(text,text,text) RETURNS boolean
        LANGUAGE sql AS $$ SELECT ($1,$2,$3)=('sourced','s:1','s:2') $$`);
    await resolveIdentityAccount(local.env, {
      provider: issuer,
      subject: "sourced",
    });
    const real = await connectionKeysForAccount(
      local.env,
      await lookupIdentityAccount(local.env, {
        provider: issuer,
        subject: "sourced",
      }),
      { issuer, subject: "sourced", incarnation: "s:1", generation: "s:2" },
    ).create({ name: "Real", scope: "read", expiry: 30 });
    const db = new Proxy(local.db, {
      get(target, key) {
        if (key === "query")
          return async (statement: SQL) => {
            queries++;
            if (hold) {
              peak = Math.max(peak, ++stalled);
              await hold;
              stalled--;
            }
            return target.query(statement);
          };
        return Reflect.get(target, key);
      },
    });
    const fixture = await tokenFixture(local.pg);
    const handler = createMiltonHandler(
      { storeDatabase: db, issuer, resource, appOrigin: origin },
      fixture.verify,
      () => {},
    );
    // Google's load balancer appends "<client>, <load balancer>"; anything
    // earlier came from the client.
    const post = (key: string, forwardedFor: string) =>
      handler(
        new Request(resource, {
          method: "POST",
          headers: {
            Host: "localhost:3001",
            Authorization: "Bearer " + key,
            Accept: "application/json, text/event-stream",
            "Content-Type": "application/json",
            "X-Forwarded-For": forwardedFor,
          },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
        }),
      );
    const invented = () =>
      `mk_${randomBytes(16).toString("base64url")}_${"A".repeat(43)}`;
    const a = "198.51.100.7, 203.0.113.1";
    const b = "198.51.100.8, 203.0.113.1";
    let refused = 0;
    for (let n = 0; n < 12; n++) {
      const reply = await post(invented(), a);
      if (reply.status === 429) {
        refused++;
        expect(Number(reply.headers.get("Retry-After"))).toBeGreaterThan(0);
        expect((await reply.json()).error).toBe("rate_limited");
      } else expect(reply.status).toBe(401);
    }
    expect(refused).toBeGreaterThan(0);
    // Refusals touch neither the database nor a lookup slot, and a forged
    // leading entry does not make source A someone else.
    const before = queries;
    for (const forged of ["192.0.2.1", "192.0.2.2, 192.0.2.3", "unknown"])
      expect((await post(invented(), `${forged}, ${a}`)).status).toBe(429);
    expect(queries).toBe(before);
    // Sources are keyed by forwardedClient (tested with it): IPv4 as is,
    // IPv6 by /64, and no well-formed pair as one shared "unknown".
    const source = (forwardedFor?: string) =>
      keyAttemptSource(
        new Request(resource, {
          headers: forwardedFor ? { "X-Forwarded-For": forwardedFor } : {},
        }),
      );
    expect(source(a)).toBe("198.51.100.7");
    expect(source("2001:db8:1:2::5, 203.0.113.1")).toBe("2001:db8:1:2::/64");
    expect(source()).toBe("unknown");
    // Source B's real key keeps working, past the burst and the per-minute rate.
    for (let n = 0; n < 15; n++)
      expect((await post(real.key, b)).status).toBe(200);
    // Source C's lookups stall (as up to the 20-second statement timeout).
    // However far its bucket refills, it holds at most 3 lookups at once; the
    // rest get 429 without the database, and B's real key still gets a slot.
    const c = "198.51.100.9, 203.0.113.1";
    const start = Date.now();
    let release!: () => void;
    hold = new Promise((resolve) => (release = resolve));
    const held = Array.from({ length: 3 }, () => post(invented(), c));
    while (stalled < 3) await new Promise((r) => setTimeout(r, 5));
    const stalledQueries = queries;
    for (const seconds of [0, 6, 12, 18, 60]) {
      setSystemTime(new Date(start + seconds * 1000));
      const reply = await Promise.race([
        post(invented(), c),
        new Promise<"stalled">((r) => setTimeout(r, 1000, "stalled")),
      ]);
      expect(reply === "stalled" ? reply : reply.status).toBe(429);
      if (reply !== "stalled")
        expect(Number(reply.headers.get("Retry-After"))).toBeGreaterThan(0);
    }
    expect(peak).toBe(3);
    expect(queries).toBe(stalledQueries);
    hold = undefined;
    expect((await post(real.key, b)).status).toBe(200);
    expect(stalled).toBe(3);
    release();
    for (const reply of await Promise.all(held)) expect(reply.status).toBe(401);
  } finally {
    setSystemTime();
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
    const fixture = await tokenFixture(local.pg, resource);
    const logged: ToolCall[] = [];
    let verified = 0;
    const handler = createMiltonHandler(
      {
        storeDatabase: db,
        issuer,
        resource,
        appOrigin: "https://mcp.meetmilton.com",
      },
      (header) => {
        verified++;
        return fixture.verify(header);
      },
      (call) => logged.push(call),
    );
    for (const [method, host, origin, expected] of [
      ["GET", "mcp.meetmilton.com", "https://claude.ai", 405],
      ["DELETE", "mcp.meetmilton.com", "https://claude.ai", 405],
      ["POST", "untrusted.example", "https://claude.ai", 403],
      ["POST", "localhost:3001", "https://claude.ai", 403],
      ["POST", "mcp.meetmilton.com", "https://untrusted.example", 401],
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
    // Over the bound, an authorized call is refused once, before parsing, auth,
    // a query or a tool event.
    logged.length = 0;
    verified = 0;
    const oversized = await handler(
      new Request(resource, {
        method: "POST",
        headers: {
          Host: "mcp.meetmilton.com",
          Authorization: `Bearer ${await fixture.token("bound")}`,
          "Content-Type": "application/json",
        },
        body: new ReadableStream({
          start(c) {
            c.enqueue(new Uint8Array(262145));
            c.close();
          },
        }),
      }),
    );
    expect(oversized.status).toBe(413);
    expect(await oversized.json()).toEqual({ error: "request_too_large" });
    expect(queries).toBe(0);
    expect(logged).toEqual([]);
    expect(verified).toBe(0);
  } finally {
    await local.dispose();
  }
}, 30000);

test("tool dispatch logs bounded final outcomes, invalid arguments, and unknown tools exactly once", async () => {
  const calls: unknown[] = [];
  const server = createMiltonServer(stubStore(), (call) => calls.push(call));
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
        elapsed_ms: expect.any(Number),
      },
      {
        tool: "create_memo",
        outcome: "refused",
        error_code: "invalid_arguments",
        elapsed_ms: expect.any(Number),
      },
      {
        tool: "unknown",
        outcome: "refused",
        error_code: "unknown_tool",
        elapsed_ms: expect.any(Number),
      },
    ]);
  } finally {
    await client.close();
    await server.close();
  }
});

test("final outcomes include early refusal/read failure and a logging failure cannot reverse a save", async () => {
  const { StoreError, lookupIdentityAccount, storeForCurrentRequest } =
    await import("../src/store");
  const local = await localStore(),
    events: import("../src/mcp").ToolCall[] = [];
  let server: ReturnType<typeof createMiltonServer> | undefined,
    client: Client | undefined;
  try {
    await resolveIdentityAccount(local.env, {
      provider: issuer,
      subject: "outcome-fixture",
    });
    const auth = await lookupIdentityAccount(local.env, {
      provider: issuer,
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
    server = createMiltonServer(store, (event) => {
      events.push(event);
      if (throwLog) throw new Error("Fictional logger failure");
    });
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
    expect(data.memo_update).toBeUndefined();
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
      events.map((e) => [e.tool, e.outcome, e.error_code ?? null]),
    ).toEqual([
      ["get_cover_sheet", "refused", "rate_limited"],
      ["get_cover_sheet", "failed", "store_unavailable"],
      ["create_memo", "saved", null],
      ["create_memo", "unchanged", null],
    ]);
    expect(JSON.stringify(events)).not.toContain("private-client");
    expect(JSON.stringify(events)).not.toContain("Fictional");
    expect(events).toHaveLength(4);
    const fixture = await tokenFixture(local.pg);
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
      error_code: "auth_unavailable",
    });
    expect(JSON.stringify(early)).not.toContain("Fictional");
  } finally {
    await client?.close();
    await server?.close();
    await local.dispose();
  }
});
