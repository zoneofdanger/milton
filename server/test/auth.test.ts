import { expect, test, spyOn } from "bun:test";
import { sql } from "drizzle-orm";
import {
  NEON_AUTH_SESSION_COOKIE_NAME,
  NEON_AUTH_SESSION_CHALLENGE_COOKIE_NAME,
} from "@neondatabase/auth/server";
import { createMiltonApp } from "../src/index";
import { navigation, page } from "../src/pages";
import { COVER_COMMENTS, memoPages } from "../src/memo-pages";
import {
  resolveIdentityAccount,
  lookupIdentityAccount,
  personStoreForCurrentRequest,
  storeForCurrentRequest,
  StoreError,
} from "../src/store";
import { localAsset } from "../src/assets";
import { localStore } from "./local-store";

const appOrigin = "http://localhost:3001";
const issuer = "https://auth.example/milton/auth";
const resource = appOrigin + "/mcp";
const signedQuery =
  "client_id=fixture&resource=" +
  encodeURIComponent(resource) +
  "&redirect_uri=" +
  encodeURIComponent("http://localhost:9999/callback") +
  "&scope=openid%20profile&state=a%2Bb&sig=fixture%2Fsignature&ba_param=client_id&ba_param=resource&ba_param=sig";

const appFor = (env: Partial<Parameters<typeof createMiltonApp>[0]>) =>
  createMiltonApp({
    issuer,
    resource,
    appOrigin,
    cookieSecret: crypto.randomUUID(),
    ...env,
  });

// A browser on `app` with one cookie jar. Form posts come from the app origin.
// Field records and multipart forms carry the CSRF cookie; a URLSearchParams
// body is sent as given.
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

// Answers Neon Auth calls; any other host throws. Each call is recorded.
function fakeNeon(
  answer: (
    path: string,
    body: Record<string, unknown>,
    request: Request,
    url: URL,
  ) => Response | Promise<Response>,
  calls: { path: string; body: Record<string, unknown> }[] = [],
) {
  return spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      async (
        input: Parameters<typeof fetch>[0],
        init?: Parameters<typeof fetch>[1],
      ) => {
        const request = new Request(input, init);
        const url = new URL(request.url);
        if (url.origin !== new URL(issuer).origin)
          throw new Error("Unexpected upstream host");
        const path = url.pathname.slice(new URL(issuer).pathname.length);
        const body =
          request.method === "POST"
            ? ((await request.json()) as Record<string, unknown>)
            : {};
        calls.push({ path, body });
        return answer(path, body, request, url);
      },
      { preconnect: fetch.preconnect },
    ),
  );
}

// Neon's /get-session answer for a signed-in subject.
const neonSession = (subject: string, email?: string) =>
  Response.json({
    user: { id: subject, ...(email === undefined ? {} : { email }) },
    session: {
      userId: subject,
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
    },
  });

