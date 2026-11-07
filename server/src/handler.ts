import {
  createMcpHandler,
  hostHeaderValidationResponse,
} from "@modelcontextprotocol/server";
import { createMiltonServer } from "./mcp";
import {
  connectionKeyAccount,
  lookupIdentityAccount,
  storeForCurrentRequest,
  type StoreBindings,
  StoreError,
  type VerifiedStoreAuth,
} from "./store";
import {
  AuthError,
  createAccessTokenVerifier,
  type AccessTokenVerifier,
} from "./token";
import { isLoopback } from "./config";
import { boundRequest, MAX_REQUEST_BYTES } from "./http";
import { z } from "zod";
import {
  finalToolCall,
  knownTool,
  safeToolLog,
  type ToolCall,
} from "./mcp-outcomes";
import { storeResult } from "./mcp-tools";
import { bindingActive } from "./auth-authority";

const incomingTool = z.object({
  method: z.literal("tools/call"),
  params: z.object({ name: z.unknown().optional() }).catch({}),
});

export interface McpConfig extends StoreBindings {
  issuer: string;
  resource: string;
  appOrigin: string;
}
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "Content-Type, Accept, Authorization, mcp-session-id, MCP-Protocol-Version, Mcp-Method, Mcp-Name",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Expose-Headers":
    "WWW-Authenticate, mcp-session-id, MCP-Protocol-Version",
  "Access-Control-Max-Age": "86400",
};
export function withMcpCors(response: Response, methods = "POST, OPTIONS") {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(cors)) headers.set(name, value);
  headers.set("Access-Control-Allow-Methods", methods);
  headers.set("Cache-Control", "no-store");
  return new Response(response.body, { status: response.status, headers });
}
export function allowedHosts(
  config: Pick<McpConfig, "resource" | "appOrigin">,
) {
  const hostnames = [
    new URL(config.resource).hostname,
    new URL(config.appOrigin).hostname,
  ];
  if (isLoopback(new URL(config.appOrigin).hostname))
    hostnames.push("localhost", "127.0.0.1", "[::1]");
  return hostnames;
}
function validateMcpTransport(
  request: Request,
  config: Pick<McpConfig, "resource" | "appOrigin">,
) {
  if (!["POST", "OPTIONS"].includes(request.method))
    return withMcpCors(
      Response.json(
        {
          jsonrpc: "2.0",
          error: { code: -32000, message: "Method not allowed." },
          id: null,
        },
        { status: 405, headers: { Allow: "POST, OPTIONS" } },
      ),
    );
  // The Host check stops DNS rebinding and tokens authenticate every call.
  // Origin is deliberately not restricted, so web clients reach auth.
  const refused = hostHeaderValidationResponse(request, allowedHosts(config));
  if (refused) return withMcpCors(refused);
  if (request.method === "OPTIONS")
    return withMcpCors(new Response(null, { status: 200 }));
  return null;
}
export function createMiltonHandler(
  config: McpConfig,
  verify: AccessTokenVerifier = createAccessTokenVerifier(config),
  log: (call: ToolCall) => void = (call) => console.info(JSON.stringify(call)),
) {
  // Assistants (account and OAuth client) this process has served a tool call.
  // Each one's first tool call after startup carries tools/list_changed, so a
  // client still holding the tool schemas from before a release refreshes
  // them. Memory only, bounded; a cleared or restarted set announces again.
  const announced = new Set<string>();
  return async (request: Request): Promise<Response> => {
    const refusal = validateMcpTransport(request, config);
    if (refusal) return refusal;
    const started = performance.now();
    let pending: ToolCall["tool"] | undefined,
      keyId: string | undefined,
      emitted = false;
    const emit = (event: ToolCall) => {
      emitted = true;
      safeToolLog(log, {
        ...event,
        ...(keyId ? { connection_key: keyId } : {}),
        elapsed_ms: Math.max(
          0,
          Math.min(3_600_000, Math.round(performance.now() - started)),
        ),
      });
    };
    const recordFailure = (code: string) => {
      if (pending && !emitted)
        emit(
          finalToolCall(pending, started, {
            result: storeResult({ error: code }, true),
          }),
        );
    };
    try {
      const bounded = await boundRequest(request);
      if (bounded instanceof Response) return withMcpCors(bounded);
      // Parse only an already bounded clone. Retain a whitelisted name, never
      // the input/task, so access/DB refusals before SDK dispatch are observed.
      const call = incomingTool.safeParse(
        await bounded
          .clone()
          .json()
          .catch(() => undefined),
      );
      if (call.success) pending = knownTool(call.data.params.name);
      const authorization = request.headers.get("Authorization");
      let auth: VerifiedStoreAuth,
        assistant: { issuer: string; clientId: string },
        write: boolean,
        announcedAs: string;
      if (authorization !== null && /^Bearer mk_/i.test(authorization)) {
        // A connection key. Every refusal, whatever its reason, answers like
        // an invalid token. Only the key's public id is ever logged.
        const key = await connectionKeyAccount(config, authorization.slice(7));
        if (!key)
          throw new AuthError(
            "invalid_token",
            "Reconnect your assistant to Milton.",
            401,
          );
        write = key.scope === "read_write";
        if (call.success && call.data.params.name === "create_memo" && !write)
          throw new AuthError(
            "insufficient_scope",
            "This connection key is read only. Create a key that can save.",
            403,
          );
        keyId = key.keyId;
        auth = key.auth;
        assistant = { issuer: "connection_key", clientId: key.keyId };
        announcedAs = `${auth.userId}\nconnection_key\n${key.keyId}`;
      } else {
        const identity = await verify(authorization);
        await bindingActive(config, identity);
        const scopes = identity.scope.split(" ");
        if (
          !scopes.includes("milton:read") ||
          (call.success &&
            call.data.params.name === "create_memo" &&
            !scopes.includes("milton:write"))
        )
          throw new AuthError(
            "insufficient_scope",
            "Reconnect this assistant with the permission this action needs.",
            403,
          );
        auth = await lookupIdentityAccount(config, {
          provider: identity.issuer,
          subject: identity.subject,
        });
        write = scopes.includes("milton:write");
        assistant = { issuer: identity.issuer, clientId: identity.clientId };
        announcedAs = `${auth.userId}\n${identity.clientId}`;
      }
      const store = await storeForCurrentRequest(config, auth, assistant);
      const announce = call.success && !announced.has(announcedAs);
      if (announce) {
        if (announced.size >= 10_000) announced.clear();
        announced.add(announcedAs);
      }
      const sdk = createMcpHandler(
        () =>
          createMiltonServer(store, emit, {
            announceToolsChanged: announce,
            readOnly: !write,
          }),
        {
          legacy: "stateless",
          maxSubscriptions: 0,
          keepAliveMs: 0,
          maxRequestBodySize: MAX_REQUEST_BYTES,
        },
      );
      const result = await sdk.fetch(bounded);
      if (result.status >= 400)
        recordFailure(
          result.status === 413 ? "request_too_large" : "protocol_error",
        );
      return withMcpCors(result);
    } catch (error) {
      recordFailure(
        error instanceof AuthError || error instanceof StoreError
          ? error.code
          : "server_unavailable",
      );
      if (error instanceof AuthError || error instanceof StoreError) {
        const headers = new Headers();
        if (error.status === 401) {
          const invalid = request.headers.has("Authorization")
            ? ', error="invalid_token"'
            : "";
          headers.set(
            "WWW-Authenticate",
            `Bearer resource_metadata="${new URL("/.well-known/oauth-protected-resource/mcp", config.resource).href}"${invalid}`,
          );
        }
        if (error.code === "insufficient_scope")
          headers.set(
            "WWW-Authenticate",
            `Bearer error="insufficient_scope", scope="milton:read${pending === "create_memo" ? " milton:write" : ""}"`,
          );
        return withMcpCors(
          Response.json(
            { error: error.code, message: error.message },
            { status: error.status, headers },
          ),
        );
      }
      return withMcpCors(
        Response.json(
          {
            error: "server_unavailable",
            message: "Milton is unavailable. Try again.",
          },
          { status: 503 },
        ),
      );
    }
  };
}
