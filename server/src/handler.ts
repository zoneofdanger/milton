import {
  createMcpHandler,
  hostHeaderValidationResponse,
} from "@modelcontextprotocol/server";
import { createMiltonServer } from "./mcp";
import {
  type AssistantAuth,
  connectionKeyAccount,
  lookupIdentityAccount,
  parseConnectionKey,
  tenantStore,
  type StoreBindings,
  StoreError,
} from "./store";
import {
  AuthError,
  createAccessTokenVerifier,
  type AccessTokenVerifier,
} from "./token";
import { isLoopback } from "./config";
import { boundRequest, MAX_REQUEST_BYTES } from "./http";
import { forwardedClient } from "@milton/forwarded-client";
import { z } from "zod";
import {
  finalToolCall,
  knownTool,
  safeToolLog,
  type ToolCall,
  withNext,
} from "./mcp-outcomes";
import { storeResult } from "./mcp-tools";
import { bindingStatus, checkBinding, unavailable } from "./auth-authority";

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
const invalidKey = () =>
  new AuthError("invalid_token", "Reconnect your assistant to Milton.", 401);
const keyLookupBusy = () =>
  new AuthError("server_busy", "Milton is busy. Try again shortly.", 503);
class KeyAttemptsLimited extends AuthError {
  readonly retryAfter: number;
  constructor(retryAfter: number) {
    super("rate_limited", "Too many connection-key attempts. Try later.", 429);
    this.retryAfter = retryAfter;
  }
}

/**
 * The client address Google's external Application Load Balancer saw, used
 * only to limit connection-key attempts: forwardedClient's rules (the
 * second-to-last X-Forwarded-For entry; never the first, which the client
 * sent). MCP ingress is internal-and-cloud-load-balancing, so direct internet
 * requests to run.app are refused and every public request carries that
 * appended pair (https://docs.cloud.google.com/run/docs/securing/ingress).
 * Requests with no well-formed pair (local runs, internal callers) share one
 * "unknown" source. The socket peer is not used: behind Cloud Run it is
 * Google's front end, not the client. IPv6 clients are keyed as "a:b:c:d::/64".
 */
export function keyAttemptSource(request: Request): string {
  const client = forwardedClient(request.headers.get("X-Forwarded-For"));
  if (!client) return "unknown";
  return "ipv4" in client ? client.ipv4 : `${client.ipv6Prefix}::/64`;
}

/**
 * Bounds unauthenticated database work on the connection-key path, per
 * process, before any database access. Anyone can send well-formed keys with
 * invented ids, so:
 * - each source (see keyAttemptSource) has a token bucket of 5, refilled at 10
 *   a minute, in a 10,000-source LRU. A lookup reserves one token before it
 *   takes a slot; an empty bucket gets 429 with Retry-After, without touching
 *   the database or a slot. A failed lookup keeps its token; a successful one
 *   is refunded to 0.1, so an agent can make about 100 key calls a minute
 *   while one source's invented keys reach the database about 10 times a
 *   minute. Requests that never reach the database (malformed keys, busy
 *   refusals) cost nothing;
 * - each source runs at most 3 lookups at once, however far its bucket has
 *   refilled while earlier ones stall (up to the 20-second statement
 *   timeout); a 4th gets 429 with Retry-After: 1, without touching the
 *   database or a slot, so one source can never fill all the slots. These
 *   counts live outside the bucket LRU, so evicting a bucket never forgets
 *   a running lookup. An entry exists only while its source has a lookup
 *   running and every running lookup holds a slot (there is no queue), so
 *   there are never more than 8 entries;
 * - at most 8 lookups run at once across all sources (beyond that a quick 503
 *   with Retry-After, without touching the database).
 * All of this is per instance; MCP runs at most 3, so the effective limits are
 * up to three times these.
 */
