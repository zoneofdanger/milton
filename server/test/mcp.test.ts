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
  serverDescription,
  type ToolCall,
} from "../src/mcp";
import { saveMemoInput } from "../src/mcp-tools";
import { createMiltonHandler, keyAttemptSource } from "../src/handler";
import { createAccessTokenVerifier } from "../src/token";
import {
  connectionKeysForAccount,
  lookupIdentityAccount,
  personStoreForCurrentRequest,
  resolveIdentityAccount,
} from "../src/store";
import {
  fixtureStore,
  read,
  seedUsers,
  storeForCurrentRequest,
} from "./store-fixtures";
import { localStore } from "./local-store";
import { PgDialect } from "drizzle-orm/pg-core";
import {
  backgroundSettled,
  type StoreDatabase,
  type StoreSession,
} from "../src/store/database";
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
  // Admission is the separate milton-admit service: no internal route here,
  // and no redirect toward the app either.
  for (const path of [
    "/internal/auth/admit",
    "/internal/auth/preserve-eligibility",
  ])
    expect(
      (
        await app(
          new Request(`https://mcp.example${path}`, {
            method: "POST",
            headers: { Host: "mcp.example" },
          }),
        )
      ).status,
    ).toBe(404);
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

test("both instruction variants stay under 3,500 characters, keep every topic and leave error handling to results", () => {
  // Claude Code truncates MCP server instructions at 4,096 characters; 3,500
  // keeps room for growth.
  for (const served of [storeInstructions, readOnlyInstructions]) {
    expect(served.length).toBeLessThan(3500);
    expect(served.isWellFormed()).toBe(true);
    // Error handling lives in each error result's next; one pointer remains.
    expect(served).toContain("On an error, follow its next.");
    for (const moved of [
      /subscription_required/,
      /not retry|don't retry/,
      /after conflict|conflict\/|edit_conflict/,
      /uncertain retr/,
      /refused saves/,
    ])
      expect(served).not.toMatch(moved);
  }
  // The topics and their order: served-contract.test.ts.
});

test("an SDK client receives instructions, discovers the two tools, and reads the report", async () => {
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
    expect(await checkMcp(client)).toContain("exactly two");
    expect(calls).toEqual(["get_report"]);
    // For clients that drop instructions: a short description in server info
    // that still says to read before writing.
    const description = client.getServerVersion()?.description;
    expect(description).toBe(serverDescription);
    expect(serverDescription.length).toBeLessThanOrEqual(120);
    expect(serverDescription).toMatch(
      /writing\. Before writing or editing .*get_report/,
    );
    expect(serverDescription).not.toContain("get_cover_sheet");
    const tools = (await client.listTools()).tools;
    // AIs see reports, never the retired TPS name or cover sheet.
    for (const served of [client.getInstructions(), ...tools])
      expect(JSON.stringify(served)).not.toMatch(
        /TPS|tps_report|cover[ _]sheet|report_id|rounds/,
      );
    const save = tools.find((tool) => tool.name === "create_memo")!;
    expect(Object.keys(save.inputSchema.properties ?? {}).sort()).toEqual([
      "forget_memos",
      "memo",
      "memo_context",
      "request_id",
    ]);
    const fields = (schema: object | undefined) =>
      (schema as { properties: Record<string, Record<string, unknown>> })
        .properties;
    const memoSchema = (
      save.inputSchema.properties as Record<string, { properties?: object }>
    ).memo!;
    expect(Object.keys(memoSchema.properties ?? {}).sort()).toEqual(
      [
        "context",
        "final",
        "first_draft",
        "first_draft_missing",
        "kind_id",
        "mode",
        "new_kind",
        "request",
      ].sort(),
    );
    // Clients may send kind_id: null for none; memo_context's kind_id still
    // takes only an id.
    expect(fields(memoSchema).kind_id!.anyOf).toContainEqual({ type: "null" });
    expect(fields(save.inputSchema.properties!.memo_context).kind_id).toEqual({
      type: "string",
      minLength: 1,
      maxLength: 64,
      description: expect.any(String),
    });
    // The request id takes the database's alphabet.
    expect(fields(save.inputSchema).request_id).toMatchObject({
      type: "string",
      pattern: "^[A-Za-z0-9._:-]{1,64}$",
    });
    // What a memo may hold, and what it never holds (rule, sections 2 and 5).
    for (const field of [
      "request_id: any new id for each save, up to 64 letters, digits, dots, dashes, underscores or colons; resend the same one only to recover an uncertain outcome.",
      "save one when the person accepts a final.",
      "send first_draft_missing: true instead",
      "Milton works out the person's changes (their tweaks) from first_draft and final",
      "request: only what they typed to ask, no pasted text",
      "A memo holds only these: never secrets, the transcript, the person's correction messages or other people's text",
      "Don't save a final holding a secret (say why; never redact)",
      "carries receipt: tell the person that line",
    ])
      expect(save.description).toContain(field);
    expect(save.description).not.toContain("without asking");
    // Error handling is in each result's next, not the description.
    expect(save.description).toEndWith(
      "An error result's next says what to do.",
    );
    const read = tools.find((tool) => tool.name === "get_report")!;
    expect(read.inputSchema.required).toEqual(["intent"]);
    for (const part of [
      'when asked "Did you get the memo?"',
      "memos (how many memos they have)",
      "While memos is 0, setup holds the first-setup script",
    ])
      expect(read.description).toContain(part);
    const text = client.getInstructions();
    expect(text).toContain('"Did you get the memo?"');
    expect(text).toContain('"Did you get that memo?"');
    expect(text).toContain("even if you already read it");
    expect(text).toContain("Confirm only after a successful read");
    expect(text).toContain(
      "Quoting or discussing the phrase is not an invocation",
    );
    // The memo cue is stated once across everything served.
    const served = JSON.stringify([client.getInstructions(), tools]);
    for (const once of [
      "even if you already read it",
      "Quoting or discussing the phrase is not an invocation",
    ])
      expect(served.split(once).length - 1).toBe(1);
  } finally {
    await client.close();
    await server.close();
  }
});

