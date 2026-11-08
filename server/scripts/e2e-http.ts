/** What the end-to-end check and the test-account provisioning share: production's
 * origins, bounded requests, fixed error codes, and a browser-like client that
 * signs in with email and password. No database or auth-library imports, so the
 * check bundles into the runtime image. */
export const PRODUCTION = {
  app: "https://app.meetmilton.com",
  auth: "https://auth.meetmilton.com",
  mcp: "https://mcp.meetmilton.com/mcp",
};
export type Origins = typeof PRODUCTION;
export type Fetch = (url: string, init: RequestInit) => Promise<Response>;
/** Every request gives up after this long; one slow hop fails its step. */
export const REQUEST_MS = 15_000;
export const KEY_PATTERN = /mk_([A-Za-z0-9_-]{22})_[A-Za-z0-9_-]{43}/;

/** A refusal with a fixed code, the only error text either script prints. */
export class CheckError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
  }
}
export function fail(code: string): never {
  throw new CheckError(code);
}

const entities: Record<string, string> = {
  "&amp;": "&",
  "&quot;": '"',
  "&#39;": "'",
  "&#x27;": "'",
  "&lt;": "<",
  "&gt;": ">",
};
/** An HTML attribute value as escaped by Hono JSX, unescaped. */
export const unescape = (value: string) =>
  value.replace(/&(amp|quot|#39|#x27|lt|gt);/g, (e) => entities[e]!);

/** The URL of native's JSON redirect, `{"redirect": true, "url": "..."}`. */
function jsonRedirect(response: Response, body: string) {
  if (!/^application\/json\b/i.test(response.headers.get("Content-Type") ?? ""))
    return undefined;
  try {
    const parsed: unknown = JSON.parse(body);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "redirect" in parsed &&
      parsed.redirect === true &&
      "url" in parsed &&
      typeof parsed.url === "string"
    )
      return parsed.url;
  } catch {}
  return undefined;
}

/** A cookie jar per host and manual redirects, as a browser keeps host-only
 * Secure cookies. Only the given origins are ever requested. */
export function browser(origins: Origins, fetcher: Fetch = fetch) {
  const allowed = new Set([origins.app, origins.auth]);
  const jars = new Map<string, Map<string, string>>();
  async function go(url: string, form?: Record<string, string>) {
    const u = new URL(url);
    if (!allowed.has(u.origin)) fail("unexpected_origin");
    const jar = jars.get(u.host) ?? new Map<string, string>();
    jars.set(u.host, jar);
    const headers = new Headers({
      Accept: "text/html",
      "Sec-Fetch-Mode": "navigate",
    });
    if (jar.size)
      headers.set("Cookie", [...jar].map(([k, v]) => `${k}=${v}`).join("; "));
    if (form) {
      headers.set("Content-Type", "application/x-www-form-urlencoded");
      headers.set("Origin", u.origin);
      headers.set("Sec-Fetch-Site", "same-origin");
    }
    const response = await fetcher(u.href, {
      method: form ? "POST" : "GET",
      headers,
      ...(form ? { body: new URLSearchParams(form).toString() } : {}),
      redirect: "manual",
      signal: AbortSignal.timeout(REQUEST_MS),
    });
    for (const cookie of response.headers.getSetCookie()) {
      const pair = cookie.split(";")[0]!;
      const i = pair.indexOf("=");
      if (i < 1) continue;
      const name = pair.slice(0, i),
        value = pair.slice(i + 1);
      if (/;\s*Max-Age=0/i.test(cookie) || value === "") jar.delete(name);
      else jar.set(name, value);
    }
    return response;
  }
  /** Follows redirects, native's Continue pages (meta refresh) and native's
   * JSON redirects to a page. Node's fetch sends `Sec-Fetch-Mode: cors` whatever
   * go() sets (Bun keeps `navigate`), and native then answers a redirect as
   * 200 `{"redirect": true, "url": ...}` instead of a 302. Every hop still goes
   * through go(), so only the given origins are requested. */
  async function follow(url: string, form?: Record<string, string>) {
    let current = url;
    let response = await go(current, form);
    for (let hop = 0; hop < 12; hop++) {
      const location = response.headers.get("Location");
      if (response.status >= 300 && response.status < 400 && location) {
        await response.body?.cancel();
        current = new URL(location, current).href;
        response = await go(current);
        continue;
      }
      const html = await response.text();
      const refresh = /<meta http-equiv="refresh" content="0;url=([^"]+)"/.exec(
        html,
      );
      if (response.status === 200 && refresh) {
        current = new URL(unescape(refresh[1]!), current).href;
        response = await go(current);
        continue;
      }
      const redirect = response.status === 200 && jsonRedirect(response, html);
      if (redirect) {
        current = new URL(redirect, current).href;
        response = await go(current);
        continue;
      }
      return { status: response.status, url: new URL(current), html };
    }
    return fail("too_many_redirects");
  }
  return { go, follow };
}
export type Browser = ReturnType<typeof browser>;

/** Signs in with email and password exactly as a browser does: app /login, the
 * native sign-in page, its form, then the app's code flow back to the report.
 * Returns the signed-in page, which must name this account. */
export async function signIn(
  b: Browser,
  origins: Origins,
  email: string,
  password: string,
) {
  const login = await b.follow(origins.app + "/login");
  if (
    login.status !== 200 ||
    login.url.origin !== origins.auth ||
    login.url.pathname !== "/login"
  )
    fail("sign_in_page_unavailable");
  const at = login.html.indexOf('action="/form/signin"');
  const query = /name="oauth_query" value="([^"]*)"/.exec(
    login.html.slice(Math.max(at, 0)),
  );
  if (at < 0 || !query) fail("sign_in_form_unavailable");
  const home = await b.follow(origins.auth + "/form/signin", {
    oauth_query: unescape(query[1]!),
    email,
    password,
  });
  if (
    home.status !== 200 ||
    home.url.origin !== origins.app ||
    home.url.pathname !== "/"
  )
    fail("sign_in_refused");
  if (!home.html.includes(`Signed in as <strong>${email}</strong>`))
    fail("signed_in_account_mismatch");
  return home;
}
