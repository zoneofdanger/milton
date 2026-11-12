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
    readReport: async () => ({
      text: EMPTY_REPORT,
      is_empty: true,
      examples: [],
      kinds: [],
      memos: 0,
      keep_memos: true,
    }),
    saveMemo: async () => {
      throw new Error("The stub store saves nothing.");
    },
    requestReceipt: async () => false,
  };
}

export async function checkMcp(client: Client) {
  assert.equal(client.getInstructions(), storeInstructions);
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((tool) => tool.name).sort(), [
    "create_memo",
    "get_report",
  ]);
  const reply = await client.callTool({
    name: "get_report",
    arguments: {
      intent: {
        situation: "confirming what is on file",
        medium: "email",
        audience: "the person",
        purpose: "check the connection",
      },
    },
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
    is_empty: z.boolean(),
    memos: z.number().int().min(0),
  }).parse(JSON.parse(content.content[0]!.text));
  return "initialize: instructions present; tools: exactly two; current report read answered; no save performed";
}
