import { expect, test, spyOn } from "bun:test";
import { brotliDecompressSync, gunzipSync } from "node:zlib";
import { sql } from "drizzle-orm";
import { createMiltonApp } from "../src/index";
import { navigation, page } from "../src/pages";
import {
  resolveIdentityAccount,
  lookupIdentityAccount,
  personStoreForCurrentRequest,
  StoreError,
} from "../src/store";
import { localAsset } from "../src/assets";
import { fixtureStore, memoSave, teach, vendorIntent } from "./store-fixtures";
import { localStore, openTransactions } from "./local-store";

import {
  appOrigin,
  issuer,
  resource,
  clientSettings,
  pageFixture,
  protocolFixture,
} from "./auth-fixtures";
import { authAdmission, trialFingerprints } from "../src/auth-admission";
import { ensureSubscription } from "../src/billing";
import { backfillSubscriptions } from "../scripts/backfill-subscriptions";

const appFor = (env: Partial<Parameters<typeof createMiltonApp>[0]>) =>
  createMiltonApp({ issuer, resource, appOrigin, ...clientSettings, ...env });
function browser(
  app: ReturnType<typeof createMiltonApp>,
  jar = new Map<string, string>(),
) {
  return async (
    path: string,
    fields?: Record<string, string> | URLSearchParams | FormData,
    headers: Record<string, string> = {},
  ) => {
    if (fields instanceof FormData && !fields.has("csrf"))
      fields.set("csrf", jar.get("milton-csrf") ?? "");
    const body =
      fields instanceof URLSearchParams || fields instanceof FormData
        ? fields
        : fields &&
          new URLSearchParams({
            csrf: jar.get("milton-csrf") ?? "",
            ...fields,
          });
    const response = await app(
      new Request(appOrigin + path, {
        method: body ? "POST" : "GET",
        headers: {
          Host: "localhost:3001",
          Cookie: [...jar].map(([k, v]) => k + "=" + v).join("; "),
          ...(body ? { Origin: appOrigin } : {}),
          // A multipart body sets its own Content-Type with the boundary.
          ...(body && !(body instanceof FormData)
            ? { "Content-Type": "application/x-www-form-urlencoded" }
            : {}),
          ...headers,
        },
        body,
      }),
    );
    for (const value of response.headers.getSetCookie()) {
      const pair = value.split(";")[0]!;
      const at = pair.indexOf("=");
      jar.set(pair.slice(0, at), pair.slice(at + 1));
    }
    return response;
  };
}

async function accountFixture(
  extra: Partial<Parameters<typeof createMiltonApp>[0]> = {},
) {
  const local = await pageFixture("account", extra);
  await resolveIdentityAccount(local.env, {
    provider: issuer,
    subject: "account",
  });
  const jar = new Map([["milton-session", local.token]]);
  return {
    local,
    jar,
    state: { email: "fixture@example.invalid" as string | undefined },
    send: browser(appFor(local.config), jar),
    dispose: local.dispose,
  };
}
async function memoPageFixture() {
  const local = await pageFixture();
  await resolveIdentityAccount(local.env, {
    provider: issuer,
    subject: "page-fixes",
  });
  const account = await lookupIdentityAccount(local.env, {
    provider: issuer,
    subject: "page-fixes",
  });
  const store = await personStoreForCurrentRequest(local.env, account);
  // An AI connected through a client whose id names its host.
  const author = fixtureStore(
    local.db,
    account.userId,
    "https://ai.example/client",
  );
  const app = appFor(local.config);
  return {
    app,
    userId: account.userId,
    store,
    author,
    db: local.db,
    pg: local.pg,
    send: browser(app, new Map([["milton-session", local.token]])),
    dispose: local.dispose,
  };
}
const tryAgain =
  "Milton could not start your subscription. Nothing was charged. Try again.";
const stripeSubscription = (status: string, created?: number) => {
  const now = Math.floor(Date.now() / 1000);
  return {
    id: "sub_fixture",
    status,
    created: created ?? now,
    trial_end: now + 30 * 86400,
    items: {
      data: [
        { current_period_start: now, current_period_end: now + 30 * 86400 },
      ],
    },
  };
};

// Answers Stripe's API with fixture objects; each call is recorded.
function fakeStripe() {
  const stripe = {
    // A path or "METHOD path" answers 500; true fails every call.
    down: false as boolean | string,
    deleteStatus: 200,
    // What a read of the customer answers after a DELETE 404.
    customer: { status: 404, body: {} as Record<string, unknown> },
    subscriptions: [] as Record<string, unknown>[],
    // Runs as Stripe creates or updates a customer, before it answers.
    onCustomer: async () => {},
    // Runs as Stripe creates a Checkout session, before it answers.
    onSession: async () => {},
    calls: [] as Record<string, unknown>[],
    // Every call made while a database transaction was open.
    inTransaction: [] as string[],
    onDelete: async () => {},
    onList: async () => {},
  };
  const billing = {
    secretKey: "rk_test_fixtureNotAKey",
    webhookSecret: "whsec_fixtureNotASecret",
    priceId: "price_fixture",
    fetch: async (url: string, init: RequestInit) => {
      const { pathname: path, search } = new URL(url);
      const headers = new Headers(init.headers);
      const method = init.method!;
      stripe.calls.push({
        call: `${method} ${path}${search}`,
        idempotency: headers.get("Idempotency-Key"),
        bearer:
          headers.get("Authorization") === "Bearer rk_test_fixtureNotAKey",
        version: headers.get("Stripe-Version"),
        ...(init.body
          ? Object.fromEntries(new URLSearchParams(String(init.body)))
          : {}),
      });
      if (openTransactions() > 0)
        stripe.inTransaction.push(`${method} ${path}`);
      if (stripe.down === true || stripe.down === `${method} ${path}`)
        return Response.json({}, { status: 500 });
      if (method === "DELETE") {
        await stripe.onDelete();
        return Response.json({}, { status: stripe.deleteStatus });
      }
      if (path === "/v1/customers") {
        await stripe.onCustomer();
        return Response.json({ id: "cus_fixture" });
      }
      if (path === "/v1/customers/cus_fixture" && method === "POST") {
        await stripe.onCustomer();
        return Response.json({ id: "cus_fixture" });
      }
      if (path === "/v1/customers/cus_fixture")
        return Response.json(stripe.customer.body, {
          status: stripe.customer.status,
        });
      if (path === "/v1/subscriptions" && method === "GET") {
        // What Stripe held when the read began.
        const data = stripe.subscriptions;
        await stripe.onList();
        return Response.json({ data });
      }
      if (path === "/v1/subscriptions") {
        const created = stripeSubscription("trialing");
        stripe.subscriptions = [created];
        return Response.json(created);
      }
      if (path === "/v1/checkout/sessions") {
        await stripe.onSession();
        return Response.json({
          id: "cs_test_fixture",
          url: "https://checkout.stripe.com/c/pay/cs_test_fixture",
        });
      }
      if (path === "/v1/checkout/sessions/cs_test_fixture/expire")
        return Response.json({ id: "cs_test_fixture", status: "expired" });
      if (path === "/v1/billing_portal/sessions")
        return Response.json({
          url: "https://billing.stripe.com/p/session/test_fixture",
        });
      throw new Error("Unexpected Stripe endpoint");
    },
  };
  return { stripe, billing };
}
const stripeCall = (call: string, fields: Record<string, unknown> = {}) => ({
  call,
  idempotency: null,
  bearer: true,
  version: "2026-10-28.endive",
  ...fields,
});

