// Content-versioned static assets for the app and auth services. The build
// writes assets.json (path -> content hash) and points CSS url()s at versioned
// URLs; the server loads, verifies and compresses each file once at startup.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { extname, join } from "node:path";
import { brotliCompressSync, constants, gzipSync } from "node:zlib";

// woff2 and ico are served as stored: woff2 is already compressed.
const kinds: Record<string, { type: string; text: boolean }> = {
  ".css": { type: "text/css; charset=utf-8", text: true },
  ".svg": { type: "image/svg+xml", text: true },
  ".ico": { type: "image/x-icon", text: false },
  ".woff2": { type: "font/woff2", text: false },
};
export const ASSET_MANIFEST = "assets.json";
const IMMUTABLE = "public, max-age=31536000, immutable";
const hash = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("base64url").slice(0, 16);
const read = (dir: string, path: string) =>
  new Uint8Array(readFileSync(join(dir, path)));

/**
 * Build step: hash each listed file, rewrite root-relative CSS url()s to
 * `?v=<hash>` URLs (refusing any it cannot version), then hash the CSS.
 */
export function versionAssets(dir: string, paths: string[]) {
  const versions: Record<string, string> = {};
  const sheets = paths.filter((path) => extname(path) === ".css");
  for (const path of paths) {
    if (!kinds[extname(path)]) throw new Error(`asset_type_unknown ${path}`);
    if (!sheets.includes(path)) versions[path] = hash(read(dir, path));
  }
  for (const path of sheets) {
    const css = readFileSync(join(dir, path), "utf8").replace(
      /url\(\s*(["']?)(\/[^"'()?#\s]*)(?:\?v=[\w-]*)?\1\s*\)/g,
      (_match, quote: string, ref: string) => {
        const version = versions[ref];
        if (!version) throw new Error(`css_reference_unversioned ${ref}`);
        return `url(${quote}${ref}?v=${version}${quote})`;
      },
    );
    writeFileSync(join(dir, path), css);
    versions[path] = hash(new TextEncoder().encode(css));
  }
  writeFileSync(
    join(dir, ASSET_MANIFEST),
    JSON.stringify(versions, null, 2) + "\n",
  );
}

const accepts = (header: string | null, coding: string) =>
  (header ?? "").split(",").some((part) => {
    const [name, ...params] = part.trim().toLowerCase().split(";");
    const q = params.map((p) => p.trim()).find((p) => p.startsWith("q="));
    return name === coding && (!q || Number(q.slice(2)) > 0);
  });

/**
 * Runtime: serve exactly the files in the build's manifest. `?v=` equal to the
 * served bytes' hash caches for a year; any other URL (legacy, stale or
 * missing version) revalidates with a weak ETag.
 */
export function staticAssets(dir: string) {
  const versions = JSON.parse(
    readFileSync(join(dir, ASSET_MANIFEST), "utf8"),
  ) as Record<string, string>;
  const files = new Map(
    Object.entries(versions).map(([path, version]) => {
      const kind = kinds[extname(path)];
      const bytes = read(dir, path);
      if (!kind || hash(bytes) !== version)
        throw new Error(`asset_manifest_stale ${path}`);
      const encoded = kind.text
        ? {
            br: new Uint8Array(
              brotliCompressSync(bytes, {
                params: {
                  [constants.BROTLI_PARAM_MODE]: constants.BROTLI_MODE_TEXT,
                  [constants.BROTLI_PARAM_QUALITY]: 11,
                  [constants.BROTLI_PARAM_SIZE_HINT]: bytes.byteLength,
                },
              }),
            ),
            gzip: new Uint8Array(gzipSync(bytes, { level: 9 })),
          }
        : null;
      return [path, { version, type: kind.type, bytes, encoded }] as const;
    }),
  );
  return {
    url(path: string) {
      const file = files.get(path);
      if (!file) throw new Error(`asset_unknown ${path}`);
      return `${path}?v=${file.version}`;
    },
    respond(request: Request): Response | null {
      const url = new URL(request.url);
      const file = files.get(url.pathname);
      if (!file) return null;
      if (request.method !== "GET" && request.method !== "HEAD")
        return new Response(null, {
          status: 405,
          headers: { Allow: "GET, HEAD" },
        });
      const etag = `W/"${file.version}"`;
      const headers = new Headers({
        "Cache-Control":
          url.searchParams.get("v") === file.version ? IMMUTABLE : "no-cache",
        ETag: etag,
      });
      if (file.encoded) headers.set("Vary", "Accept-Encoding");
      const match = request.headers.get("if-none-match");
      if (
        match
          ?.split(",")
          .some((tag) => tag.trim() === etag || tag.trim() === etag.slice(2))
      )
        return new Response(null, { status: 304, headers });
      headers.set("Content-Type", file.type);
      headers.set("X-Content-Type-Options", "nosniff");
      const accept = request.headers.get("accept-encoding");
      const coding = accepts(accept, "br")
        ? "br"
        : accepts(accept, "gzip")
          ? "gzip"
          : null;
      let body = file.bytes;
      if (file.encoded && coding) {
        headers.set("Content-Encoding", coding);
        body = file.encoded[coding];
      }
      return new Response(request.method === "HEAD" ? null : body, {
        headers,
      });
    },
  };
}
export type StaticAssets = ReturnType<typeof staticAssets>;
