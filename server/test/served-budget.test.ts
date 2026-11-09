import { expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { stubStore } from "../scripts/check-mcp";
import { createMiltonServer } from "../src/mcp";

// Characters per served tool description, read and kept by every assistant at
// connect. Each budget is the size on 2026-11-09 (memos) plus 10-15% headroom, so growth
// beyond that is a deliberate edit here, made with the description change.
const BUDGETS: Record<
  "readWrite" | "readOnly",
  { tools: Record<string, number>; total: number }
> = {
  readWrite: {
    tools: { get_cover_sheet: 570, get_report: 860, create_memo: 1900 },
    total: 3300, // 2,982 served
  },
  readOnly: {
    tools: { get_cover_sheet: 330, get_report: 510 },
    total: 830, // 745 served
  },
};

test("each served tool description, and all of them together, stays within its budget", async () => {
  for (const [mode, budget] of Object.entries(BUDGETS)) {
    const server = createMiltonServer(stubStore(), () => {}, {
      readOnly: mode === "readOnly",
    });
    const client = new Client({ name: "budget", version: "0" });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const tools = (await client.listTools()).tools;
      // One word for each thing (SPEC.md): never the retired names.
      for (const tool of tools)
        expect(tool.description).not.toMatch(
          /\b(assistants?|samples?|trails?|lessons?|rules?)\b/i,
        );
      const sizes = Object.fromEntries(
        tools.map((tool) => [tool.name, tool.description?.length ?? 0]),
      );
      const over = Object.entries(sizes).flatMap(([name, size]) => {
        const limit = budget.tools[name];
        return limit === undefined || size > limit
          ? [
              `${mode} ${name}: ${size} characters, budget ${limit ?? "none"} (server/test/served-budget.test.ts); shorten it or raise the budget deliberately`,
            ]
          : [];
      });
      const total = Object.values(sizes).reduce((a, b) => a + b, 0);
      if (total > budget.total)
        over.push(
          `${mode} total: ${total} characters, budget ${budget.total}; shorten the descriptions or raise the budget deliberately`,
        );
      expect(over).toEqual([]);
      expect(Object.keys(sizes).sort()).toEqual(
        Object.keys(budget.tools).sort(),
      );
    } finally {
      await client.close();
    }
  }
});
