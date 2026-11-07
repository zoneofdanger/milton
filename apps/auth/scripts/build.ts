import { mkdir, cp, readFile, writeFile } from "node:fs/promises";
const base = new URL("../", import.meta.url);
await mkdir(new URL("dist/public/fonts/", base), { recursive: true });
const theme = await readFile(
  new URL("../../../packages/theme/base.css", import.meta.url),
  "utf8",
);
const css = await readFile(new URL("src/auth.css", base), "utf8");
const themeImport =
  /@import\s+(["'])\.\.\/\.\.\/\.\.\/packages\/theme\/base\.css\1\s*;/g;
if ([...css.matchAll(themeImport)].length !== 1) {
  throw new Error("auth_theme_import_missing_or_duplicated");
}
const bundledCss = css.replace(themeImport, () => theme);
if (/@import\b/i.test(bundledCss)) {
  throw new Error("auth_css_unresolved_import");
}
await writeFile(new URL("dist/public/auth.css", base), bundledCss);
await cp(
  new URL("../../../packages/theme/public/fonts/", import.meta.url),
  new URL("dist/public/fonts/", base),
  { recursive: true },
);
await cp(
  new URL("../../../packages/theme/public/favicon.svg", import.meta.url),
  new URL("dist/public/favicon.svg", base),
);
const r = await Bun.build({
  entrypoints: [
    new URL("src/cloud-run.ts", base).pathname,
    new URL("scripts/deliver.ts", base).pathname,
    new URL("src/app.tsx", base).pathname,
  ],
  outdir: new URL("dist", base).pathname,
  naming: "[name].js",
  target: "node",
  format: "esm",
  external: ["pg-native"],
});
if (!r.success) throw new Error("auth_build_failed");
console.log("Auth Node bundle and local theme assets built.");