test("Cloud Run app serves only canonical browser routes and public assets", async () => {
  const { createCloudApp } = await import("../src/cloud-app");
  const app = createCloudApp({
    issuer,
    resource: "https://mcp.example/mcp",
    appOrigin: "https://app.example",
    cookieSecret: crypto.randomUUID(),
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
  for (const path of [
    "/milton.css",
    "/favicon.svg",
    "/fonts/jetbrains-mono-regular.woff2",
    "/fonts/geist-latin-variable.woff2",
  ]) {
    const asset = await request(path);
    expect(asset.status).toBe(200);
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

test("page content is text unless explicitly rendered as a component", async () => {
  const input = '<script>alert("fictional")</script> & <img src=x>';
  const html = await page(input, input).text();
  expect(html).not.toContain("<script>");
  expect(html).not.toContain("<img src=x>");
  expect(html).toContain("&lt;script&gt;");
  expect(html).toContain("&amp;");
});

test("page fonts and favicons are local while other browser restrictions stay closed", async () => {
  const response = page("Example", "<p>Example</p>");
  expect(response.headers.get("Content-Security-Policy")).toBe(
    "default-src 'none'; script-src 'none'; style-src 'self'; img-src 'self'; font-src 'self'; connect-src 'none'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'; object-src 'none'",
  );
  const html = await response.text();
  expect(html).toContain('href="/favicon.svg?v=printer"');
  expect(html).toContain('href="/favicon.ico?v=printer"');
  const { localAsset } = await import("../scripts/assets");
  for (const [path, type] of [
    ["/fonts/source-serif-4-semibold.woff2", "font/woff2"],
    ["/fonts/jetbrains-mono-regular.woff2", "font/woff2"],
    ["/favicon.svg", "image/svg+xml"],
    ["/favicon.ico", "image/x-icon"],
    ["/milton.css", "text/css; charset=utf-8"],
  ]) {
    const asset = localAsset(new Request(appOrigin + path));
    expect(asset?.status).toBe(200);
    expect(asset?.headers.get("Content-Type")).toBe(type);
    expect((await asset!.arrayBuffer()).byteLength).toBeGreaterThan(100);
    expect(
      localAsset(new Request(appOrigin + path, { method: "POST" }))?.status,
    ).toBe(405);
    expect(
      await localAsset(
        new Request(appOrigin + path, { method: "HEAD" }),
      )!.text(),
    ).toBe("");
  }
  for (const path of [
    "/fonts/unknown.woff2",
    "/fonts/../secret",
    "/fonts/%2e%2e/secret",
    "/src/pages.ts",
  ])
    expect(localAsset(new Request(appOrigin + path))).toBeNull();
});

test("Neon server adapter preserves signed queries, cookies, sign-in admission and Allow/Deny", async () => {
  const local = await localStore();
  const jar = new Map<string, string>();
  const calls: { path: string; body: Record<string, unknown> }[] = [];
  let metadataAvailable = true;
  let signInAvailable = true;
  const now = new Date().toISOString();
  const session = {
    session: {
      id: "fixture-session",
      token: "fixture-session-token",
      userId: "neon-browser",
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
      createdAt: now,
      updatedAt: now,
    },
    user: {
      id: "neon-browser",
      name: "Fixture",
      email: "fixture@example.invalid",
      emailVerified: true,
      createdAt: now,
      updatedAt: now,
    },
  };
  const upstream = fakeNeon((path, body, request, url) => {
    if (path === "/get-session") {
      if (url.searchParams.has("neon_auth_session_verifier")) {
        const headers = new Headers();
        headers.append(
          "Set-Cookie",
          `${NEON_AUTH_SESSION_COOKIE_NAME}=fixture-session-token; Path=/; Secure; HttpOnly`,
        );
        headers.append(
          "Set-Cookie",
          `${NEON_AUTH_SESSION_CHALLENGE_COOKIE_NAME}=; Path=/; Secure; HttpOnly; Max-Age=0`,
        );
        return Response.json(session, { headers });
      }
      return Response.json(
        request.headers
          .get("Cookie")
          ?.includes(NEON_AUTH_SESSION_COOKIE_NAME + "=")
          ? session
          : null,
      );
    }
    if (body.oauth_query && String(body.oauth_query).includes("sig=forged"))
      return Response.json(
        { code: "INVALID_SIGNATURE", message: "fixture rejected query" },
        { status: 400 },
      );
    if (path === "/sign-in/social" && !signInAvailable)
      return Response.json({ message: "Unavailable" }, { status: 503 });
    if (path === "/sign-in/social")
      return Response.json(
        { url: issuer + "/social", redirect: true },
        {
          headers: {
            "Set-Cookie": `${NEON_AUTH_SESSION_CHALLENGE_COOKIE_NAME}=fixture-challenge; Path=/; Secure; HttpOnly`,
          },
        },
      );
    if (path === "/oauth2/continue")
      return Response.json({
        url: appOrigin + "/consent?" + body.oauth_query,
        redirect: true,
      });
    if (path === "/oauth2/get-consents")
      return metadataAvailable
        ? Response.json([{ clientId: "fixture" }])
        : Response.json({ message: "Unavailable" }, { status: 503 });
    if (path === "/oauth2/public-client")
      return Response.json({
        client_id: "fixture",
        client_name: '<script>alert("client")</script>',
        client_uri: "https://client.example",
      });
    if (path === "/oauth2/consent")
      return Response.json({
        url:
          "http://localhost:9999/callback?" +
          (body.accept ? "code=fixture-code" : "error=access_denied"),
        redirect: true,
      });
    if (path === "/sign-out") return Response.json({ success: true });
    throw new Error("Unexpected upstream endpoint");
  }, calls);
  try {
    await local.db.query(sql`UPDATE store_config SET signup_mode='open'`);
    const app = appFor(local.env);
    const browse = browser(app, jar);
    const send = (path: string, body?: URLSearchParams, cookie?: string) =>
      browse(path, body, cookie === undefined ? {} : { Cookie: cookie });
    const login = await send("/login?" + signedQuery);
    const loginHtml = await login.text();
    expect(login.status).toBe(200);
    expect(loginHtml).toContain("Continue with Google");
    expect(login.headers.get("Content-Security-Policy")).toContain(
      "form-action 'self'",
    );
    const csrf = /name="csrf" value="([^"]+)"/.exec(loginHtml)![1]!;
    signInAvailable = false;
    for (const flow of [signedQuery, ""]) {
      const failedSignIn = await send(
        "/login",
        new URLSearchParams({ csrf, provider: "google", oauth_query: flow }),
      );
      expect(failedSignIn.status).toBe(503);
      const failureHtml = await failedSignIn.text();
      const retry = flow ? "/login?flow=" + encodeURIComponent(flow) : "/login";
      expect(failureHtml).toContain(`href="${retry}"`);
      expect(failureHtml).toContain("Back to sign-in");
      expect(failureHtml).not.toContain('http-equiv="refresh"');
    }
    signInAvailable = true;
    const start = await send(
      "/login",
      new URLSearchParams({
        csrf,
        provider: "google",
        oauth_query: signedQuery,
      }),
    );
    expect(start.status).toBe(200);
    expect(await start.text()).toContain('http-equiv="refresh"');
    const signIn = calls.find((call) => call.path === "/sign-in/social")!;
    expect(signIn.body.oauth_query).toBe(signedQuery);
    expect(
      start.headers
        .getSetCookie()
        .some(
          (cookie) =>
            cookie.includes("SameSite=Lax") &&
            cookie.includes("HttpOnly") &&
            cookie.includes("Secure") &&
            !cookie.includes("Domain="),
        ),
    ).toBe(true);
    const callbackURL = new URL(String(signIn.body.callbackURL));
    callbackURL.searchParams.set(
      "neon_auth_session_verifier",
      "fixture-verifier",
    );
    const callback = await send(callbackURL.pathname + callbackURL.search);
    expect(callback.status).toBe(302);
    expect(callback.headers.getSetCookie().length).toBeGreaterThanOrEqual(2);
    const completed = await send(
      new URL(callback.headers.get("Location")!).pathname +
        new URL(callback.headers.get("Location")!).search,
    );
    expect(completed.status).toBe(200);
    expect(
      calls.find((call) => call.path === "/oauth2/continue")?.body.oauth_query,
    ).toBe(signedQuery);
    expect(
      await local.db.query(sql`SELECT count(*)::integer AS n FROM users`),
    ).toEqual([{ n: 1 }]);
    const consent = await send("/consent?" + signedQuery);
    const consentHtml = await consent.text();
    expect(consentHtml).toContain("read and change your memos");
    expect(consentHtml).toContain("&lt;script&gt;");
    expect(consentHtml).not.toContain("<script>");
    expect(consentHtml).toContain("(name not verified)");
    expect(consentHtml).toContain(
      "Only allow this if you just started connecting it.",
    );
    expect(consentHtml).not.toContain("Requested sign-in information:");
    expect(consentHtml).not.toContain("Resource:");
    const cimd = await send(
      "/consent?" +
        signedQuery.replace(
          "client_id=fixture",
          "client_id=" +
            encodeURIComponent("https://metadata.example/client.json"),
        ),
    );
    const cimdHtml = await cimd.text();
    expect(cimdHtml).toContain(", from metadata.example");
    expect(cimdHtml).not.toContain("name not verified");
    expect(cimdHtml).not.toContain("client.example");
    const consentCsrf = /name="csrf" value="([^"]+)"/.exec(consentHtml)![1]!;
    for (const decision of ["allow", "deny"]) {
      const response = await send(
        "/consent",
        new URLSearchParams({
          csrf: consentCsrf,
          decision,
          oauth_query: signedQuery,
        }),
      );
      expect(response.status).toBe(200);
      expect(await response.text()).toContain(
        decision === "allow" ? "code=fixture-code" : "error=access_denied",
      );
      expect(calls.at(-1)?.body.oauth_query).toBe(signedQuery);
    }
    const forged = await send(
      "/consent",
      new URLSearchParams({
        csrf: consentCsrf,
        decision: "allow",
        oauth_query: signedQuery.replace(
          "sig=fixture%2Fsignature",
          "sig=forged",
        ),
      }),
    );
    expect(forged.status).toBe(400);
    expect(await forged.text()).toContain("Restart");
    expect(
      (
        await send(
          "/consent",
          new URLSearchParams({
            csrf: consentCsrf,
            decision: "allow",
            oauth_query: signedQuery,
          }),
          "",
        )
      ).status,
    ).toBe(403);
    expect(
      (await send("/login?client_id=fixture&sig=missing-resource")).status,
    ).toBe(400);
    const forced = signedQuery + "&prompt=login&max_age=0";
    expect((await send("/login?" + forced)).status).toBe(200);
    const repeated = await send("/login?" + forced);
    expect(repeated.status).toBe(400);
    expect(await repeated.text()).toContain("Sign-in requested again");
    expect(
      (
        await send(
          "/consent?" +
            signedQuery +
            "&redirect_uri=https%3A%2F%2Fevil.example%2Fcallback",
        )
      ).status,
    ).toBe(400);
    const home = await send("/");
    const homeHtml = await home.text();
    expect(homeHtml).toContain("<h1>T.P.S. Report</h1>");
    expect(homeHtml).not.toContain("Version history");
    expect(homeHtml).not.toContain("Your memos");
    // Moving hosts can rotate the cache-signing key without replacing Neon's
    // session token. The browser adapter must still ask Neon for a live session.
    const { createCloudApp } = await import("../src/cloud-app");
    const migratedApp = createCloudApp({
      ...local.env,
      issuer,
      resource,
      appOrigin,
      cookieSecret: crypto.randomUUID(),
    });
    const callsBeforeMigration = calls.length;
    const migratedHome = await migratedApp(
      new Request(appOrigin, {
        headers: {
          Host: "localhost:3001",
          Cookie: [...jar].map(([k, v]) => k + "=" + v).join("; "),
        },
      }),
    );
    expect(migratedHome.status).toBe(200);
    expect(await migratedHome.text()).toContain("<h1>T.P.S. Report</h1>");
    expect(
      calls
        .slice(callsBeforeMigration)
        .some((call) => call.path === "/get-session"),
    ).toBe(true);
    expect((await send("/new-memo")).status).toBe(404);
    const currentCsrf = jar.get("milton-csrf")!;
    const sameOriginNull = await app(
      new Request(appOrigin + "/consent", {
        method: "POST",
        headers: {
          Host: "localhost:3001",
          Origin: "null",
          "Sec-Fetch-Site": "same-origin",
          Cookie: [...jar].map(([k, v]) => k + "=" + v).join("; "),
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          csrf: currentCsrf,
          decision: "deny",
          oauth_query: signedQuery,
        }),
      }),
    );
    expect(sameOriginNull.status).toBe(200);
    const expires = session.session.expiresAt;
    session.session.expiresAt = new Date(Date.now() - 1000).toISOString();
    const expiredReport = await send("/tps-report");
    expect(expiredReport.status).toBe(403);
    const expiredHtml = await expiredReport.text();
    expect(expiredHtml).toContain('href="/login"');
    expect(expiredHtml).toContain("Sign in to Milton");
    expect(expiredHtml).not.toContain('href="/tps-report"');
    // A multipart post is refused before routing as well.
    const form = new FormData();
    for (const [key, value] of Object.entries({
      csrf: currentCsrf,
      name: "expired",
      description: "Expired",
      text: "No",
    }))
      form.set(key, value);
    expect(
      (
        await app(
          new Request(appOrigin + "/memos", {
            method: "POST",
            headers: {
              Host: "localhost:3001",
              Origin: appOrigin,
              Cookie: [...jar].map(([k, v]) => k + "=" + v).join("; "),
            },
            body: form,
          }),
        )
      ).status,
    ).toBe(403);
    session.session.expiresAt = expires;
    const signedOut = await send(
      "/logout",
      new URLSearchParams({ csrf: currentCsrf }),
    );
    expect(signedOut.status).toBe(200);
    expect(
      signedOut.headers
        .getSetCookie()
        .some(
          (cookie) =>
            cookie.startsWith("milton-csrf=") && cookie.includes("Max-Age=0"),
        ),
    ).toBe(true);
    expect(
      await local.db.query(sql`SELECT count(*)::integer AS n FROM users`),
    ).toEqual([{ n: 1 }]);
  } finally {
    upstream.mockRestore();
    await local.dispose();
  }
}, 30000);

