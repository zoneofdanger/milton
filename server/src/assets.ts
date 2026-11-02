import { readFileSync } from "node:fs";

// Serve only built public assets, never arbitrary paths from the container.
const assets: Record<string, string> = {
  "/milton.css": "text/css; charset=utf-8",
  "/favicon.svg": "image/svg+xml",
  "/favicon.ico": "image/x-icon",
  "/fonts/source-serif-4-semibold.woff2": "font/woff2",
  "/fonts/jetbrains-mono-regular.woff2": "font/woff2",
  "/fonts/geist-latin-variable.woff2": "font/woff2",
};

export function localAsset(request: Request): Response | null {
  const path = new URL(request.url).pathname;
  if (!Object.hasOwn(assets, path)) return null;
  if (request.method !== "GET" && request.method !== "HEAD")
    return new Response(null, { status: 405, headers: { Allow: "GET, HEAD" } });
  return new Response(
    request.method === "HEAD"
      ? null
      : new Uint8Array(
          readFileSync(new URL(`../public${path}`, import.meta.url)),
        ),
    {
      headers: {
        "Content-Type": assets[path]!,
        "X-Content-Type-Options": "nosniff",
      },
    },
  );
}