test("Cloud Run app serves only canonical browser routes and public assets", async () => {
  const { createCloudApp } = await import("../src/cloud-app");
  const app = createCloudApp({
    issuer,
    resource: "https://mcp.example/mcp",
    appOrigin: "https://app.example",
    ...clientSettings,
  });
  const request = (path: string, host = "app.example", method = "GET") =>
    app(
      new Request(`https://${host}${path}`, {
        method,
        headers: { Host: host },
      }),
    );
  expect((await request("/health")).status).toBe(200);
  expect((await request("/mcp")).status).toBe(404);
  for (const [path, type] of [
    ["/milton.css", "text/css; charset=utf-8"],
    ["/favicon.svg", "image/svg+xml"],
    ["/favicon.ico", "image/x-icon"],
    ["/fonts/jetbrains-mono-regular.woff2", "font/woff2"],
    ["/fonts/geist-latin-variable.woff2", "font/woff2"],
  ] as const) {
    const asset = await request(path);
    expect(asset.status).toBe(200);
    expect(asset.headers.get("Content-Type")).toBe(type);
    expect(asset.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect((await asset.arrayBuffer()).byteLength).toBeGreaterThan(100);
    expect((await request(path, "app.example", "POST")).status).toBe(405);
    expect(await (await request(path, "app.example", "HEAD")).text()).toBe("");
    expect((await request(path, "revision.run.app")).status).toBe(403);
  }
  for (const path of ["/.env", "/src/config.ts", "/fonts/%2e%2e/.env"])
    expect((await request(path)).status).toBe(404);
  expect((await request("/health", "mcp.example")).status).toBe(403);
  // Admission is the separate milton-admit service, never the public app.
  for (const path of [
    "/internal/auth/admit",
    "/internal/auth/preserve-eligibility",
  ])
    expect((await request(path, "app.example", "POST")).status).toBe(404);
});

test("the admission role serves auth's two calls and nothing else", async () => {
  const { createAdmitApp } = await import("../src/index");
  const { admitRuntimeConfig } = await import("../src/config");
  const env = {
    NODE_ENV: "production",
    AUTH_ISSUER: issuer,
    AUTH_ADMISSION_SECRET: clientSettings.admissionSecret,
    MILTON_TRIAL_FINGERPRINT_KEY: clientSettings.trialFingerprintKey,
  };
  // It needs no browser, OIDC client or MCP setting, and refuses without its own.
  const app = createAdmitApp(admitRuntimeConfig(env));
  for (const missing of ["AUTH_ADMISSION_SECRET", "AUTH_ISSUER"])
    expect(() => admitRuntimeConfig({ ...env, [missing]: undefined })).toThrow(
      StoreError,
    );
  // Stripe for trials, but never the webhook secret; key and price come together.
  const stripe = {
    STRIPE_SECRET_KEY: "rk_test_fixtureNotAKey",
    STRIPE_PRICE_ID: "price_fixture",
    STRIPE_WEBHOOK_SECRET: "whsec_fixtureNotASecret",
  };
  expect(admitRuntimeConfig({ ...env, ...stripe }).billing).toEqual({
    secretKey: stripe.STRIPE_SECRET_KEY,
    priceId: stripe.STRIPE_PRICE_ID,
  });
  expect(() =>
    admitRuntimeConfig({ ...env, STRIPE_SECRET_KEY: stripe.STRIPE_SECRET_KEY }),
  ).toThrow(StoreError);
  const request = (path: string, method = "POST") =>
    app(new Request(`https://milton-admit.example.run.app${path}`, { method }));
  for (const path of [
    "/internal/auth/admit",
    "/internal/auth/preserve-eligibility",
  ]) {
    // Routed to admission, which refuses a missing bearer before anything else.
    expect((await request(path)).status).toBe(401);
    expect((await request(path, "GET")).status).toBe(405);
  }
  for (const path of [
    "/",
    "/health",
    "/mcp",
    "/login",
    "/billing/webhook",
    "/internal/auth",
    "/internal/auth/admit/",
    "/milton.css",
  ]) {
    expect((await request(path)).status).toBe(404);
    expect((await request(path, "GET")).status).toBe(404);
  }
});

test("page fonts and favicons are local while other browser restrictions stay closed", async () => {
  const response = page("Example", "<p>Example</p>");
  expect(response.headers.get("Content-Security-Policy")).toBe(
    "default-src 'none'; script-src 'none'; style-src 'self'; img-src 'self'; font-src 'self'; connect-src 'none'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'; object-src 'none'",
  );
  const html = await response.text();
  expect(html).toMatch(/href="\/favicon\.svg\?v=[\w-]{16}"/);
  expect(html).toMatch(/href="\/favicon\.ico\?v=[\w-]{16}"/);
  const { localAsset } = await import("../src/assets");
  for (const path of [
    "/fonts/unknown.woff2",
    "/fonts/../secret",
    "/fonts/%2e%2e/secret",
    "/src/pages.ts",
  ])
    expect(localAsset(new Request(appOrigin + path))).toBeNull();
});

test("pages link content-versioned assets that cache for a year; legacy URLs revalidate", async () => {
  const response = page("Example", "<p>Example</p>");
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  const html = await response.text();
  const linked = (pattern: RegExp) => html.match(pattern)?.[1] ?? "missing";
  const css = linked(
    /<link rel="stylesheet" href="(\/milton\.css\?v=[\w-]{16})"/,
  );
  const svg = linked(/href="(\/favicon\.svg\?v=[\w-]{16})"/);
  const fonts = ["geist-latin-variable", "jetbrains-mono-latin"].map((font) =>
    linked(
      new RegExp(
        `<link rel="preload" href="(/fonts/${font}\\.woff2\\?v=[\\w-]{16})" as="font" type="font/woff2" crossorigin="anonymous"`,
      ),
    ),
  );
  expect(html).not.toContain("jetbrains-mono-regular");
  const get = (path: string, headers: Record<string, string> = {}) =>
    localAsset(new Request(appOrigin + path, { headers }))!;
  const immutable = "public, max-age=31536000, immutable";
  const stylesheet = await get(css).text();
  for (const font of fonts) expect(stylesheet).toContain(`url(${font})`);
  // JetBrains Mono is the README's Latin subset plus the master for the rest
  // of Unicode, so Latin-only text never fetches the master. They share only
  // the combining marks, so a non-Latin letter and its mark render together.
  const ranges = (list: string) =>
    [...list.matchAll(/U\+([\dA-F?]+)(?:-([\dA-F]+))?/gi)].map(([, lo, hi]) =>
      [lo!.replaceAll("?", "0"), hi ?? lo!.replaceAll("?", "F")].map((n) =>
        parseInt(n, 16),
      ),
    );
  const [latin, master] = ["latin", "regular"].map((file) => {
    const rule = [...stylesheet.matchAll(/@font-face\s*\{([^}]*)\}/g)].find(
      ([face]) => face.includes(`/fonts/jetbrains-mono-${file}.woff2?v=`),
    )![1]!;
    return {
      url: /url\(([^)]*)\)/.exec(rule)![1]!,
      ranges: ranges(/unicode-range:([^;]*)/.exec(rule)![1]!),
    };
  });
  const readme = await Bun.file(
    new URL("../../packages/theme/README.md", import.meta.url),
  ).text();
  expect(latin!.url).toBe(fonts[1]!);
  expect(latin!.ranges).toEqual(
    ranges(/--unicodes="([^"]*)"/.exec(readme)![1]!),
  );
  const covers = (list: number[][], c: number) =>
    list.some(([lo, hi]) => lo! <= c && c <= hi!);
  const wrong: number[] = [];
  for (let c = 0; c < 0x110000; c++) {
    const [l, m] = [latin!, master!].map((face) => covers(face.ranges, c));
    if (!(l || m) || (l && m) !== (c >= 0x300 && c <= 0x36f)) wrong.push(c);
  }
  expect(wrong).toEqual([]);
  fonts.push(master!.url);
  for (const [path, type] of [
    [css, "text/css; charset=utf-8"],
    [svg, "image/svg+xml"],
  ] as const) {
    const plain = get(path);
    expect(plain.headers.get("Content-Encoding")).toBeNull();
    const bytes = Buffer.from(await plain.arrayBuffer());
    for (const [accept, coding, decode] of [
      ["br, gzip", "br", brotliDecompressSync],
      ["gzip", "gzip", gunzipSync],
    ] as const) {
      const r = get(path, { "Accept-Encoding": accept });
      expect(r.headers.get("Content-Type")).toBe(type);
      expect(r.headers.get("Cache-Control")).toBe(immutable);
      expect(r.headers.get("Content-Encoding")).toBe(coding);
      expect(r.headers.get("Vary")).toBe("Accept-Encoding");
      const encoded = Buffer.from(await r.arrayBuffer());
      expect(encoded.byteLength).toBeLessThan(bytes.byteLength);
      expect(decode(encoded).equals(bytes)).toBe(true);
    }
  }
  for (const font of fonts) {
    const r = get(font, { "Accept-Encoding": "br, gzip" });
    expect(r.headers.get("Content-Type")).toBe("font/woff2");
    expect(r.headers.get("Cache-Control")).toBe(immutable);
    expect(r.headers.get("Content-Encoding")).toBeNull();
  }
  for (const path of [
    "/milton.css",
    "/favicon.ico",
    "/fonts/geist-latin-variable.woff2",
    css.replace(/v=.*/, "v=stale"),
  ]) {
    const r = get(path);
    expect(r.status).toBe(200);
    expect(r.headers.get("Cache-Control")).toBe("no-cache");
    const again = get(path, { "If-None-Match": r.headers.get("ETag")! });
    expect(again.status).toBe(304);
    expect(again.headers.get("Cache-Control")).toBe("no-cache");
    expect(await again.text()).toBe("");
  }
});

test("navigation accepts native Allow/Deny callbacks while rejecting unsafe destinations", async () => {
  for (const result of ["code=fixture-code", "error=access_denied"]) {
    const response = navigation(
      "cursor://anysphere.cursor-mcp/oauth/callback?" +
        result +
        "&state=fixture",
    );
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain(
      'href="cursor://anysphere.cursor-mcp/oauth/callback?' +
        result +
        '&amp;state=fixture"',
    );
    expect(html).toContain('http-equiv="refresh"');
  }
  for (const target of [
    "native+app:/oauth/callback",
    "com.example.app:/oauth/callback",
    "https://client.example/callback",
    "http://localhost:9999/callback",
    "http://127.0.0.1:9999/callback",
    "http://[::1]:9999/callback",
  ])
    expect(navigation(target).status).toBe(200);
  for (const target of [
    "javascript:alert(1)",
    "data:text/html,fixture",
    "vbscript:msgbox(1)",
    "file:///tmp/fixture",
    "blob:https://client.example/fixture",
    "http://client.example/callback",
    "https://user:pass@client.example/callback",
    "cursor://user:pass@anysphere.cursor-mcp/oauth/callback",
    "https://client.example/callback\r\nfixture",
    "cursor://anysphere.cursor-mcp/oauth/callback\nfixture",
  ])
    expect(() => navigation(target)).toThrow(
      "The sign-in destination is unavailable.",
    );
});

