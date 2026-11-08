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
    // The daily end-to-end check, run as the Cloud Run job milton-e2e-daily.
    new URL("./e2e.ts", import.meta.url).pathname,
  ],
  outdir: new URL("../dist/", import.meta.url).pathname,
  naming: "[name].js",
  target: "node",
  format: "esm",
  // Smaller bundles load faster on deploys and scale-out. Identifiers stay:
  // error-log.ts logs constructor names, and Bun 1.4.4 ignores keepNames.
  minify: { whitespace: true, syntax: true, identifiers: false },
  // Maps stay beside the bundles for local `node --enable-source-maps`; the
  // image copies only the bundles.
  sourcemap: "linked",
});
if (!cloud.success)
  throw new Error("Bundling the Cloud Run entrypoint failed.");
console.log(
  "Bundled app/MCP, finite guide worker and end-to-end check entrypoints.",
);
