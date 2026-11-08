import { expect, test, spyOn } from "bun:test";
import { brotliDecompressSync, gunzipSync } from "node:zlib";
import { sql } from "drizzle-orm";
import { createMiltonApp } from "../src/index";
import { navigation, page } from "../src/pages";
import { COVER_COMMENTS, memoPages } from "../src/memo-pages";
import {
  resolveIdentityAccount,
  lookupIdentityAccount,
  personStoreForCurrentRequest,
  StoreError,
} from "../src/store";
import { localAsset } from "../src/assets";
import { seedRule, seedSample, storeForCurrentRequest } from "./store-fixtures";
import { localStore } from "./local-store";

import {
  appOrigin,
  issuer,
  resource,
  clientSettings,
  pageFixture,
  protocolFixture,
} from "./auth-fixtures";
import { authAdmission, trialFingerprints } from "../src/auth-admission";

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
  const author = await storeForCurrentRequest(local.env, account, {
    issuer,
    clientId: "fixture",
  });
  const app = appFor(local.config);
  return {
    app,
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
    calls: [] as Record<string, unknown>[],
    onDelete: async () => {},
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
      if (stripe.down === true || stripe.down === `${method} ${path}`)
        return Response.json({}, { status: 500 });
      if (method === "DELETE") {
        await stripe.onDelete();
        return Response.json({}, { status: stripe.deleteStatus });
      }
      if (path === "/v1/customers") return Response.json({ id: "cus_fixture" });
      if (path === "/v1/customers/cus_fixture" && method === "POST")
        return Response.json({ id: "cus_fixture" });
      if (path === "/v1/customers/cus_fixture")
        return Response.json(stripe.customer.body, {
          status: stripe.customer.status,
        });
      if (path === "/v1/subscriptions" && method === "GET")
        return Response.json({ data: stripe.subscriptions });
      if (path === "/v1/subscriptions") {
        const created = stripeSubscription("trialing");
        stripe.subscriptions = [created];
        return Response.json(created);
      }
      if (path === "/v1/checkout/sessions")
        return Response.json({
          url: "https://checkout.stripe.com/c/pay/cs_test_fixture",
        });
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
      "GET /v1/subscriptions?customer=cus_fixture&status=all&limit=10",
      "POST /v1/subscriptions",
      "POST /v1/customers/cus_fixture",
      "POST /v1/billing_portal/sessions",
    ]);
    // Any subscription Stripe counts as existing, plus a trial, is managed in
    // the portal; anything else subscribes, no trial, after Stripe confirms it.
    const listCall = stripeCall(
      "GET /v1/subscriptions?customer=cus_fixture&status=all&limit=10",
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
      await leavesFor(await send("/billing/checkout", {}), location);
      expect([status, stripe.calls]).toEqual([status, [...calls]]);
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
  const { db, pg } = fixture.local;
  const { userId } = await lookupIdentityAccount(fixture.local.env, {
    provider: issuer,
    subject: "account",
  });
  await seedRule(pg, userId, "fictional-rule", "Fictional rule.");
  await db.query(
    sql`INSERT INTO trial_accounts(user_id,started_at,stripe_customer_id) VALUES(${userId},now(),'cus_fixture')`,
  );
  // What the person, or a later sign-in, would find of the account.
  const remains = async () => ({
    account: (await db.query(sql`SELECT 1 FROM users WHERE id=${userId}`))
      .length,
    writing: (
      await db.query(
        sql`SELECT 1 FROM instruction_cards WHERE user_id=${userId}`,
      )
    ).length,
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
    expect(after).toContain("No assistants are connected.");
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
    const first = await fixture.store.readTpsReport();
    const saved = await fixture.author.saveMemo({
      text: "Be concise.",
      rules: [{ report: "cover", text: "Be concise." }],
      expected_version: first.version,
      request_id: crypto.randomUUID(),
    });
    expect(saved.status).toBe("saved");
    const report = await fixture.store.readTpsReport();
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
    // Page views do not consume an assistant's reminder milestone.
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
    expect(html).toContain("Assistant reads and saves are paused until");
    expect(html).not.toContain('action="/billing');
    expect(html).not.toContain("ask a connected assistant to save");
    expect(html).toContain("Be concise.");
    const download = await fixture.send("/download");
    expect(download.status).toBe(200);
    expect(await download.text()).toBe(report.text);
    expect(await fixture.store.readTpsReport()).toEqual(report);
  } finally {
    await fixture.dispose();
  }
});