test("a stale client's get_cover_sheet, and each removed create_memo field in every supported form, is refused at dispatch with its guidance and a tool list change; nothing is written, and writing strings are never searched", async () => {
  const local = await localStore();
  const calls: ToolCall[] = [];
  const store = fixtureStore(local.db, "u");
  for (const readOnly of [false, true]) {
    const server = createMiltonServer(
      { ...store, appOrigin: stubStore().appOrigin },
      (call) => calls.push(call),
      { readOnly },
    );
    const client = new Client({ name: "sdk-test", version: "0.0.0" });
    const changed: unknown[] = [];
    client.setNotificationHandler(ToolListChangedNotificationSchema, (n) => {
      changed.push(n);
    });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    try {
      if (!readOnly) await seedUsers(local.pg, "u");
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      expect(
        (await client.listTools()).tools.map((t) => t.name).sort(),
      ).toEqual(readOnly ? ["get_report"] : ["create_memo", "get_report"]);
      const call = async (name: string, args: Record<string, unknown>) => {
        const reply = await client.callTool({ name, arguments: args });
        return { isError: reply.isError, value: read(reply as never) };
      };
      // The retired tool, on both connections.
      const before = changed.length;
      expect(await call("get_cover_sheet", {})).toEqual({
        isError: true,
        value: {
          error: "tool_replaced",
          code: "tool_replaced",
          message:
            "get_cover_sheet was replaced by get_report. Call get_report with intent.",
          next: expect.objectContaining({ action: "reread" }),
        },
      });
      await Bun.sleep(5);
      expect(changed.length).toBe(before + 1);
      if (readOnly) continue;
      const memo = {
        final: "Friday works. We had three rounds of tweaks on this.\n\n–P",
        first_draft: "Hi Sam! Friday could work.",
        mode: "draft",
        request: "Say yes, mention the rounds and tweaks.",
        context: {
          summary: "accepting a fictional meeting day",
          medium: "email",
        },
      };
      const guidance = {
        cover_sheet:
          "There is no cover sheet. When the person asks you to remember a preference, keep it in your own memory or instructions; Milton keeps their changes as tweaks.",
        tweaks:
          "tweaks are no longer sent: Milton works out the person's changes from first_draft and final.",
        rounds: "rounds is no longer sent.",
        report_id: "report_id is no longer sent.",
      };
      const sent: [keyof typeof guidance, Record<string, unknown>][] = [];
      sent.push([
        "cover_sheet",
        { cover_sheet: { add: "x", expected_version: 0 } },
      ]);
      sent.push(["cover_sheet", { cover_sheet: {}, memo }]);
      for (const [field, value] of [
        ["tweaks", []],
        ["tweaks", [{ text: "no warm-up opener" }]],
        ["rounds", 2],
        ["report_id", crypto.randomUUID()],
      ] as const) {
        // Nested, as a JSON-object string, and flattened.
        sent.push([field, { memo: { ...memo, [field]: value } }]);
        sent.push([
          field,
          { memo: JSON.stringify({ ...memo, [field]: value }) },
        ]);
        const { final, ...rest } = memo;
        sent.push([field, { memo: final, ...rest, [field]: value }]);
      }
      for (const [field, args] of sent) {
        const changes = changed.length;
        const refused = await call("create_memo", {
          request_id: crypto.randomUUID(),
          ...args,
        });
        expect([field, refused]).toEqual([
          field,
          {
            isError: true,
            value: expect.objectContaining({
              error: "invalid_input",
              field: "removed",
              message: expect.stringContaining(guidance[field]),
              next: expect.objectContaining({ action: "ask_user" }),
            }),
          },
        ]);
        expect(refused.value.message).toContain(
          "Milton can't recover an earlier outcome for this request. Before saving again with a new request_id, ask the person to check their TPS page and, if it isn't there, the full TPS.md export (the page lists the latest 200 memos), for this memo.",
        );
        await Bun.sleep(5);
        expect(changed.length).toBe(changes + 1);
      }
      expect(
        (await local.pg.query("SELECT 1 FROM save_requests")).rows,
      ).toEqual([]);
      // Unknown keys deeper down meet the strict schema; none is a removed
      // field at its position.
      for (const args of [
        { memo: { ...memo, context: { ...memo.context, rounds: 1 } } },
        { memo_context: { memo_id: "m", context: memo.context, tweaks: [] } },
        { memo: { ...memo, colour: "blue" } },
      ]) {
        const refused = await call("create_memo", {
          request_id: crypto.randomUUID(),
          ...args,
        });
        expect(refused.isError).toBe(true);
        expect(refused.value.field).toBeUndefined();
      }
      // A bidirectional control in a one-line field (rule B) is refused at
      // dispatch in every form, with the rollout-boundary sentence, and
      // writes nothing; even under a request id that already holds a receipt.
      const RLO = String.fromCharCode(0x202e);
      const PDI = String.fromCharCode(0x2069);
      const bidiMemo = {
        ...memo,
        context: { ...memo.context, summary: `accepting${RLO} a day` },
      };
      const { final: bidiFinal, ...bidiRest } = bidiMemo;
      const held = crypto.randomUUID();
      expect(
        (
          await call("create_memo", {
            request_id: held,
            memo: { final: "Held earlier.", context: memo.context },
          })
        ).value.status,
      ).toBe("saved");
      const receipts = async () =>
        (await local.pg.query("SELECT 1 FROM save_requests")).rows.length;
      const receiptsBefore = await receipts();
      for (const [form, args] of [
        ["object", { memo: bidiMemo }],
        ["JSON-object string", { memo: JSON.stringify(bidiMemo) }],
        ["flattened", { memo: bidiFinal, ...bidiRest }],
        [
          "memo_context",
          {
            memo_context: {
              memo_id: "m",
              context: { summary: "a day", medium: "email" },
              new_kind: `meeting${PDI}`,
            },
          },
        ],
        [
          "memo_context as a JSON-object string",
          {
            memo_context: JSON.stringify({
              memo_id: "m",
              context: { summary: `a${RLO}day`, medium: "email" },
            }),
          },
        ],
        ["a held request id", { request_id: held, memo: bidiMemo }],
      ] as const) {
        const refused = await call("create_memo", {
          request_id: crypto.randomUUID(),
          ...args,
        });
        expect([form, refused]).toEqual([
          form,
          {
            isError: true,
            value: expect.objectContaining({
              error: "invalid_input",
              field: "bidi",
              message: expect.stringContaining(
                "Milton can't recover an earlier outcome for this request. Before saving again with a new request_id, ask the person to check their TPS page and, if it isn't there, the full TPS.md export",
              ),
              next: expect.objectContaining({ action: "ask_user" }),
            }),
          },
        ]);
      }
      expect(await receipts()).toBe(receiptsBefore);
      // A final, first draft or request that says "rounds" or "tweaks" saves.
      expect(
        await call("create_memo", {
          request_id: "save-vendor-decline-1",
          memo,
        }),
      ).toMatchObject({
        value: { status: "saved", receipt: "Kept memo: email." },
      });
    } finally {
      await client.close();
      await server.close();
    }
  }
  expect(calls.filter((c) => c.tool === "get_cover_sheet")).toEqual([
    expect.objectContaining({
      outcome: "refused",
      error_code: "tool_replaced",
    }),
    expect.objectContaining({
      outcome: "refused",
      error_code: "tool_replaced",
    }),
  ]);
  await local.dispose();
});