test("consent shows an escaped, unverified client ID when the client has no name", async () => {
  const local = await localStore();
  const clientId = "fixture<client>";
  const upstream = fakeNeon((path) => {
    if (path === "/get-session") return neonSession("neon-unnamed-client");
    if (path === "/oauth2/public-client")
      return Response.json({ client_id: clientId });
    throw new Error("Unexpected upstream endpoint");
  });
  try {
    await local.db.query(sql`UPDATE store_config SET signup_mode='open'`);
    await resolveIdentityAccount(local.env, {
      provider: "neon",
      subject: "neon-unnamed-client",
    });
    const app = appFor(local.env);
    const query = signedQuery.replace(
      "client_id=fixture",
      "client_id=" + encodeURIComponent(clientId),
    );
    const response = await app(
      new Request(appOrigin + "/consent?" + query, {
        headers: {
          Host: "localhost:3001",
          Cookie: `${NEON_AUTH_SESSION_COOKIE_NAME}=fixture-session-token`,
        },
      }),
    );
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("<strong>fixture&lt;client&gt;</strong>");
    expect(html).not.toContain(clientId);
    expect(html).toContain("(name not verified)");
    expect(html).toContain('value="allow"');
    expect(html).toContain('value="deny"');
  } finally {
    upstream.mockRestore();
    await local.dispose();
  }
}, 30000);

async function accountFixture() {
  const local = await localStore();
  const subject = "neon-account";
  const state = {
    email: "fixture@example.invalid" as string | undefined,
    consentsAvailable: true,
    deleteAvailable: true,
    consentAvailable: true,
    consents: [
      {
        id: "consent-c",
        clientId: "client-c",
        userId: subject,
        scopes: ["openid"],
        createdAt: "2026-10-01T12:00:00.000Z",
        updatedAt: "2026-10-01T12:00:00.000Z",
      },
      {
        id: "consent-other-user",
        clientId: "client-elsewhere",
        userId: "neon-someone-else",
        scopes: ["openid"],
        createdAt: "2026-10-02T12:00:00.000Z",
        updatedAt: "2026-10-02T12:00:00.000Z",
      },
    ],
    calls: [] as { path: string; body: Record<string, unknown> }[],
    rowsAtDelete: [] as number[],
  };
  const rows = async () =>
    (
      await local.db.query<{ n: number }>(
        sql`SELECT count(*)::integer AS n FROM assistant_disconnects WHERE provider='neon' AND subject=${subject} AND client_id='client-c'`,
      )
    )[0]!.n;
  const upstream = fakeNeon(async (path, body, request, url) => {
    if (path === "/get-session")
      return request.headers
        .get("Cookie")
        ?.includes(NEON_AUTH_SESSION_COOKIE_NAME + "=")
        ? neonSession(subject, state.email)
        : Response.json(null);
    if (path === "/oauth2/get-consents")
      return state.consentsAvailable
        ? Response.json(state.consents)
        : Response.json({ message: "Unavailable" }, { status: 503 });
    if (path === "/oauth2/public-client")
      return Response.json({
        client_id: url.searchParams.get("client_id"),
        client_name: "Fixture <Assistant>",
      });
    if (path === "/oauth2/delete-consent") {
      state.rowsAtDelete.push(await rows());
      if (!state.deleteAvailable)
        return Response.json({ message: "Unavailable" }, { status: 503 });
      state.consents = state.consents.filter((c) => c.id !== body.id);
      return Response.json(null);
    }
    if (path === "/oauth2/consent" && !state.consentAvailable)
      return Response.json({ message: "Unavailable" }, { status: 503 });
    if (path === "/oauth2/consent")
      return Response.json({
        url:
          "http://localhost:9999/callback?" +
          (body.accept ? "code=fixture-code" : "error=access_denied"),
        redirect: true,
      });
    if (path === "/sign-out") return Response.json({ success: true });
    throw new Error("Unexpected upstream endpoint");
  }, state.calls);
  await local.db.query(sql`UPDATE store_config SET signup_mode='open'`);
  await resolveIdentityAccount(local.env, { provider: "neon", subject });
  const jar = new Map<string, string>([
    [NEON_AUTH_SESSION_COOKIE_NAME, "fixture-session-token"],
  ]);
  return {
    local,
    state,
    rows,
    jar,
    send: browser(appFor(local.env), jar),
    async dispose() {
      upstream.mockRestore();
      await local.dispose();
    },
  };
}