test("web shows only current TPS, escaped, and downloads it", async () => {
  const fixture = await memoPageFixture();
  try {
    const empty = await (await fixture.send("/")).text();
    expect(empty).toContain("No writing samples on file yet.");
    expect(empty).toContain('href="/assistants#connect"');
    expect(
      (
        await fixture.app(
          new Request(appOrigin + "/download", {
            method: "PUT",
            headers: { Host: "localhost:3001" },
          }),
        )
      ).status,
    ).toBe(405);
    const first = await fixture.author.readTpsReport();
    const body =
      "Lead with the answer.\n\nUnless clarification is needed, keep the reply brief. <script>alert('fixture')</script>";
    const outcome = await fixture.author.saveMemo({
      text: "Add a fictional rule.",
      rules: [{ report: "cover", text: body }],
      expected_version: first.version,
      request_id: crypto.randomUUID(),
    });
    expect(outcome.status).toBe("saved");
    const html = await (await fixture.send("/tps-report")).text();
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
    for (const font of ["geist-latin-variable", "jetbrains-mono-latin"])
      expect(
        html.split(`<link rel="preload" href="/fonts/${font}.woff2?v=`),
      ).toHaveLength(2);
    expect(html).toContain('<ol class="ruled">');
    expect(html).toContain(
      '<li class="line"><span class="typed">Lead with the answer.\n\nUnless clarification is needed, keep the reply brief. &lt;script&gt;',
    );
    for (const absent of [
      "Version history",
      "Restore",
      "Archive",
      "Your memos",
      "<textarea",
      "writes today",
    ])
      expect(html).not.toContain(absent);
    const download = await fixture.send("/download");
    expect(download.headers.get("Content-Disposition")).toBe(
      'attachment; filename="TPS.md"',
    );
    expect(await download.text()).toBe("- " + body);
  } finally {
    await fixture.dispose();
  }
}, 30000);

