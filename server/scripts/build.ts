import { fileURLToPath } from "node:url";
import { build } from "vite";
import { versionAssets } from "@milton/theme/assets";
import { PUBLIC_ASSETS } from "../src/assets";
import assets from "../vite.config";

await build({ ...assets, configFile: false });
versionAssets(
  fileURLToPath(new URL("../public/", import.meta.url)),
  PUBLIC_ASSETS,
);

const cloud = await Bun.build({
  entrypoints: [
    new URL("../src/cloud-run.ts", import.meta.url).pathname,
    new URL("../src/guide-worker.ts", import.meta.url).pathname,
  ],
  outdir: new URL("../dist/", import.meta.url).pathname,
  naming: "[name].js",
  target: "node",
  format: "esm",
});
if (!cloud.success)
  throw new Error("Bundling the Cloud Run entrypoint failed.");
console.log("Bundled app/MCP and finite guide worker entrypoints.");