test("connected assistants: list the session's consents, disconnect in order, retry, and reconnect on Allow", async () => {
  const fixture = await accountFixture();
  const { state, send, rows } = fixture;
  try {
    const listed = await send("/assistants");
    expect(listed.status).toBe(200);
    expect(listed.headers.get("Cache-Control")).toBe("no-store");
    expect(listed.headers.get("Content-Security-Policy")).toContain(
      "script-src 'none'",
    );
    const html = await listed.text();
    expect(html).toContain("Fixture &lt;Assistant&gt;");
    expect(html).toContain("(name not verified)");
    expect(html).toContain("Connected 2026-10-01");
    expect(html).toContain('value="consent-c"');
    expect(html).not.toContain("consent-other-user");
    expect(html).not.toContain("client-elsewhere");
    const deletes = () =>
      state.calls.filter((c) => c.path === "/oauth2/delete-consent").length;
    // Cross-site, missing-CSRF and foreign consent ids change nothing.
    for (const [fields, headers] of [
      [{ consent: "consent-c" }, { Origin: "https://evil.example" }],
      [{ consent: "consent-c", csrf: "x".repeat(43) }, {}],
    ] as const) {
      expect(
        (await send("/assistants/disconnect", { ...fields }, { ...headers }))
          .status,
      ).toBe(403);
    }
    for (const consent of ["consent-other-user", "consent-unknown"])
      expect((await send("/assistants/disconnect", { consent })).status).toBe(
        404,
      );
    expect(await rows()).toBe(0);
    expect(deletes()).toBe(0);
    // Milton's refusal is written first; a provider failure leaves it standing.
    state.deleteAvailable = false;
    const partial = await send("/assistants/disconnect", {
      consent: "consent-c",
    });
    expect(partial.status).toBe(503);
    const partialHtml = await partial.text();
    expect(partialHtml).toContain(
      "Disconnected. Milton now refuses this assistant, but removing it from your sign-in provider did not finish. Retry.",
    );
    expect(partialHtml).toContain("Disconnect incomplete");
    expect(partialHtml).toContain(">Retry</button>");
    expect(state.rowsAtDelete).toEqual([1]);
    expect(await (await send("/assistants")).text()).toContain(
      "Disconnect incomplete",
    );
    state.deleteAvailable = true;
    const done = await send("/assistants/disconnect", { consent: "consent-c" });
    expect(done.status).toBe(303);
    expect(done.headers.get("Location")).toBe(
      appOrigin + "/assistants?done=disconnected",
    );
    expect(state.calls.at(-1)).toEqual({
      path: "/oauth2/delete-consent",
      body: { id: "consent-c" },
    });
    expect(await rows()).toBe(1);
    const after = await (await send("/assistants?done=disconnected")).text();
    expect(after).toContain("can no longer read or change your memos");
    expect(after).not.toContain("revoked");
    expect(after).toContain("No assistants are connected.");
    // A failed consent listing never shows a stale list.
    state.consentsAvailable = false;
    const unavailable = await send("/assistants");
    expect(unavailable.status).toBe(503);
    expect(await unavailable.text()).toContain(
      "Connected assistants are unavailable right now. Try again.",
    );
    state.consentsAvailable = true;
    // Deny keeps the refusal; Allow for the same client lifts it, but only
    // after the provider accepted the approval.
    const query = signedQuery.replace(
      "client_id=fixture",
      "client_id=client-c",
    );
    state.consentAvailable = false;
    const failed = await send("/consent", {
      decision: "allow",
      oauth_query: query,
    });
    expect(failed.status).toBe(503);
    expect(await rows()).toBe(1);
    state.consentAvailable = true;
    // The provider kept an approval whose refusal clear failed twice: no code,
    // and the page points to Connected assistants. One failure is retried.
    await fixture.local.pg.exec(`CREATE SEQUENCE clear_attempts;
      CREATE FUNCTION fail_clear() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        IF nextval('clear_attempts') <= 3 THEN RAISE EXCEPTION 'fixture_clear_failed'; END IF;
        RETURN NULL; END $$;
      CREATE TRIGGER fail_clear BEFORE DELETE ON assistant_disconnects
        FOR EACH STATEMENT EXECUTE FUNCTION fail_clear();`);
    const stuck = await send("/consent", {
      decision: "allow",
      oauth_query: query,
    });
    expect(stuck.status).toBe(503);
    const stuckHtml = await stuck.text();
    expect(stuckHtml).not.toContain("fixture-code");
    expect(stuckHtml).toContain('href="/assistants"');
    expect(stuckHtml).toContain(
      "Open Connected assistants, choose Retry or Disconnect for this assistant, then reconnect it from the assistant.",
    );
    expect(await rows()).toBe(1);
    for (const [decision, remaining] of [
      ["deny", 1],
      ["allow", 0],
    ] as const) {
      const response = await send("/consent", { decision, oauth_query: query });
      expect(response.status).toBe(200);
      expect(await rows()).toBe(remaining);
    }
  } finally {
    await fixture.dispose();
  }
}, 30000);