test("pages stay capped and download includes every active sample, only for the session account", async () => {
  // The browser session belongs to page-fixes; a second account shares the store.
  const fixture = await memoPageFixture();
  try {
    const bindings = { storeDatabase: fixture.db, appOrigin };
    const identity = { provider: issuer, subject: "page-alpha" };
    await resolveIdentityAccount(bindings, identity);
    const alpha = await lookupIdentityAccount(bindings, identity);
    const alphaAuthor = await storeForCurrentRequest(bindings, alpha, {
      issuer,
      clientId: "fixture",
    });
    const alphaRule = await alphaAuthor.saveMemo({
      text: "- Alpha signs as Ada.",
      rules: [{ report: "email", text: "- Alpha signs as Ada." }],
      expected_version: (await alphaAuthor.readTpsReport()).version,
      request_id: crypto.randomUUID(),
    });
    expect(alphaRule.status).toBe("saved");
    const alphaSample = await alphaAuthor.saveMemo({
      text: "Keep this approved email.",
      expected_version: alphaRule.version!,
      request_id: crypto.randomUUID(),
      sample: {
        report: "email",
        new_kind: "follow-up",
        context: { version: 1 as const, summary: "alpha context" },
        text: "Alpha sample body.",
      },
    });
    expect(alphaSample.status).toBe("saved");
    const rules = [
      {
        report: "cover",
        text: "Beta keeps it brief.\n  Keep this exception & <tag>.  ",
      },
      {
        report: "email",
        text: "Preserve email wording.\nIncluding this line.",
      },
      { report: "chat", text: "Preserve chat wording." },
      { report: "post", text: "Keep this report with rules alone." },
    ] as const;
    expect(
      (
        await fixture.author.saveMemo({
          text: "Beta keeps it brief.",
          rules: [...rules],
          expected_version: (await fixture.store.readTpsReport()).version,
          request_id: crypto.randomUUID(),
        })
      ).status,
    ).toBe("saved");
    const beta = await lookupIdentityAccount(bindings, {
      provider: issuer,
      subject: "page-fixes",
    });
    const expected = new Map<string, string[]>();
    for (const report of ["email", "chat"] as const) {
      await fixture.db
        .query(sql`INSERT INTO sample_kinds(user_id,id,report,label)
        VALUES (${beta.userId},${report},${report},'fictional note')`);
      const bodies = Array.from(
        { length: 10 },
        (_, n) =>
          `Fictional ${report} sample ${n}: <tag> & *verbatim*.${n === 0 ? "\n\n  Keep the oldest sample's spacing.  " : ""}`,
      );
      for (const [n, body] of bodies.entries())
        await seedSample(
          fixture.pg,
          beta.userId,
          `${report}-${n}`,
          report,
          report,
          { version: 1, summary: `${report} context ${n}` },
          body,
          { createdAt: `2026-01-0${1 + Math.floor(n / 2)}T00:00:00Z` },
        );
      const replacement = `Fictional ${report} replacement: exact & approved.`;
      expect(
        await fixture.author.saveMemo({
          text: "Fictional audit detail, outside the export.",
          expected_version: (await fixture.store.readTpsReport()).version,
          request_id: crypto.randomUUID(),
          retire_samples: [`${report}-1`],
          sample: {
            report,
            kind_id: report,
            sample_id: `${report}-2`,
            context: {
              version: 1 as const,
              summary: `${report} replacement context`,
            },
            text: replacement,
          },
        }),
      ).toMatchObject({ status: "saved" });
      expected.set(report, [
        replacement,
        ...[9, 8, 7, 6, 5, 4, 3, 0].map((n) => bodies[n]!),
      ]);
    }
    const own = await fixture.store.readTpsReport();
    const documents = await fixture.store.readDocuments();
    for (const [report, bodies] of expected) {
      expect(
        documents.reports
          .find((r) => r.id === report)!
          .samples.map((s) => s.body),
      ).toEqual(bodies.slice(0, 8));
      expect(own.text).not.toContain("Keep the oldest sample's spacing.");
    }
    const [card] = await fixture.db.query<{ id: string }>(
      sql`SELECT card_id AS id FROM instruction_card_versions WHERE user_id=${alpha.userId} AND report='email'`,
    );
    for (const query of [
      "",
      `?user=${alpha.userId}`,
      "?user=page-alpha",
      `?id=${card!.id}`,
      `?version=${alphaSample.version}`,
      `?user_id=${alpha.userId}&subject=page-alpha&report=email`,
    ])
      for (const path of ["/", "/tps-report", "/download"]) {
        const response = await fixture.send(path + query);
        expect(response.status).toBe(200);
        const text = await response.text();
        if (path === "/download") {
          expect(response.headers.get("Content-Type")).toBe(
            "text/markdown; charset=utf-8",
          );
          expect(response.headers.get("Content-Disposition")).toBe(
            'attachment; filename="TPS.md"',
          );
          expect(response.headers.get("Cache-Control")).toBe("no-store");
          expect(response.headers.get("X-Content-Type-Options")).toBe(
            "nosniff",
          );
          expect(text.match(/^Approved,/gm)).toHaveLength(18);
          for (const rule of rules) expect(text).toContain("- " + rule.text);
          expect(text).not.toContain("# Document");
          expect(text).not.toContain("# Speech");
          for (const [report, bodies] of expected) {
            let previous = -1;
            for (const body of bodies) {
              const position = text.indexOf("> " + body.split("\n")[0]!);
              expect(position).toBeGreaterThan(previous);
              previous = position;
            }
            expect(text).toContain(
              `Approved, ${report} context 0, 2026-01-01:\n> Fictional ${report} sample 0: <tag> & *verbatim*.\n>\n>   Keep the oldest sample's spacing.  `,
            );
            for (const n of [1, 2])
              expect(text).not.toContain(`Fictional ${report} sample ${n}:`);
          }
          expect(text).not.toContain("Fictional audit detail");
          expect(text).not.toContain(beta.userId);
        } else {
          expect(text).toContain("Beta keeps it brief.");
          expect(text).not.toContain("Keep the oldest sample&#39;s spacing.");
          expect(text).not.toContain("Keep the oldest sample's spacing.");
        }
        for (const foreign of [
          "Alpha signs as Ada",
          "Alpha sample body",
          "alpha context",
          alpha.userId,
        ])
          expect(text).not.toContain(foreign);
      }
    expect(await fixture.store.readTpsReport()).toEqual(own);
  } finally {
    await fixture.dispose();
  }
}, 30000);

test("a live session whose account is closing refuses its pages with account_unavailable", async () => {
  const fixture = await memoPageFixture();
  try {
    await fixture.db.query(sql`UPDATE users SET status='deleting'`);
    for (const path of ["/", "/tps-report", "/assistants"]) {
      const response = await fixture.send(path);
      expect(response.status).toBe(403);
      expect(await response.text()).toContain(
        "Sign in to Milton before connecting your assistant.",
      );
    }
  } finally {
    await fixture.dispose();
  }
}, 30000);

