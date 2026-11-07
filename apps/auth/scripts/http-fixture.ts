import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer as tcpServer } from "node:net";
import { createServer, request } from "node:https";
import { spawnSync } from "node:child_process";
import { serve } from "@hono/node-server";
import type { AuthService } from "../src/provider.ts";
import { AUTH_ORIGIN } from "../src/config.ts";
import { SECURITY_HEADERS } from "../src/http.ts";
export async function httpFixture(auth: AuthService) {
  const port = 19911;
  await new Promise<void>((resolve, reject) => {
    const s = tcpServer();
    s.once("error", () => reject(new Error("owned_http_port_in_use")));
    s.listen(port, "127.0.0.1", () => s.close(() => resolve()));
  });
  const directory = mkdtempSync(join(tmpdir(), "milton-auth-local-tls-"));
  const key = join(directory, "key.pem"),
    certificate = join(directory, "cert.pem");
  let server: ReturnType<typeof serve> | undefined;
  try {
    const cert = spawnSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-sha256",
        "-nodes",
        "-keyout",
        key,
        "-out",
        certificate,
        "-days",
        "1",
        "-subj",
        "/CN=auth.meetmilton.com",
        "-addext",
        "subjectAltName=DNS:auth.meetmilton.com",
      ],
      { stdio: "ignore" },
    );
    if (cert.status !== 0) throw new Error("local_tls_fixture_failed");
    const { createApp }: typeof import("../src/app.tsx") = await import(
      new URL("../dist/app.js", import.meta.url).href
    );
    const assets = new URL("../dist/public/", import.meta.url).pathname;
    const app = createApp(auth, assets);
    server = serve({
      fetch: app.fetch,
      hostname: "127.0.0.1",
      port,
      createServer,
      serverOptions: {
        key: readFileSync(key),
        cert: readFileSync(certificate),
      },
    });
    await new Promise<void>((resolve, reject) => {
      server!.once("listening", resolve);
      server!.once("error", reject);
    });
    async function call(
      path: string,
      body?: Record<string, string>,
      headers: Record<string, string> = {},
    ) {
      return new Promise<{
        status: number;
        body: string;
        cookies: string[];
        headers: import("node:http").IncomingHttpHeaders;
      }>((resolve, reject) => {
        const r = request(
          {
            hostname: "127.0.0.1",
            port,
            servername: "auth.meetmilton.com",
            ca: readFileSync(certificate),
            path,
            method: body ? "POST" : "GET",
            headers: {
              host: "auth.meetmilton.com",
              ...(body
                ? {
                    origin: AUTH_ORIGIN,
                    "content-type": "application/x-www-form-urlencoded",
                  }
                : {}),
              ...headers,
            },
          },
          (res) => {
            let data = "";
            res.setEncoding("utf8");
            res.on("data", (part) => {
              data += part;
              if (data.length > 131072)
                r.destroy(new Error("local_http_response_limit"));
            });
            res.on("end", () =>
              resolve({
                status: res.statusCode ?? 0,
                body: data,
                cookies: res.headers["set-cookie"] ?? [],
                headers: res.headers,
              }),
            );
          },
        );
        r.once("error", reject);
        r.setTimeout(5000, () => r.destroy(new Error("local_http_timeout")));
        r.end(
          body
            ? headers["content-type"] === "application/json"
              ? JSON.stringify(body)
              : new URLSearchParams(body).toString()
            : undefined,
        );
      });
    }
    assert.equal((await call("/health")).status, 200);
    assert.equal(
      (await call("/health", undefined, { host: "app.meetmilton.com" })).status,
      421,
    );
    // F-3: form documents must retain same-origin POST Origin without exposing
    // URL paths/proofs in Referer. This checks policy, not browser serialization.
    {
      for (const path of [
        "/login",
        "/signup",
        "/verify",
        "/forgot-password",
        "/reset-password",
        "/consent?client_id=%3Cscript%3E&scope=milton%3Aread",
      ]) {
        const r = await call(path);
        assert.equal(r.status, 200);
        assert(r.body.includes("/auth.css"));
        assert(!r.body.includes("<script>"));
        assert.equal(r.headers["referrer-policy"], "strict-origin", path);
        assert(
          r.body.includes('<meta name="referrer" content="strict-origin"'),
          `${path} document referrer policy`,
        );
      }
      for (const origin of [undefined, "null", "https://app.meetmilton.com"])
        for (const path of ["/form/social", "/api/auth/sign-in/social"]) {
          const response = await app.request(AUTH_ORIGIN + path, {
            method: "POST",
            headers: origin === undefined ? {} : { origin },
            body: new URLSearchParams({ provider: "google" }),
          });
          assert.equal(response.status, 403, `${path} Origin ${origin}`);
          assert.deepEqual(await response.json(), {
            error: "same_origin_required",
          });
        }
    }
    assert.equal((await call("/auth.css")).status, 200);
    assert.equal((await call("/fonts/geist-latin-variable.woff2")).status, 200);
    {
      // Versioned assets cache for a year and arrive compressed over HTTP.
      const login = (await call("/login")).body;
      const css = /href="(\/auth\.css\?v=[\w-]{16})"/.exec(login)?.[1];
      assert(css, "versioned stylesheet link");
      // The page preloads only the Latin JetBrains Mono; the built stylesheet
      // gives it and the master their split unicode-ranges.
      const latin =
        /<link rel="preload" href="(\/fonts\/jetbrains-mono-latin\.woff2\?v=[\w-]{16})"/.exec(
          login,
        )?.[1];
      assert(latin, "Latin JetBrains Mono preload");
      assert(!login.includes("jetbrains-mono-regular"), "master not preloaded");
      const sheet = (await call(css)).body;
      assert.match(
        sheet,
        new RegExp(
          `url\\("${latin.replace(/[?.]/g, "\\$&")}"\\)[^}]*unicode-range:\\s*U\\+0000-036F,`,
        ),
      );
      assert.match(
        sheet,
        /url\("\/fonts\/jetbrains-mono-regular\.woff2\?v=[\w-]{16}"\)[^}]*unicode-range:\s*U\+0300-1DFF,/,
      );
      const r = await call(css, undefined, { "accept-encoding": "br, gzip" });
      assert.equal(r.status, 200);
      assert.equal(
        r.headers["cache-control"],
        "public, max-age=31536000, immutable",
      );
      assert.equal(r.headers["content-encoding"], "br");
      assert.equal(r.headers.vary, "Accept-Encoding");
    }
    assert.equal(
      (
        await call(
          "/form/signin",
          {
            email: "social-only@example.invalid",
            password: "First fictional social password 321",
          },
          { origin: "https://app.meetmilton.com" },
        )
      ).status,
      403,
    );
    const loginPage = await call("/login?notice=done");
    const query =
      /name="oauth_query" value="([^"]*)"/.exec(loginPage.body)?.[1] ?? "";
    const signin = await call("/form/signin", {
      email: "social-only@example.invalid",
      password: "First fictional social password 321",
      oauth_query: query,
    });
    assert.equal(signin.status, 200);
    assert(
      signin.body.includes(
        'http-equiv="refresh" content="0;url=https://auth.meetmilton.com/security"',
      ),
    );
    assert(
      signin.body.includes(
        '<a href="https://auth.meetmilton.com/security">Continue</a>',
      ),
    );
    assert(
      signin.cookies.some(
        (c) => /HttpOnly/i.test(c) && /Secure/i.test(c) && !/Domain=/i.test(c),
      ),
    );
    const cookie = signin.cookies.map((c) => c.split(";")[0]).join("; ");
    const security = await call("/security", undefined, { cookie });
    assert.equal(security.status, 200);
    assert(security.body.includes("Browser sessions"));
    assert(security.body.includes("Account security"));
    // F-2: actual native logout expires multiple cookies; every finalized response
    // kind must receive the same headers without changing native body/status.
    const signout = await call(
      "/api/auth/sign-out",
      {},
      {
        cookie,
        "content-type": "application/json",
      },
    );
    assert.equal(signout.status, 200);
    assert.deepEqual(JSON.parse(signout.body), { success: true });
    for (const name of ["session_token", "session_data", "dont_remember"])
      assert(
        signout.cookies.some(
          (c) =>
            c.startsWith(`__Secure-better-auth.${name}=`) &&
            /Max-Age=0/i.test(c),
        ),
        `native ${name} clearing cookie retained`,
      );
    const invalidReset = await call(
      "/api/auth/reset-password/fictional-missing-proof?callbackURL=" +
        encodeURIComponent(AUTH_ORIGIN + "/reset-password"),
    );
    assert.equal(invalidReset.status, 302);
    assert.equal(
      invalidReset.headers.location,
      AUTH_ORIGIN + "/reset-password?error=INVALID_TOKEN",
    );
    assert.equal(invalidReset.body, "");
    for (const r of [
      signout,
      invalidReset,
      await call("/api/auth/ok"),
      await call("/health", undefined, { host: "app.meetmilton.com" }),
    ])
      for (const [name, value] of Object.entries(SECURITY_HEADERS))
        assert.equal(r.headers[name], value, `final response ${name}`);
    // An unversioned asset URL revalidates; its other security headers stay.
    const legacy = await call("/auth.css");
    for (const [name, value] of Object.entries(SECURITY_HEADERS))
      assert.equal(
        legacy.headers[name],
        name === "cache-control" ? "no-cache" : value,
        `legacy asset ${name}`,
      );
    // Clients behind the load balancer get their own network bucket (the same
    // address keys milton_guard.take_rate); a leading entry cannot pick one.
    for (const forwarded of [
      "203.0.113.7, 34.149.0.10",
      "198.51.100.9, 203.0.113.66, 34.149.0.10",
    ])
      assert.equal(
        (
          await call("/api/auth/ok", undefined, {
            "x-forwarded-for": forwarded,
          })
        ).status,
        200,
      );
    assert.deepEqual(
      (
        await auth.pool.query<{ key: string }>(
          `select key from milton_auth."rateLimit" where key like '%|/ok' order by key`,
        )
      ).rows.map((r) => r.key),
      ["127.0.0.1|/ok", "203.0.113.66|/ok", "203.0.113.7|/ok"],
    );
    // F-1: exercise the compiled form/document boundary, including native logout.
    // Controlled destinations are separate from actual native confirmation below.
    // Browser navigation remains a separate gate.
    {
      const cookies = [
        "fictional_state=one; Path=/; HttpOnly; Secure; SameSite=Lax",
        "fictional_session=two; Path=/; HttpOnly; Secure; SameSite=Lax",
      ];
      const nativeConfirmation = "/api/auth/oauth2/end-session/confirm";
      for (const [action, target, escaped, redirect] of [
        [
          "social",
          'https://provider.example.invalid/authorize?state=exact%2Bstate&label="<next>"',
          "https://provider.example.invalid/authorize?state=exact%2Bstate&amp;label=%22%3Cnext%3E%22",
          false,
        ],
        [
          "signin",
          "https://auth.meetmilton.com/api/auth/oauth2/authorize?client_id=fictional&state=exact%2Bstate&sig=fictional",
          "https://auth.meetmilton.com/api/auth/oauth2/authorize?client_id=fictional&amp;state=exact%2Bstate&amp;sig=fictional",
          false,
        ],
        [
          "link",
          "https://provider.example.invalid/authorize?state=link",
          "https://provider.example.invalid/authorize?state=link",
          true,
        ],
        [
          "consent",
          "fictional-assistant://callback?code=exact%2Bcode&state=exact%2Fstate",
          "fictional-assistant://callback?code=exact%2Bcode&amp;state=exact%2Fstate",
          false,
        ],
        [
          "consent",
          "http://127.0.0.1:19935/callback?error=access_denied&state=exact%2Bstate",
          "http://127.0.0.1:19935/callback?error=access_denied&amp;state=exact%2Bstate",
          true,
        ],
        [
          "confirmation",
          "https://app.meetmilton.com/auth/logged-out?logout=fictional&state=exact%2Bstate",
          "https://app.meetmilton.com/auth/logged-out?logout=fictional&amp;state=exact%2Bstate",
          true,
        ],
      ] as const) {
        const app = createApp(
          {
            handler: async (request: Request) => {
              assert.equal(
                new URL(request.url).pathname,
                "/api/auth" +
                  (
                    {
                      social: "/sign-in/social",
                      signin: "/sign-in/email",
                      link: "/link-social",
                      consent: "/oauth2/consent",
                      confirmation: "/oauth2/end-session/confirm",
                    } as const
                  )[action],
              );
              const headers = new Headers();
              for (const cookie of cookies)
                headers.append("set-cookie", cookie);
              if (redirect) {
                headers.set("location", target);
                return new Response("fictional native redirect body", {
                  status: 302,
                  headers,
                });
              }
              return Response.json(
                { redirect: true, url: target },
                { headers },
              );
            },
          } as unknown as AuthService,
          assets,
        );
        const path =
          action === "confirmation" ? nativeConfirmation : "/form/" + action;
        const navigations: Record<string, string>[] =
          action === "confirmation"
            ? [{ "sec-fetch-mode": "navigate" }, { accept: "text/html" }]
            : [{}];
        for (const navigation of navigations) {
          const response = await app.request(AUTH_ORIGIN + path, {
            method: "POST",
            headers: { origin: AUTH_ORIGIN, ...navigation },
            body: new URLSearchParams({
              oauth_query: "sig=fictional",
              accept: "false",
            }),
          });
          assert.equal(response.status, 200, `${path} browser form navigation`);
          assert.equal(response.headers.get("location"), null);
          assert.deepEqual(response.headers.getSetCookie(), cookies);
          assert(
            response.headers
              .get("content-security-policy")
              ?.includes("form-action 'self'"),
          );
          const document = await response.text();
          assert(
            document.includes(
              `<meta http-equiv="refresh" content="0;url=${escaped}"`,
            ),
          );
          assert(document.includes(`<a href="${escaped}">Continue</a>`));
          assert(document.includes('href="/auth.css?v='));
          assert(!document.includes("<next>"));

          assert.equal(
            response.headers.get("referrer-policy"),
            "strict-origin",
          );
          assert(
            document.includes('<meta name="referrer" content="strict-origin"'),
          );
        }
        if (action === "confirmation") {
          const machines: Record<string, string>[] = [
            {},
            { accept: "application/json" },
            { "sec-fetch-mode": "cors", accept: "text/html" },
            { "sec-fetch-mode": "navigate", accept: "application/json" },
            {
              "content-type": "application/json",
              "sec-fetch-mode": "navigate",
              accept: "text/html",
            },
          ];
          for (const headers of machines) {
            const response = await app.request(AUTH_ORIGIN + path, {
              method: "POST",
              headers: { origin: AUTH_ORIGIN, ...headers },
              body:
                headers["content-type"] === "application/json"
                  ? JSON.stringify({ action: "confirm" })
                  : new URLSearchParams({ action: "confirm" }),
            });
            assert.equal(response.status, 302);
            assert.equal(response.headers.get("location"), target);
            assert.deepEqual(response.headers.getSetCookie(), cookies);
            assert.equal(
              await response.text(),
              "fictional native redirect body",
            );
          }
        }
      }
      for (const target of [
        "javascript:alert(1)",
        "data:text/html,unsafe",
        "vbscript:unsafe",
        "file:///unsafe",
        "blob:https://example.invalid/unsafe",
        "https://user:password@example.invalid/callback",
        "https://example.invalid/callback\nunsafe",
        "http://example.invalid/callback",
      ]) {
        const app = createApp(
          {
            handler: async () => Response.json({ url: target }),
          } as unknown as AuthService,
          assets,
        );
        const response = await app.request(
          "https://auth.meetmilton.com/form/consent",
          {
            method: "POST",
            headers: { origin: "https://auth.meetmilton.com" },
            body: "accept=true",
          },
        );
        assert.equal(response.status, 503);
        assert(!(await response.text()).includes('http-equiv="refresh"'));
      }
      // Real native signed confirmation and session retirement, through the
      // compiled app and TLS listener; no controlled native authority here.
      const login = await call("/form/signin", {
        email: "social-only@example.invalid",
        password: "First fictional social password 321",
      });
      assert.equal(login.status, 200);
      const sessionCookie = login.cookies
        .map((c) => c.split(";")[0])
        .join("; ");
      const browser = { cookie: sessionCookie, accept: "text/html" };
      assert.equal(
        (await call(nativeConfirmation, { action: "confirm" }, browser)).status,
        400,
      );
      const fixed = await auth.pool.query<{ clientId: string }>(
        'select "clientId" from milton_auth."oauthClient" where "enableEndSession"=true and "skipConsent"=true and "userId" is null',
      );
      assert.equal(fixed.rows.length, 1);
      const returnTo = "https://app.meetmilton.com/auth/logged-out";
      const confirmation = await call(
        "/api/auth/oauth2/end-session?" +
          new URLSearchParams({
            client_id: fixed.rows[0]!.clientId,
            post_logout_redirect_uri: returnTo,
          }),
        undefined,
        browser,
      );
      assert.equal(confirmation.status, 200);
      assert(confirmation.body.includes("data-oidc-logout-confirmation"));
      assert(
        confirmation.headers["content-security-policy"]?.includes(
          "form-action 'self'",
        ),
      );
      const completed = await call(
        nativeConfirmation,
        { action: "confirm" },
        {
          ...browser,
          cookie: [
            sessionCookie,
            ...confirmation.cookies.map((c) => c.split(";")[0]),
          ].join("; "),
        },
      );
      assert.equal(completed.status, 200);
      assert.equal(completed.headers.location, undefined);
      assert(
        completed.body.includes(
          `http-equiv="refresh" content="0;url=${returnTo}"`,
        ),
      );
      assert(completed.body.includes(`<a href="${returnTo}">Continue</a>`));
      for (const name of [
        "session_token",
        "session_data",
        "dont_remember",
        "session_token.oauth_logout_confirmation",
      ])
        assert(
          completed.cookies.some(
            (c) =>
              c.startsWith(`__Secure-better-auth.${name}=`) &&
              /Max-Age=0/i.test(c),
          ),
        );
      assert.equal(
        JSON.parse(
          (await call("/api/auth/get-session", undefined, browser)).body,
        ),
        null,
      );
      // A browser replay after applying native's clearing cookies has no proof.
      assert.equal(
        (
          await call(
            nativeConfirmation,
            { action: "confirm" },
            { accept: "text/html" },
          )
        ).status,
        400,
      );
    }
  } finally {
    if (server)
      await new Promise<void>((resolve, reject) =>
        server!.close((e) => (e ? reject(e) : resolve())),
      );
    rmSync(directory, { recursive: true });
  }
}