test("account deletion: confirmed, same-origin, consents recorded first, then disconnect all, sign out and a public page", async () => {
  const fixture = await accountFixture();
  const { state, send, local } = fixture;
  const email = "fixture@example.invalid";
  state.consents.push({
    ...state.consents[0]!,
    id: "consent-d",
    clientId: "client-d",
  });
  const account = () =>
    local.db.query(
      sql`SELECT u.id FROM identities i JOIN users u ON u.id=i.user_id WHERE i.subject='neon-account'`,
    );
  const disconnects = async () =>
    (
      await local.pg.query(
        "SELECT client_id FROM assistant_disconnects ORDER BY 1",
      )
    ).rows;
  const upstream = (path: string) =>
    state.calls.filter((c) => c.path === path).map((c) => c.body);
  try {
    expect(await (await send("/")).text()).toContain('href="/account/delete"');
    const form = await send("/account/delete");
    expect(form.status).toBe(200);
    const html = await form.text();
    for (const text of [
      'href="/download"',
      'action="/account/delete"',
      "one-way fingerprint of your sign-in",
      "stays with our sign-in provider",
      "Copies in database backups are not erased immediately",
    ])
      expect(html).toContain(text);
    // Wrong phrase, foreign origin or missing CSRF: nothing happens.
    for (const [fields, headers, status] of [
      [{ confirm: "Delete my account" }, {}, 400],
      [
        { confirm: "delete my account" },
        { Origin: "https://evil.example" },
        403,
      ],
      [{ confirm: "delete my account", csrf: "x".repeat(43) }, {}, 403],
    ] as const)
      expect(
        (await send("/account/delete", { ...fields }, { ...headers })).status,
      ).toBe(status);
    // Without the live consent list there is nothing to disconnect safely.
    state.consentsAvailable = false;
    const unavailable = await send("/account/delete", {
      confirm: "delete my account",
    });
    expect(unavailable.status).toBe(503);
    expect(await unavailable.text()).toContain(
      "Account deletion is unavailable right now. Nothing was deleted. Try again.",
    );
    state.consentsAvailable = true;
    expect(await account()).toHaveLength(1);
    expect(await disconnects()).toEqual([]);
    expect(upstream("/oauth2/delete-consent")).toEqual([]);
    expect(upstream("/sign-out")).toEqual([]);

    const done = await send("/account/delete", {
      confirm: "delete my account",
    });
    expect(done.status).toBe(200);
    const deleted = await done.text();
    expect(deleted).toContain("Account deleted");
    expect(deleted).toContain("not erased immediately");
    expect(deleted).toContain('href="/"');
    expect(deleted).not.toContain(email);
    expect(deleted).not.toContain("neon-account");
    expect(deleted).not.toContain("Signed in as");
    expect(done.headers.getSetCookie().join("\n")).toContain("milton-csrf=;");
    expect(await account()).toEqual([]);
    expect(await disconnects()).toEqual([
      { client_id: "client-c" },
      { client_id: "client-d" },
    ]);
    expect(
      upstream("/oauth2/delete-consent")
        .map((body) => body.id)
        .sort(),
    ).toEqual(["consent-c", "consent-d"]);
    // Milton's refusal for client-c was committed before either provider call.
    expect(state.rowsAtDelete).toEqual([1, 1]);
    expect(upstream("/sign-out")).toHaveLength(1);
    // A stale session for a deleted account changes nothing.
    await send("/");
    const again = await send("/account/delete", {
      confirm: "delete my account",
    });
    expect(again.status).toBe(403);
    expect(upstream("/oauth2/delete-consent")).toHaveLength(2);
  } finally {
    await fixture.dispose();
  }
}, 30000);

test("signed-in email shows only in authenticated chrome; switch account signs out to /login", async () => {
  const fixture = await accountFixture();
  const { send, jar } = fixture;
  const email = "fixture@example.invalid";
  try {
    for (const path of ["/", "/tps-report", "/assistants"]) {
      const html = await (await send(path)).text();
      expect(html).toContain(`Signed in as <strong>${email}</strong>`);
      if (path !== "/assistants") expect(html).toContain('href="/assistants"');
    }
    const report = await (await send("/")).text();
    // The cover sheet form is prepared for the signed-in email; the download is not.
    expect(report).toContain(
      `<dt>Prepared for:</dt><dd class="fill">${email}</dd>`,
    );
    // Setup steps moved to Connected assistants, still keyed to the empty account.
    const assistants = await (await send("/assistants")).text();
    expect(assistants).toContain(
      '<pre class="setup-copy"><code>https://mcp.meetmilton.com/mcp</code></pre>',
    );
    expect(assistants).toContain("It is empty, so run the setup questions");
    expect(report).not.toContain("https://mcp.meetmilton.com/mcp");
    expect(report).toContain('name="next" value="login"');
    expect(report).toContain(
      "Signing out of this browser does not disconnect your assistants.",
    );
    expect(await (await send("/download")).text()).not.toContain(email);
    fixture.state.email = undefined;
    const anonymousEmail = await (await send("/")).text();
    expect(anonymousEmail).not.toContain("Signed in as");
    expect(anonymousEmail).not.toContain("neon-account");
    fixture.state.email = email;
    for (const [next, target] of [
      ["login", "/login"],
      ["https://evil.example", "/"],
      ["", "/"],
    ] as const) {
      await send("/");
      const out = await send("/logout", next ? { next } : {});
      expect(out.status).toBe(200);
      expect(await out.text()).toContain(
        `content="0;url=${appOrigin + target}"`,
      );
    }
    jar.delete(NEON_AUTH_SESSION_COOKIE_NAME);
    const landing = await (await send("/")).text();
    expect(landing).toContain("Sign in to Milton");
    expect(landing).not.toContain(email);
  } finally {
    await fixture.dispose();
  }
}, 30000);

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
    cookieSecret: crypto.randomUUID(),
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
    });
  }
  const denied = await app(
    new Request(appOrigin + "/login", {
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
    cookieSecret: crypto.randomUUID(),
  });
  const upstream = fakeNeon((path) => {
    if (path === "/get-session") return Response.json(null);
    throw new Error("Unexpected upstream endpoint");
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
    upstream.mockRestore();
  }
});

test("pages on the MCP host redirect to the app host; assistant routes stay", async () => {
  const app = createMiltonApp({
    issuer,
    resource: "https://mcp.meetmilton.com/mcp",
    appOrigin: "https://app.meetmilton.com",
    cookieSecret: crypto.randomUUID(),
  });
  const page = await app(
    new Request("https://mcp.meetmilton.com/memos/vibes?tab=history", {
      headers: { Host: "mcp.meetmilton.com" },
    }),
  );
  expect(page.status).toBe(308);
  expect(page.headers.get("Location")).toBe(
    "https://app.meetmilton.com/memos/vibes?tab=history",
  );
  const discovery = await app(
    new Request(
      "https://mcp.meetmilton.com/.well-known/oauth-protected-resource/mcp",
      { headers: { Host: "mcp.meetmilton.com" } },
    ),
  );
  expect(discovery.status).toBe(200);
});

