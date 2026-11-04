import { runtimeConfig } from "../src/config";
import { createMiltonApp } from "../src/index";
import { loadEnvironment } from "../src/environment";
import { localAsset } from "../src/assets";
import { build } from "vite";
import assets from "../vite.config";

const port = Number(process.env.PORT ?? 3001);
if (!Number.isInteger(port) || port < 1 || port > 65535)
  throw new Error("Set PORT to an available local port.");
const env = loadEnvironment();
const app = createMiltonApp(runtimeConfig(env), env.MILTON_SERVICE === "app");
// CSS rebuilds on change; production pages intentionally need no browser scripts.
await build({
  ...assets,
  configFile: false,
  build: { ...assets.build, watch: {} },
});
const server = Bun.serve({
  hostname: "127.0.0.1",
  port,
  async fetch(request) {
    const asset = localAsset(request);
    if (asset) return asset;
    return app(request);
  },
});
console.log(`Milton local server listening on localhost:${server.port}.`);