test("resource discovery is public and browser mutations reject foreign origins", async () => {
  const app = createMiltonApp({
    issuer,
    resource,
    appOrigin,
    ...clientSettings,
  });
  for (const path of [
    "/.well-known/oauth-protected-resource",
    "/.well-known/oauth-protected-resource/mcp",
  ]) {
    const reply = await app(
      new Request(appOrigin + path, { headers: { Host: "localhost:3001" } }),
    );
    expect(reply.status).toBe(200);
    expect(await reply.json()).toEqual({
      resource,
      authorization_servers: [issuer],
      bearer_methods_supported: ["header"],
      scopes_supported: ["milton:read", "milton:write"],
    });
  }
  const denied = await app(
    new Request(appOrigin + "/logout", {
      method: "POST",
      headers: {
        Host: "localhost:3001",
        Origin: "https://evil.example",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: "csrf=bad&provider=google",
    }),
  );
  expect(denied.status).toBe(403);
  expect(
    (
      await app(
        new Request(appOrigin + "/api/auth/admin/list-users", {
          headers: { Host: "localhost:3001" },
        }),
      )
    ).status,
  ).toBe(404);
});

test("behind Cloud Run, a same-origin Origin: null form post passes on the canonical host only", async () => {
  const { createCloudApp } = await import("../src/cloud-app");
  const app = createCloudApp({
    issuer,
    resource: "https://mcp.example/mcp",
    appOrigin: "https://app.example",
    ...clientSettings,
  });
  const csrf = "a".repeat(43);
  // TLS ends at Google's front end, so Node sees http: and the Host header.
  const post = (headers: Record<string, string>) =>
    app(
      new Request("http://app.example/assistants/disconnect", {
        method: "POST",
        headers: {
          Host: "app.example",
          Origin: "null",
          "Sec-Fetch-Site": "same-origin",
          Cookie: "__Host-milton-csrf=" + csrf,
          "Content-Type": "application/x-www-form-urlencoded",
          ...headers,
        },
        body: new URLSearchParams({ csrf }),
      }),
    );
  try {
    // Past the CSRF check, a signed-out browser is asked to sign in.
    const passed = await post({});
    expect(passed.status).toBe(403);
    expect(await passed.text()).toContain(
      "Sign in to Milton before continuing.",
    );
    const offHost = await post({ Host: "revision.run.app" });
    expect(offHost.status).toBe(403);
    expect(await offHost.text()).toContain("Invalid Host");
    const foreign = await post({ Origin: "https://evil.example" });
    expect(foreign.status).toBe(403);
    expect(await foreign.text()).toContain(
      "Reload the page before submitting this form.",
    );
  } finally {
  }
});

test("billing checkout and portal: 503 without config; signed-in CSRF forms; the status picks the portal or Checkout; a healed sign-up keeps its trial", async () => {
  const off = await accountFixture();
  try {
    await off.send("/");
    const refused = await off.send("/billing/checkout", {});
    expect(refused.status).toBe(503);
    expect(await refused.text()).toBe(
      '{"error":"billing_unavailable","message":"Billing is not available yet."}',
    );
    expect((await off.send("/billing/portal", {})).status).toBe(503);
  } finally {
    await off.dispose();
  }
  const { stripe, billing } = fakeStripe();
  const fixture = await accountFixture({ billing });
  const { send, local } = fixture;
  const clock = async () =>
    (
      await local.db.query<{ customer: string | null; status: string | null }>(
        sql`SELECT stripe_customer_id AS customer,subscription_status AS status FROM trial_accounts`,
      )
    )[0];
  const portalUrl = "https://billing.stripe.com/p/session/test_fixture";
  const checkoutUrl = "https://checkout.stripe.com/c/pay/cs_test_fixture";
  // form-action 'self' blocks an external Location after a form, so the answer
  // is a page that navigates, as sign-in's is.
  const leavesFor = async (response: Response, target: string) => {
    expect(response.status).toBe(200);
    expect(response.headers.get("Location")).toBeNull();
    const html = await response.text();
    expect(html).toContain(`http-equiv="refresh" content="0;url=${target}"`);
    expect(html).not.toContain("sign-in");
  };
  const portalCall = stripeCall("POST /v1/billing_portal/sessions", {
    customer: "cus_fixture",
    return_url: appOrigin + "/",
  });
  const emailCall = stripeCall("POST /v1/customers/cus_fixture", {
    email: "fixture@example.invalid",
  });
  const sessionCall = stripeCall("POST /v1/checkout/sessions", {
    mode: "subscription",
    customer: "cus_fixture",
    payment_method_collection: "always",
    "line_items[0][price]": "price_fixture",
    "line_items[0][quantity]": "1",
    success_url: appOrigin + "/",
    cancel_url: appOrigin + "/",
    expires_at: expect.any(String),
  });
  try {
    await send("/");
    // Without a trial clock there is no subscription to start or manage.
    expect((await send("/billing/checkout", {})).status).toBe(409);
    const nothing = await send("/billing/portal", {});
    expect(nothing.status).toBe(409);
    expect(await nothing.text()).toContain(
      "There is no Milton subscription to manage yet.",
    );
    await local.db.query(sql`UPDATE store_config SET trials_enabled=true`);
    await local.db.query(
      sql`INSERT INTO trial_accounts(user_id,started_at) SELECT id,clock_timestamp() FROM users`,
    );
    // Forms only: GET, a foreign origin or a missing CSRF token start nothing.
    expect((await send("/billing/checkout")).status).toBe(405);
    expect(
      (await send("/billing/checkout", {}, { Origin: "https://evil.example" }))
        .status,
    ).toBe(403);
    expect(
      (await send("/billing/checkout", { csrf: "x".repeat(43) })).status,
    ).toBe(403);
    expect(stripe.calls).toEqual([]);
    // Waiting on a healed sign-up: paying now would lose the 30 days, so it
    // takes the trial and the portal, and answers 503 if the trial did not start.
    stripe.down = "POST /v1/subscriptions";
    const down = await send("/billing/checkout", {});
    expect(down.status).toBe(503);
    expect(await down.text()).toContain(tryAgain);
    expect(await clock()).toEqual({ customer: "cus_fixture", status: null });
    expect(stripe.calls.map((call) => call.call)).not.toContain(
      "POST /v1/checkout/sessions",
    );
    stripe.down = false;
    stripe.calls.length = 0;
    await leavesFor(await send("/billing/checkout", {}), portalUrl);
    expect(await clock()).toEqual({
      customer: "cus_fixture",
      status: "trialing",
    });
    expect(stripe.calls.map((call) => call.call)).toEqual([
      "GET /v1/subscriptions?customer=cus_fixture&status=all&limit=100",
      "POST /v1/subscriptions",
      "POST /v1/customers/cus_fixture",
      "POST /v1/billing_portal/sessions",
    ]);
    // Any subscription Stripe counts as existing, plus a trial, is managed in
    // the portal; anything else subscribes, no trial, after Stripe confirms it.
    const listCall = stripeCall(
      "GET /v1/subscriptions?customer=cus_fixture&status=all&limit=100",
    );
    stripe.subscriptions = [];
    for (const [status, location, calls] of [
      ["trialing", portalUrl, [emailCall, portalCall]],
      ["active", portalUrl, [emailCall, portalCall]],
      ["past_due", portalUrl, [emailCall, portalCall]],
      ["unpaid", portalUrl, [emailCall, portalCall]],
      ["paused", portalUrl, [emailCall, portalCall]],
      ["canceled", checkoutUrl, [listCall, emailCall, sessionCall]],
      ["incomplete_expired", checkoutUrl, [listCall, emailCall, sessionCall]],
    ] as const) {
      await local.db.query(
        sql`UPDATE trial_accounts SET subscription_status=${status}`,
      );
      stripe.calls.length = 0;
      const now = Math.floor(Date.now() / 1000);
      await leavesFor(await send("/billing/checkout", {}), location);
      expect([status, stripe.calls]).toEqual([status, [...calls]]);
      // An abandoned tab stops being payable soon after Stripe's 30-minute
      // minimum, with headroom so Stripe's later creation time never undercuts it.
      for (const { call, expires_at } of stripe.calls)
        if (call === "POST /v1/checkout/sessions")
          expect(Number(expires_at) - now).toBeWithin(1830, 1921);
    }
    // A webhook that has not landed: the stored copy says canceled, Stripe has a
    // live one. No second subscription, and the row catches up.
    for (const status of [
      "active",
      "trialing",
      "past_due",
      "unpaid",
      "paused",
    ]) {
      await local.db.query(
        sql`UPDATE trial_accounts SET subscription_status='canceled'`,
      );
      stripe.subscriptions = [
        stripeSubscription("canceled", 2_000_000_000),
        stripeSubscription(status, 1_900_000_000),
      ];
      stripe.calls.length = 0;
      await leavesFor(await send("/billing/checkout", {}), portalUrl);
      expect([status, stripe.calls]).toEqual([
        status,
        [listCall, emailCall, portalCall],
      ]);
      expect((await clock())?.status).toBe(status);
    }
    // A failed read is not "nothing to find": no session is created.
    await local.db.query(
      sql`UPDATE trial_accounts SET subscription_status='canceled'`,
    );
    stripe.down = "GET /v1/subscriptions";
    stripe.calls.length = 0;
    const logged = spyOn(console, "error").mockImplementation(() => {});
    expect((await send("/billing/checkout", {})).status).toBe(503);
    expect(stripe.calls).toEqual([listCall]);
    stripe.down = "POST /v1/billing_portal/sessions";
    expect((await send("/billing/portal", {})).status).toBe(503);
    // Logged as a sign-in failure is: where, class and code, nothing of Stripe's.
    expect(logged.mock.calls.map(([line]) => String(line))).toEqual(
      Array(2).fill(
        '{"event":"unexpected_error","where":"billing","class":"AuthError","code":"billing_unavailable"}',
      ),
    );
    logged.mockRestore();
    stripe.down = false;
    stripe.subscriptions = [];
    // A returning deleted identity has no customer yet.
    await local.db.query(
      sql`UPDATE trial_accounts SET stripe_customer_id=NULL,subscription_status='canceled'`,
    );
    stripe.calls.length = 0;
    await leavesFor(await send("/billing/checkout", {}), checkoutUrl);
    expect(stripe.calls.map((call) => call.call)).toEqual([
      "POST /v1/customers",
      "POST /v1/checkout/sessions",
    ]);
    expect(await clock()).toEqual({
      customer: "cus_fixture",
      status: "canceled",
    });
    stripe.calls.length = 0;
    await leavesFor(await send("/billing/portal", {}), portalUrl);
    expect(stripe.calls).toEqual([emailCall, portalCall]);
    // A failed email copy never stops someone paying, on either route, and its
    // log names no address or key. An unknown email makes no call.
    await local.db.query(
      sql`UPDATE trial_accounts SET subscription_status='canceled'`,
    );
    stripe.down = "POST /v1/customers/cus_fixture";
    const failing = spyOn(console, "error").mockImplementation(() => {});
    await leavesFor(await send("/billing/portal", {}), portalUrl);
    await leavesFor(await send("/billing/checkout", {}), checkoutUrl);
    expect(failing.mock.calls.map(([line]) => String(line))).toEqual(
      Array(2).fill(
        '{"event":"unexpected_error","where":"billing","class":"AuthError","code":"billing_unavailable"}',
      ),
    );
    failing.mockRestore();
    stripe.down = false;
    await local.db.query(sql`UPDATE milton_app.session SET email=NULL`);
    stripe.calls.length = 0;
    await leavesFor(await send("/billing/portal", {}), portalUrl);
    expect(stripe.calls).toEqual([portalCall]);
  } finally {
    await fixture.dispose();
  }
}, 30000);

test("the account menu offers the way to pay on every signed-in page, and the note shows only near the end or when paused", async () => {
  const { billing } = fakeStripe();
  const fixture = await accountFixture({ billing });
  const { local, send } = fixture;
  const set = (status: string, left = "11 days 12 hours", renewed = "1 day") =>
    local.db.query(sql`UPDATE trial_accounts SET subscription_status=${status},
      trial_end=clock_timestamp()+${left}::interval,
      current_period_start=clock_timestamp()-${renewed}::interval`);
  // The two places billing can appear on a page, cut out of its HTML.
  const read = async (path = "/") => {
    const html = await (await send(path)).text();
    const panel = html.slice(
      html.indexOf('<div class="menu-panel"'),
      html.indexOf("</header>"),
    );
    const start = html.indexOf('aria-label="Milton subscription"');
    return {
      menu: /<form method="post" action="\/billing\/(\w+)">.*?<button class="menu-item">([^<]+)</
        .exec(panel)
        ?.slice(1),
      csrf: /action="\/billing\/\w+"><input type="hidden" name="csrf"/.test(
        panel,
      ),
      note:
        start < 0 ? null : html.slice(start, html.indexOf("</aside>", start)),
    };
  };
  const quiet = spyOn(console, "error").mockImplementation(() => {});
  try {
    // Early access: nothing anywhere, even with billing on.
    expect(await read()).toMatchObject({ menu: undefined, note: null });
    await local.db.query(sql`UPDATE store_config SET trials_enabled=true`);
    await local.db.query(
      sql`INSERT INTO trial_accounts(user_id,started_at) SELECT id,created_at FROM users`,
    );
    // Every signed-in page carries the menu item, with its own CSRF field.
    await set("trialing");
    for (const path of ["/", "/tps-report", "/assistants", "/account/delete"])
      expect([path, await read(path)]).toEqual([
        path,
        { menu: ["checkout", "Add a card"], csrf: true, note: null },
      ]);
    // Seven days or fewer: the note joins the menu, with its button.
    await set("trialing", "6 days 12 hours");
    const ending = await read();
    expect(ending.menu).toEqual(["checkout", "Add a card"]);
    expect(ending.note).toContain("7 days left in your Milton trial");
    expect(ending.note).toContain("Unless you&#39;ve already added a card");
    expect(ending.note).toContain('action="/billing/checkout"');
    expect(ending.note).toContain(">Add a card</button>");
    await set("trialing", "2 hours");
    expect((await read()).note).toContain("1 day left in your Milton trial");
    // Eight days rounds up past the line: nothing above the report.
    await set("trialing", "7 days 1 hour");
    expect((await read()).note).toBeNull();
    for (const status of ["canceled", "unpaid"]) {
      await set(status);
      const paused = await read();
      expect(paused.menu).toEqual(["checkout", "Subscribe"]);
      expect(paused.note).toContain(
        "paused until you subscribe for $5.01/month",
      );
      expect(paused.note).toContain(">Subscribe</button>");
      expect(paused.note).not.toContain("trial has ended");
    }
    // Past grace reads as expired, inside it as paid.
    await set("past_due", "1 day", "4 days");
    expect((await read()).menu).toEqual(["checkout", "Subscribe"]);
    for (const status of ["active", "past_due"]) {
      await set(status);
      expect(await read()).toEqual({
        menu: ["portal", "Manage billing"],
        csrf: true,
        note: null,
      });
    }
    // A failed status read costs the item, never the page.
    await local.db.query(
      sql`ALTER TABLE trial_accounts RENAME COLUMN current_period_start TO hidden_clock`,
    );
    for (const path of ["/", "/assistants", "/account/delete"]) {
      const response = await send(path);
      expect([path, response.status]).toEqual([path, 200]);
      expect(await response.text()).not.toContain('action="/billing');
    }
    await local.db.query(
      sql`ALTER TABLE trial_accounts RENAME COLUMN hidden_clock TO current_period_start`,
    );
  } finally {
    quiet.mockRestore();
    await fixture.dispose();
  }
}, 30000);

test("connection keys: create shows the key once, the list never shows secrets, revoke confirms first, and forms need CSRF and a fresh sign-in", async () => {
  const fixture = await accountFixture();
  const { local, send, jar } = fixture;
  const count = async () =>
    (await local.db.query(sql`SELECT 1 FROM connection_keys`)).length;
  const quiet = spyOn(console, "error").mockImplementation(() => {});
  try {
    const empty = await (await send("/assistants")).text();
    expect(empty).toContain("Connection keys");
    expect(empty).toContain("No connection keys.");
    expect(empty).toMatch(
      /<form method="post" action="\/assistants\/keys" class="key-form"><input type="hidden" name="csrf"/,
    );
    expect(empty).toContain('value="read" checked=""');
    expect(empty).toContain('value="90" checked=""');
    // CSRF and Origin are enforced; nothing is created.
    for (const headers of [{ Origin: "https://evil.example" }, {}] as Record<
      string,
      string
    >[]) {
      const refused = await send(
        "/assistants/keys",
        new URLSearchParams({
          csrf: Object.keys(headers).length
            ? jar.get("milton-csrf")!
            : "x".repeat(43),
          name: "Refused",
          scope: "read",
          expiry: "90",
        }),
        headers,
      );
      expect(refused.status).toBe(403);
      expect(await refused.text()).toContain("Reload the page");
    }
    expect(await count()).toBe(0);
    // Creating a key needs a recent sign-in, and returns to this page after it.
    await local.db.query(
      sql`UPDATE milton_guard.fixture_authority SET fresh=false`,
    );
    const stale = await send("/assistants/keys", {
      name: "Stale",
      scope: "read",
      expiry: "90",
    });
    expect(stale.status).toBe(403);
    expect(await stale.text()).toContain(
      'href="/login?fresh=1&amp;next=/assistants"',
    );
    await local.db.query(
      sql`UPDATE milton_guard.fixture_authority SET fresh=true`,
    );
    const created = await send("/assistants/keys", {
      name: "Nightly <job>",
      scope: "read",
      expiry: "90",
    });
    expect(created.status).toBe(200);
    expect(created.headers.get("Cache-Control")).toBe("no-store");
    const html = await created.text();
    const key = /mk_[A-Za-z0-9_-]{22}_[A-Za-z0-9_-]{43}/.exec(html)![0];
    expect(html).toContain("You won’t see it again");
    expect(html).toContain(
      `claude mcp add --transport http milton ${resource} --header &quot;Authorization: Bearer ${key}&quot;`,
    );
    expect(html).toContain("Nightly &lt;job&gt;");
    const never = await send("/assistants/keys", {
      name: "CI",
      scope: "read_write",
      expiry: "never",
    });
    expect(never.status).toBe(200);
    const neverKey = /mk_[A-Za-z0-9_-]{22}_[A-Za-z0-9_-]{43}/.exec(
      await never.text(),
    )![0];
    for (const bad of [
      { name: "", scope: "read", expiry: "90" },
      { name: "Two\nlines", scope: "read", expiry: "90" },
      { name: "Odd", scope: "admin", expiry: "90" },
      { name: "Odd", scope: "read", expiry: "7" },
    ])
      expect((await send("/assistants/keys", bad)).status).toBe(400);
    // The list shows each key's details, never a secret or hash.
    const listed = await (await send("/assistants")).text();
    const hashes = await local.db.query<{ secret_hash: string }>(
      sql`SELECT secret_hash FROM connection_keys`,
    );
    expect(hashes).toHaveLength(2);
    for (const secret of [
      key.slice(26),
      neverKey.slice(26),
      ...hashes.map((row) => row.secret_hash),
    ])
      expect(listed).not.toContain(secret);
    expect(listed).toContain("Nightly &lt;job&gt;");
    expect(listed).toContain("Read only · Created");
    expect(listed).toContain("Read and save · Created");
    expect(listed).toContain("Never used");
    expect(listed).toContain("<strong>Never expires</strong>");
    expect(listed).toMatch(/Expires <time datetime="/);
    // Expired keys move to their own bounded history, and a key bound to an
    // earlier native generation is marked as stopped.
    const id = key.slice(3, 25);
    await local.db.query(
      sql`UPDATE connection_keys SET generation='f:0' WHERE name='CI'`,
    );
    await local.db.query(
      sql`UPDATE connection_keys SET created_at=now()-interval '91 days',expires_at=now()-interval '1 day' WHERE id=${id}`,
    );
    const history = await (await send("/assistants")).text();
    expect(history).toContain("<h3>Expired keys</h3>");
    expect(history.indexOf("Nightly &lt;job&gt;")).toBeGreaterThan(
      history.indexOf("<h3>Expired keys</h3>"),
    );
    expect(history).toContain("<strong>Stopped working.</strong>");
    // Revoking asks first, with a plain form, then refuses the key.
    const confirm = await send(`/assistants/keys/revoke?key=${id}`);
    expect(confirm.status).toBe(200);
    const confirmHtml = await confirm.text();
    expect(confirmHtml).toContain("Revoke this key?");
    expect(confirmHtml).toMatch(
      /<form method="post" action="\/assistants\/keys\/revoke"><input type="hidden" name="csrf"/,
    );
    expect(await count()).toBe(2);
    expect(
      (
        await send(
          "/assistants/keys/revoke",
          new URLSearchParams({ csrf: "x".repeat(43), key: id }),
        )
      ).status,
    ).toBe(403);
    const revoked = await send("/assistants/keys/revoke", { key: id });
    expect(revoked.status).toBe(303);
    expect(revoked.headers.get("Location")).toBe(
      appOrigin + "/assistants#connection-keys",
    );
    expect(
      (
        await local.db.query<{ revoked: boolean }>(
          sql`SELECT revoked_at IS NOT NULL AS revoked FROM connection_keys WHERE id=${id}`,
        )
      )[0]!.revoked,
    ).toBe(true);
    expect(await (await send("/assistants")).text()).not.toContain(
      "Nightly &lt;job&gt;",
    );
    expect((await send(`/assistants/keys/revoke?key=${id}`)).status).toBe(404);
  } finally {
    quiet.mockRestore();
    await fixture.dispose();
  }
}, 30000);

// Deletion and disconnect run against the native lifecycle stand-ins in
// auth-fixtures.ts; check-auth-integration.ts runs the native functions.
const operationIn = (html: string) =>
  /name="operation" value="([^"]+)"/.exec(html)![1]!;
