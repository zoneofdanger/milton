import { serve } from "@hono/node-server";
import { loadEnvironment } from "./environment";
import { mcpRuntimeConfig, runtimeConfig } from "./config";
import { createMcpApp } from "./index";
import { createCloudApp } from "./cloud-app";
import { logUnexpected } from "./error-log";

try {
  const env = loadEnvironment();
  const port = Number(env.PORT ?? 8080);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error();
  if (!["app", "mcp"].includes(env.MILTON_SERVICE ?? "")) throw new Error();
  const fetch =
    env.MILTON_SERVICE === "app"
      ? createCloudApp(runtimeConfig(env))
      : createMcpApp(mcpRuntimeConfig(env));
  const server = serve({ fetch, port, hostname: "0.0.0.0" });
  const shutdown = () => {
    server.close(() => process.exit(0));
    // Cloud Run grants ten seconds. An interrupted save keeps its claimed
    // receipt, which expires at its deadline; replay then reports the outcome.
    setTimeout(() => process.exit(0), 8000).unref();
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
} catch (error) {
  // Runtime configuration unavailable or invalid; never log its values.
  logUnexpected("startup", error);
  process.exitCode = 1;
}
