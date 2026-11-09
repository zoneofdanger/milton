import { z } from "zod";
import { strict as assert } from "node:assert";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { storeInstructions } from "../src/mcp";
import type { TenantStore } from "../src/store";
import { EMPTY_REPORT } from "../src/store/memos";

// An empty account that allows every call and saves nothing.
export function stubStore(): TenantStore {
  return {
    appOrigin: "http://localhost:3001",
    readCoverSheet: async () => ({
      text: "",
      version: 0,
      memos: 0,
      tweaks: 0,
      keep_memos: true,
      is_empty: true,
    }),
    readReport: async () => ({
      report_id: "00000000-0000-4000-8000-000000000000",
      text: EMPTY_REPORT,
      is_empty: true,
      examples: [],
      tweaks: [],
      kinds: [],
    }),
    saveMemo: async () => {
      throw new Error("The stub store saves nothing.");
    },
  };
}

export async function checkMcp(client: Client) {
  assert.equal(client.getInstructions(), storeInstructions);
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((tool) => tool.name).sort(), [
    "create_memo",
    "get_cover_sheet",
    "get_report",
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
    version: z.number(),
    is_empty: z.boolean(),
  }).parse(JSON.parse(content.content[0]!.text));
  return "initialize: instructions present; tools: exactly three; current cover sheet read answered; no save performed";
}