test("report bullets keep complete text parity and the download needs no layout read", async () => {
  const bodies = [
    "  Keep fictional units explicit.\n\nUnless a condition applies, preserve <tag> & wording.  ",
    "Do the second instruction after the first.\nKeep this exception attached.\n",
  ];
  const report = {
    text: bodies.join("\n\n"),
    version: "a".repeat(64),
    is_empty: false,
  };
  const base = { exportTpsReport: async () => report.text };
  const emptyReport = (id: string, title: string) => ({
    id,
    title,
    when: "fictional",
    body: `# ${title}\n\nApplies when fictional.`,
    is_empty: true,
    samples: [],
    rules: [],
  });
  const exact = {
    version: report.version,
    cover: bodies.join("\n\n"),
    cover_rules: bodies,
    index: [],
    reports: [emptyReport("email", "Email")],
    full: report.text,
    is_empty: false,
  };
  // The date and comment are fixed here; a request uses today and a random one.
  const options = {
    now: () => new Date("2026-11-02T12:00:00Z"),
    comment: () => COVER_COMMENTS[2],
  };
  const render = (
    readDocuments: () => Promise<typeof exact>,
    path = "/tps-report",
  ) =>
    memoPages(
      new Request(appOrigin + path),
      { ...base, readDocuments: readDocuments as never },
      () => "",
      "you@example.com",
      options,
    );
  const html = await (await render(async () => exact)).text();
  for (const [label, value] of [
    ["Prepared for", "you@example.com"],
    ["Date", "2026-11-02 UTC"],
    ["Reports", "None"],
    ["Rules", "2"],
    ["Samples shown", "0"],
  ])
    expect(html).toContain(`<dt>${label}:</dt><dd class="fill">${value}</dd>`);
  expect(html).toContain(
    "Give a connected assistant the facts for your next email or DM and ask it to use what’s on file. You can also approve a writing sample.</p>",
  );
  expect(html).not.toContain("Memo updates");
  expect(html).toContain(
    '<p class="line typed comment">Red stapler located. Returned to owner.</p>',
  );
  expect(html).toContain(
    '<ol class="ruled"><li class="line"><span class="typed">  Keep fictional units explicit.\n\nUnless a condition applies, preserve &lt;tag&gt; &amp; wording.  </span></li><li class="line"><span class="typed">Do the second instruction after the first.\nKeep this exception attached.\n</span></li></ol>',
  );
  // A multi-line compiler-era rule drops its stored dash, as in MCP and TPS.md.
  expect(
    await (
      await render(async () => ({
        ...exact,
        cover_rules: ["- Fictional older rule.\nIts second line."],
      }))
    ).text(),
  ).toContain(
    '<ol class="ruled"><li class="line"><span class="typed">Fictional older rule.\nIts second line.</span></li></ol>',
  );
  expect(
    html.indexOf('<h1 aria-label="T.P.S. Report, cover sheet">'),
  ).toBeLessThan(html.indexOf('<ol class="ruled">'));
  let lookups = 0;
  const download = await render(async () => {
    lookups++;
    throw new Error("Download must not need layout");
  }, "/download");
  expect(new Uint8Array(await download.arrayBuffer())).toEqual(
    new TextEncoder().encode(report.text),
  );
  expect(lookups).toBe(0);
  const renderTitled = (rules = ["- One.", "- Two\nlines."]) =>
    memoPages(
      new Request(appOrigin + "/tps-report"),
      {
        ...base,
        readDocuments: (async () => ({
          ...exact,
          cover: "",
          cover_rules: [],
          reports: [
            {
              ...emptyReport("email", "Email"),
              is_empty: false,
              samples: [
                {
                  id: "s",
                  report: "email",
                  kind_id: "k",
                  kind: "follow-up",
                  context: {
                    version: 1 as const,
                    summary: "after a call",
                    audience: { relationship: "client" },
                    purposes: ["follow up"],
                  },
                  revision: 1,
                  body: "Hi <there>,\n\nThanks.",
                  date: "2026-11-02",
                },
              ],
              rules,
            },
            emptyReport("chat", "Chat"),
          ],
        })) as never,
      },
      () => "",
    );
  const titledPage = await (await renderTitled()).text();
  const emailSection =
    titledPage.match(
      /<section class="form-section"><h2 id="report-email">Email<\/h2>([\s\S]*?)<\/section>/,
    )?.[1] ?? "";
  // Keep exact text and sample/rule order within the same report section.
  let offset = 0;
  for (const fragment of [
    '<p class="report-counts">1 sample · 2 rules</p>',
    '<p class="applies">Applies when fictional.</p>',
    '<h3 class="sub-label">Approved samples (1)</h3>',
    '<details class="form-sample">',
    "<summary>",
    '<span class="typed">after a call</span>',
    '<span class="labels">purposes: follow up; audience relationship: client</span>',
    '<span class="date">2026-11-02</span>',
    "</summary>",
    '<pre class="memo-text"><span>Hi &lt;there&gt;,\n\nThanks.</span></pre>',
    "</details>",
    '<h3 class="sub-label">Rules (2)</h3>',
    '<ol class="ruled">',
    '<li class="line"><span class="typed">One.</span></li>',
    '<li class="line"><span class="typed">Two\nlines.</span></li>',
    "</ol>",
  ]) {
    const remaining = emailSection.slice(offset);
    expect(remaining).toContain(fragment);
    offset += remaining.indexOf(fragment) + fragment.length;
  }
  expect(titledPage).not.toContain("Not set up yet");
  expect(titledPage).toContain(
    "Other reports are available whenever you need them.",
  );
  const sampleOnly = await (await renderTitled([])).text();
  expect(sampleOnly).toContain("1 sample · 0 rules");
  expect(sampleOnly).toContain("Hi &lt;there&gt;,\n\nThanks.");
  expect(sampleOnly).not.toContain("Not set up yet");
  expect(sampleOnly).not.toContain("set up my email report");
});

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
    databaseFailure({ code: "P0001", message: "sample_version_is_immutable" });
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
  const config = {
    ...local.config,
    authFetch: (async (input, init) => {
      if (slowUserInfo && String(input).endsWith("/oauth2/userinfo"))
        await Bun.sleep(50);
      return protocol.transport(input, init);
    }) satisfies typeof protocol.transport,
  };
  const app = appFor(config);
  const jar = new Map<string, string>();
  const send = browser(app, jar);
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