async function deletionFixture() {
  const { stripe, billing } = fakeStripe();
  const fixture = await accountFixture({ billing });
  const { db } = fixture.local;
  const { userId } = await lookupIdentityAccount(fixture.local.env, {
    provider: issuer,
    subject: "account",
  });
  await fixtureStore(db, userId).saveMemo(memoSave());
  await db.query(
    sql`INSERT INTO trial_accounts(user_id,started_at,stripe_customer_id) VALUES(${userId},now(),'cus_fixture')`,
  );
  // What the person, or a later sign-in, would find of the account.
  const remains = async () => ({
    account: (await db.query(sql`SELECT 1 FROM users WHERE id=${userId}`))
      .length,
    writing: (await db.query(sql`SELECT 1 FROM memos WHERE user_id=${userId}`))
      .length,
    sessions: (await db.query(sql`SELECT 1 FROM milton_app.session`)).length,
    customer: (
      await db.query<{ customer: string | null }>(
        sql`SELECT stripe_customer_id AS customer FROM trial_accounts WHERE user_id=${userId}`,
      )
    )[0]?.customer,
  });
  return { ...fixture, stripe, userId, remains };
}

test("account deletion needs the exact phrase and a fresh sign-in; either refusal starts nothing and changes nothing", async () => {
  const fixture = await deletionFixture();
  const { local, send, stripe } = fixture;
  try {
    const form = await send("/account/delete");
    expect(form.status).toBe(200);
    const operation = operationIn(await form.text());
    const before = await fixture.remains();
    expect(before).toEqual({
      account: 1,
      writing: 1,
      sessions: 1,
      customer: "cus_fixture",
    });
    const wrong = await send("/account/delete", {
      operation,
      confirm: "delete my acount",
    });
    expect(wrong.status).toBe(400);
    expect(await wrong.text()).toContain("Nothing was deleted.");
    await local.db.query(
      sql`UPDATE milton_guard.fixture_authority SET fresh=false`,
    );
    const stale = await send("/account/delete", {
      operation,
      confirm: "delete my account",
    });
    expect(stale.status).toBe(403);
    expect(await stale.text()).toContain("Sign in again");
    expect(await fixture.remains()).toEqual(before);
    expect(stripe.calls).toEqual([]);
    // No deletion began: the session still reads, and the page offers a new
    // deletion rather than a retry.
    expect((await send("/tps-report")).status).toBe(200);
    const again = await send("/account/delete");
    expect(again.status).toBe(200);
    expect(await again.text()).toContain("Type <code>delete my account</code>");
  } finally {
    await fixture.dispose();
  }
}, 30000);

test("account deletion: a Stripe failure keeps the account and its writing; retries of the same operation resume where it stopped, end the customer once and finish, and the identity gets no second trial", async () => {
  const fixture = await deletionFixture();
  const { local, send, stripe, jar } = fixture;
  const quiet = spyOn(console, "error").mockImplementation(() => {});
  try {
    const operation = operationIn(await (await send("/account/delete")).text());
    const before = await fixture.remains();
    const confirm = { operation, confirm: "delete my account" };
    stripe.down = true;
    const failed = await send("/account/delete", confirm);
    expect(failed.status).toBe(503);
    const failedPage = await failed.text();
    expect(failedPage).toContain("Account deletion is incomplete.");
    expect(failedPage).toContain(`name="operation" value="${operation}"`);
    expect(failedPage).not.toContain("Your writing has been erased.");
    expect(await fixture.remains()).toEqual(before);
    expect(stripe.calls.map((call) => call.call)).toEqual([
      "DELETE /v1/customers/cus_fixture",
      "GET /v1/customers/cus_fixture",
    ]);
    // Reloading offers the same operation's retry, not a new deletion.
    const reload = await send("/account/delete");
    expect(reload.status).toBe(503);
    expect(operationIn(await reload.text())).toBe(operation);
    // Stripe answers, then erasing the writing fails: the customer has ended,
    // the account and its writing remain.
    stripe.down = false;
    stripe.calls.length = 0;
    await local.pg.exec(
      `CREATE FUNCTION fixture_outage() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture erase outage'; END $$`,
    );
    await local.pg.exec(
      `CREATE TRIGGER fixture_outage BEFORE DELETE ON users FOR EACH ROW EXECUTE FUNCTION fixture_outage()`,
    );
    const unerased = await send("/account/delete", confirm);
    expect(unerased.status).toBe(503);
    expect(await unerased.text()).not.toContain(
      "Your writing has been erased.",
    );
    expect(await fixture.remains()).toEqual({ ...before, customer: null });
    expect(stripe.calls.map((call) => call.call)).toEqual([
      "DELETE /v1/customers/cus_fixture",
    ]);
    // Then native cleanup fails: the writing is erased without asking Stripe
    // again, and the retry page says so.
    await local.pg.exec(`DROP TRIGGER fixture_outage ON users`);
    await local.db.query(
      sql`UPDATE milton_guard.fixture_authority SET fail='cleanup_operation'`,
    );
    stripe.calls.length = 0;
    const partial = await send("/account/delete", confirm);
    expect(partial.status).toBe(503);
    expect(await partial.text()).toContain("Your writing has been erased.");
    expect(await fixture.remains()).toEqual({
      account: 0,
      writing: 0,
      sessions: 0,
      customer: undefined,
    });
    expect(stripe.calls).toEqual([]);
    // The next retry finishes without asking Stripe again, and signs out.
    await local.db.query(
      sql`UPDATE milton_guard.fixture_authority SET fail=NULL`,
    );
    stripe.calls.length = 0;
    const done = await send("/account/delete", confirm);
    expect(done.status).toBe(200);
    expect(await done.text()).toContain("Account deleted");
    expect(stripe.calls).toEqual([]);
    expect(done.headers.getSetCookie()).toContainEqual(
      expect.stringMatching(/^milton-session=; .*Max-Age=0/),
    );
    expect(jar.get("milton-session")).toBe("");
    // A later sign-in with the same identity and verified email gets a new,
    // empty account whose trial starts canceled: deletion kept the email's
    // trial-eligibility fingerprint (the account itself was made without one).
    await resolveIdentityAccount(
      local.env,
      { provider: issuer, subject: "account" },
      trialFingerprints(local.config.trialFingerprintKey, {
        verifiedEmail: "fixture@example.invalid",
        verifiedIdentities: [],
      }),
    );
    const returning = await local.db.query<{
      user_id: string;
      subscription_status: string | null;
    }>(sql`SELECT user_id,subscription_status FROM trial_accounts`);
    expect(returning).toHaveLength(1);
    expect(returning[0]!.user_id).not.toBe(fixture.userId);
    expect(returning[0]!.subscription_status).toBe("canceled");
  } finally {
    quiet.mockRestore();
    await fixture.dispose();
  }
}, 30000);

