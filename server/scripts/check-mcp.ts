import { z } from "zod";
import { strict as assert } from "node:assert";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMiltonServer, storeInstructions } from "../src/mcp";
import type { TenantStore } from "../src/store";
import { assembleDocuments } from "../src/store/reports";

// An empty account that allows every call and saves nothing.
export function stubStore(): TenantStore {
  const documents = { ...assembleDocuments([], []), version: "stub" };
  return {
    appOrigin: "http://localhost:3001",
    readTpsReport: async () => ({ text: "", version: "stub", is_empty: true }),
    readDocuments: async () => documents,
    saveMemo: async () => {
      throw new Error("The stub store saves nothing.");
    },
    chargeToolCall: async () => ({ allowed: true }),
  };
}

export async function checkMcp(client: Client) {
  assert.equal(client.getInstructions(), storeInstructions);
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((tool) => tool.name).sort(), [
    "create_memo",
    "get_cover_sheet",
    "get_report",
    "list_reports",
  ]);
  const reply = await client.callTool({
    name: "get_cover_sheet",
    arguments: {},
  });
  assert.notEqual(reply.isError, true, "TPS read failed");
  const content = z
    .object({
      content: z
        .array(z.object({ type: z.literal("text"), text: z.string() }))
        .min(1),
    })
    .parse(reply);
  z.object({
    text: z.string(),
    version: z.string(),
    is_empty: z.boolean(),
  }).parse(JSON.parse(content.content[0]!.text));
  return "initialize: instructions present; tools: exactly four; current cover sheet read answered; no save performed";
}

if (import.meta.main) {
  const client = new Client({ name: "milton-check", version: "0.0.0" });
  const url = process.argv[2];
  let server: ReturnType<typeof createMiltonServer> | undefined;
  try {
    if (url) {
      const token = process.env.MILTON_ACCESS_TOKEN;
      await client.connect(
        new StreamableHTTPClientTransport(new URL(url), {
          ...(token
            ? { requestInit: { headers: { Authorization: `Bearer ${token}` } } }
            : {}),
        }),
      );
    } else {
      server = createMiltonServer(stubStore());
      const [clientTransport, serverTransport] =
        InMemoryTransport.createLinkedPair();
      await server.connect(serverTransport);
      await client.connect(clientTransport);
    }
    console.log(await checkMcp(client));
  } finally {
    await client.close();
    await server?.close();
  }
}
