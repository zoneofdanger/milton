import type { APIRoute } from "astro";
import { MCP_URL } from "../data/connect";

/** A short index for AIs that look for llms.txt; it points at /agents.md. Copy
 * approved by Peter, 2026-11-19. */
const body = `# Milton

> Milton makes your AI write like you. Milton keeps what you wrote and what you changed.
> Your AI reads it before it drafts. MCP server: ${MCP_URL}

- [Set up Milton](https://www.meetmilton.com/agents.md): steps for an AI to connect Milton
- [For agents](https://www.meetmilton.com/for-agents): what Milton keeps, its two tools, saving, price and limits
- [Tool reference](https://www.meetmilton.com/tools): arguments, results and errors
- [Pricing](https://www.meetmilton.com/pricing)
`;

export const GET: APIRoute = () =>
  new Response(body, {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