test("account deletion: a checkout in flight as it begins links no customer and opens no session, nothing enrols the account, and the erase first ends a customer linked late", async () => {
  const fixture = await deletionFixture();
  const { local, send, stripe, userId } = fixture;
  const quiet = spyOn(console, "error").mockImplementation(() => {});
  try {
    // A returning deleted identity: no customer, so checkout makes one.
    await local.db.query(
      sql`UPDATE trial_accounts SET stripe_customer_id=NULL,subscription_status='canceled'`,
    );
    const operation = operationIn(await (await send("/account/delete")).text());
    const confirm = { operation, confirm: "delete my account" };
    // Erasing fails, so the deletion stops once its Stripe step is done.
    await local.pg.exec(
      `CREATE FUNCTION fixture_outage() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture erase outage'; END $$`,
    );
    await local.pg.exec(
      `CREATE TRIGGER fixture_outage BEFORE DELETE ON users FOR EACH ROW EXECUTE FUNCTION fixture_outage()`,
    );
    // The checkout is past its sign-in check when the deletion begins, while
    // Stripe creates its customer.
    let deletion: Response | undefined;
    stripe.onCustomer = async () => {
      stripe.onCustomer = async () => {};
      deletion = await send("/account/delete", confirm);
    };
    const checkout = await send("/billing/checkout", {});
    expect(deletion?.status).toBe(503);
    expect(checkout.status).toBe(409);
    expect(await checkout.text()).toContain("This account is being deleted");
    // The customer Stripe made holds the email, so it is deleted at once.
    expect(stripe.calls.map((call) => call.call)).toEqual([
      "POST /v1/customers",
      "DELETE /v1/customers/cus_fixture",
    ]);
    expect(await fixture.remains()).toMatchObject({
      account: 1,
      customer: null,
    });
    // Nothing enrols the account either: enrolment refuses it, and the
    // subscription backfill counts it as skipped.
    await local.db.query(
      sql`UPDATE trial_accounts SET subscription_status=NULL`,
    );
    await local.db.query(sql`UPDATE store_config SET trials_enabled=true`);
    stripe.calls.length = 0;
    await expect(
      ensureSubscription(local.config, userId),
    ).rejects.toMatchObject({ code: "account_deleting", status: 409 });
    expect(
      await backfillSubscriptions(
        local.config,
        { apply: true, allowTestKey: true },
        async () => {},
      ),
    ).toEqual({ total: 1, created: 0, skipped: 1, failed: 0, still_null: 1 });
    expect(stripe.calls).toEqual([]);
    // A customer linked anyway, as an image without that refusal could while a
    // release rolls out, is ended before the erase.
    await local.db.query(
      sql`UPDATE trial_accounts SET stripe_customer_id='cus_fixture'`,
    );
    await local.pg.exec(`DROP TRIGGER fixture_outage ON users`);
    stripe.calls.length = 0;
    const done = await send("/account/delete", confirm);
    expect(done.status).toBe(200);
    expect(stripe.calls.map((call) => call.call)).toEqual([
      "DELETE /v1/customers/cus_fixture",
    ]);
    expect(await fixture.remains()).toEqual({
      account: 0,
      writing: 0,
      sessions: 0,
      customer: undefined,
    });
  } finally {
    quiet.mockRestore();
    await fixture.dispose();
  }
}, 30000);

test("account deletion: a refused link leaves alone the customer an earlier request linked under the same idempotency key", async () => {
  const fixture = await deletionFixture();
  const { local, send, stripe } = fixture;
  const quiet = spyOn(console, "error").mockImplementation(() => {});
  try {
    await local.db.query(
      sql`UPDATE trial_accounts SET stripe_customer_id=NULL,subscription_status='canceled'`,
    );
    const operation = operationIn(await (await send("/account/delete")).text());
    const confirm = { operation, confirm: "delete my account" };
    // Ending the customer fails, so the deletion stops refused, the customer
    // still linked.
    stripe.down = "DELETE /v1/customers/cus_fixture";
    // While Stripe creates this checkout's customer, another checkout in the
    // same minute gets the same one and links it, then the deletion begins.
    let earlier: Response | undefined;
    let deletion: Response | undefined;
    stripe.onCustomer = async () => {
      stripe.onCustomer = async () => {};
      earlier = await send("/billing/checkout", {});
      deletion = await send("/account/delete", confirm);
    };
    const later = await send("/billing/checkout", {});
    expect(earlier?.status).toBe(200);
    expect(deletion?.status).toBe(503);
    expect(later.status).toBe(409);
    // Only the deletion tries to delete the linked customer.
    expect(
      stripe.calls.filter(({ call }) => String(call).startsWith("DELETE")),
    ).toHaveLength(1);
    expect((await fixture.remains()).customer).toBe("cus_fixture");
    stripe.down = false;
    stripe.calls.length = 0;
    expect((await send("/account/delete", confirm)).status).toBe(200);
    expect(stripe.calls.map(({ call }) => call)).toEqual([
      "DELETE /v1/customers/cus_fixture",
    ]);
  } finally {
    quiet.mockRestore();
    await fixture.dispose();
  }
}, 30000);

test("account deletion: a checkout with a stored customer expires the session it opened once the deletion has begun", async () => {
  const fixture = await deletionFixture();
  const { local, send, stripe } = fixture;
  const quiet = spyOn(console, "error").mockImplementation(() => {});
  try {
    await local.db.query(
      sql`UPDATE trial_accounts SET subscription_status='canceled'`,
    );
    const operation = operationIn(await (await send("/account/delete")).text());
    // Erasing fails, so the deletion stops once its Stripe step is done.
    await local.pg.exec(
      `CREATE FUNCTION fixture_outage() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture erase outage'; END $$`,
    );
    await local.pg.exec(
      `CREATE TRIGGER fixture_outage BEFORE DELETE ON users FOR EACH ROW EXECUTE FUNCTION fixture_outage()`,
    );
    // The deletion begins and ends the customer while checkout copies the email.
    let deletion: Response | undefined;
    stripe.onCustomer = async () => {
      stripe.onCustomer = async () => {};
      deletion = await send("/account/delete", {
        operation,
        confirm: "delete my account",
      });
    };
    const checkout = await send("/billing/checkout", {});
    expect(deletion?.status).toBe(503);
    expect(checkout.status).toBe(409);
    expect(await checkout.text()).toContain("This account is being deleted");
    expect(
      stripe.calls
        .map(({ call }) => String(call))
        .filter((call) => !call.startsWith("GET /v1/subscriptions")),
    ).toEqual([
      "POST /v1/customers/cus_fixture",
      "DELETE /v1/customers/cus_fixture",
      "POST /v1/checkout/sessions",
      "POST /v1/checkout/sessions/cs_test_fixture/expire",
    ]);
  } finally {
    quiet.mockRestore();
    await fixture.dispose();
  }
}, 30000);

test("account deletion: a checkout expires its session when the deletion finishes, account erased, while Stripe opens it", async () => {
  const fixture = await deletionFixture();
  const { local, send, stripe } = fixture;
  try {
    await local.db.query(
      sql`UPDATE trial_accounts SET subscription_status='canceled'`,
    );
    const operation = operationIn(await (await send("/account/delete")).text());
    let deletion: Response | undefined;
    stripe.onSession = async () => {
      stripe.onSession = async () => {};
      deletion = await send("/account/delete", {
        operation,
        confirm: "delete my account",
      });
    };
    const checkout = await send("/billing/checkout", {});
    expect(deletion?.status).toBe(200);
    expect((await fixture.remains()).account).toBe(0);
    expect(checkout.status).toBe(409);
    expect(await checkout.text()).not.toContain("checkout.stripe.com");
    expect(
      stripe.calls
        .map(({ call }) => String(call))
        .filter((call) => !call.startsWith("GET /v1/subscriptions")),
    ).toEqual([
      "POST /v1/customers/cus_fixture",
      "POST /v1/checkout/sessions",
      "DELETE /v1/customers/cus_fixture",
      "POST /v1/checkout/sessions/cs_test_fixture/expire",
    ]);
  } finally {
    await fixture.dispose();
  }
}, 30000);

test("billing answers 409 to an account whose deletion has begun, before any Stripe call", async () => {
  const fixture = await deletionFixture();
  const { local, send, stripe, userId } = fixture;
  try {
    await send("/");
    await local.db.query(
      sql`UPDATE trial_accounts SET subscription_status='canceled'`,
    );
    // A refusal recorded after this request's sign-in check, which is all a
    // request already past that check would see of it.
    await local.db.query(
      sql`INSERT INTO milton_app.lifecycle(operation_id,issuer,subject,incarnation,user_id,kind,requester_hash,progress) VALUES(${crypto.randomUUID()}::uuid,${issuer},'account','f:1',${userId},'delete',${"a".repeat(64)},'refused')`,
    );
    for (const route of ["/billing/checkout", "/billing/portal"]) {
      const refused = await send(route, {});
      expect([route, refused.status]).toEqual([route, 409]);
      expect(await refused.text()).toContain("This account is being deleted");
    }
    expect(stripe.calls).toEqual([]);
  } finally {
    await fixture.dispose();
  }
}, 30000);

test("account deletion: native refusal and the progress billing reads commit together", async () => {
  const fixture = await deletionFixture();
  const { local, send } = fixture;
  const quiet = spyOn(console, "error").mockImplementation(() => {});
  try {
    const operation = operationIn(await (await send("/account/delete")).text());
    const confirm = { operation, confirm: "delete my account" };
    await local.pg.exec(
      `CREATE FUNCTION fixture_refusal_outage() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture refusal outage'; END $$`,
    );
    await local.pg.exec(
      `CREATE TRIGGER fixture_refusal_outage BEFORE UPDATE ON milton_app.lifecycle FOR EACH ROW WHEN (NEW.progress='refused') EXECUTE FUNCTION fixture_refusal_outage()`,
    );
    expect((await send("/account/delete", confirm)).status).toBe(503);
    // Neither committed: native deletion has not begun, so billing reading
    // the operation as pending is right, and the session still works.
    const native = await local.db.query(
      sql`SELECT 1 FROM milton_guard.fixture_operation`,
    );
    const progress = await local.db.query<{ progress: string }>(
      sql`SELECT progress FROM milton_app.lifecycle`,
    );
    expect([native.length, progress]).toEqual([0, [{ progress: "pending" }]]);
    expect((await send("/tps-report")).status).toBe(200);
    await local.pg.exec(
      `DROP TRIGGER fixture_refusal_outage ON milton_app.lifecycle`,
    );
    expect((await send("/account/delete", confirm)).status).toBe(200);
  } finally {
    quiet.mockRestore();
    await fixture.dispose();
  }
}, 30000);

