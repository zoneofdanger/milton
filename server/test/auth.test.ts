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
  const { localAsset } = await import("../src/assets");
  for (const [path, type] of [
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
    expect(consentHtml).toContain(
      "read your cover sheet and reports and save rules and samples to them",
    );
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
    expect(homeHtml).toContain('<h1 aria-label="T.P.S. Report, cover sheet">');
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
    expect(await migratedHome.text()).toContain(
      '<h1 aria-label="T.P.S. Report, cover sheet">',
    );
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
          new Request(appOrigin + "/tps-report", {
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

async function accountFixture(
  extra: Partial<Parameters<typeof createMiltonApp>[0]> = {},
) {
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
    if (path === "/oauth2/continue")
      return Response.json({ url: "http://localhost:9999/callback?code=c" });
    if (path === "/sign-out") return Response.json({ success: true });
    throw new Error("Unexpected upstream endpoint");
  }, state.calls);
  await resolveIdentityAccount(local.env, { provider: "neon", subject });
  const jar = new Map<string, string>([
    [NEON_AUTH_SESSION_COOKIE_NAME, "fixture-session-token"],
  ]);
  return {
    local,
    state,
    rows,
    jar,
    send: browser(appFor({ ...local.env, ...extra }), jar),
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

test("served pages take the MCP address and support address from configuration", async () => {
  const { runtimeConfig } = await import("../src/config");
  const env = {
    APP_ORIGIN: "https://app.example",
    MCP_RESOURCE: "https://mcp.example/mcp",
    NEON_AUTH_BASE_URL: "https://auth.example/auth",
    NEON_AUTH_COOKIE_SECRET: "x".repeat(32),
  };
  expect(runtimeConfig(env).supportEmail).toBeUndefined();
  expect(
    runtimeConfig({ ...env, MILTON_SUPPORT_EMAIL: "help@example.invalid" })
      .supportEmail,
  ).toBe("help@example.invalid");
  expect(() =>
    runtimeConfig({ ...env, MILTON_SUPPORT_EMAIL: "not an address" }),
  ).toThrow();
  // Stripe is all or nothing: a partial or malformed set fails at startup, the
  // same way, naming no value. All unset stays legal.
  const stripe = {
    STRIPE_SECRET_KEY: "rk_test_fixtureNotAKey",
    STRIPE_WEBHOOK_SECRET: "whsec_fixtureNotASecret",
    STRIPE_PRICE_ID: "price_fixture",
  };
  expect(runtimeConfig(env).billing).toBeUndefined();
  expect(runtimeConfig({ ...env, ...stripe }).billing?.priceId).toBe(
    "price_fixture",
  );
  for (const broken of [
    { STRIPE_SECRET_KEY: stripe.STRIPE_SECRET_KEY },
    { ...stripe, STRIPE_PRICE_ID: undefined },
    { ...stripe, STRIPE_WEBHOOK_SECRET: "" },
    { ...stripe, STRIPE_SECRET_KEY: "pk_test_fixtureNotAKey" },
    { ...stripe, STRIPE_PRICE_ID: "prod_fixture" },
  ]) {
    let refused: unknown;
    try {
      runtimeConfig({ ...env, ...broken });
    } catch (error) {
      refused = error;
    }
    expect(refused).toMatchObject({
      code: "configuration",
      message: "Milton's server configuration is unavailable.",
    });
  }
  const configured = await accountFixture({
    supportEmail: "help@example.invalid",
  });
  try {
    const assistants = await (await configured.send("/assistants")).text();
    expect(assistants).toContain(`<code>${resource}</code>`);
    expect(assistants).not.toContain("meetmilton.com");
    const deletion = await (await configured.send("/account/delete")).text();
    expect(deletion).toContain('href="mailto:help@example.invalid"');
    expect(deletion).not.toContain("meetmilton.com");
  } finally {
    await configured.dispose();
  }
  const hosted = await accountFixture();
  try {
    expect(await (await hosted.send("/account/delete")).text()).toContain(
      'href="mailto:support@meetmilton.com"',
    );
  } finally {
    await hosted.dispose();
  }
});

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
      `<pre class="setup-copy"><code>${resource}</code></pre>`,
    );
    expect(assistants).toContain(
      "It is empty, so run the setup it returns exactly as written",
    );
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

test("account deletion ends the Stripe customer first, a Stripe failure deletes nothing, and the page says so", async () => {
  const unavailable =
    "Account deletion is unavailable right now. Nothing was deleted. Try again.";
  const remove = { confirm: "delete my account" };
  const setUp = async (fixture: Awaited<ReturnType<typeof accountFixture>>) => {
    await fixture.send("/");
    await fixture.local.db.query(
      sql`INSERT INTO trial_accounts(user_id,started_at,stripe_customer_id,subscription_status)
        SELECT id,clock_timestamp(),'cus_fixture','active' FROM users`,
    );
  };
  const users = async (fixture: Awaited<ReturnType<typeof accountFixture>>) =>
    (
      await fixture.local.db.query<{ n: number }>(
        sql`SELECT count(*)::int AS n FROM users`,
      )
    )[0]!.n;
  // A customer on record with billing unconfigured cannot be ended.
  const off = await accountFixture();
  try {
    await setUp(off);
    const refused = await off.send("/account/delete", remove);
    expect(refused.status).toBe(503);
    expect(await refused.text()).toContain(unavailable);
    expect(await users(off)).toBe(1);
  } finally {
    await off.dispose();
  }
  const { stripe, billing } = fakeStripe();
  const fixture = await accountFixture({ billing });
  const deleteCall = stripeCall("DELETE /v1/customers/cus_fixture");
  try {
    await setUp(fixture);
    const form = await (await fixture.send("/account/delete")).text();
    for (const text of [
      "any subscription end immediately, with no refund",
      "Stripe keeps past invoices and payment records",
    ])
      expect(form).toContain(text);
    stripe.down = true;
    const failed = await fixture.send("/account/delete", remove);
    expect(failed.status).toBe(503);
    expect(await failed.text()).toContain(unavailable);
    expect(await users(fixture)).toBe(1);
    expect(fixture.state.calls.map(({ path }) => path)).not.toContain(
      "/oauth2/delete-consent",
    );
    // A failed DELETE proves nothing, 404 included: a key from the wrong mode gets
    // one for a live customer, whose subscription would go on charging. Nothing
    // is deleted.
    stripe.down = false;
    stripe.calls.length = 0;
    for (const deleteStatus of [404, 409])
      for (const customer of [
        { status: 404, body: {} },
        { status: 200, body: { id: "cus_fixture", deleted: false } },
        { status: 500, body: {} },
      ]) {
        stripe.deleteStatus = deleteStatus;
        stripe.customer = customer;
        const unproven = await fixture.send("/account/delete", remove);
        expect(unproven.status).toBe(503);
        expect(await unproven.text()).toContain(unavailable);
        expect(await users(fixture)).toBe(1);
      }
    // Stripe goes first, with the account still here. A repeat DELETE on a deleted
    // customer may answer anything: only a read reporting it deleted is done.
    stripe.customer = {
      status: 200,
      body: { id: "cus_fixture", deleted: true },
    };
    stripe.calls.length = 0;
    let usersAtDelete = -1;
    stripe.onDelete = async () => {
      usersAtDelete = await users(fixture);
    };
    const done = await fixture.send("/account/delete", remove);
    expect(done.status).toBe(200);
    const deleted = await done.text();
    expect(deleted).toContain(
      "any subscription ended immediately, with no refund",
    );
    expect(deleted).toContain("Stripe keeps past invoices and payment records");
    expect(stripe.calls).toEqual([
      deleteCall,
      stripeCall("GET /v1/customers/cus_fixture"),
    ]);
    expect(usersAtDelete).toBe(1);
    expect(await users(fixture)).toBe(0);
  } finally {
    await fixture.dispose();
  }
  // Stripe's delete lands and Milton's fails: the row forgets the dead customer,
  // so a retry calls nothing and a later subscription starts a new customer.
  const half = fakeStripe();
  const stuck = await accountFixture({ billing: half.billing });
  const quiet = spyOn(console, "error").mockImplementation(() => {});
  try {
    await setUp(stuck);
    await stuck.local.pg.exec(`
      UPDATE trial_accounts SET stripe_subscription_id='sub_fixture';
      CREATE FUNCTION refuse_delete() RETURNS trigger LANGUAGE plpgsql AS
        $$ BEGIN RAISE EXCEPTION 'fixture refusal'; END $$;
      CREATE TRIGGER refuse_delete BEFORE DELETE ON users
        FOR EACH ROW EXECUTE FUNCTION refuse_delete()`);
    expect((await stuck.send("/account/delete", remove)).status).toBe(503);
    expect(half.stripe.calls).toEqual([deleteCall]);
    expect(
      await stuck.local.db.query(
        sql`SELECT stripe_customer_id AS customer,stripe_subscription_id AS subscription,subscription_status AS status FROM trial_accounts`,
      ),
    ).toEqual([{ customer: null, subscription: null, status: "canceled" }]);
    await stuck.local.pg.exec("DROP TRIGGER refuse_delete ON users");
    half.stripe.calls.length = 0;
    expect((await stuck.send("/account/delete", remove)).status).toBe(200);
    expect(half.stripe.calls).toEqual([]);
    expect(await users(stuck)).toBe(0);
  } finally {
    quiet.mockRestore();
    await stuck.dispose();
  }
}, 30000);

const tryAgain =
  "Milton could not start your subscription. Nothing was charged. Try again.";

test("signing in starts one Stripe trial, stops on a Stripe failure, and the repeat completes and continues", async () => {
  const account = async (fixture: {
    local: Awaited<ReturnType<typeof localStore>>;
  }) =>
    (
      await fixture.local.db.query<Record<string, unknown>>(
        sql`SELECT u.id,t.stripe_customer_id AS customer,t.stripe_subscription_id AS subscription,
          t.subscription_status AS status,t.trial_end IS NOT NULL AS has_end
          FROM users u JOIN trial_accounts t ON t.user_id=u.id`,
      )
    )[0];
  // Trials on, and the fixture's account gone, so /login is a real sign-up.
  const fresh = async (fixture: {
    local: Awaited<ReturnType<typeof localStore>>;
  }) => {
    await fixture.local.db.query(
      sql`UPDATE store_config SET trials_enabled=true`,
    );
    await fixture.local.db.query(sql`DELETE FROM users`);
  };
  // Billing unset: no Stripe, and sign-in proceeds.
  const off = await accountFixture();
  try {
    await fresh(off);
    const signedUp = await off.send("/login");
    expect(signedUp.status).toBe(302);
    expect((await account(off))?.status).toBeNull();
  } finally {
    await off.dispose();
  }
  const { stripe, billing } = fakeStripe();
  const fixture = await accountFixture({ billing });
  const logged = spyOn(console, "error").mockImplementation(() => {});
  const flow = "/login?" + signedQuery;
  const continued = () =>
    fixture.state.calls.filter(({ path }) => path === "/oauth2/continue");
  // Fixed inside one UTC minute; moved on to show the keys follow it.
  let time = Math.floor(Date.now() / 60000) * 60000 + 1000;
  const clock = spyOn(Date, "now").mockImplementation(() => time);
  const minute = () => Math.floor(time / 60000);
  try {
    await fresh(fixture);
    stripe.down = true;
    const refused = await fixture.send(flow);
    expect(refused.status).toBe(503);
    expect(refused.headers.get("Location")).toBeNull();
    const page = await refused.text();
    expect(page).toContain(tryAgain);
    expect(page).toContain('href="/login?flow=');
    expect(continued()).toEqual([]);
    expect(await account(fixture)).toMatchObject({
      customer: null,
      status: null,
    });
    expect(logged.mock.calls.map(([line]) => String(line))).toEqual([
      '{"event":"unexpected_error","where":"billing","class":"AuthError","code":"billing_unavailable"}',
    ]);
    expect(page).not.toContain('<a href="/">Milton home</a>');
    // A plain web sign-in involves no assistant, so web view stays one link away.
    const plain = await (await fixture.send("/login")).text();
    expect(plain).toContain(tryAgain);
    expect(plain).toContain('href="/login"');
    expect(plain).toContain('<a href="/">Milton home</a>');
    // The customer lands, the subscription fails: the customer is kept.
    stripe.down = "POST /v1/subscriptions";
    stripe.calls.length = 0;
    expect((await fixture.send(flow)).status).toBe(503);
    expect(continued()).toEqual([]);
    const { id } = (await account(fixture))!;
    expect(await account(fixture)).toMatchObject({
      customer: "cus_fixture",
      status: null,
    });
    const list = stripeCall(
      "GET /v1/subscriptions?customer=cus_fixture&status=all&limit=10",
    );
    const subscribe = () =>
      stripeCall("POST /v1/subscriptions", {
        idempotency: `milton-subscription-${id}-${minute()}`,
        customer: "cus_fixture",
        "items[0][price]": "price_fixture",
        trial_period_days: "30",
        "payment_settings[save_default_payment_method]": "on_subscription",
        "trial_settings[end_behavior][missing_payment_method]": "cancel",
      });
    expect(stripe.calls).toEqual([
      stripeCall("POST /v1/customers", {
        idempotency: `milton-customer-${id}-${minute()}`,
        "metadata[milton_user_id]": id,
        email: "fixture@example.invalid",
      }),
      list,
      subscribe(),
    ]);
    // Within the minute the key repeats, so a double submit dedupes.
    stripe.calls.length = 0;
    expect((await fixture.send(flow)).status).toBe(503);
    expect(stripe.calls).toEqual([list, subscribe()]);
    // A new minute is a new key, so Stripe's stored error cannot trap the retry.
    const before = subscribe();
    time += 60000;
    stripe.down = false;
    stripe.calls.length = 0;
    const done = await fixture.send(flow);
    expect(done.status).toBe(200);
    expect(await done.text()).toContain("http://localhost:9999/callback");
    expect(stripe.calls).toEqual([list, subscribe()]);
    expect(subscribe()).not.toEqual(before);
    expect(continued()).toHaveLength(1);
    expect(await account(fixture)).toMatchObject({
      subscription: "sub_fixture",
      status: "trialing",
      has_end: true,
    });
    // Later sign-ins call nothing.
    stripe.calls.length = 0;
    expect((await fixture.send("/login")).status).toBe(302);
    expect(stripe.calls).toEqual([]);
    // A subscription Stripe has and Milton lost is stored, never re-created.
    await fixture.local.db.query(
      sql`UPDATE trial_accounts SET stripe_subscription_id=NULL,subscription_status=NULL`,
    );
    expect((await fixture.send("/login")).status).toBe(302);
    expect(stripe.calls).toEqual([list]);
    expect((await account(fixture))?.status).toBe("trialing");
    // A returning deleted identity's canceled row never starts a trial.
    await fixture.local.db.query(
      sql`UPDATE trial_accounts SET subscription_status='canceled'`,
    );
    stripe.calls.length = 0;
    expect((await fixture.send("/login")).status).toBe(302);
    expect(stripe.calls).toEqual([]);
  } finally {
    clock.mockRestore();
    logged.mockRestore();
    await fixture.dispose();
  }
}, 30000);

test("consent reached with a live session grants nothing until the account has a subscription", async () => {
  const { stripe, billing } = fakeStripe();
  const fixture = await accountFixture({ billing });
  const { send, state, local } = fixture;
  const consentPath = "/consent?" + signedQuery;
  const decide = (decision: string) =>
    send("/consent", { decision, oauth_query: signedQuery });
  const granted = () =>
    state.calls.filter(({ path }) => path === "/oauth2/consent");
  const logged = spyOn(console, "error").mockImplementation(() => {});
  try {
    await send("/");
    stripe.down = true;
    // No clock row: trials off, no Stripe call, and consent proceeds.
    expect(await (await send(consentPath)).text()).toContain('value="allow"');
    expect(stripe.calls).toEqual([]);
    await local.db.query(sql`UPDATE store_config SET trials_enabled=true`);
    await local.db.query(
      sql`INSERT INTO trial_accounts(user_id,started_at) SELECT id,clock_timestamp() FROM users`,
    );
    // Status NULL with Stripe failing: no page to approve, and a posted approval
    // reaches nobody. Denying grants nothing, so it still goes through.
    const refused = await send(consentPath);
    expect(refused.status).toBe(503);
    const page = await refused.text();
    expect(page).toContain(tryAgain);
    expect(page).toContain('href="/login?flow=');
    expect(page).not.toContain('value="allow"');
    const posted = await decide("allow");
    expect(posted.status).toBe(503);
    expect(await posted.text()).toContain(tryAgain);
    expect(granted()).toEqual([]);
    expect((await decide("deny")).status).toBe(200);
    expect(granted().map(({ body }) => body.accept)).toEqual([false]);
    // Stripe back: the same page starts the trial, then the approval lands.
    stripe.down = false;
    expect(await (await send(consentPath)).text()).toContain('value="allow"');
    expect(
      (
        await local.db.query<{ status: string }>(
          sql`SELECT subscription_status AS status FROM trial_accounts`,
        )
      )[0]!.status,
    ).toBe("trialing");
    stripe.calls.length = 0;
    expect((await decide("allow")).status).toBe(200);
    expect(granted().map(({ body }) => body.accept)).toEqual([false, true]);
    // Status set: no Stripe call on either step.
    expect(await (await send(consentPath)).text()).toContain('value="allow"');
    expect(stripe.calls).toEqual([]);
  } finally {
    logged.mockRestore();
    await fixture.dispose();
  }
}, 30000);

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
    fixture.state.email = undefined;
    stripe.calls.length = 0;
    await leavesFor(await send("/billing/portal", {}), portalUrl);
    expect(stripe.calls).toEqual([portalCall]);
  } finally {
    await fixture.dispose();
  }
}, 30000);

