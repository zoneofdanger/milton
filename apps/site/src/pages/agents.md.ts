import type { APIRoute } from "astro";
import { PRICE_USD, TRIAL_DAYS } from "@milton/theme/facts";
import {
  CLAUDE_CODE_COMMAND,
  CLAUDE_CONNECTOR_LINK,
  CODEX_ADD_COMMAND,
  CODEX_LOGIN_COMMAND,
  CURSOR_INSTALL_LINK,
  MCP_URL,
  VSCODE_COMMAND,
} from "../data/connect";

/** Setup steps an AI can follow end to end, as plain Markdown. Copy approved by
 * Peter, 2026-11-19; the URL, commands and price come from shared sources. */
const body = `# Set up Milton

Milton makes your AI write like you. It keeps what the person wrote and what they changed in
their AI's drafts, and their AI reads it before it drafts. These steps are for an AI setting
up Milton for the person who sent you here.

1. Check whether you already have Milton's tools, get_report and create_memo. If you do, go
   to step 4.
2. Add the server, ${MCP_URL}, the way your client does:
   - Claude Code: \`${CLAUDE_CODE_COMMAND}\`.
     Then ask the person to run /mcp, pick Milton and sign in.
   - Codex: \`${CODEX_ADD_COMMAND}\`, then
     \`${CODEX_LOGIN_COMMAND}\`. Start a new session if the tools don't appear.
   - Cursor: give the person this link: ${CURSOR_INSTALL_LINK}
   - VS Code: \`${VSCODE_COMMAND}\`
   - Claude on the web or desktop: give the person this link to add Milton as a custom
     connector: ${CLAUDE_CONNECTOR_LINK}. They turn Milton on in the conversation's connectors
     menu.
   - ChatGPT: you can't add it yourself. Ask the person to open Plugins, add a custom MCP
     server with the URL above and sign in.
3. The person signs in to Milton with Google or GitHub and approves the connection in their
   browser. You can't do this step for them. The first ${TRIAL_DAYS} days are free with no card, then
   $${PRICE_USD} a month.
4. Call get_report. Only a successful read confirms the connection. With no memos yet, the
   result holds a setup script: follow it.

If the person wants something written or cleaned up first, help with that; setup can wait.

Milton needs remote MCP, OAuth sign-in and tools that read and save; a plan or workspace
administrator may block these. An agent with no browser uses a connection key instead:
https://www.meetmilton.com/for-agents#headless
`;

export const GET: APIRoute = () =>
  new Response(body, {
    headers: { "Content-Type": "text/markdown; charset=utf-8" },
  });