test("disconnect ends only a listed connection: another one is refused and starts nothing; an interrupted one is offered for retry and finishes", async () => {
  const fixture = await accountFixture();
  const { local, send } = fixture;
  const quiet = spyOn(console, "error").mockImplementation(() => {});
  const listing = async () => {
    const response = await send("/assistants");
    expect(response.status).toBe(200);
    return response.text();
  };
  try {
    await local.db.query(
      sql`INSERT INTO milton_guard.fixture_connection(reference,subject,client_id,scopes) VALUES('listed-ref','account','https://assistant.example/client','["milton:read","milton:write"]'),('elsewhere-ref','another-person','https://elsewhere.example/client','["milton:read"]')`,
    );
    const page = await listing();
    expect(page).toContain("<strong>assistant.example</strong>");
    expect(page).toContain('name="connection" value="listed-ref"');
    expect(page).not.toContain("elsewhere");
    const operation = operationIn(page);
    // A connection this list does not show is refused before any operation.
    const refused = await send("/assistants/disconnect", {
      connection: "elsewhere-ref",
      operation,
    });
    expect(refused.status).toBe(401);
    const unchanged = await listing();
    expect(unchanged).toContain('name="connection" value="listed-ref"');
    expect(unchanged).not.toContain("Disconnect cleanup is incomplete");
    // When native begin_operation fails, the answer is a retry page for the
    // same operation, and the request stays listed for retry.
    await local.db.query(
      sql`UPDATE milton_guard.fixture_authority SET fail='begin_operation'`,
    );
    const failed = await send("/assistants/disconnect", {
      connection: "listed-ref",
      operation,
    });
    expect(failed.status).toBe(503);
    const failedPage = await failed.text();
    expect(failedPage).toContain("Finish disconnecting");
    expect(failedPage).toContain(
      "Retry to finish disconnecting assistant.example.",
    );
    expect(operationIn(failedPage)).toBe(operation);
    await local.db.query(
      sql`UPDATE milton_guard.fixture_authority SET fail=NULL`,
    );
    const pending = await listing();
    expect(pending).toContain(
      "Retry to finish disconnecting assistant.example.",
    );
    // The retry form carries only the operation.
    const retry = await send("/assistants/disconnect", {
      operation: operationIn(failedPage),
    });
    expect(retry.status).toBe(303);
    expect(retry.headers.get("Location")).toBe(appOrigin + "/assistants");
    const after = await listing();
    expect(after).toContain("No AIs are connected.");
    expect(after).not.toContain("Disconnect cleanup is incomplete");
    // The other person's connection is untouched.
    expect(
      await local.db.query(
        sql`SELECT reference FROM milton_guard.fixture_connection WHERE active`,
      ),
    ).toEqual([{ reference: "elsewhere-ref" }]);
  } finally {
    quiet.mockRestore();
    await fixture.dispose();
  }
}, 30000);

test("trial reminders stay outside TPS and expired accounts retain web view and download", async () => {
  const fixture = await memoPageFixture();
  try {
    const saved = await fixture.author.saveMemo(
      memoSave({ final: "Be concise." }),
    );
    expect(saved.status).toBe("saved");
    const exported = await fixture.store.exportTps();
    expect(await (await fixture.send("/")).text()).not.toContain(
      "Milton subscription",
    );
    await fixture.db.query(sql`UPDATE store_config SET trials_enabled=true`);
    await fixture.db.query(
      sql`INSERT INTO trial_accounts(user_id,started_at,subscription_status,trial_end) SELECT id,created_at,'trialing',clock_timestamp()+interval '30 days' FROM users`,
    );
    const freshTrial = await (await fixture.send("/")).text();
    expect(freshTrial).not.toContain("trial starts");
    expect(freshTrial).not.toContain("Milton subscription");
    await fixture.db.query(
      sql`UPDATE trial_accounts SET trial_end=clock_timestamp()+interval '6 days'`,
    );
    const warning = await fixture.send("/");
    expect(warning.status).toBe(200);
    const warned = await warning.text();
    expect(warned).toContain("days left in your Milton trial");
    // Without billing configured there is nothing to press.
    expect(warned).not.toContain('action="/billing');
    // Page views do not consume an AI's reminder milestone.
    expect(
      (await fixture.db.query(sql`SELECT notice_stage FROM trial_accounts`))[0]!
        .notice_stage,
    ).toBe(0);
    await fixture.db.query(
      sql`UPDATE trial_accounts SET subscription_status='canceled'`,
    );
    const expired = await fixture.send("/tps-report");
    expect(expired.status).toBe(200);
    const html = await expired.text();
    expect(html).toContain("AI reads and saves are paused until");
    expect(html).toContain("Your memos, tweaks and cover sheet are still here");
    expect(html).not.toContain('action="/billing');
    expect(html).not.toContain("it keeps a memo here");
    expect(html).toContain("decline a vendor&#39;s meeting request");
    const download = await fixture.send("/download");
    expect(download.status).toBe(200);
    expect(await download.text()).toBe(exported);
  } finally {
    await fixture.dispose();
  }
});

// A second account in the same store, with a memo and a tweak of its own.
async function otherAccount(
  fixture: Awaited<ReturnType<typeof memoPageFixture>>,
) {
  const bindings = { storeDatabase: fixture.db, appOrigin };
  const identity = { provider: issuer, subject: "page-alpha" };
  await resolveIdentityAccount(bindings, identity);
  const { userId } = await lookupIdentityAccount(bindings, identity);
  const saved = await fixtureStore(fixture.db, userId).saveMemo(
    memoSave({
      first_draft: "Alpha's first draft.",
      final: "Alpha's final.",
      mode: "draft",
      rounds: 1,
      changes: teach("first draft", { text: "alpha signs as Ada" }),
    }),
  );
  return {
    userId,
    memo: saved.memo!.memo_id,
    tweak: saved.memo!.tweaks[0]!.tweak_id,
  };
}

test("the TPS page lists memos newest first, escaped, opens each only for its own account, and downloads TPS.md", async () => {
  const fixture = await memoPageFixture();
  try {
    const empty = await (await fixture.send("/")).text();
    expect(empty).toContain("No memos on file yet.");
    expect(empty).toContain('href="/assistants#connect"');
    expect(empty).toContain("No cover sheet yet.");
    expect(empty).not.toContain("<textarea");
    for (const [path, method] of [
      ["/download", "PUT"],
      ["/download", "POST"],
      ["/tps/forget", "GET"],
      ["/tps/memo/" + crypto.randomUUID(), "POST"],
    ] as const)
      expect(
        (
          await fixture.app(
            new Request(appOrigin + path, {
              method,
              headers: { Host: "localhost:3001" },
            }),
          )
        ).status,
      ).toBe(405);
    const steered = await fixture.author.saveMemo(
      memoSave({
        first_draft: "Hi! Hope you're well. <script>alert('draft')</script>",
        final: "No, thanks. <script>alert('final')</script>\n\n–P",
        mode: "draft",
        rounds: 2,
        changes: teach("Hi!", { text: "no warm-up opener <b>" }),
        new_kind: "vendor decline",
      }),
    );
    const report = await fixture.author.readReport(vendorIntent);
    const untouched = await fixture.author.saveMemo(
      memoSave({
        first_draft: "Same.",
        final: "Same.",
        mode: "draft",
        rounds: 0,
        report_id: report.report_id,
      }),
    );
    const own = await fixture.author.saveMemo(
      memoSave({ final: "My own words & more." }),
    );
    const [a, b, c] = [steered, untouched, own].map((s) => s.memo!.memo_id) as [
      string,
      string,
      string,
    ];
    const alpha = await otherAccount(fixture);
    const html = await (await fixture.send("/tps-report")).text();
    expect(html).not.toContain("<script>");
    expect(html).toContain("Email · vendor decline");
    expect(html).toContain("ai.example · 2 rounds · steered by you");
    expect(html).toContain("ai.example · 0 rounds · accepted untouched");
    expect(html).toContain("ai.example · your words");
    expect(html).toContain(
      '<span class="tweak-label">Taught:</span> <span class="typed">no warm-up opener &lt;b&gt;</span>',
    );
    expect(html).toContain(
      '<span class="tweak-label">Served:</span> <span class="typed">no warm-up opener &lt;b&gt;</span>',
    );
    expect(html).toContain(
      "First drafts: 2 scored memos so far. 8 more to start the scoreboard.",
    );
    // The untouched memo was served the tweak and did not need it again.
    expect(html).toContain(
      '<p><span class="typed">no warm-up opener &lt;b&gt;</span></p><p class="report-counts tweak-counts"><span>1 memo</span><span>served 1</span><span>needed again 0</span></p>',
    );
    // Newest first.
    const at = (id: string) => html.indexOf(`href="/tps/memo/${id}"`);
    expect(at(c)).toBeGreaterThan(0);
    expect(at(c)).toBeLessThan(at(b));
    expect(at(b)).toBeLessThan(at(a));
    for (const foreign of ["Alpha", "alpha signs", alpha.memo, alpha.userId])
      expect(html).not.toContain(foreign);
    const full = await fixture.send(`/tps/memo/${a}`);
    expect(full.status).toBe(200);
    const memo = await full.text();
    for (const text of [
      "Hi! Hope you&#39;re well. &lt;script&gt;alert(&#39;draft&#39;)&lt;/script&gt;",
      "No, thanks. &lt;script&gt;alert(&#39;final&#39;)&lt;/script&gt;\n\n–P",
      "decline a vendor&#39;s meeting request",
      "Drafted by your AI",
      `<input type="hidden" name="memo" value="${a}"/>`,
    ])
      expect(memo).toContain(text);
    expect(memo).not.toContain("<script>");
    expect(await (await fixture.send(`/tps/memo/${c}`)).text()).toContain(
      "Your own writing: there’s no first draft.",
    );
    for (const path of [
      `/tps/memo/${alpha.memo}`,
      `/tps/memo/${crypto.randomUUID()}`,
      "/tps/memo/not-a-memo",
    ]) {
      const missing = await fixture.send(path);
      expect([path, missing.status]).toEqual([path, 404]);
      expect(await missing.text()).not.toContain("Alpha");
    }
    const download = await fixture.send("/download");
    expect(download.headers.get("Content-Type")).toBe(
      "text/markdown; charset=utf-8",
    );
    expect(download.headers.get("Content-Disposition")).toBe(
      'attachment; filename="TPS.md"',
    );
    expect(download.headers.get("Cache-Control")).toBe("no-store");
    const text = await download.text();
    expect(text).toBe(await fixture.store.exportTps());
    expect(text).toContain("> No, thanks. <script>alert('final')</script>");
    expect(text).not.toContain("Alpha");
  } finally {
    await fixture.dispose();
  }
}, 30000);

test("the TPS page shows the cover sheet read-only, line by line and escaped, and takes no cover sheet POST", async () => {
  const fixture = await memoPageFixture();
  try {
    const save = (cover_sheet: {
      add?: string;
      remove?: string;
      expected_version: number;
    }) =>
      fixture.author.saveMemo({ request_id: crypto.randomUUID(), cover_sheet });
    await save({ add: "No em dashes <b>", expected_version: 0 });
    await save({ add: "Sign off –P", expected_version: 1 });
    const shown = await (await fixture.send("/")).text();
    expect(shown).toContain(
      '<span class="typed">No em dashes &lt;b&gt;</span>',
    );
    expect(shown).toContain('<span class="typed">Sign off –P</span>');
    expect(shown).not.toContain("No cover sheet yet.");
    expect(shown).not.toContain("<textarea");
    expect(shown).not.toContain('action="/tps/cover-sheet"');
    const posted = await fixture.send("/tps/cover-sheet", {
      text: "Mine.",
      expected_version: "2",
    });
    expect(posted.status).toBe(404);
    expect((await fixture.store.read()).cover_sheet).toEqual({
      text: "No em dashes <b>\nSign off –P",
      version: 2,
    });
  } finally {
    await fixture.dispose();
  }
}, 30000);