test("the cover sheet offers the way to pay for each status, only with billing configured", async () => {
  const { billing } = fakeStripe();
  const fixture = await accountFixture({ billing });
  const { local, send } = fixture;
  const set = (status: string, renewed = "1 day") =>
    local.db.query(sql`UPDATE trial_accounts SET subscription_status=${status},
      trial_end=clock_timestamp()+interval '11 days 12 hours',
      current_period_start=clock_timestamp()-${renewed}::interval`);
  const form = (action: string, label: string) =>
    new RegExp(
      `<form method="post" action="/billing/${action}"><input type="hidden" name="csrf"[^>]*/?><button[^>]*>${label}</button></form>`,
    );
  try {
    // Early access: nothing, even with billing on.
    expect(await (await send("/")).text()).not.toContain("Milton subscription");
    await local.db.query(sql`UPDATE store_config SET trials_enabled=true`);
    await local.db.query(
      sql`INSERT INTO trial_accounts(user_id,started_at) SELECT id,created_at FROM users`,
    );
    await set("trialing");
    const trial = await (await send("/")).text();
    expect(trial).toContain("12 days left in your Milton trial");
    expect(trial).toContain("Unless you&#39;ve already added a card");
    expect(trial).toMatch(form("checkout", "Add a card"));
    await local.db.query(
      sql`UPDATE trial_accounts SET trial_end=clock_timestamp()+interval '2 hours'`,
    );
    expect(await (await send("/")).text()).toContain(
      "1 day left in your Milton trial",
    );
    for (const status of ["canceled", "unpaid"]) {
      await set(status);
      const paused = await (await send("/")).text();
      expect(paused).toContain("paused until you subscribe for $5.01/month");
      expect(paused).toMatch(form("checkout", "Subscribe"));
      expect(paused).not.toContain("trial has ended");
    }
    // Past grace reads as expired, inside it as paid.
    await set("past_due", "4 days");
    expect(await (await send("/")).text()).toMatch(
      form("checkout", "Subscribe"),
    );
    for (const status of ["active", "past_due"]) {
      await set(status);
      const paid = await (await send("/")).text();
      expect(paid).toMatch(form("portal", "Manage billing"));
      expect(paid).not.toContain("$5.01");
      expect(paid).not.toContain("/billing/checkout");
    }
  } finally {
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
      sql`INSERT INTO trial_accounts(user_id,started_at,subscription_status,trial_end) SELECT id,created_at,'trialing',clock_timestamp()+interval '6 days' FROM users`,
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
      sql`UPDATE trial_accounts SET subscription_status='canceled'`,
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
    const bindings = { storeDatabase: fixture.db, appOrigin };
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
    ["Date", "2026-11-02 UTC"],
    ["Reports", "None"],
    ["Rules", "2"],
    ["Samples", "0"],
    ["Memo updates today", "2 of 100"],
  ])
    expect(html).toContain(`<dt>${label}:</dt><dd class="fill">${value}</dd>`);
  // Pending and reset sit on the line above the sheet; used is only in the form.
  expect(html).toContain(
    "To change your cover sheet, tell a connected assistant what to change. Memo updates reset at 00:00 UTC. 1 pending.</p>",
  );
  expect(html).toContain(
    '<p class="line typed comment">Red stapler located. Returned to owner.</p>',
  );
  balanceUnavailable = true;
  const withoutBalance = await render(async () => exact);
  expect(withoutBalance.status).toBe(200);
  const unmetered = await withoutBalance.text();
  expect(unmetered).not.toContain("Memo updates today");
  expect(unmetered).toContain("tell a connected assistant what to change.</p>");
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
  expect(
    html.indexOf('<h1 aria-label="T.P.S. Report, cover sheet">'),
  ).toBeLessThan(html.indexOf('<ol class="ruled">'));
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
          emptyReport("chat", "Chat"),
        ],
      })) as never,
    },
    () => "",
  );
  const titledPage = await titled.text();
  expect(titledPage).toContain(
    '<section class="form-section"><h2>Email</h2><p class="applies">Applies when fictional.</p><p class="sub-label">Approved samples:</p><details class="form-sample"><summary><span class="box" aria-hidden="true">☑</span><span class="typed">After a call</span><span class="date">2026-11-02</span></summary><pre class="memo-text"><span>Hi &lt;there&gt;,\n\nThanks.</span></pre></details><p class="sub-label">Rules:</p><ol class="ruled"><li class="line"><span class="typed">One.</span></li><li class="line"><span class="typed">Two\nlines.</span></li></ol></section>',
  ); // A report without rules says how to ask for its setup.
  expect(titledPage).toContain(
    '<h2>Not set up yet</h2><p class="applies">Tell any connected assistant: set up my chat report.</p></section>',
  );
  expect(titledPage).not.toContain("set up my email report");
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

test("an unexpected error on a page logs one line with its class and code, never its message", async () => {
  const secret = "token=fixture-secret https://private.example/path";
  const failing = fakeNeon(() => {
    throw Object.assign(new RangeError(secret), { code: "E_FIXTURE" });
  });
  const logged = spyOn(console, "error").mockImplementation(() => {});
  try {
    const response = await browser(appFor({}))("/login?" + signedQuery);
    expect(response.status).toBe(503);
    expect(logged).toHaveBeenCalledTimes(1);
    const line = String(logged.mock.calls[0]![0]);
    expect(JSON.parse(line)).toEqual({
      event: "unexpected_error",
      where: "page",
      class: "RangeError",
      code: "E_FIXTURE",
    });
    expect(line).not.toContain("fixture-secret");
    expect(line).not.toContain("private.example");
  } finally {
    logged.mockRestore();
    failing.mockRestore();
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
    databaseFailure({ code: "P0001", message: "sample_is_append_only" });
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
