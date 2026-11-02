import {
  createMcpHandler,
  hostHeaderValidationResponse,
  originValidationResponse,
} from "@modelcontextprotocol/server";
import { createMiltonServer } from "./mcp";
import {
  guardStoreRequest,
  lookupIdentityAccount,
  storeForCurrentRequest,
  type StoreBindings,
  StoreError,
} from "./store";
import {
  AuthError,
  createAccessTokenVerifier,
  type AccessTokenVerifier,
} from "./token";
import { isLoopback } from "./config";
import { boundRequest } from "./http";
import { z } from "zod";
import {
  finalToolCall,
  knownTool,
  safeToolLog,
  type ToolCall,
} from "./mcp-outcomes";
import { storeResult } from "./store/tools";

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
export function validateMcpTransport(
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
  const hosts = allowedHosts(config);
  const refused =
    hostHeaderValidationResponse(request, hosts) ??
    originValidationResponse(request, [...hosts, "claude.ai", "chatgpt.com"]);
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
  return async (request: Request): Promise<Response> => {
    const refusal = validateMcpTransport(request, config);
    if (refusal) return refusal;
    const started = performance.now();
    let pending: ToolCall["tool"] | undefined,
      emitted = false;
    const emit = (event: ToolCall) => {
      emitted = true;
      safeToolLog(log, {
        ...event,
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
      const identity = await verify(request.headers.get("Authorization"));
      const bindings = { ...config, MEMOS_SOURCE: "store" };
      // Also refuses an assistant the person disconnected, on every request.
      const auth = await lookupIdentityAccount(bindings, {
        provider: "neon",
        subject: identity.subject,
        clientId: identity.clientId,
      });
      const checked = await guardStoreRequest(bounded, bindings);
      if (checked instanceof Response) {
        recordFailure("request_too_large");
        return withMcpCors(checked);
      }
      const store = await storeForCurrentRequest(bindings, auth, {
        issuer: identity.issuer,
        clientId: identity.clientId,
      });
      const sdk = createMcpHandler(
        () => createMiltonServer([], () => identity.clientId, emit, store),
        {
          legacy: "stateless",
          maxSubscriptions: 0,
          keepAliveMs: 0,
          maxRequestBodySize: 65536,
        },
      );
      const result = await sdk.fetch(checked);
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