test("forget, tweak delete and reword change only the session account's memos and tweaks", async () => {
  const fixture = await memoPageFixture();
  try {
    const alpha = await otherAccount(fixture);
    const saved = await fixture.author.saveMemo(
      memoSave({
        first_draft: "Hi! Long draft.",
        final: "Short.",
        mode: "draft",
        rounds: 1,
        changes: teach("Hi!", { text: "no opener" }, { text: "two sentences" }),
      }),
    );
    const memo = saved.memo!.memo_id;
    const [opener, sentences] = saved.memo!.tweaks.map((t) => t.tweak_id) as [
      string,
      string,
    ];
    const alphaRead = async () =>
      (
        await fixture.db.query(
          sql`SELECT (SELECT count(*) FROM memos WHERE user_id=${alpha.userId}) AS memos,
            (SELECT string_agg(text,',') FROM tweaks WHERE user_id=${alpha.userId}) AS tweaks`,
        )
      )[0];
    const before = await alphaRead();
    await fixture.send("/");
    for (const [path, fields] of [
      ["/tps/tweaks/reword", { tweak: alpha.tweak, text: "taken over" }],
      ["/tps/tweaks/delete", { tweak: alpha.tweak }],
      ["/tps/forget", { memo: alpha.memo }],
      ["/tps/forget", { memo: "not-a-memo" }],
    ] as const)
      expect([path, (await fixture.send(path, fields)).status]).toEqual([
        path,
        404,
      ]);
    expect(await alphaRead()).toEqual(before);
    const reworded = await fixture.send("/tps/tweaks/reword", {
      tweak: opener,
      text: "No warm-up opener <i>",
    });
    expect(reworded.status).toBe(303);
    expect(reworded.headers.get("Location")).toBe(
      appOrigin + "/?done=tweak-reworded#tweaks",
    );
    expect((await fixture.store.read()).tweaks).toContainEqual({
      id: opener,
      text: "No warm-up opener <i>",
      memos: 1,
      served: 0,
      needed_again: 0,
    });
    const page = await (await fixture.send("/?done=tweak-reworded")).text();
    expect(page).toContain("Tweak reworded.");
    expect(page).toContain("No warm-up opener &lt;i&gt;");
    const taken = await fixture.send("/tps/tweaks/reword", {
      tweak: sentences,
      text: "no warm-up opener <i>.",
    });
    expect(taken.status).toBe(409);
    expect(await taken.text()).toContain("Another tweak already says that.");
    expect(
      (await fixture.send("/tps/tweaks/delete", { tweak: sentences })).status,
    ).toBe(303);
    expect((await fixture.store.read()).tweaks.map((t) => t.id)).toEqual([
      opener,
    ]);
    const forgot = await fixture.send("/tps/forget", { memo });
    expect(forgot.status).toBe(303);
    expect(forgot.headers.get("Location")).toBe(
      appOrigin + "/?done=forgot#memos",
    );
    const view = await fixture.store.read();
    expect(view.memos).toEqual([]);
    expect(view.tweaks).toEqual([]);
    expect(await alphaRead()).toEqual(before);
  } finally {
    await fixture.dispose();
  }
}, 30000);

test("Keep memos turns off and on, and Delete all memos asks first, then keeps the cover sheet and other accounts", async () => {
  const fixture = await memoPageFixture();
  try {
    const alpha = await otherAccount(fixture);
    const settings = await (await fixture.send("/account/memos")).text();
    expect(settings).toContain("Turn off Keep memos");
    const off = await fixture.send("/account/memos", { keep: "off" });
    expect(off.status).toBe(303);
    expect(off.headers.get("Location")).toBe(
      appOrigin + "/account/memos?done=off",
    );
    expect((await fixture.store.read()).keep_memos).toBe(false);
    expect(
      await (await fixture.send("/account/memos?done=off")).text(),
    ).toContain("Turn on Keep memos");
    expect(await (await fixture.send("/")).text()).toContain(
      "Keep memos is off",
    );
    expect(
      (await fixture.send("/account/memos", { keep: "maybe" })).status,
    ).toBe(400);
    expect(
      (
        await fixture.send(
          "/account/memos",
          { keep: "on" },
          { Origin: "https://evil.example" },
        )
      ).status,
    ).toBe(403);
    expect((await fixture.store.read()).keep_memos).toBe(false);
    expect((await fixture.send("/account/memos", { keep: "on" })).status).toBe(
      303,
    );
    expect((await fixture.store.read()).keep_memos).toBe(true);

    await fixture.author.saveMemo(
      memoSave({
        first_draft: "Draft.",
        final: "Final.",
        mode: "draft",
        rounds: 1,
        changes: teach("Draft", { text: "be brief" }),
        new_kind: "vendor decline",
      }),
    );
    await fixture.author.saveMemo({
      request_id: crypto.randomUUID(),
      cover_sheet: { add: "Sign off –P", expected_version: 0 },
    });
    const counts = (userId: string) =>
      fixture.db.query(
        sql`SELECT (SELECT count(*) FROM memos WHERE user_id=${userId})::int AS memos,
          (SELECT count(*) FROM tweaks WHERE user_id=${userId})::int AS tweaks,
          (SELECT count(*) FROM memo_kinds WHERE user_id=${userId})::int AS kinds,
          (SELECT count(*) FROM cover_sheets WHERE user_id=${userId})::int AS covers`,
      );
    const confirm = await (await fixture.send("/account/memos/delete")).text();
    expect(confirm).toContain('<input type="hidden" name="confirm"');
    expect(confirm).toContain("Your cover sheet stays.");
    // The download it offers as a backup leaves out first drafts; say so.
    expect(confirm).toContain("it leaves out first drafts");
    expect(
      (await fixture.send("/account/memos/delete", { confirm: "yes" })).status,
    ).toBe(400);
    expect(await counts(fixture.userId)).toEqual([
      { memos: 1, tweaks: 1, kinds: 1, covers: 1 },
    ]);
    const deleted = await fixture.send("/account/memos/delete", {
      confirm: "delete all memos",
    });
    expect(deleted.status).toBe(303);
    expect(deleted.headers.get("Location")).toBe(
      appOrigin + "/account/memos?done=deleted",
    );
    expect(await counts(fixture.userId)).toEqual([
      { memos: 0, tweaks: 0, kinds: 0, covers: 1 },
    ]);
    expect(await counts(alpha.userId)).toEqual([
      { memos: 1, tweaks: 1, kinds: 0, covers: 0 },
    ]);
    expect((await fixture.store.read()).cover_sheet.text).toBe("Sign off –P");
  } finally {
    await fixture.dispose();
  }
}, 30000);

test("a live session whose account is closing refuses its pages with account_unavailable", async () => {
  const fixture = await memoPageFixture();
  try {
    await fixture.db.query(sql`UPDATE users SET status='deleting'`);
    for (const path of ["/", "/tps-report", "/assistants", "/account/memos"]) {
      const response = await fixture.send(path);
      expect(response.status).toBe(403);
      expect(await response.text()).toContain(
        "Sign in to Milton before connecting your AI.",
      );
    }
  } finally {
    await fixture.dispose();
  }
}, 30000);

test("the MCP host redirects browser paths to the app host unchanged", async () => {
  const { createMcpApp } = await import("../src/index");
  const app = createMcpApp({
    issuer,
    resource: "https://mcp.example/mcp",
    appOrigin,
  });
  for (const path of [
    "/login?flow=a%2Bb",
    "/tps-report",
    "/unrelated/%25252541",
  ]) {
    const response = await app(
      new Request("https://mcp.example" + path, {
        headers: { Host: "mcp.example" },
      }),
    );
    expect(response.status).toBe(308);
    expect(response.headers.get("Location")).toBe(appOrigin + path);
  }
});

test("an unexpected error shows a browser page PC LOAD LETTER and answers everything else with the same JSON", async () => {
  // The host check runs before every route; a throwing Host read reaches onError.
  const failing = (path: string, init: RequestInit) => {
    const request = new Request(appOrigin + path, init);
    const get = request.headers.get.bind(request.headers);
    request.headers.get = (name) => {
      if (name.toLowerCase() === "host") throw new RangeError("Fixture");
      return get(name);
    };
    return request;
  };
  const logged = spyOn(console, "error").mockImplementation(() => {});
  try {
    const app = appFor({});
    const shown = await app(
      failing("/tps-report", {
        headers: { Accept: "text/html,application/xhtml+xml,*/*;q=0.8" },
      }),
    );
    expect(shown.status).toBe(503);
    expect(shown.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
    expect(shown.headers.get("Cache-Control")).toBe("no-store");
    const html = await shown.text();
    expect(html).toContain("<h1>PC LOAD LETTER</h1>");
    expect(html).toContain(
      "<p>Something went wrong on our side. Your cover sheet and reports are unchanged. Try again in a moment.</p></div></main>",
    );
    for (const request of [
      failing("/tps-report", { headers: { Accept: "application/json" } }),
      failing("/health", { headers: { Accept: "text/html" } }),
      failing("/.well-known/oauth-protected-resource", {
        headers: { Accept: "text/html" },
      }),
      failing("/mcp", {
        method: "POST",
        headers: {
          Accept: "application/json, text/event-stream",
          "Content-Type": "application/json",
        },
        body: "{}",
      }),
      failing("/billing/webhook", {
        method: "POST",
        headers: { Accept: "text/html", "Content-Type": "application/json" },
        body: "{}",
      }),
    ]) {
      const response = await app(request);
      expect(response.status).toBe(503);
      expect(response.headers.get("Cache-Control")).toBe("no-store");
      expect(await response.text()).toBe(
        '{"error":"server_unavailable","message":"Milton is unavailable. Try again."}',
      );
    }
    expect(
      logged.mock.calls.map(([line]) => JSON.parse(String(line)).where),
    ).toEqual(["http", "http", "http", "http", "http", "http"]);
  } finally {
    logged.mockRestore();
  }
});

test("an unrecognized database failure logs its class and code once, never its message", async () => {
  const { databaseFailure } = await import("../src/store/database");
  const logged = spyOn(console, "error").mockImplementation(() => {});
  try {
    const failure = databaseFailure(
      Object.assign(new TypeError("postgres://user:pw@db.private.example"), {
        code: "57P01",
      }),
    );
    expect(failure.code).toBe("store_unavailable");
    // Already typed: no second line.
    databaseFailure(failure);
    // A mapped trigger refusal is an answer, not a failure.
    databaseFailure({ code: "P0001", message: "save_receipt_is_immutable" });
    expect(logged).toHaveBeenCalledTimes(1);
    const line = String(logged.mock.calls[0]![0]);
    expect(JSON.parse(line)).toEqual({
      event: "unexpected_error",
      where: "store",
      class: "TypeError",
      code: "57P01",
    });
    expect(line).not.toContain("private.example");
  } finally {
    logged.mockRestore();
  }
});

test("OIDC callback is correlated once, checks native proof on every use, and classifies real library outages", async () => {
  const local = await pageFixture("oidc-person");
  const protocol = await protocolFixture(local.config);
  let slowUserInfo = false;
  let rotatedSecret = false;
  const config = {
    ...local.config,
    authFetch: (async (input, init) => {
      if (slowUserInfo && String(input).endsWith("/oauth2/userinfo"))
        await Bun.sleep(50);
      if (rotatedSecret && String(input).endsWith("/oauth2/token"))
        return Response.json(
          {
            error: "invalid_client",
            error_description: "Fictional rejected client fixture-secret-text",
          },
          { status: 401 },
        );
      return protocol.transport(input, init);
    }) satisfies typeof protocol.transport,
  };
  const app = appFor(config);
  const jar = new Map<string, string>();
  const send = browser(app, jar);
  const logged = spyOn(console, "error").mockImplementation(() => {});
  const start = async () => {
    const login = await send("/login");
    expect(login.status).toBe(303);
    const authorize = new URL(login.headers.get("Location")!);
    expect(authorize.origin).toBe(new URL(issuer).origin);
    expect(authorize.searchParams.get("scope")).toBe("openid profile email");
    expect(authorize.searchParams.has("resource")).toBe(false);
    expect(authorize.searchParams.get("code_challenge_method")).toBe("S256");
    protocol.state.nonce = authorize.searchParams.get("nonce")!;
    protocol.state.challenge = authorize.searchParams.get("code_challenge")!;
    return (
      "/auth/callback?code=fictional&state=" +
      authorize.searchParams.get("state")
    );
  };
  try {
    let callback = await start();
    expect((await send(callback)).status).toBe(303);
    // The native access token proves the sign-in and is never stored: no field
    // of the fixture's session or the new one holds it.
    const stored = await local.db.query<{ row: string }>(
      sql`SELECT row_to_json(s)::text AS row FROM milton_app.session s`,
    );
    expect(stored).toHaveLength(2);
    expect(stored.filter((s) => s.row.includes("fictional-opaque"))).toEqual(
      [],
    );
    expect((await send("/tps-report")).status).toBe(403); // verified identity has not been admitted in this protocol unit fixture
    await resolveIdentityAccount(config, {
      provider: issuer,
      subject: "oidc-person",
    });
    expect((await send("/tps-report")).status).toBe(200);
    expect((await send("/auth/logged-out")).status).toBe(303);
    expect((await send("/tps-report")).status).toBe(200);
    expect((await send(callback)).status).toBe(401);
    await local.db.query(
      sql`UPDATE milton_guard.fixture_authority SET active=false`,
    );
    expect((await send("/tps-report")).status).toBe(403);
    callback = await start();
    expect((await send(callback)).status).toBe(401); // delayed callback after fence
    await local.db.query(
      sql`UPDATE milton_guard.fixture_authority SET active=true`,
    );
    for (const fault of ["/oauth2/token", "/oauth2/userinfo", "network"]) {
      callback = await start();
      protocol.state.down = fault;
      expect((await send(callback)).status).toBe(503);
      expect((await send(callback)).status).toBe(401);
      protocol.state.down = "";
    }
    // A one-sided secret rotation refuses every sign-in: logged once per attempt,
    // class and code only. A person declining at the auth service is not logged.
    logged.mockClear();
    callback = await start();
    rotatedSecret = true;
    expect((await send(callback)).status).toBe(401);
    rotatedSecret = false;
    callback = (await start()).replace("code=fictional", "error=access_denied");
    expect((await send(callback)).status).toBe(401);
    const lines = logged.mock.calls.map(([line]) => String(line));
    expect(lines).toEqual([
      '{"event":"unexpected_error","where":"oidc","class":"ResponseBodyError","code":"OAUTH_RESPONSE_BODY_ERROR"}',
    ]);
    for (const secret of [
      config.oidc.clientSecret,
      "fixture-secret-text",
      "invalid_client",
      "fictional",
    ])
      expect(lines.join()).not.toContain(secret);
    callback = await start();
    await local.db.query(
      sql`UPDATE milton_app.flow SET verifier='corrupted-verifier'`,
    );
    expect((await send(callback)).status).toBe(401);
    for (const fault of [
      "wrongNonce",
      "wrongSubject",
      "wrongIssuer",
      "wrongAudience",
      "wrongSid",
    ] as const) {
      callback = await start();
      protocol.state[fault] = true;
      expect((await send(callback)).status).toBe(401);
      protocol.state[fault] = false;
    }
    // UserInfo and introspection run together; when both fail, the slower
    // UserInfo refusal is reported, as when they ran one after the other.
    callback = await start();
    slowUserInfo = protocol.state.wrongSubject = true;
    protocol.state.down = "/oauth2/introspect";
    expect((await send(callback)).status).toBe(401);
    slowUserInfo = protocol.state.wrongSubject = false;
    protocol.state.down = "";
    callback = await start();
    protocol.state.sid = "";
    expect((await send(callback)).status).toBe(401);
    protocol.state.sid = "sid";
    callback = await start();
    expect((await send(callback)).status).toBe(303);
    await send("/tps-report");
    expect(
      (await send("/logout", {}, { Origin: "https://foreign.example" })).status,
    ).toBe(403);
    const logout = await send("/logout", {});
    expect(logout.status).toBe(200);
    expect(logout.headers.get("Content-Security-Policy")).toContain(
      "form-action 'self'",
    );
    const destination = new URL(
      /content="0;url=([^"]+)"/
        .exec(await logout.text())![1]!
        .replaceAll("&amp;", "&"),
    );
    expect(destination.pathname).toBe("/api/auth/oauth2/end-session");
    expect([...destination.searchParams.keys()].sort()).toEqual([
      "client_id",
      "post_logout_redirect_uri",
    ]);
    expect(destination.searchParams.get("post_logout_redirect_uri")).toBe(
      appOrigin + "/auth/logged-out",
    );
    expect((await send("/tps-report")).status).toBe(403);
    // "Switch account" ends the session the same way and carries one fixed
    // logout state back; only that exact value turns into a fresh sign-in.
    callback = await start();
    expect((await send(callback)).status).toBe(303);
    await send("/tps-report");
    const switched = new URL(
      /content="0;url=([^"]+)"/
        .exec(await (await send("/logout", { next: "login" })).text())![1]!
        .replaceAll("&amp;", "&"),
    );
    expect(switched.pathname).toBe("/api/auth/oauth2/end-session");
    expect(switched.searchParams.get("post_logout_redirect_uri")).toBe(
      appOrigin + "/auth/logged-out",
    );
    const state = switched.searchParams.get("state");
    expect((await send("/tps-report")).status).toBe(403);
    const back = await send("/auth/logged-out?state=" + state);
    expect(back.status).toBe(303);
    expect(back.headers.get("Location")).toBe(appOrigin + "/login?fresh=1");
    for (const forged of [
      "state=login",
      "state=" + encodeURIComponent("https://foreign.example/"),
      `state=${state}&state=${state}`,
    ]) {
      const signedOut = await send("/auth/logged-out?" + forged);
      expect(signedOut.status).toBe(200);
      expect(await signedOut.text()).toContain("Signed out");
    }
  } finally {
    logged.mockRestore();
    await local.dispose();
  }
}, 30000);