const goodIntent = {
  situation: "a fictional reply",
  medium: "email",
  audience: "a client",
  purpose: "reply",
};
test("get_report requires an intent: without a well-formed one it refuses, saying what to send; with one the store ranks for it", async () => {
  const calls: ToolCall[] = [];
  const intents: unknown[] = [];
  const stub = stubStore();
  const server = createMiltonServer(
    {
      ...stub,
      readReport: (intent) => {
        intents.push(intent);
        return stub.readReport(intent);
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
    expect(schema.required).toEqual(["intent"]);
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
    expect(missing).toContain("reconnect your AI if it has no intent field");
    expect(missing).toContain("medium, audience and purpose");
    expect(changed).toBe(1);
    // A malformed intent names the limit it broke, without the reconnect hint.
    for (const [intent, says] of [
      [
        { ...goodIntent, situation: " " },
        "situation must be one line of at most 200 characters",
      ],
      [
        { ...goodIntent, situation: "x".repeat(201) },
        "situation must be one line of at most 200 characters",
      ],
      [
        { situation: "a reply", medium: "email", audience: "a client" },
        "purpose is required: one line of at most 100 characters",
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
        intent: {
          situation: "declining a client's request for a discount",
          medium: "email",
          audience: "a client",
          purpose: "decline",
        },
      },
    });
    expect(read.isError).toBeUndefined();
    expect(changed).toBe(1);
    expect(intents).toEqual([
      {
        situation: "declining a client's request for a discount",
        medium: "email",
        audience: "a client",
        purpose: "decline",
      },
    ]);
  } finally {
    await client.close();
    await server.close();
  }
});

test("the server hands the store one-line fields after the rule: separators as one space, trimmed", async () => {
  const LS = String.fromCharCode(0x2028);
  const PS = String.fromCharCode(0x2029);
  const saved: unknown[] = [];
  const intents: unknown[] = [];
  const stub = stubStore();
  const server = createMiltonServer({
    ...stub,
    readReport: (intent) => {
      intents.push(intent);
      return stub.readReport(intent);
    },
    saveMemo: async (input) => {
      saved.push(input);
      return { status: "saved", request_id: input.request_id };
    },
  });
  const client = new Client({ name: "sdk-test", version: "0.0.0" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    await client.callTool({
      name: "get_report",
      arguments: {
        intent: { ...goodIntent, situation: `declining${LS}${PS}a vendor ` },
      },
    });
    expect(intents).toEqual([
      { ...goodIntent, situation: "declining a vendor" },
    ]);
    const request_id = crypto.randomUUID();
    for (const args of [
      {
        memo: {
          final: `Friday works.${LS}Thanks!`,
          context: { summary: `${LS}accepting a day${PS}`, medium: "email" },
          new_kind: `meeting${PS}yes`,
          first_draft: "Friday is fine.",
          mode: "draft",
        },
      },
      {
        memo_context: {
          memo_id: "m",
          context: {
            summary: `a day${LS}`,
            medium: "email",
            audience: ` a${PS}client`,
          },
          new_kind: `meeting${LS}${PS}yes`,
        },
      },
    ])
      await client.callTool({
        name: "create_memo",
        arguments: { request_id, ...args },
      });
    expect(saved).toEqual([
      {
        request_id,
        memo: {
          // A memo's words are kept as sent.
          final: `Friday works.${LS}Thanks!`,
          context: { summary: "accepting a day", medium: "email" },
          new_kind: "meeting yes",
          first_draft: "Friday is fine.",
          mode: "draft",
        },
      },
      {
        request_id,
        memo_context: {
          memo_id: "m",
          context: { summary: "a day", medium: "email", audience: "a client" },
          new_kind: "meeting yes",
        },
      },
    ]);
    // What create_memo promises matches: only final and first_draft are kept
    // byte for byte.
    const { tools } = await client.listTools();
    const description =
      tools.find((tool) => tool.name === "create_memo")?.description ?? "";
    expect(description).toContain(
      "Milton keeps final and first_draft unchanged; saves are all or nothing.",
    );
    expect(description).not.toContain("bytes unchanged");
  } finally {
    await client.close();
    await server.close();
  }
});

test("an object argument sent as a JSON string is read as that object; any other string is still refused", async () => {
  const saved: unknown[] = [];
  const intents: unknown[] = [];
  const stub = stubStore();
  const server = createMiltonServer({
    ...stub,
    readReport: (intent) => {
      intents.push(intent);
      return stub.readReport(intent);
    },
    saveMemo: async (input) => {
      saved.push(input);
      return {
        status: "saved",
        request_id: (input as { request_id: string }).request_id,
        receipt: "Kept memo: email.",
      };
    },
  });
  const client = new Client({ name: "sdk-test", version: "0.0.0" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const memo = {
      final: "Hi Sam,\n\nFriday works. Thanks!\n\n> quoted\n–P",
      context: {
        summary: "accepting a fictional meeting day",
        medium: "email",
      },
    };
    const request_id = crypto.randomUUID();
    const reply = await client.callTool({
      name: "create_memo",
      arguments: { request_id, memo: JSON.stringify(memo) },
    });
    expect(reply.isError).toBeUndefined();
    expect(saved).toEqual([{ request_id, memo }]);
    // kind_id: null arrives as omitted, even inside the string.
    const lenient = await client.callTool({
      name: "create_memo",
      arguments: {
        request_id,
        memo: JSON.stringify({ ...memo, kind_id: null }),
      },
    });
    expect(lenient.isError).toBeUndefined();
    expect(JSON.stringify(saved[1])).toBe(JSON.stringify(saved[0]));
    saved.pop();
    const read = await client.callTool({
      name: "get_report",
      arguments: { intent: JSON.stringify(goodIntent) },
    });
    expect(read.isError).toBeUndefined();
    expect(intents).toEqual([goodIntent]);
    for (const value of ["not json", JSON.stringify([memo]), '"text"']) {
      const refused = await client.callTool({
        name: "create_memo",
        arguments: { request_id: crypto.randomUUID(), memo: value },
      });
      expect(refused.isError).toBe(true);
    }
    expect(saved).toHaveLength(1);
  } finally {
    await client.close();
    await server.close();
  }
});

test("a memo sent flattened (the final as a string memo, its fields beside it) saves as the object form, one request either way; ambiguous shapes are refused with how to send it", async () => {
  const local = await localStore();
  const saved: unknown[] = [];
  const store = fixtureStore(local.db, "u");
  const server = createMiltonServer({
    ...store,
    appOrigin: stubStore().appOrigin,
    saveMemo: (input, call) => {
      saved.push(input);
      return store.saveMemo(input, call);
    },
  });
  const client = new Client({ name: "sdk-test", version: "0.0.0" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  try {
    await seedUsers(local.pg, "u");
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const save = async (args: Record<string, unknown>) => {
      const reply = await client.callTool({
        name: "create_memo",
        arguments: args,
      });
      return { isError: reply.isError, value: read(reply as never) };
    };
    // The #80 setup runs' first saves: the final as memo, context and
    // new_kind beside it. Here with every other memo field too.
    const fields = {
      first_draft: "Hi Sam! Hope you're well. Friday could work for me.",
      mode: "draft",
      request: "Say yes to Friday.",
      context: {
        summary: "accepting a fictional meeting day",
        medium: "email",
      },
      new_kind: "meeting reply",
    };
    const final = "Friday works.\n\n–P";
    const request_id = crypto.randomUUID();
    const flat = await save({ request_id, memo: final, ...fields });
    expect(flat.isError).toBeUndefined();
    expect(flat.value).toMatchObject({ status: "saved" });
    // The store got exactly the object form, so the same memo and hash.
    const nested = await save({ request_id, memo: { final, ...fields } });
    expect(nested).toEqual({
      ...flat,
      value: { ...flat.value, replayed: expect.any(String) },
    });
    expect(JSON.stringify(saved[0])).toBe(JSON.stringify(saved[1]));
    expect(JSON.stringify(saved[0])).toBe(
      JSON.stringify(
        saveMemoInput.parse({ request_id, memo: { ...fields, final } }),
      ),
    );
    // A retry of the flattened save replays; nothing is duplicated.
    expect(await save({ request_id, memo: final, ...fields })).toEqual({
      ...flat,
      value: { ...flat.value, replayed: expect.any(String) },
    });
    expect((await local.pg.query("SELECT final FROM memos")).rows).toEqual([
      { final },
    ]);
    // Ambiguous, or flattened but still malformed: refused with how to
    // send it, nothing saved.
    const context = fields.context;
    for (const args of [
      { memo: final, new_kind: "reply" },
      { memo: final, context: { summary: "a reply" }, new_kind: "reply" },
      { memo: final },
      { memo: final, final, context },
      { memo: '"Friday works."', context },
      { memo: final, context, colour: "blue" },
      { memo: final, context, forget_memos: ["m"] },
      { memo: { final }, context },
      { memo: JSON.stringify({ final }), context },
    ]) {
      const refused = await save({ request_id: crypto.randomUUID(), ...args });
      expect(refused.isError).toBe(true);
      expect(refused.value).toMatchObject({
        error: "invalid_input",
        message: expect.stringContaining("memo: {final,"),
      });
    }
    expect(saved).toHaveLength(3);
  } finally {
    await client.close();
    await server.close();
    await local.dispose();
  }
});

test("a pasted request is refused with its own next step, before any write", async () => {
  const local = await localStore();
  const calls: ToolCall[] = [];
  const store = fixtureStore(local.db, "u");
  const server = createMiltonServer(
    { ...store, appOrigin: stubStore().appOrigin },
    (call) => calls.push(call),
  );
  const client = new Client({ name: "sdk-test", version: "0.0.0" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  try {
    await seedUsers(local.pg, "u");
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const save = async (memo: Record<string, unknown>) => {
      const reply = await client.callTool({
        name: "create_memo",
        arguments: { request_id: crypto.randomUUID(), memo },
      });
      expect(reply.isError).toBe(true);
      return read(reply as never);
    };
    const memo = {
      final: "Friday works.\n\n–S",
      first_draft: "Hi Sam! Hope you're well. Friday could work for me.",
      mode: "draft",
      context: {
        summary: "accepting a fictional meeting day",
        medium: "email",
      },
    };
    expect(
      await save({ ...memo, request: "Reply yes.\n> On Friday we could meet" }),
    ).toMatchObject({
      error: "invalid_input",
      field: "request",
      next: {
        text: "Send only what the person typed to ask, without pasted or quoted text, or leave request out; send the rest unchanged and save with a new request_id.",
      },
    });
    expect(calls.map((c) => [c.outcome, c.error_code])).toEqual([
      ["refused", "invalid_input"],
    ]);
    expect((await local.pg.query("SELECT 1 FROM save_requests")).rows).toEqual(
      [],
    );
  } finally {
    await client.close();
    await server.close();
    await local.dispose();
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
      discovered.find((t) => t.name === "get_report")?.annotations,
    ).toMatchObject({
      readOnlyHint: true,
      idempotentHint: false,
      openWorldHint: true,
    });
    expect(discovered.map((t) => t.name).sort()).toEqual([
      "create_memo",
      "get_report",
    ]);
    const check = {
      intent: {
        situation: "confirming what is on file",
        medium: "email",
        audience: "a client",
        purpose: "check",
      },
    };
    expect(
      discovered.find((t) => t.name === "create_memo")?.annotations
        ?.idempotentHint,
    ).toBe(true);
    // Connecting and listing tools announce nothing; each assistant's first
    // tool call after this process started does, and only that one.
    expect(changed).toEqual([0, 0]);
    const first = (await call(0, "get_report", check)).value;
    const second = (await call(1, "get_report", check)).value;
    expect(changed).toEqual([1, 1]);
    // An empty account carries the first-setup script; it leaves after the
    // first save.
    expect(first).toMatchObject({ is_empty: true, memos: 0 });
    expect(second).toMatchObject({ is_empty: true, memos: 0 });
    expect(String(first.setup)).toStartWith("First setup");
    const input = {
      request_id: crypto.randomUUID(),
      memo: {
        final: "Lead with the answer.",
        context: { summary: "a fictional note", medium: "email" },
      },
    };
    const saved = await call(0, "create_memo", input);
    expect(saved.value.status).toBe("saved");
    const filed = (await call(0, "get_report", check)).value;
    expect(filed).toMatchObject({ is_empty: false, memos: 1 });
    expect(filed.setup).toBeUndefined();
    expect(filed.text).toContain("> Lead with the answer.");
    // A field the old schema had is refused, with a next step.
    const unknownField = await clients[0]!.callTool({
      name: "get_report",
      arguments: {
        report_id: "email",
        intent: {
          situation: "confirming what is on file",
          medium: "email",
          audience: "a client",
          purpose: "check",
        },
      },
    });
    expect(unknownField.isError).toBe(true);
    expect(
      JSON.parse((unknownField.content as { text: string }[])[0]!.text),
    ).toMatchObject({
      error: "invalid_arguments",
      next: { action: "fix_input" },
    });
    expect((await call(1, "get_report", check)).value.memos).toBe(0);
    expect(changed).toEqual([1, 1]);
    expect((await call(1, "get_report", check)).value.memos).toBe(0);
    expect(changed).toEqual([1, 1]);
    // A get_report from a client holding the schema before intent is refused
    // and told again that the tool list changed.
    expect(
      (await call(0, "get_report", { report_id: "email" })).value.error,
    ).toBe("invalid_input");
    expect(changed).toEqual([2, 1]);
    // The same words saved by the other tenant are its own first memo.
    expect((await call(1, "create_memo", input)).value.status).toBe("saved");
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
    // Over HTTP too, read only or not, server info carries the description.
    expect(reader.getServerVersion()?.description).toBe(serverDescription);
    expect(readOnlyInstructions.length).toBeLessThanOrEqual(4096);
    expect((await reader.listTools()).tools.map((t) => t.name)).toEqual([
      "get_report",
    ]);
    const cover = JSON.parse(
      (
        (
          await reader.callTool({
            name: "get_report",
            arguments: { intent: goodIntent },
          })
        ).content as { text: string }[]
      )[0]!.text,
    );
    // An empty account, read only: permission, never setup.
    expect(cover.memos).toBe(0);
    expect(cover.setup).toBeUndefined();
    expect(cover.permission).toContain("Read only");
    await expect(
      reader.callTool({ name: "create_memo", arguments: {} }),
    ).rejects.toBeDefined();
    const writer = await connect(await fixture.token("alpha", "writer"));
    expect((await writer.listTools()).tools).toHaveLength(2);
    // A read-only connection reads the same report, served changes included.
    await writer.callTool({
      name: "create_memo",
      arguments: {
        request_id: crypto.randomUUID(),
        memo: {
          first_draft: "Hi Dana, I hope this finds you well. Thanks!",
          final: "Dana — thanks!",
          mode: "draft",
          context: { summary: "thank a colleague", medium: "email" },
        },
      },
    });
    const reportText = async (client: Client) =>
      JSON.parse(
        (
          (
            await client.callTool({
              name: "get_report",
              arguments: {
                intent: {
                  situation: "thanking a colleague",
                  medium: "email",
                  audience: "a colleague",
                  purpose: "thank",
                },
              },
            })
          ).content as { text: string }[]
        )[0]!.text,
      ).text as string;
    const written = await reportText(writer);
    expect(written).toContain("What they changed in the AI's first draft:");
    expect(await reportText(reader)).toBe(written);
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
    const revoked = await request(readToken);
    expect(revoked.status).toBe(401);
    // Auth refusals carry their code and next step too.
    expect(await revoked.json()).toMatchObject({
      error: "invalid_token",
      code: "invalid_token",
      next: { action: "tell_user" },
    });
    expect(
      (await request(await fixture.token("alpha", "reader", "milton:read")))
        .status,
    ).toBe(200);
    expect((await request(readToken)).status).toBe(401);
    const unscoped = await request(
      await fixture.token("alpha", "identity-only", "openid"),
    );
    expect(unscoped.status).toBe(403);
    // A scope refusal names the permission the attempted action needed: a
    // read needs only read, so its next never asks for write.
    const needsRead = await unscoped.json();
    expect(needsRead).toMatchObject({
      error: "insufficient_scope",
      code: "insufficient_scope",
      required_permission: "read",
      next: { action: "tell_user" },
    });
    expect(needsRead.next.text).toContain("Read");
    expect(needsRead.next.text).not.toMatch(/save|write/i);
    const save = await handler(
      new Request(resource, {
        method: "POST",
        headers: {
          Host: "localhost:3001",
          Authorization:
            "Bearer " +
            (await fixture.token("alpha", "reader", "openid milton:read")),
          Accept: "application/json, text/event-stream",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "create_memo", arguments: {} },
        }),
      }),
    );
    expect(save.status).toBe(403);
    const needsWrite = await save.json();
    expect(needsWrite).toMatchObject({
      code: "insufficient_scope",
      required_permission: "read_write",
      next: { action: "tell_user" },
    });
    expect(needsWrite.next.text).toContain("Read and write");
    await local.pg.exec(
      `CREATE OR REPLACE FUNCTION milton_guard.binding_status(text,text,text,text[],text[]) RETURNS jsonb LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fictional status outage'; END $$`,
    );
    expect((await request(readToken)).status).toBe(503);
  } finally {
    await Promise.all(clients.map((c) => c.close()));
    await local.dispose();
  }
}, 30000);

// Round trips per call, beyond the per-tweak statements.
const TRIPS = { report: 5, save: 13 };
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
    const report = {
      name: "get_report",
      arguments: {
        intent: {
          situation: "declining a fictional vendor's call",
          medium: "email",
          audience: "a vendor",
          purpose: "decline",
        },
      },
    };
    const initialize = {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "counted", version: "0" },
    };
    for (const bearer of [token, key]) {
      // The first call records the key's last use; later ones within a minute do not.
      await trips_for(bearer, "tools/call", report);
      expect(await trips_for(bearer, "initialize", initialize)).toBe(1);
      expect(await trips_for(bearer, "notifications/initialized")).toBe(1);
      expect(await trips_for(bearer, "tools/list", {})).toBe(1);
      // An empty account's report: access, the trial gate and the
      // candidates in sequence, and the usage append (one statement)
      // alongside; with nothing to serve, no second statement.
      expect(await trips_for(bearer, "tools/call", report)).toBe(4);
    }
    // A memo save: access, then one transaction (the account lock, the
    // receipt, the trial gate, the savepoint, the keep-memos switch, the
    // duplicate check, the memo, its changes, the receipt), with the usage
    // append alongside. Its gate found no reminder due, so no notice claim.
    // No statement depends on what the person changed.
    const save = (n: number) => ({
      name: "create_memo",
      arguments: {
        request_id: crypto.randomUUID(),
        memo: {
          first_draft: "Hi! Hope you're well. Unfortunately not this time.",
          final: `Not this time, thanks. ${n}`,
          mode: "draft",
          context: { summary: "a fictional decline", medium: "email" },
        },
      },
    });
    expect(await trips_for(key, "tools/call", save(1))).toBe(TRIPS.save);
    const again = save(2);
    expect(await trips_for(key, "tools/call", again)).toBe(TRIPS.save);
    // A replay never reaches the gate, so its notice claim runs (a
    // transaction of the timeouts and the claim).
    expect(await trips_for(key, "tools/call", again)).toBe(5 + 4);
    // A report with examples: access, the trial gate, the candidates, then
    // the chosen words, and the usage append alongside. It writes nothing.
    expect(await trips_for(key, "tools/call", report)).toBe(TRIPS.report);
  } finally {
    await local.dispose();
  }
}, 30000);

test("an admitted call appends its usage alongside its work without a blocking lock, and its reply waits for the row at most 250 ms", async () => {
  const local = await localStore();
  let release = () => {};
  try {
    const { miltonUserId } = await resolveIdentityAccount(local.env, {
      provider: issuer,
      subject: "usage",
    });
    const fixture = await tokenFixture(local.pg);
    const token = await fixture.token("usage");
    // Every statement a request's own work runs; usage appends can be held
    // before they are sent.
    const dialect = new PgDialect();
    const during: string[] = [];
    let hold: Promise<void> | undefined;
    const watched = (session: StoreSession): StoreSession => ({
      async query<Row extends Record<string, unknown>>(statement: SQL) {
        const text = dialect.sqlToQuery(statement).sql;
        if (/usage_calls/.test(text)) await hold;
        else during.push(text);
        return session.query<Row>(statement);
      },
    });
    const db: StoreDatabase = {
      ...watched(local.db),
      transaction: (work) => local.db.transaction((tx) => work(watched(tx))),
      withConnection: (work) => work(db),
    };
    const handler = createMiltonHandler(
      { storeDatabase: db, issuer, resource, appOrigin: origin },
      fixture.verify,
      () => {},
    );
    const call = async (name: string, args: unknown) => {
      during.length = 0;
      const started = performance.now();
      const body = await (
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
              params: { name, arguments: args },
            }),
          }),
        )
      ).text();
      const result = JSON.parse(
        body.startsWith("{") ? body : body.split("data: ").at(-1)!,
      ).result;
      return {
        ms: performance.now() - started,
        statements: [...during],
        value: JSON.parse(result.content[0].text),
      };
    };
    const rows = async () =>
      (
        await local.pg.query<{ tool: string }>(
          "SELECT tool FROM usage_calls WHERE user_id=$1 ORDER BY at",
          [miltonUserId],
        )
      ).rows.map((r) => r.tool);
    // The row commits before the reply: no draining needed.
    const cover = await call("get_report", { intent: goodIntent });
    expect(cover.value.memos).toBeNumber();
    expect(await rows()).toEqual(["get_report"]);
    // A read takes no row lock.
    expect(
      cover.statements.filter((s) => /FOR (NO KEY )?UPDATE/i.test(s)),
    ).toEqual([]);
    const save = await call("create_memo", {
      request_id: crypto.randomUUID(),
      memo: {
        final: "Keep fictional dates exact.",
        context: { summary: "a fictional note", medium: "email" },
      },
    });
    expect(save.value.status).toBe("saved");
    expect(await rows()).toEqual(["get_report", "create_memo"]);
    // A save's one lock is its own account lock, FOR NO KEY UPDATE, which a
    // usage row's foreign-key check does not wait on.
    expect(
      save.statements.filter((s) => /FOR (NO KEY )?UPDATE/i.test(s)),
    ).toEqual([expect.stringContaining("FOR NO KEY UPDATE")]);
    // A stalled append delays the reply by the bound, never more.
    hold = new Promise<void>((resolve) => (release = resolve));
    const stalled = await call("get_report", { intent: goodIntent });
    expect(stalled.value.memos).toBeNumber();
    expect(stalled.ms).toBeGreaterThanOrEqual(240);
    expect(stalled.ms).toBeLessThan(2000);
    expect(await rows()).toHaveLength(2);
    release();
    await backgroundSettled();
    expect(await rows()).toHaveLength(3);
  } finally {
    release();
    await backgroundSettled();
    await local.dispose();
  }
}, 30000);

