import { Server } from "node:http";
import { serve } from "@hono/node-server";
import { readConfig, safeError } from "./config.ts";
import { createProvider } from "./provider.ts";
import { createCloudApp } from "./cloud-app.ts";
import { loadEnvironment } from "./environment.ts";
import { checkRuntimeRole } from "./roles.ts";
const config = readConfig(loadEnvironment());
const auth = createProvider(config);
await checkRuntimeRole(auth.pool, "milton_auth_runtime");
const fetch = createCloudApp(
  auth,
  new URL("./public/", import.meta.url).pathname,
);
const server = serve({ fetch, port: config.PORT, hostname: "0.0.0.0" });
if (!(server instanceof Server)) throw new Error("http1_runtime_required");
server.requestTimeout = 15000;
server.headersTimeout = 10000;
server.keepAliveTimeout = 5000;
server.maxHeadersCount = 64;
server.on("error", (error) => console.error("auth_listener", safeError(error)));
for (const signal of ["SIGTERM", "SIGINT"])
  process.once(signal, () => {
    server.close(() => {
      void auth.pool.end();
    });
  });
