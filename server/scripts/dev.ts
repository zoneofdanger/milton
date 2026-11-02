import entry from "../src/function";
import { localAsset } from "./assets";
import { build } from "vite";
import assets from "../vite.config";

const port = Number(process.env.PORT ?? 3001);
if (!Number.isInteger(port) || port < 1 || port > 65535)
  throw new Error("Set PORT to an available local port.");
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
    return entry.fetch(request);
  },
});
console.log(`Milton local server listening on localhost:${server.port}.`);
