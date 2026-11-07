import { forwardedClient } from "@milton/forwarded-client";
import { AUTH_ORIGIN } from "./config.ts";
const browserPosts = new Set([
  "/sign-up/email",
  "/sign-in/email",
  "/sign-in/social",
  "/sign-out",
  "/send-verification-email",
  "/request-password-reset",
  "/reset-password",
  "/change-password",
  "/link-social",
  "/unlink-account",
  "/revoke-session",
  "/revoke-sessions",
  "/revoke-other-sessions",
  "/oauth2/consent",
  "/oauth2/continue",
  "/oauth2/end-session/confirm",
]);
const nativeGets = new Set([
  "/get-session",
  "/list-sessions",
  "/list-accounts",
  "/verify-email",
  "/reset-password/:token",
  "/jwks",
  "/ok",
  "/error",
  "/.well-known/openid-configuration",
  "/.well-known/oauth-authorization-server",
  "/oauth2/authorize",
  "/oauth2/userinfo",
  "/oauth2/end-session",
]);
const nativePosts = new Set([
  ...browserPosts,
  "/oauth2/token",
  "/oauth2/revoke",
  "/oauth2/introspect",
  "/oauth2/register",
]);
export function nativeEndpointEnabled(path: string) {
  return (
    nativeGets.has(path) ||
    nativePosts.has(path) ||
    path === "/callback/:id" ||
    /^\/callback\/(google|github)$/.test(path)
  );
}
export function json(value: unknown, status = 200) {
  return Response.json(value, {
    status,
    headers: {
      "cache-control": "no-store",
      "referrer-policy": "strict-origin",
    },
  });
}
export function guardRequest(request: Request): Response | undefined {
  const u = new URL(request.url);
  if (
    u.origin !== AUTH_ORIGIN ||
    (request.headers.has("host") && request.headers.get("host") !== u.host)
  )
    return json({ error: "canonical_auth_host_required" }, 421);
  if (
    request.headers.get("origin") &&
    request.headers.get("origin") !== AUTH_ORIGIN
  )
    return json({ error: "same_origin_required" }, 403);
  if (
    u.search.length > 8192 ||
    [...request.headers].reduce((n, [a, b]) => n + a.length + b.length, 0) >
      16384
  )
    return json({ error: "request_too_large" }, 413);
  if (
    request.headers.has("transfer-encoding") &&
    request.headers.has("content-length")
  )
    return json({ error: "ambiguous_body" }, 400);
  if (Number(request.headers.get("content-length") ?? 0) > 16384)
    return json({ error: "request_too_large" }, 413);
  if (
    [
      "password",
      "newPassword",
      "currentPassword",
      "client_secret",
      "access_token",
      "refresh_token",
      "id_token",
      "id_token_hint",
      "client_assertion",
    ].some((k) => u.searchParams.has(k))
  )
    return json({ error: "credential_query_refused" }, 400);
  if (
    u.searchParams.has("token") &&
    !["/api/auth/verify-email", "/reset-password"].includes(u.pathname)
  )
    return json({ error: "credential_query_refused" }, 400);
  const path = u.pathname.startsWith("/api/auth/") ? u.pathname.slice(9) : "";
  if (!path) return;
  const callback = /^\/callback\/(google|github)$/.test(path);
  const resetGet = /^\/reset-password\/[^/]+$/.test(path);
  if (
    (request.method === "GET" &&
      !nativeGets.has(path) &&
      !callback &&
      !resetGet) ||
    (request.method === "POST" && !nativePosts.has(path) && !callback) ||
    !["GET", "POST"].includes(request.method)
  )
    return json({ error: "method_not_available" }, 403);
  if (
    request.method === "POST" &&
    browserPosts.has(path) &&
    request.headers.get("origin") !== AUTH_ORIGIN
  )
    return json({ error: "same_origin_required" }, 403);
  if (path === "/reset-password" && request.method === "GET")
    return json({ error: "use_reset_form" }, 405);
}
export async function boundedBody(request: Request): Promise<string> {
  if (!request.body) return "";
  const reader = request.body.getReader();
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const r = await reader.read();
      if (r.done) break;
      size += r.value.byteLength;
      if (size > 16384) throw new Error("body_limit");
      chunks.push(r.value);
    }
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const part of chunks) {
    bytes.set(part, offset);
    offset += part.length;
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}
export const SECURITY_HEADERS = {
  "cache-control": "no-store",
  "referrer-policy": "strict-origin",
  "x-content-type-options": "nosniff",
  "content-security-policy":
    "default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  "strict-transport-security": "max-age=31536000",
};
/**
 * The client address Google's external Application Load Balancer saw, used
 * for the network rate limits: forwardedClient's rules, shared with the MCP
 * server's keyAttemptSource. This holds only while auth ingress is
 * internal-and-cloud-load-balancing. An IPv6 client's /64 is returned as a
 * valid address ("a:b:c:d::") for Better Auth's IP header. Without a
 * well-formed pair, undefined: the caller keeps the socket peer (local runs
 * and tests).
 */
export function loadBalancerClient(forwarded: string | null) {
  const client = forwardedClient(forwarded);
  return client && ("ipv4" in client ? client.ipv4 : `${client.ipv6Prefix}::`);
}
