import { defineConfig } from "astro/config";
import { copyFileSync, cpSync, mkdirSync } from "node:fs";

// Build and dev serve the same local masters as the app. No runtime font service.
const publicDirectory = new URL("./public/", import.meta.url);
mkdirSync(publicDirectory, { recursive: true });
cpSync(
  new URL("../../packages/theme/public/", import.meta.url),
  publicDirectory,
  { recursive: true },
);
// The site serves the theme's Latin subset of JetBrains Mono at the regular URL;
// the app keeps the full master there. See packages/theme/README.md.
copyFileSync(
  new URL(
    "../../packages/theme/public/fonts/jetbrains-mono-latin.woff2",
    import.meta.url,
  ),
  new URL("./fonts/jetbrains-mono-regular.woff2", publicDirectory),
);

export default defineConfig({
  site: "https://www.meetmilton.com",
  output: "static",
  devToolbar: { enabled: false },
  vite: { server: { strictPort: true } },
});
