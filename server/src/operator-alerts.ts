import { createHash, timingSafeEqual } from "node:crypto";
import type { StoreBindings } from "./store";
import { neonDatabase } from "./store/database";
import { sql } from "drizzle-orm";
import { readSpendAlerts } from "./store/spend-alerts";

export const spendAlertsPrefix = "/operator/spend-alerts/";
const base = spendAlertsPrefix.slice(0, -1);
const headers = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "private, no-store",
  "X-Robots-Tag": "noindex, nofollow",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
};

// Catch encoded prefix variants before the MCP-host browser redirect. Actual
// credential admission accepts only the canonical unescaped path below.
export function isSpendAlertsPath(path: string) {
  // Normalize to a fixed point, with bounded total character work. If unusual
  // nested encoding exceeds that budget, refuse it instead of redirecting it.
  let remaining = 65_536;
  for (;;) {
    if (path === base || path.startsWith(spendAlertsPrefix)) return true;
    if (path.length > remaining) return true;
    remaining -= path.length;
    // The protected prefix is ASCII. Decode valid escapes without validating
    // the credential suffix: a malformed suffix must not hide this prefix.
    const decoded = path.replace(/%([a-fA-F0-9]{2})/g, (_escape, hex: string) =>
      String.fromCharCode(Number.parseInt(hex, 16)),
    );
    if (decoded === path) return false;
    path = decoded;
  }
}

function response(
  request: Request,
  value: unknown,
  status = 200,
  extra?: Record<string, string>,
) {
  return new Response(
    request.method === "HEAD" ? null : JSON.stringify(value),
    {
      status,
      headers: { ...headers, ...extra },
    },
  );
}
export const feedDenied = (request: Request, status = 404) =>
  response(request, { error: "feed_unavailable" }, status);
const matches = (digest: Buffer, stored: string | null | undefined) =>
  typeof stored === "string" &&
  /^[a-f0-9]{64}$/.test(stored) &&
  timingSafeEqual(digest, Buffer.from(stored, "hex"));

// Capability only: cookies, bearer tokens and asserted identity headers grant
// nothing. Every read checks current DB state; no credential cache or history.
export async function operatorAlerts(request: Request, config: StoreBindings) {
  if (!["GET", "HEAD"].includes(request.method))
    return response(request, { error: "method_not_allowed" }, 405, {
      Allow: "GET, HEAD",
    });
  const url = new URL(request.url);
  const candidate = url.pathname.startsWith(spendAlertsPrefix)
    ? url.pathname
        .slice(spendAlertsPrefix.length)
        .match(/^([A-Za-z0-9_-]{43})\.json$/)?.[1]
    : undefined;
  if (!candidate || url.search) return feedDenied(request);
  const digest = createHash("sha256").update(candidate, "ascii").digest();
  try {
    const db =
      config.storeDatabase ??
      (config.DATABASE_URL ? neonDatabase(config.DATABASE_URL) : undefined);
    if (!db) return feedDenied(request, 503);
    const initial = (
      await db.query<{ hash: string | null }>(
        sql`SELECT spend_feed_key_hash AS hash FROM store_config WHERE singleton=1`,
      )
    )[0];
    if (!matches(digest, initial?.hash)) return feedDenied(request);
    return await db.transaction(async (tx) => {
      await tx.query(
        sql`SELECT set_config('lock_timeout','250ms',true),set_config('statement_timeout','1000ms',true)`,
      );
      const current = (
        await tx.query<{ hash: string | null }>(
          sql`SELECT spend_feed_key_hash AS hash FROM store_config WHERE singleton=1 FOR SHARE`,
        )
      )[0];
      if (!matches(digest, current?.hash)) return feedDenied(request);
      if (request.method === "HEAD") return response(request, null);
      return response(request, await readSpendAlerts(tx));
    });
  } catch {
    // Never echo an exception: request URLs are credentials and may be included
    // in runtime errors. Platform/ingress log protection is a separate release gate.
    return feedDenied(request, 503);
  }
}
