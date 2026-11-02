import { build } from "vite";
import assets from "../vite.config";

await build({ ...assets, configFile: false });

const cloud = await Bun.build({
  entrypoints: [new URL("../src/cloud-run.ts", import.meta.url).pathname],
  outdir: new URL("../dist/", import.meta.url).pathname,
  naming: "cloud-run.js",
  target: "node",
  format: "esm",
});
if (!cloud.success)
  throw new Error("Bundling the Cloud Run entrypoint failed.");
console.log("Bundled Cloud Run into dist/cloud-run.js.");
