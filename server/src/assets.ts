import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  ASSET_MANIFEST,
  staticAssets,
  type StaticAssets,
} from "@milton/theme/assets";

// Serve only the built public assets in the build's manifest, never arbitrary
// paths from the container. The bytes load and compress once.
export const PUBLIC_ASSETS = [
  "/milton.css",
  "/favicon.svg",
  "/favicon.ico",
  "/fonts/jetbrains-mono-regular.woff2",
  "/fonts/geist-latin-variable.woff2",
];
const publicDir = fileURLToPath(new URL("../public/", import.meta.url));
let loaded: StaticAssets | null | undefined;
// Without a build (bundled integration checks), pages link plain paths and no
// asset is served. The app service loads strictly at startup instead.
const assets = () =>
  loaded === undefined
    ? (loaded = existsSync(publicDir + ASSET_MANIFEST)
        ? staticAssets(publicDir)
        : null)
    : loaded;

/** The content-versioned URL of a built asset, for page links. */
export const assetUrl = (path: string) => assets()?.url(path) ?? path;

export function localAsset(request: Request): Response | null {
  return assets()?.respond(request) ?? null;
}

/** Load and verify the built assets now, failing if they are missing. */
export function loadAssets() {
  loaded = staticAssets(publicDir);
}

/** Local development: pick up a rebuilt stylesheet. */
export function reloadAssets() {
  loaded = undefined;
}
