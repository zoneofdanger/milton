import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  // Server secrets belong to runtime configuration, never the asset build.
  envDir: false,
  publicDir: fileURLToPath(
    new URL("../packages/theme/public", import.meta.url),
  ),
  build: {
    outDir: "public",
    emptyOutDir: false,
    rolldownOptions: {
      input: fileURLToPath(new URL("./src/client.css", import.meta.url)),
      output: { assetFileNames: "milton.[ext]" },
    },
  },
});
