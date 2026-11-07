import { z } from "zod";
import { strict as assert } from "node:assert";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { storeInstructions } from "../src/mcp";
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