function keyLookupGate(
  concurrent = 8,
  entries = 10_000,
  burst = 5,
  perMinute = 10,
  successCost = 0.1,
  perSource = 3,
) {
  let running = 0;
  const active = new Map<string, number>(); // source → lookups running
  const buckets = new Map<string, { tokens: number; at: number }>(); // LRU
  const bucket = (source: string) => {
    const now = Date.now();
    const found = buckets.get(source);
    buckets.delete(source);
    if (!found && buckets.size >= entries)
      buckets.delete(buckets.keys().next().value!);
    const current = {
      tokens: found
        ? Math.min(
            burst,
            found.tokens + ((now - found.at) * perMinute) / 60_000,
          )
        : burst,
      at: now,
    };
    buckets.set(source, current);
    return current;
  };
  const refund = (source: string, tokens: number) => {
    const current = bucket(source);
    current.tokens = Math.min(burst, current.tokens + tokens);
  };
  return async <T>(
    source: string,
    lookup: () => Promise<{ ok: true; value: T } | { ok: false }>,
  ): Promise<T | undefined> => {
    const reserved = bucket(source);
    if (reserved.tokens < 1)
      throw new KeyAttemptsLimited(
        Math.ceil(((1 - reserved.tokens) * 60) / perMinute),
      );
    const mine = active.get(source) ?? 0;
    if (mine >= perSource) throw new KeyAttemptsLimited(1);
    if (running >= concurrent) throw keyLookupBusy();
    reserved.tokens -= 1;
    active.set(source, mine + 1);
    running++;
    try {
      const result = await lookup();
      if (result.ok) {
        refund(source, 1 - successCost);
        return result.value;
      }
      return undefined;
    } finally {
      running--;
      const left = active.get(source)! - 1;
      if (left > 0) active.set(source, left);
      else active.delete(source);
    }
  };
}

export function createMiltonHandler(
  config: McpConfig,
  verify: AccessTokenVerifier = createAccessTokenVerifier(config),
  log: (call: ToolCall) => void = (call) => console.info(JSON.stringify(call)),
) {
  const keyLookup = keyLookupGate();
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
      // boundRequest's only refusal; MCP's body adds the code and next step.
      if (bounded instanceof Response)
        return withMcpCors(
          Response.json(withNext({ error: "request_too_large" }), {
            status: bounded.status,
          }),
        );
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
      let auth: AssistantAuth,
        assistant: { issuer: string; clientId: string },
        write: boolean,
        announcedAs: string;
      if (authorization !== null && /^Bearer mk_/i.test(authorization)) {
        // A connection key. Every refusal, whatever its reason, answers like
        // an invalid token. Only the key's public id is ever logged.
        const parsed = parseConnectionKey(authorization.slice(7));
        if (!parsed) throw invalidKey();
        const key = await keyLookup(keyAttemptSource(request), async () => {
          const found = await connectionKeyAccount(config, parsed);
          return found.ok ? { ok: true as const, value: found } : found;
        });
        if (!key) throw invalidKey();
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
        const scopes = identity.scope.split(" ");
        // One statement reads the native binding and the account; refusals
        // keep their order: binding (401), scope (403), then account (403).
        // A failed statement is an auth outage (503).
        auth = await lookupIdentityAccount(
          config,
          { provider: identity.issuer, subject: identity.subject },
          {
            value: bindingStatus(config, identity),
            admit(status) {
              checkBinding(status, identity);
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
            },
            outage: unavailable,
          },
        );
        write = scopes.includes("milton:write");
        assistant = { issuer: identity.issuer, clientId: identity.clientId };
        announcedAs = `${auth.userId}\n${identity.clientId}`;
      }
      // `auth` comes from this request's identity or key statement, which
      // requires an active account and reads the store limits, so building the
      // store makes no query (invalid limits refuse here, before any work);
      // initialize, tools/list and notifications make no store query at all.
      const store = tenantStore(config, auth, assistant);
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
        if (error.code === "server_busy") headers.set("Retry-After", "1");
        if (error instanceof KeyAttemptsLimited)
          headers.set("Retry-After", String(error.retryAfter));
        if (error.code === "insufficient_scope")
          headers.set(
            "WWW-Authenticate",
            `Bearer error="insufficient_scope", scope="milton:read${pending === "create_memo" ? " milton:write" : ""}"`,
          );
        return withMcpCors(
          Response.json(
            withNext({ error: error.code, message: error.message }),
            { status: error.status, headers },
          ),
        );
      }
      return withMcpCors(
        Response.json(
          withNext({
            error: "server_unavailable",
            message: "Milton is unavailable. Try again.",
          }),
          { status: 503 },
        ),
      );
    }
  };
}