test("in one JSON-RPC batch, only the admitted call records usage", async () => {
  const local = await localStore();
  let client: Client | undefined;
  try {
    const { miltonUserId } = await resolveIdentityAccount(local.env, {
      provider: issuer,
      subject: "batched",
    });
    const auth = await lookupIdentityAccount(local.env, {
      provider: issuer,
      subject: "batched",
    });
    const store = await storeForCurrentRequest(local.env, auth, {
      issuer: "fixture",
      clientId: "batched-client",
    });
    // One server, so one store, serving both calls at once.
    const server = createMiltonServer(store, () => {});
    client = new Client({ name: "fixture", version: "1" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(b);
    await client.connect(a);
    const [admitted, refused] = await Promise.all([
      client.callTool({
        name: "get_report",
        arguments: { intent: goodIntent },
      }),
      client.callTool({
        name: "get_report",
        arguments: {
          report_id: "email",
          intent: { situation: "confirming what is on file", kind_id: "none" },
        },
      }),
    ]);
    expect(admitted.isError).toBeFalsy();
    expect(refused.isError).toBe(true);
    await backgroundSettled();
    expect(
      (
        await local.pg.query("SELECT tool FROM usage_calls WHERE user_id=$1", [
          miltonUserId,
        ])
      ).rows,
    ).toEqual([{ tool: "get_report" }]);
  } finally {
    await client?.close();
    await backgroundSettled();
    await local.dispose();
  }
}, 30000);

test("invalid store limits refuse a tool call and record no usage; a stored retired key is ignored", async () => {
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
              params: { name: "get_report", arguments: { intent: goodIntent } },
            }),
          }),
        )
      ).text();
    const used = async () => {
      await backgroundSettled();
      return (
        await local.db.query<{ n: number }>(
          sql`SELECT count(*)::int AS n FROM usage_calls WHERE user_id=${miltonUserId}`,
        )
      )[0]!.n;
    };
    // 0008 removed the retired daily_calls key; a stored one is ignored
    // whatever its value, and left as stored.
    const current = {
      body_bytes: 131072,
      description_bytes: 500,
      reason_bytes: 500,
      report_body_bytes: 262144,
    };
    const valid = (
      await local.db.query<{ limits: unknown }>(
        sql`SELECT limits_json AS limits FROM store_config`,
      )
    )[0]!.limits;
    expect(valid).toEqual(current);
    expect(await cover()).not.toContain('"isError":true');
    expect(await used()).toBe(1);
    for (const retired of ["1", "0", '"none"']) {
      await local.db.query(
        sql`UPDATE store_config SET limits_json=limits_json || ${`{"daily_calls":${retired}}`}::jsonb`,
      );
      expect(await cover()).not.toContain('"isError":true');
    }
    expect(await used()).toBe(4);
    await local.db.query(
      sql`UPDATE store_config SET limits_json=${JSON.stringify(valid)}::jsonb`,
    );
    for (const invalid of [
      '{"body_bytes":"large"}',
      '{"report_body_bytes":0}',
    ]) {
      await local.db.query(
        sql`UPDATE store_config SET limits_json=limits_json || ${invalid}::jsonb`,
      );
      expect(await cover()).toContain("configuration");
      expect(await used()).toBe(4);
      await local.db.query(
        sql`UPDATE store_config SET limits_json=${JSON.stringify(valid)}::jsonb`,
      );
    }
    expect(await cover()).not.toContain('"isError":true');
    expect(await used()).toBe(5);
  } finally {
    await local.dispose();
  }
}, 30000);