async function memoPageFixture(
  answer?: (path: string) => Response | undefined,
) {
  const local = await localStore();
  await local.db.query(sql`UPDATE store_config SET signup_mode='open'`);
  await resolveIdentityAccount(local.env, {
    provider: "neon",
    subject: "page-fixes",
  });
  const account = await lookupIdentityAccount(local.env, {
    provider: "neon",
    subject: "page-fixes",
  });
  const store = await personStoreForCurrentRequest(local.env, account);
  const author = await storeForCurrentRequest(local.env, account, {
    issuer,
    clientId: "fixture",
  });
  const upstream = fakeNeon((path, _body, _request, url) => {
    const answered = answer?.(path);
    if (answered) return answered;
    if (url.href !== issuer + "/get-session")
      throw new Error("Unexpected upstream endpoint");
    return neonSession("page-fixes");
  });
  const app = appFor(local.env);
  return {
    app,
    store,
    author,
    db: local.db,
    send: browser(app),
    async dispose() {
      upstream.mockRestore();
      await local.dispose();
    },
  };
}

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
      "Subscribe for $5.01/month",
    );
    await fixture.db.query(sql`UPDATE store_config SET trials_enabled=true`);
    await fixture.db.query(
      sql`INSERT INTO trial_accounts(user_id,started_at) SELECT id,created_at FROM users`,
    );
    const freshTrial = await (await fixture.send("/")).text();
    expect(freshTrial).not.toContain("trial starts");
    expect(freshTrial).not.toContain("Subscribe for $5.01/month");
    await fixture.db.query(
      sql`UPDATE trial_accounts SET started_at=clock_timestamp()-interval '24 days'`,
    );
    const warning = await fixture.send("/");
    expect(warning.status).toBe(200);
    const warned = await warning.text();
    expect(warned).toContain("Subscribe for $5.01/month.");
    expect(warned).not.toContain('href="/billing"');
    // Page views do not consume an assistant's reminder milestone.
    expect(
      (await fixture.db.query(sql`SELECT notice_stage FROM trial_accounts`))[0]!
        .notice_stage,
    ).toBe(0);
    await fixture.db.query(
      sql`UPDATE trial_accounts SET started_at=clock_timestamp()-interval '31 days'`,
    );
    const expired = await fixture.send("/tps-report");
    expect(expired.status).toBe(200);
    const html = await expired.text();
    expect(html).toContain("Assistant reads and saves are paused.");
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

test("no served page, trial notice or subscription refusal links to a route that does not exist", async () => {
  let signedIn = true;
  const fixture = await memoPageFixture((path) => {
    if (path === "/get-session")
      return signedIn ? neonSession("page-fixes") : Response.json(null);
    if (path === "/oauth2/get-consents") return Response.json([]);
    if (path === "/oauth2/public-client")
      return Response.json({
        client_id: "fixture",
        client_name: "Fixture assistant",
        client_uri: "https://client.example",
      });
  });
  try {
    const first = await fixture.store.readTpsReport();
    await fixture.author.saveMemo({
      text: "Be concise.",
      rules: [{ report: "cover", text: "Be concise." }],
      expected_version: first.version,
      request_id: crypto.randomUUID(),
    });
    await fixture.db.query(sql`UPDATE store_config SET trials_enabled=true`);
    await fixture.db.query(
      sql`INSERT INTO trial_accounts(user_id,started_at) SELECT id,clock_timestamp()-interval '24 days' FROM users`,
    );
    // Every link Milton serves: page hrefs, and URL fields in the notice and
    // the refusal assistants receive. Only same-origin paths are checked.
    const links = new Set<string>();
    const collect = (value: unknown) => {
      for (const match of JSON.stringify(value ?? null).matchAll(
        /https?:\/\/[^"\s\\]+/g,
      ))
        links.add(match[0]);
    };
    // Browser routing is an if-chain (browserPages and isMemoRoute), not a
    // route table, so the served GET pages are listed here: signed-in pages,
    // consent, signed-out landing and login, and the not-found page.
    const signedInPages = [
      "/",
      "/tps-report",
      "/assistants",
      "/account/delete",
      "/consent?" + signedQuery,
    ];
    const signedOutPages = ["/", "/login", "/login?" + signedQuery];
    const visit = async () => {
      const pages = [
        ...signedInPages.map((path) => [path, true] as const),
        ...signedOutPages.map((path) => [path, false] as const),
        ["/no-such-page", true] as const,
      ];
      for (const [path, session] of pages) {
        signedIn = session;
        // Consent is past Neon's middleware, which needs its session cookie.
        const response = await fixture.send(
          path,
          undefined,
          path.startsWith("/consent")
            ? {
                Cookie: `${NEON_AUTH_SESSION_COOKIE_NAME}=fixture-session-token`,
              }
            : {},
        );
        expect([path, response.status]).toEqual([
          path,
          path === "/no-such-page" ? 404 : 200,
        ]);
        for (const match of (await response.text()).matchAll(/href="([^"]+)"/g))
          links.add(match[1]!);
      }
      signedIn = true;
    };
    await visit();
    const notice = await fixture.author.trialNotice!();
    expect(notice?.code).toBe("trial_ending_7_days");
    collect(notice);
    await fixture.db.query(
      sql`UPDATE trial_accounts SET started_at=clock_timestamp()-interval '31 days'`,
    );
    await visit();
    const refused = await fixture.author
      .saveMemo({
        text: "Be brief.",
        rules: [{ report: "cover", text: "Be brief." }],
        expected_version: first.version,
        request_id: crypto.randomUUID(),
      })
      .catch((error: StoreError) => error);
    expect(refused).toBeInstanceOf(StoreError);
    expect((refused as StoreError).code).toBe("subscription_required");
    collect((refused as StoreError).details);
    const dead: string[] = [];
    for (const link of links) {
      const url = new URL(link, appOrigin);
      if (![appOrigin, "https://app.meetmilton.com"].includes(url.origin))
        continue;
      // Built assets are served ahead of the app, as in cloud-app.ts.
      const served =
        localAsset(new Request(url)) ?? (await fixture.send(url.pathname));
      if (served.status === 404) dead.push(link);
    }
    expect(dead).toEqual([]);
  } finally {
    await fixture.dispose();
  }
});

test("web shows only current TPS and rejects all retired history and mutation routes", async () => {
  const fixture = await memoPageFixture();
  try {
    const empty = await (await fixture.send("/")).text();
    expect(empty).toContain("No instructions on file.");
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
    for (const font of ["geist-latin-variable", "jetbrains-mono-regular"])
      expect(html).toContain(
        `<link rel="preload" href="/fonts/${font}.woff2" as="font" type="font/woff2" crossorigin="anonymous"`,
      );
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
    const before = await fixture.db.query(
      sql`SELECT * FROM memo_versions ORDER BY user_id,memo_id,version`,
    );
    for (const path of [
      "/memos",
      "/memos/sample",
      "/memos/sample/history",
      "/memos/sample/archive",
      "/memos/sample/restore",
      "/memos/sample/revert",
      "/tps-report/history",
      "/tps-report/history/1",
      "/tps-report/revert",
    ]) {
      expect((await fixture.send(path)).status).toBe(404);
      expect((await fixture.send(path, {})).status).toBe(404);
      expect((await fixture.send(path, new FormData())).status).toBe(404);
    }
    expect(
      await fixture.db.query(
        sql`SELECT * FROM memo_versions ORDER BY user_id,memo_id,version`,
      ),
    ).toEqual(before);
    const download = await fixture.send("/download");
    expect(download.headers.get("Content-Disposition")).toBe(
      'attachment; filename="TPS.md"',
    );
    expect(await download.text()).toBe("- " + body);
  } finally {
    await fixture.dispose();
  }
}, 30000);

test("pages and download show only the session account, whatever the query names", async () => {
  // The browser session belongs to page-fixes; a second account shares the store.
  const fixture = await memoPageFixture();
  try {
    const bindings = { storeDatabase: fixture.db };
    const identity = { provider: "neon", subject: "page-alpha" };
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
        context: "alpha context",
        text: "Alpha sample body.",
      },
    });
    expect(alphaSample.status).toBe("saved");
    expect(
      (
        await fixture.author.saveMemo({
          text: "Beta keeps it brief.",
          rules: [{ report: "cover", text: "Beta keeps it brief." }],
          expected_version: (await fixture.store.readTpsReport()).version,
          request_id: crypto.randomUUID(),
        })
      ).status,
    ).toBe("saved");
    const own = await fixture.store.readTpsReport();
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
        if (path === "/download") expect(text).toBe(own.text);
        else expect(text).toContain("Beta keeps it brief.");
        for (const foreign of [
          "Alpha signs as Ada",
          "Alpha sample body",
          "alpha context",
          alpha.userId,
        ])
          expect(text).not.toContain(foreign);
      }
  } finally {
    await fixture.dispose();
  }
}, 30000);

