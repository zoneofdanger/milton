/** How each AI connects to Milton. `/setup` and `/agents.md` both read these, so
 * the server URL and the commands people and agents run can't drift apart. */

/** Milton's MCP server. */
export const MCP_URL = "https://mcp.meetmilton.com/mcp";

/** Claude Code, at user scope so every project has it. */
export const CLAUDE_CODE_COMMAND = `claude mcp add --transport http --scope user milton ${MCP_URL}`;

/** Codex adds the server, then signs in. */
export const CODEX_ADD_COMMAND = `codex mcp add milton --url ${MCP_URL}`;
export const CODEX_LOGIN_COMMAND = "codex mcp login milton";

/** Cursor's install link: the server entry, JSON then base64, without its name
 * (https://cursor.com/docs/context/mcp/install-links). */
export const CURSOR_INSTALL_LINK = `cursor://anysphere.cursor-deeplink/mcp/install?name=milton&config=${btoa(JSON.stringify({ url: MCP_URL }))}`;

/** VS Code adds a named server in its own format to the user profile
 * (https://code.visualstudio.com/docs/agents/reference/mcp-configuration). */
export const VSCODE_COMMAND = `code --add-mcp '${JSON.stringify({ name: "milton", type: "http", url: MCP_URL })}'`;

/** Claude's custom connector dialog with the name and URL filled in; the person
 * still confirms (https://claude.com/docs/connectors/building/directory-vs-custom). */
export const CLAUDE_CONNECTOR_LINK = `https://claude.ai/customize/connectors?modal=add-custom-connector&connectorName=Milton&connectorUrl=${encodeURIComponent(MCP_URL)}`;

/** The one line a person pastes so their AI sets Milton up from /agents.md
 * (copy approved by Peter, 2026-11-19). */
export const AGENTS_PROMPT =
  "Set up Milton for me: read https://www.meetmilton.com/agents.md and follow it.";