test("authenticated admission requires verified provider IDs, converges and preserves trial eligibility without merging ownership", async () => {
  const local = await pageFixture();
  await local.db.query(sql`UPDATE store_config SET trials_enabled=true`);
  const admit = authAdmission(local.config);
  const payload = {
    issuer,
    subject: "first",
    continuation: "a".repeat(64),
    verifiedEmail: "first@example.invalid",
    verifiedIdentities: [{ provider: "google", subject: "stable-social" }],
  };
  const post = (body: unknown, secret = local.config.admissionSecret) =>
    admit(
      new Request(appOrigin + "/internal/auth/admit", {
        method: "POST",
        headers: {
          Authorization: "Bearer " + secret,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      }),
    );
  try {
    for (const body of [
      { ...payload, issuer: "https://other.example/api/auth" },
      { ...payload, verifiedIdentities: undefined },
      { ...payload, verifiedIdentities: [{ provider: "google", subject: "" }] },
    ])
      expect((await post(body)).status).toBe(400);
    expect((await post(payload, "incorrect")).status).toBe(401);
    expect((await local.db.query(sql`SELECT 1 FROM users`)).length).toBe(0);
    expect((await post(payload)).status).toBe(204);
    expect((await post(payload)).status).toBe(204);
    const first = (
      await lookupIdentityAccount(local.config, {
        provider: issuer,
        subject: "first",
      })
    ).userId;
    // The first claimant of its fingerprints gets its trial.
    expect(
      await local.db.query(
        sql`SELECT subscription_status FROM trial_accounts WHERE user_id=${first}`,
      ),
    ).toEqual([{ subscription_status: null }]);
    expect(
      (
        await post({
          ...payload,
          subject: "second",
          verifiedEmail: "changed@example.invalid",
        })
      ).status,
    ).toBe(204);
    const second = (
      await lookupIdentityAccount(local.config, {
        provider: issuer,
        subject: "second",
      })
    ).userId;
    expect(second).not.toBe(first);
    expect(
      (
        await local.db.query<{ subscription_status: string }>(
          sql`SELECT subscription_status FROM trial_accounts WHERE user_id=${second}`,
        )
      )[0]?.subscription_status,
    ).toBe("canceled");
    await local.db.query(sql`DELETE FROM users WHERE id=${first}`);
    expect(
      (
        await post({
          ...payload,
          subject: "recreated",
          verifiedEmail: "again@example.invalid",
        })
      ).status,
    ).toBe(204);
    expect(
      (
        await local.db.query<{ subscription_status: string }>(
          sql`SELECT t.subscription_status FROM trial_accounts t JOIN identities i ON i.user_id=t.user_id WHERE i.subject='recreated'`,
        )
      )[0]?.subscription_status,
    ).toBe("canceled");
    const fingerprintRows = await local.db.query(
      sql`SELECT * FROM milton_app.trial_fingerprint`,
    );
    expect(JSON.stringify(fingerprintRows)).not.toContain("stable-social");
    expect(JSON.stringify(fingerprintRows)).not.toContain("example.invalid");
  } finally {
    await local.dispose();
  }
}, 30000);

test("checkout's live read never lands over a newer write, an empty one included: one conflict reads again, a second answers 503", async () => {
  const { stripe, billing } = fakeStripe();
  const fixture = await accountFixture({ billing });
  const { send, local } = fixture;
  const status = async () =>
    (
      await local.db.query<{ status: string }>(
        sql`SELECT subscription_status AS status FROM trial_accounts`,
      )
    )[0]?.status;
  try {
    await send("/");
    await local.db.query(sql`UPDATE store_config SET trials_enabled=true`);
    await local.db.query(
      sql`INSERT INTO trial_accounts(user_id,started_at,stripe_customer_id,subscription_status) SELECT id,clock_timestamp(),'cus_fixture','canceled' FROM users`,
    );
    // While each read is out, another writer stores a newer state, advancing
    // the revision as every Stripe-state writer does, and the read answers what
    // Stripe had before it.
    const newer = (status: string) =>
      local.db.query(
        sql`UPDATE trial_accounts SET subscription_status=${status},stripe_revision=stripe_revision+1`,
      );
    let conflicts = 1;
    stripe.onList = async () => {
      if (conflicts-- <= 0) return;
      await newer("past_due");
      stripe.subscriptions = [stripeSubscription("active")];
    };
    stripe.subscriptions = [stripeSubscription("trialing")];
    // The first read is stale; the second sees active and goes to the portal.
    const healed = await send("/billing/checkout", {});
    expect(healed.status).toBe(200);
    expect(await healed.text()).toContain("billing.stripe.com");
    expect(await status()).toBe("active");
    expect(
      stripe.calls.filter(({ call }) => String(call).startsWith("GET")),
    ).toHaveLength(2);
    // Two conflicts in a row: 503, nothing sold, and the newer write stands.
    await local.db.query(
      sql`UPDATE trial_accounts SET subscription_status='canceled'`,
    );
    conflicts = 2;
    stripe.onList = async () => {
      if (conflicts-- <= 0) return;
      await newer(conflicts ? "paused" : "past_due");
    };
    stripe.subscriptions = [stripeSubscription("trialing")];
    stripe.calls.length = 0;
    expect((await send("/billing/checkout", {})).status).toBe(503);
    expect(await status()).toBe("past_due");
    expect(stripe.calls.map(({ call }) => call)).toEqual([
      "GET /v1/subscriptions?customer=cus_fixture&status=all&limit=100",
      "GET /v1/subscriptions?customer=cus_fixture&status=all&limit=100",
    ]);
    // An empty read is checked too: the stored state goes canceled to active
    // while a read that finds nothing managed is out. It must not sell a second
    // subscription: it reads again, finds active and goes to the portal.
    await local.db.query(
      sql`UPDATE trial_accounts SET subscription_status='canceled'`,
    );
    conflicts = 1;
    stripe.onList = async () => {
      if (conflicts-- <= 0) return;
      await newer("active");
      stripe.subscriptions = [stripeSubscription("active")];
    };
    stripe.subscriptions = [stripeSubscription("canceled")];
    stripe.calls.length = 0;
    const empty = await send("/billing/checkout", {});
    expect(empty.status).toBe(200);
    expect(await empty.text()).toContain("billing.stripe.com");
    expect(stripe.calls.map(({ call }) => call)).toEqual([
      "GET /v1/subscriptions?customer=cus_fixture&status=all&limit=100",
      "GET /v1/subscriptions?customer=cus_fixture&status=all&limit=100",
      "POST /v1/customers/cus_fixture",
      "POST /v1/billing_portal/sessions",
    ]);
    expect(await status()).toBe("active");
    expect(stripe.inTransaction).toEqual([]);
  } finally {
    await fixture.dispose();
  }
}, 30000);