test("report bullets require exact revision and complete text parity; optional lookup failure keeps canonical access", async () => {
  const bodies = [
    "  Keep fictional units explicit.\n\nUnless a condition applies, preserve <tag> & wording.  ",
    "Do the second instruction after the first.\nKeep this exception attached.\n",
  ];
  const report = {
    text: bodies.join("\n\n"),
    version: "a".repeat(64),
    is_empty: false,
  };
  let balanceReads = 0;
  let balanceUnavailable = false;
  const balance = {
    limit: 100,
    used: 2,
    pending: 1,
    available: 97,
    resets_at: "2026-11-02T00:00:00Z",
    as_of: "2026-11-01T23:00:00Z",
  };
  const base = {
    readTpsReport: async () => report,
    memoUpdates: async () => {
      balanceReads++;
      if (balanceUnavailable) throw new Error("Optional usage unavailable");
      return balance;
    },
  };
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
    readDocuments?: () => Promise<typeof exact | null>,
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
    ["Date", "2026-11-02"],
    ["Reports", "None"],
    ["Rules", "2"],
    ["Samples", "0"],
    ["Memo updates today", "2 of 100"],
  ])
    expect(html).toContain(`<dt>${label}:</dt><dd class="fill">${value}</dd>`);
  expect(html).toContain(
    '<p class="line typed comment">Red stapler located. Returned to owner.</p>',
  );
  balanceUnavailable = true;
  const withoutBalance = await render(async () => exact);
  expect(withoutBalance.status).toBe(200);
  expect(await withoutBalance.text()).not.toContain("Memo updates today");
  balanceUnavailable = false;
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
  expect(html.indexOf("<h1>T.P.S. Report</h1>")).toBeLessThan(
    html.indexOf('<ol class="ruled">'),
  );
  for (const lookup of [
    undefined,
    async () => null,
    async () => ({ ...exact, version: "b".repeat(64) }),
    async () => {
      throw new Error("Optional layout unavailable");
    },
  ]) {
    const response = await render(lookup);
    expect(response.status).toBe(200);
    const fallback = await response.text();
    expect(fallback).toContain('<pre class="memo-text"><span>');
    expect(fallback).not.toContain('<ol class="ruled">');
    expect(fallback).toContain(
      "Unless a condition applies, preserve &lt;tag&gt; &amp; wording.",
    );
  }
  let lookups = 0;
  const priorBalanceReads = balanceReads;
  const download = await render(async () => {
    lookups++;
    throw new Error("Download must not need layout");
  }, "/download");
  expect(new Uint8Array(await download.arrayBuffer())).toEqual(
    new TextEncoder().encode(report.text),
  );
  expect(lookups).toBe(0);
  expect(balanceReads).toBe(priorBalanceReads);
  const titled = await memoPages(
    new Request(appOrigin + "/tps-report"),
    {
      ...base,
      readTpsReport: async () => ({
        ...report,
        text: "# Email\n\nApplies when fictional.\n\n- One.\n\n- Two\nlines.",
      }),
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
                context: "after a call",
                body: "Hi <there>,\n\nThanks.",
                date: "2026-11-02",
              },
            ],
            rules: ["- One.", "- Two\nlines."],
          },
        ],
      })) as never,
    },
    () => "",
  );
  expect(await titled.text()).toContain(
    '<section class="form-section"><h2>Email</h2><p class="applies">Applies when fictional.</p><p class="sub-label">Approved samples:</p><details class="form-sample"><summary><span class="box" aria-hidden="true">☑</span><span class="typed">After a call</span><span class="date">2026-11-02</span></summary><pre class="memo-text"><span>Hi &lt;there&gt;,\n\nThanks.</span></pre></details><p class="sub-label">Rules:</p><ol class="ruled"><li class="line"><span class="typed">One.</span></li><li class="line"><span class="typed">Two\nlines.</span></li></ol></section>',
  );
});

