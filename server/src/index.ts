import { hostHeaderValidationResponse } from "@modelcontextprotocol/server";
import type { AdmitConfig, RuntimeConfig } from "./config";
import {
  allowedHosts,
  createMiltonHandler,
  withMcpCors,
  type McpConfig,
} from "./handler";
import { browserPages } from "./auth";
import { stripeWebhook } from "./billing";
import { boundRequest } from "./http";
import { logUnexpected } from "./error-log";
import { unavailablePage } from "./pages";
import { Hono } from "hono";
import { ADMISSION_PATHS, authAdmission } from "./auth-admission";

export function createMiltonApp(config: RuntimeConfig, browserOnly = false) {
  return createHttpApp(
    config,
    browserPages(config),
    browserOnly,
    stripeWebhook(config),
  );
}

/** The admission service (MILTON_SERVICE=admit, Cloud Run `milton-admit`):
 * auth's two calls and the auth maintenance job's pending-enrolment sweep, and
 * nothing else. It is not behind the load balancer, and Cloud Run's invoker
 * check admits only auth's and the maintenance job's service accounts; the
 * bearer is the second check. */
export function createAdmitApp(config: AdmitConfig) {
  const admission = authAdmission(config);
  return async (request: Request): Promise<Response> => {
    if (!ADMISSION_PATHS.includes(new URL(request.url).pathname))
      return new Response(null, {
        status: 404,
        headers: { "Cache-Control": "no-store" },
      });
    try {
      return await admission(request);
    } catch (error) {
      logUnexpected("http", error);
      return new Response(null, {
        status: 503,
        headers: { "Cache-Control": "no-store" },
      });
    }
  };
}

export function createMcpApp(config: McpConfig) {
  const app = createHttpApp(config);
  return async (request: Request) => {
    // The load balancer preserves the canonical Host; run.app and app hosts
    // must not provide an alternate authenticated MCP endpoint.
    const refusal = hostHeaderValidationResponse(request, [
      new URL(config.resource).hostname,
    ]);
    return refusal ?? app(request);
  };
}

// A browser asking for a page: GET or HEAD, Accept lists text/html, and not
// the MCP endpoint, the health check or resource discovery (all JSON). The
// Stripe webhook is POST only, so its errors are always JSON.
function isPageRequest(request: Request) {
  const path = new URL(request.url).pathname;
  return (
    (request.method === "GET" || request.method === "HEAD") &&
    path !== "/mcp" &&
    path !== "/health" &&
    !path.startsWith("/.well-known/") &&
    (request.headers.get("Accept") ?? "")
      .split(",")
      .some((type) => type.split(";")[0]!.trim().toLowerCase() === "text/html")
  );
}

function createHttpApp(
  config: McpConfig,
  pages?: ReturnType<typeof browserPages>,
  browserOnly = false,
  webhook?: ReturnType<typeof stripeWebhook>,
) {
  const mcp = createMiltonHandler(config);
  const app = new Hono();
  app.onError((error, context) => {
    logUnexpected("http", error);
    if (isPageRequest(context.req.raw)) return unavailablePage();
    return Response.json(
      {
        error: "server_unavailable",
        message: "Milton is unavailable. Try again.",
      },
      {
        status: 503,
        headers: { "Cache-Control": "no-store" },
      },
    );
  });
  // MCP owns its protocol, body bounds and bearer authentication.
  app.all("/mcp", (context) =>
    browserOnly ? new Response(null, { status: 404 }) : mcp(context.req.raw),
  );
  app.use("*", async (context, next) => {
    const hostRefusal = hostHeaderValidationResponse(
      context.req.raw,
      allowedHosts(config),
    );
    if (hostRefusal) return hostRefusal;
    await next();
  });
  app.all("/health", (context) =>
    context.req.raw.method === "GET"
      ? Response.json(
          { status: "ok" },
          { headers: { "Cache-Control": "no-store" } },
        )
      : new Response(null, { status: 405 }),
  );
  for (const path of [
    "/.well-known/oauth-protected-resource",
    "/.well-known/oauth-protected-resource/mcp",
  ])
    app.all(path, (context) => {
      const request = context.req.raw;
      if (request.method === "OPTIONS")
        return withMcpCors(new Response(null, { status: 200 }), "GET, OPTIONS");
      if (request.method !== "GET")
        return withMcpCors(new Response(null, { status: 405 }), "GET, OPTIONS");
      return withMcpCors(
        Response.json({
          resource: config.resource,
          authorization_servers: [config.issuer],
          bearer_methods_supported: ["header"],
          scopes_supported: ["milton:read", "milton:write"],
        }),
        "GET, OPTIONS",
      );
    });
  // Stripe's webhook owns its body bound and signature check. It is routed
  // before the browser pages, so no session, cookie or CSRF check reaches it.
  if (webhook)
    app.all("/billing/webhook", (context) => webhook(context.req.raw));
  // Admission is the separate milton-admit service; neither public service has
  // an internal route, on its own host or through the MCP host's redirect.
  app.all("/internal/*", () => new Response(null, { status: 404 }));
  app.all("*", async (context) => {
    const request = context.req.raw;
    const resourceHost = new URL(config.resource).host;
    const url = new URL(request.url);
    // The MCP host serves assistants only; people use the app host.
    if (
      url.host === resourceHost &&
      new URL(config.appOrigin).host !== resourceHost
    )
      return Response.redirect(
        config.appOrigin + url.pathname + url.search,
        308,
      );
    if (!pages) return new Response(null, { status: 404 });
    const bounded = await boundRequest(request);
    return bounded instanceof Response ? bounded : pages(bounded);
  });
  return async (request: Request): Promise<Response> => app.fetch(request);
}
