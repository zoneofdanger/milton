import { hostHeaderValidationResponse } from "@modelcontextprotocol/server";
import type { RuntimeConfig } from "./config";
import {
  allowedHosts,
  createMiltonHandler,
  withMcpCors,
  type McpConfig,
} from "./handler";
import { browserPages } from "./auth";
import { boundRequest } from "./http";
import { logUnexpected } from "./error-log";
import { Hono } from "hono";

export function createMiltonApp(config: RuntimeConfig, browserOnly = false) {
  return createHttpApp(config, browserPages(config), browserOnly);
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

function createHttpApp(
  config: McpConfig,
  pages?: ReturnType<typeof browserPages>,
  browserOnly = false,
) {
  const mcp = createMiltonHandler(config);
  const app = new Hono();
  app.onError((error) => {
    logUnexpected("http", error);
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
        }),
        "GET, OPTIONS",
      );
    });
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
