import { z } from "zod";
import { strict as assert } from "node:assert";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { loadMemos } from "../src/memos";
import { createMiltonServer, storeInstructions } from "../src/mcp";

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
      server = createMiltonServer(
        await loadMemos(new URL("../../templates/", import.meta.url)),
        () => "milton-check",
      );
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