test("capability feed is direct bounded JSON with protected rotation, immediate revocation and no redirects", async () => {
  const { rotateSpendFeed, revokeSpendFeed } =
    await import("../scripts/spend-feed");
  const { mkdtemp, readFile, stat, rm, mkdir, chmod, symlink } =
    await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { createHash } = await import("node:crypto");
  const { createMcpApp } = await import("../src/index");
  const local = await localStore(),
    folder = await mkdtemp(join(tmpdir(), "milton-feed-"));
  const config = {
    ...local.env,
    issuer,
    resource: "https://mcp.example/mcp",
    appOrigin: "https://app.example",
    cookieSecret: crypto.randomUUID(),
  };
  const app = createMiltonApp(config, true);
  const send = (
    url: string,
    method = "GET",
    headers: Record<string, string> = {},
  ) =>
    app(
      new Request(url, {
        method,
        headers: { Host: new URL(url).host, ...headers },
      }),
    );
  try {
    await local.pg.exec(
      "UPDATE store_config SET global_spend_policy='alerts_only'",
    );
    const missing = await send(config.appOrigin + "/operator/spend-alerts/");
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: "feed_unavailable" });
    const file = join(folder, "capability.url");
    await rotateSpendFeed(local.db, config.appOrigin, file);
    const url = (await readFile(file, "utf8")).trim(),
      token = new URL(url).pathname.split("/").at(-1)!.slice(0, -5);
    expect(/^[A-Za-z0-9_-]{43}$/.test(token)).toBe(true);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    const hash = (
      await local.pg.query<{ spend_feed_key_hash: string }>(
        "SELECT spend_feed_key_hash FROM store_config",
      )
    ).rows[0]!.spend_feed_key_hash;
    expect(hash === createHash("sha256").update(token).digest("hex")).toBe(
      true,
    );
    expect(hash.includes(token)).toBe(false);
    const empty = await send(url);
    expect(empty.status).toBe(200);
    expect((await empty.json()).events).toEqual([]);
    const wrong =
      config.appOrigin + "/operator/spend-alerts/" + "A".repeat(43) + ".json";
    const invalid = await send(wrong, "GET", {
      Cookie: "fictional-session",
      Authorization: "Bearer fictional",
      "X-Milton-User-Id": "fictional-owner",
    });
    expect(invalid.status).toBe(404);
    expect(await invalid.json()).toEqual({ error: "feed_unavailable" });
    expect((await send(url + "?key=ignored")).status).toBe(404);
    const head = await send(url, "HEAD");
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
    expect(head.headers.get("Content-Type")).toContain("application/json");
    const invalidHead = await send(wrong, "HEAD");
    expect(invalidHead.status).toBe(404);
    expect(await invalidHead.text()).toBe("");
    const post = await send(url, "POST");
    expect(post.status).toBe(405);
    expect(post.headers.get("Allow")).toBe("GET, HEAD");
    const mcp = createMcpApp(config);
    for (const path of [
      new URL(url).pathname,
      "/operator%2fspend-alerts/" + token + ".json",
      "/%6fperator/spend-alerts/" + token + ".json%ZZ",
      "/operator/spend-alerts",
    ]) {
      const denied = await mcp(
        new Request("https://mcp.example" + path, {
          headers: { Host: "mcp.example" },
        }),
      );
      expect(denied.status).toBe(404);
      expect(denied.headers.get("Location")).toBeNull();
      expect((await denied.text()).includes(token)).toBe(false);
    }
    const wrongHost = await send(url, "GET", { Host: "wrong.example" });
    expect(wrongHost.status).toBe(403);
    expect(wrongHost.headers.get("Location")).toBeNull();
    await local.pg.exec(
      "INSERT INTO spend_alerts(id,day_utc,metric,threshold_micros,filing_micros,review_micros,derived_micros,status,published_at) SELECT gen_random_uuid()::text,(clock_timestamp() AT TIME ZONE 'UTC')::date,'model_reservations',n,123456789,1000000,2000000,'published',clock_timestamp() FROM generate_series(1,105) n",
    );
    const before = (
      await local.pg.query("SELECT * FROM spend_alerts ORDER BY id")
    ).rows;
    const response = await send(url);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(response.headers.get("X-Robots-Tag")).toContain("noindex");
    expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
    expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
    const feed = await response.json();
    expect(feed.events).toHaveLength(100);
    expect(Object.keys(feed.events[0]).sort()).toEqual(
      [
        "id",
        "day_utc",
        "threshold_usd",
        "reserved_usd",
        "observed_at",
        "published_at",
      ].sort(),
    );
    expect(feed.events[0].reserved_usd).toEqual({
      filing: "123.456789",
      review: "1.000000",
      derived: "2.000000",
      total: "126.456789",
    });
    expect(JSON.stringify(feed).includes(token)).toBe(false);
    expect(await (await send(url)).json()).toEqual(feed);
    expect(
      (await local.pg.query("SELECT * FROM spend_alerts ORDER BY id")).rows,
    ).toEqual(before);
    await expect(
      rotateSpendFeed(local.db, config.appOrigin, file),
    ).rejects.toThrow();
    const publicFolder = join(folder, "public");
    await mkdir(publicFolder);
    await chmod(publicFolder, 0o755);
    await expect(
      rotateSpendFeed(
        local.db,
        config.appOrigin,
        join(publicFolder, "key.url"),
      ),
    ).rejects.toThrow();
    await symlink(file, join(folder, "link.url"));
    await expect(
      rotateSpendFeed(local.db, config.appOrigin, join(folder, "link.url")),
    ).rejects.toThrow();
    expect((await send(url)).status).toBe(200);
    const next = join(folder, "rotated.url");
    await rotateSpendFeed(local.db, config.appOrigin, next);
    let rotated = (await readFile(next, "utf8")).trim();
    expect((await send(url)).status).toBe(404);
    expect((await send(rotated)).status).toBe(200);
    const uncertainFile = join(folder, "uncertain.url");
    let lost = true;
    const uncertain = {
      ...local.db,
      async transaction<T>(
        work: Parameters<typeof local.db.transaction<T>>[0],
      ) {
        const value = await local.db.transaction(work);
        if (lost) {
          lost = false;
          throw new Error("Fictional lost rotation acknowledgment");
        }
        return value;
      },
    };
    await expect(
      rotateSpendFeed(uncertain, config.appOrigin, uncertainFile),
    ).rejects.toThrow();
    expect((await stat(uncertainFile)).mode & 0o777).toBe(0o600);
    expect((await send(rotated)).status).toBe(404);
    rotated = (await readFile(uncertainFile, "utf8")).trim();
    expect((await send(rotated)).status).toBe(200);
    const broken = {
      ...local.db,
      async query<Row extends Record<string, unknown>>(
        _q: Parameters<typeof local.db.query>[0],
      ): Promise<Row[]> {
        throw new Error("Fictional lookup failure");
      },
    };
    const failed = await createMiltonApp(
      { ...config, storeDatabase: broken },
      true,
    )(new Request(rotated, { headers: { Host: "app.example" } }));
    expect(failed.status).toBe(503);
    expect(await failed.json()).toEqual({ error: "feed_unavailable" });
    let changed = false;
    const raced = {
      ...local.db,
      async query<Row extends Record<string, unknown>>(
        q: Parameters<typeof local.db.query>[0],
      ): Promise<Row[]> {
        const rows = await local.db.query<Row>(q);
        if (!changed) {
          changed = true;
          await revokeSpendFeed(local.db);
        }
        return rows;
      },
    };
    const revokedDuringRead = await createMiltonApp(
      { ...config, storeDatabase: raced },
      true,
    )(new Request(rotated, { headers: { Host: "app.example" } }));
    expect(revokedDuringRead.status).toBe(404);
    expect((await send(rotated)).status).toBe(404);
  } finally {
    await local.dispose();
    await rm(folder, { recursive: true, force: true });
  }
});

test("multiply encoded capability prefixes fail closed while unrelated MCP redirects remain intact", async () => {
  const { createMcpApp } = await import("../src/index");
  const app = createMcpApp({
    issuer,
    resource: "https://mcp.example/mcp",
    appOrigin,
  });
  const fictional = "x".repeat(43);
  const request = (path: string) =>
    app(
      new Request("https://mcp.example" + path, {
        headers: { Host: "mcp.example" },
      }),
    );
  for (const depth of [1, 2, 3, 4, 16, 128, 1024]) {
    const encoded = "%" + "25".repeat(depth - 1) + "6f";
    for (const suffix of [".json", ".json%ZZ"]) {
      const response = await request(
        "/" + encoded + "perator/spend-alerts/" + fictional + suffix,
      );
      expect(response.status).toBe(404);
      expect(response.headers.has("Location")).toBe(false);
      expect((await response.text()).includes(fictional)).toBe(false);
    }
  }
  for (const path of [
    "/login?flow=a%2Bb",
    "/tps-report",
    "/unrelated/%25252541",
  ]) {
    const response = await request(path);
    expect(response.status).toBe(308);
    expect(response.headers.get("Location")).toBe(appOrigin + path);
  }
});
