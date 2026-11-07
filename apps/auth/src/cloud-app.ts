import { IncomingMessage } from "node:http";
import type { HttpBindings, Http2Bindings } from "@hono/node-server";
import type { AuthService } from "./provider.ts";
import { AUTH_ORIGIN } from "./config.ts";
import { createApp } from "./app.tsx";
import { json } from "./http.ts";
export function createCloudApp(auth: AuthService, assets: string) {
  const app = createApp(auth, assets);
  const http1 = (env: HttpBindings | Http2Bindings): env is HttpBindings =>
    env.incoming instanceof IncomingMessage;
  return (request: Request, env: HttpBindings | Http2Bindings) => {
    if (!http1(env)) return json({ error: "http1_required" }, 503);
    const u = new URL(request.url);
    if (
      u.host !== "auth.meetmilton.com" ||
      (request.headers.has("host") &&
        request.headers.get("host") !== "auth.meetmilton.com")
    )
      return json({ error: "canonical_auth_host_required" }, 421);
    // Cloud Run terminates TLS. After canonical Host validation, use the fixed
    // configured HTTPS origin, never Forwarded/X-Forwarded-Host/Proto values.
    const init: RequestInit & { duplex: "half" } = {
      method: request.method,
      headers: request.headers,
      body: request.body,
      signal: request.signal,
      duplex: "half",
    };
    return app.fetch(
      new Request(AUTH_ORIGIN + u.pathname + u.search, init),
      env,
    );
  };
}