test("report guides show readable tendencies and status without internal diagnostics", async () => {
  const { assembleDocuments } = await import("../src/store/reports");
  const documents = {
    ...assembleDocuments(
      [
        {
          id: "fictional-rule",
          version: 1,
          description: "Fictional rule",
          body: "Use plain words.",
          archived: false,
          report: "email",
        },
      ],
      [],
    ),
    version: "a".repeat(64),
  };
  const report = {
    text: documents.full,
    version: documents.version,
    is_empty: false,
  };
  for (const [status, reason, expected] of [
    ["queued", "lease_expired", "queued"],
    ["running", "preparing", "Updating"],
    ["failed", "attempts_exhausted", "unavailable"],
    ["failed", "provider_or_output_failed", "unavailable"],
    ["unavailable", "input_too_large", "too long"],
    ["unavailable", "budget_limit", "spending limit"],
  ]) {
    documents.reports[0]!.guide = {
      derived: true,
      text: "Open with the collection update.\nApplies: Short pickup notes.",
      source_version: 123,
      current_version: 456,
      stale: true,
      status: status!,
      reason: reason!,
      precedence: "Explicit rules and requested edit scope win.",
    };
    const response = await memoPages(
      new Request(appOrigin + "/tps-report"),
      {
        readDocuments: async () => documents,
        exportTpsReport: async () => report.text,
      },
      () => null,
      "writer@example.invalid",
      {
        now: () => new Date("2026-11-06T00:00:00Z"),
        comment: () => "Fictional UI check.",
      },
    );
    const html = await response.text(),
      start = html.indexOf('<div class="report-guide">');
    expect(start).toBeGreaterThanOrEqual(0);
    const guide = html.slice(start, html.indexOf("</div>", start));
    expect(guide).toContain(expected!);
    expect(guide).toContain("Open with the collection update.");
    expect(guide).toContain("Short pickup notes.");
    expect(guide).toContain(
      "may still reflect samples that were removed or corrected",
    );
    expect(guide).not.toMatch(
      /123|456|version|Evidence:|lease|attempt|recovery|<button|<input|<textarea|<select/i,
    );
  }
});