test("refused tool calls record no usage; each admitted call records one row", async () => {
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
    const used = async () => {
      await backgroundSettled();
      return (
        await local.db.query<{ n: number }>(
          sql`SELECT count(*)::int AS n FROM usage_calls WHERE user_id=${miltonUserId}`,
        )
      )[0]!.n;
    };
    expect((await call("get_report", { intent: goodIntent })).memos).toBe(0);
    expect(await used()).toBe(1);
    const save = {
      request_id: crypto.randomUUID(),
      memo: {
        final: "Keep fictional dates exact.",
        context: { summary: "a fictional note", medium: "email" },
      },
    };
    const badKind = {
      intent: {
        situation: "confirming what is on file",
        medium: "email",
        audience: "a client",
        purpose: "check",
        kind_id: "none",
      },
    };
    // The billing gate, for reads and saves.
    await local.db.query(
      sql`UPDATE trial_accounts SET subscription_status='canceled' WHERE user_id=${miltonUserId}`,
    );
    // Every error result carries its code and its own next step.
    const refused = (
      value: {
        error?: unknown;
        code?: unknown;
        next?: Record<string, unknown>;
      },
      error: string,
      action: string,
    ) =>
      expect({
        error: value.error,
        code: value.code,
        action: value.next?.action,
        text: typeof value.next?.text,
      }).toEqual({ error, code: error, action, text: "string" });
    const lapsed = await call("get_report", { intent: goodIntent });
    refused(lapsed, "subscription_required", "tell_user");
    expect(lapsed.next.text).toContain("don't retry");
    refused(
      await call("create_memo", save),
      "subscription_required",
      "tell_user",
    );
    // Input is validated before the gate: an unknown kind stays invalid_kind.
    refused(await call("get_report", badKind), "invalid_kind", "reread");
    expect(await used()).toBe(1);
    await local.db.query(
      sql`UPDATE trial_accounts SET subscription_status='active' WHERE user_id=${miltonUserId}`,
    );
    // Input refusals: the SDK's schema check (its wording in message), the
    // retired tool, a get_report without intent and an unknown kind.
    const unexpected = await call("get_report", {
      intent: goodIntent,
      event: "start",
    });
    refused(unexpected, "invalid_arguments", "fix_input");
    expect(unexpected.message).toContain('"event"');
    refused(await call("get_cover_sheet", {}), "tool_replaced", "reread");
    refused(
      await call("get_report", { report_id: "email" }),
      "invalid_input",
      "fix_input",
    );
    refused(await call("get_report", badKind), "invalid_kind", "reread");
    expect(await used()).toBe(1);
    // A save that ran is recorded, whether it saved or found its words on
    // file.
    const filed = await call("create_memo", save);
    expect(filed.status).toBe("saved");
    expect(filed).not.toHaveProperty("next");
    expect(await used()).toBe(2);
    expect(
      await call("create_memo", { ...save, request_id: crypto.randomUUID() }),
    ).toMatchObject({ status: "unchanged" });
    expect(await used()).toBe(3);
    // Replaying a recorded save records nothing.
    expect((await call("create_memo", save)).status).toBe("saved");
    expect(await used()).toBe(3);
    // A refusal decided under the lock is recorded and carries its next.
    const forgetNothing = await call("create_memo", {
      request_id: crypto.randomUUID(),
      forget_memos: ["no-such-memo"],
    });
    refused(forgetNothing, "invalid_memo", "reread");
    expect(await used()).toBe(4);
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
      "get_report",
    ]);
    await read.callTool({
      name: "get_report",
      arguments: { intent: goodIntent },
    });
    const write = await connect(writer.key);
    expect(write.getInstructions()).toBe(storeInstructions);
    expect((await write.listTools()).tools).toHaveLength(2);
    const save = {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "create_memo",
        arguments: {
          request_id: crypto.randomUUID(),
          memo: {
            final: "Keep fictional notes short.",
            context: { summary: "a fictional note", medium: "email" },
          },
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
      sql`SELECT client_json AS actor FROM memos`,
    );
    expect(actors.map((row) => JSON.parse(row.actor))).toEqual([
      { issuer: "connection_key", client_id: writer.record.id },
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
    expect(await oversized.json()).toMatchObject({
      error: "request_too_large",
      code: "request_too_large",
      next: { action: "fix_input" },
    });
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
    await client.callTool({
      name: "get_report",
      arguments: { intent: goodIntent },
    });
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
        tool: "get_report",
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
  const { StoreError, lookupIdentityAccount } = await import("../src/store");
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
    let refuse = true,
      failRead = false,
      throwLog = false;
    const originalRead = store.readReport.bind(store);
    store.readReport = async (intent) => {
      if (refuse)
        throw new StoreError(
          "account_unavailable",
          "Fictional private error prose.",
          403,
        );
      if (failRead)
        throw new StoreError(
          "store_unavailable",
          "Fictional private error prose.",
        );
      return originalRead(intent);
    };
    const memo = {
      request_id: crypto.randomUUID(),
      memo: {
        final: "A fictional final.",
        context: { summary: "a fictional note", medium: "chat" },
      },
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
      (
        await client.callTool({
          name: "get_report",
          arguments: { intent: goodIntent },
        })
      ).isError,
    ).toBe(true);
    refuse = false;
    failRead = true;
    expect(
      (
        await client.callTool({
          name: "get_report",
          arguments: { intent: goodIntent },
        })
      ).isError,
    ).toBe(true);
    failRead = false;
    const saved = await client.callTool({
      name: "create_memo",
      arguments: memo,
    });
    const data = JSON.parse((saved.content as { text: string }[])[0]!.text);
    expect(data.status).toBe("saved");
    throwLog = true;
    const unchanged = await client.callTool({
      name: "create_memo",
      arguments: { ...memo, request_id: crypto.randomUUID() },
    });
    expect(
      JSON.parse((unchanged.content as { text: string }[])[0]!.text).status,
    ).toBe("unchanged");
    expect(
      events.map((e) => [e.tool, e.outcome, e.error_code ?? null]),
    ).toEqual([
      ["get_report", "refused", "account_unavailable"],
      ["get_report", "failed", "store_unavailable"],
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
            name: "get_report",
            arguments: { task: "Fictional private task." },
          },
        }),
      }),
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      error: "auth_unavailable",
      next: { action: "retry" },
    });
    expect(early).toHaveLength(1);
    expect(early[0]).toMatchObject({
      tool: "get_report",
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
