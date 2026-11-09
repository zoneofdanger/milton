import { describe, expect, spyOn, test } from "bun:test";
import { validPassword } from "../src/password.ts";
import { readConfig } from "../src/config.ts";
import { fixtureConfig } from "./fixture-config.ts";
describe("auth product boundaries", () => {
  test("native NFKC policy has predictable Unicode bounds without trimming", () => {
    expect(validPassword(" password with spaces ")).toBe(true);
    expect(validPassword("a".repeat(14))).toBe(false);
    expect(validPassword("a".repeat(129))).toBe(false);
    expect(validPassword("𝔄".repeat(128))).toBe(false);
    expect(validPassword("🔒🌲".repeat(64))).toBe(true);
    expect(validPassword("ｐａｓｓｗｏｒｄ123456789")).toBe(false);
    expect(validPassword("㍿".repeat(40))).toBe(false);
  });
  test("missing production capabilities fail startup without secret output", () => {
    expect(() => readConfig({})).toThrow("invalid_auth_configuration");
  });
  test("admission goes only to a run.app origin in production, or loopback elsewhere", () => {
    const env = Object.fromEntries(
      Object.entries(fixtureConfig()).map(([k, v]) => [k, String(v)]),
    );
    const run = "https://milton-admit-419545871671.us-east4.run.app";
    const at = (url: string, NODE_ENV = "production") =>
      readConfig({ ...env, AUTH_ADMISSION_URL: url, NODE_ENV })
        .AUTH_ADMISSION_URL;
    expect(at(run)).toBe(run);
    expect(at("http://127.0.0.1:19912", "test")).toBe("http://127.0.0.1:19912");
    for (const url of [
      "http://127.0.0.1:19912",
      "https://app.meetmilton.com",
      run + "/",
      run + "/internal/auth/admit",
      "http://milton-admit-419545871671.us-east4.run.app",
      "https://milton-admit.us-east4.run.app:8443",
      "https://run.app.example",
      "https://user@milton-admit.us-east4.run.app",
    ])
      expect(() => at(url)).toThrow("invalid_auth_configuration");
  });
  test("admission sends a cached Google ID token on run.app, none on loopback, and fails closed without one", async () => {
    const { admissionClient } = await import("../src/admission.ts");
    const run = "https://milton-admit-419545871671.us-east4.run.app";
    const jwt = (exp: number) =>
      [{ alg: "RS256" }, { aud: run, exp }, "signature"]
        .map((p) =>
          Buffer.from(typeof p === "string" ? p : JSON.stringify(p)).toString(
            "base64url",
          ),
        )
        .join(".");
    let clock = 1_000_000_000_000;
    let identity: () => Response = () => new Response(jwt(clock / 1000 + 3600));
    const calls: { url: string; headers: Headers; body?: string }[] = [];
    const networkFetch = async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      const url = String(input);
      calls.push({
        url,
        headers: new Headers(init?.headers),
        body: init?.body ? String(init.body) : undefined,
      });
      if (url.startsWith("http://metadata.google.internal/")) return identity();
      return new Response(null, { status: 204 });
    };
    const secret = "s".repeat(32);
    const google = admissionClient(
      { AUTH_ADMISSION_URL: run, AUTH_ADMISSION_SECRET: secret },
      networkFetch,
      () => clock,
    );
    expect(await google("/internal/auth/admit", { a: 1 })).toBe(true);
    expect(calls.map((c) => c.url)).toEqual([
      "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity?audience=" +
        encodeURIComponent(run),
      run + "/internal/auth/admit",
    ]);
    expect(calls[0]!.headers.get("metadata-flavor")).toBe("Google");
    expect(calls[1]!.headers.get("authorization")).toBe(`Bearer ${secret}`);
    const token = calls[1]!.headers.get("x-serverless-authorization");
    expect(token).toBe(`Bearer ${jwt(clock / 1000 + 3600)}`);
    expect(calls[1]!.body).toBe('{"a":1}');
    // Cached until five minutes before expiry, then fetched again.
    clock += 54 * 60_000;
    expect(await google("/internal/auth/preserve-eligibility", {})).toBe(true);
    expect(calls).toHaveLength(3);
    expect(calls[2]!.headers.get("x-serverless-authorization")).toBe(token);
    clock += 2 * 60_000;
    expect(await google("/internal/auth/admit", {})).toBe(true);
    expect(calls).toHaveLength(5);
    expect(calls[4]!.headers.get("x-serverless-authorization")).not.toBe(token);
    // No token, no call: a refused or malformed identity answers false.
    clock += 60 * 60_000;
    const logged = spyOn(console, "error").mockImplementation(() => {});
    try {
      for (const refused of [
        () => new Response("nope", { status: 404 }),
        () => new Response("not-a-jwt"),
        () => {
          throw new TypeError("fetch failed");
        },
      ]) {
        identity = refused;
        const before = calls.length;
        expect(await google("/internal/auth/admit", {})).toBe(false);
        expect(calls.slice(before).map((c) => c.url)).toHaveLength(1);
      }
      expect(JSON.stringify(logged.mock.calls)).not.toContain(secret);
    } finally {
      logged.mockRestore();
    }
    calls.length = 0;
    const loopback = admissionClient(
      {
        AUTH_ADMISSION_URL: "http://127.0.0.1:19912",
        AUTH_ADMISSION_SECRET: secret,
      },
      networkFetch,
    );
    expect(await loopback("/internal/auth/admit", {})).toBe(true);
    expect(calls.map((c) => c.url)).toEqual([
      "http://127.0.0.1:19912/internal/auth/admit",
    ]);
    expect(calls[0]!.headers.has("x-serverless-authorization")).toBe(false);
    // A 410 says the account's deletion has begun; any other refusal is false.
    for (const [status, answer] of [
      [410, "deleting"],
      [409, false],
      [503, false],
    ] as const) {
      const refusing = admissionClient(
        {
          AUTH_ADMISSION_URL: "http://127.0.0.1:19912",
          AUTH_ADMISSION_SECRET: secret,
        },
        async () => new Response(null, { status }),
      );
      expect([status, await refusing("/internal/auth/admit", {})]).toEqual([
        status,
        answer,
      ]);
    }
  });
  test("client metadata URLs need an https DNS host without credentials", async () => {
    const { metadataDocumentUrlAllowed: allowed } =
      await import("../src/provider.ts");
    expect(allowed("https://claude.ai/oauth/claude-code-client-metadata")).toBe(
      true,
    );
    expect(allowed("https://platform.muse.ai/oauth/client-metadata.json")).toBe(
      true,
    );
    for (const url of [
      "http://claude.ai/oauth/claude-code-client-metadata",
      "https://user:pass@claude.ai/oauth/claude-code-client-metadata",
      "https://claude.ai/oauth/claude-code-client-metadata#x",
      "https://8.8.8.8/oauth/client-metadata.json",
      "https://[2606:4700::1]/oauth/client-metadata.json",
      "https://localhost/oauth/client-metadata.json",
      "https://app.localhost./oauth/client-metadata.json",
      "not a url",
    ])
      expect(allowed(url)).toBe(false);
  });
});

test("canonical auth HTTP boundary rejects alternate host, missing Origin, and deferred mutations", async () => {
  const { guardRequest } = await import("../src/http.ts");
  expect(
    guardRequest(
      new Request("https://app.meetmilton.com/api/auth/sign-up/email", {
        method: "POST",
      }),
    )?.status,
  ).toBe(421);
  expect(
    guardRequest(
      new Request("https://auth.meetmilton.com/api/auth/sign-up/email", {
        method: "POST",
      }),
    )?.status,
  ).toBe(403);
  // Native's server-only and deferred endpoints are refused here, before
  // native sees them (handler calls guardRequest first); native has no second
  // list of disabled paths.
  for (const path of [
    "/token",
    "/delete-user",
    "/delete-user/callback",
    "/change-email",
    "/update-user",
    "/update-session",
    "/set-password",
    "/oauth2/update-consent",
    "/oauth2/delete-consent",
  ])
    for (const suffix of ["", "/"])
      for (const method of ["GET", "POST"]) {
        const refused = guardRequest(
          new Request("https://auth.meetmilton.com/api/auth" + path + suffix, {
            method,
            headers: { origin: "https://auth.meetmilton.com" },
          }),
        );
        expect(refused?.status).toBe(403);
        expect(((await refused!.json()) as { error: string }).error).toBe(
          "method_not_available",
        );
      }
});

test("startup role check retries connection failures only, within its budget", async () => {
  const { retryStartupCheck } = await import("../src/roles.ts");
  let clock = 0;
  const sleeps: number[] = [];
  const logged: unknown[] = [];
  const options = {
    now: () => clock,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      clock += ms;
    },
    log: (fields: unknown) => logged.push(fields),
  };
  const timeout = new Error("Connection terminated due to connection timeout", {
    cause: new Error("Connection terminated unexpectedly"),
  });
  const failures: Error[] = [
    timeout,
    Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }),
    Object.assign(new Error("the database system is starting up"), {
      code: "57P03",
    }),
  ];
  let calls = 0;
  const ok = async () => {
    calls++;
    const failure = failures.shift();
    if (failure) throw failure;
    return "checked";
  };
  expect(await retryStartupCheck(ok, options)).toBe("checked");
  expect(calls).toBe(4);
  expect(sleeps).toEqual([500, 1000, 2000]);
  expect(logged).toEqual([
    { attempt: 1, delayMs: 500, class: "Error", code: "UNCLASSIFIED" },
    { attempt: 2, delayMs: 1000, class: "Error", code: "ECONNRESET" },
    { attempt: 3, delayMs: 2000, class: "Error", code: "57P03" },
  ]);

  for (const refusal of [
    new Error("unsafe_runtime_role"),
    Object.assign(new Error("permission denied"), { code: "42501" }),
  ]) {
    calls = 0;
    sleeps.length = 0;
    const refuse = async () => {
      calls++;
      throw refusal;
    };
    await expect(retryStartupCheck(refuse, options)).rejects.toBe(refusal);
    expect(calls).toBe(1);
    expect(sleeps).toEqual([]);
  }

  clock = 0;
  sleeps.length = 0;
  const down = Object.assign(new Error("connect ECONNREFUSED"), {
    code: "ECONNREFUSED",
  });
  await expect(
    retryStartupCheck(async () => {
      throw down;
    }, options),
  ).rejects.toBe(down);
  expect(sleeps).toEqual([500, 1000, 2000, 4000, 4000]);
});

test("rate-limit network is forwardedClient's client, as a valid address", async () => {
  const { loadBalancerClient: client } = await import("../src/http.ts");
  const lb = "34.149.0.10";
  expect(client(`203.0.113.7, ${lb}`)).toBe("203.0.113.7");
  // IPv6 clients share a /64, as Better Auth's own limiter groups them.
  expect(client(`2001:db8:1:2::5, ${lb}`)).toBe("2001:db8:1:2::");
  // No well-formed pair: the caller keeps the socket peer.
  expect(client(null)).toBeUndefined();
});

// A versioned copy of the theme assets in a temporary directory, as the build
// writes them; createApp reads it once, so callers remove it after createApp.
async function versionedAssets() {
  const { mkdtempSync, mkdirSync, cpSync, writeFileSync } =
    await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { versionAssets } = await import("@milton/theme/assets");
  const theme = new URL("../../../packages/theme/public/", import.meta.url)
    .pathname;
  const assets = mkdtempSync(join(tmpdir(), "milton-auth-assets-"));
  mkdirSync(join(assets, "fonts"));
  cpSync(join(theme, "fonts"), join(assets, "fonts"), { recursive: true });
  cpSync(join(theme, "favicon.svg"), join(assets, "favicon.svg"));
  writeFileSync(
    join(assets, "auth.css"),
    '@font-face { font-family: "Geist"; src: url("/fonts/geist-latin-variable.woff2") format("woff2"); }\n'.repeat(
      8,
    ),
  );
  versionAssets(assets, [
    "/auth.css",
    "/favicon.svg",
    "/fonts/geist-latin-variable.woff2",
    "/fonts/jetbrains-mono-latin.woff2",
    "/fonts/jetbrains-mono-regular.woff2",
  ]);
  return assets;
}

test("the security page's session lookup takes each client's own network bucket", async () => {
  const { rmSync } = await import("node:fs");
  const { createProvider } = await import("../src/provider.ts");
  const { createApp } = await import("../src/app.tsx");
  // Each network bucket holds one request; every decision is recorded.
  const taken = new Map<unknown, number>();
  const decisions: boolean[] = [];
  const assets = await versionedAssets();
  const pool = {
    on: () => pool,
    query: async (text: string, values: unknown[] = []) => {
      if (!text.includes("milton_guard.take_rate"))
        throw new Error("fixture_database_refused");
      const count = (taken.get(values[0]) ?? 0) + 1;
      taken.set(values[0], count);
      decisions.push(count <= 1);
      return { rows: [{ allowed: [count <= 1] }] };
    },
    connect: async () => {
      throw new Error("fixture_database_refused");
    },
  };
  const app = createApp(
    createProvider(fixtureConfig(), {
      pool: pool as unknown as import("pg").Pool,
    }),
    assets,
  );
  rmSync(assets, { recursive: true, force: true });
  // An admitted lookup then fails on the refused pool and logs; keep it quiet.
  const quiet = spyOn(console, "error").mockImplementation(() => {});
  for (const client of ["203.0.113.7", "203.0.113.7", "198.51.100.9"])
    await app.request("https://auth.meetmilton.com/security", {
      headers: { "x-forwarded-for": `${client}, 34.149.0.10` },
    });
  quiet.mockRestore();
  // Client A's second load is refused; client B's first is still allowed.
  expect(decisions).toEqual([true, false, true]);
});

describe("OAuth profile refusals before database access", () => {
  // A pool that never connects: it records the rate-limit statement that
  // every admitted request makes first, and refuses it (or, with network,
  // admits the network gate and refuses the per-account bucket).
  const fixture = async ({ network = false } = {}) => {
    const { createProvider } = await import("../src/provider.ts");
    const queries: string[] = [];
    const pool = {
      on: () => pool,
      query: async (text: string) => {
        queries.push(text);
        if (!text.includes("milton_guard.take_rate"))
          throw new Error("fixture_database_refused");
        // The statement's verdicts: the gate, then the next bucket.
        return { rows: [{ allowed: network ? [true, false] : [false] }] };
      },
      connect: async () => {
        throw new Error("fixture_database_refused");
      },
    };
    const { handler } = createProvider(fixtureConfig(), {
      pool: pool as unknown as import("pg").Pool,
    });
    const post = (path: string, init: RequestInit = {}) =>
      handler(
        new Request("https://auth.meetmilton.com/api/auth" + path, {
          method: "POST",
          ...init,
        }),
        "127.0.0.1",
      );
    const json = (body: unknown) => ({
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const form = (body: Record<string, string>, headers = {}) => ({
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        ...headers,
      },
      body: new URLSearchParams(body).toString(),
    });
    const refused = async (reply: Promise<Response>) => {
      const r = await reply;
      return [r.status, ((await r.json()) as { error: string }).error];
    };
    return { post, json, form, refused, queries };
  };
  const client = {
    redirect_uris: ["https://client.example/callback"],
    token_endpoint_auth_method: "none",
  };

  test("registration is public only: an authorized registration is refused", async () => {
    const { post, json, refused, queries } = await fixture();
    expect(
      await refused(
        post("/oauth2/register", {
          ...json(client),
          headers: {
            "content-type": "application/json",
            authorization: "Bearer fictional-initial-access-token",
          },
        }),
      ),
    ).toEqual([403, "public_registration_only"]);
    expect(queries).toEqual([]);
  });

  test("DPoP, client assertions, request objects and JWT client auth are refused", async () => {
    const { post, json, form, refused, queries } = await fixture();
    for (const reply of [
      post(
        "/oauth2/token",
        form({ grant_type: "refresh_token" }, { dpop: "fictional.dpop.proof" }),
      ),
      post(
        "/oauth2/token",
        form({ grant_type: "authorization_code", client_assertion: "x.y.z" }),
      ),
      post("/oauth2/token?request_uri=urn%3Aexample", form({})),
      post(
        "/oauth2/register",
        json({ ...client, token_endpoint_auth_method: "private_key_jwt" }),
      ),
    ])
      expect(await refused(reply)).toEqual([400, "unsupported_oauth_profile"]);
    expect(queries).toEqual([]);
  });

  test("registration cannot claim consent skips, logout channels or key material", async () => {
    const { post, json, refused, queries } = await fixture();
    for (const extra of [
      { skip_consent: true },
      { backchannel_logout_uri: "https://client.example/logout" },
      { jwks_uri: "https://client.example/jwks" },
      { post_logout_redirect_uris: ["https://client.example/"] },
    ])
      expect(
        await refused(post("/oauth2/register", json({ ...client, ...extra }))),
      ).toEqual([400, "client_capability_refused"]);
    expect(queries).toEqual([]);
  });

  test("only the app client may introspect, by form post without header or query credentials", async () => {
    const { post, form, refused, queries } = await fixture();
    const app = { client_id: "fixed-app-fixture", token: "fictional" };
    for (const reply of [
      post("/oauth2/introspect", form({ ...app, client_id: "other-client" })),
      post(
        "/oauth2/introspect",
        form(app, { authorization: "Basic ZmljdGlvbmFsOng=" }),
      ),
      post("/oauth2/introspect", {
        headers: { "content-type": "application/json" },
        body: JSON.stringify(app),
      }),
      post("/oauth2/introspect?client_id=fixed-app-fixture", form(app)),
    ])
      expect(await refused(reply)).toEqual([
        403,
        "introspection_caller_refused",
      ]);
    expect(queries).toEqual([]);
    // The app client's own form post passes these checks to the rate limit.
    expect(await refused(post("/oauth2/introspect", form(app)))).toEqual([
      429,
      "rate_limited",
    ]);
    expect(queries).toHaveLength(1);
  });

  test("body guards parse each media type as native does and refuse other types", async () => {
    const { post, refused, queries } = await fixture({ network: true });
    const as = (type: string, body: unknown) => ({
      headers: { origin: "https://auth.meetmilton.com", "content-type": type },
      body: JSON.stringify(body),
    });
    const signIn = {
      email: "fictional@example.com",
      password: "fictional password",
    };
    const keyed = { ...client, jwks_uri: "https://client.example/jwks" };
    // Native lowercases the type, so this is JSON to both: the per-email limit
    // and the registration refusals still apply.
    expect(
      await refused(post("/sign-in/email", as("Application/JSON", signIn))),
    ).toEqual([429, "rate_limited"]);
    expect(
      await refused(
        post("/oauth2/register", as("Application/JSON; Charset=UTF-8", keyed)),
      ),
    ).toEqual([400, "client_capability_refused"]);
    const admitted = queries.length;
    for (const reply of [
      post("/sign-in/email", as("application/merge-patch+json", signIn)),
      post("/oauth2/register", as("application/vnd.api+json", keyed)),
      post("/sign-in/email", as("text/plain", signIn)),
      post("/sign-out", { headers: { origin: "https://auth.meetmilton.com" } }),
    ])
      expect(await refused(reply)).toEqual([415, "unsupported_media_type"]);
    expect(queries).toHaveLength(admitted);
  });

  test("on Node, native parses exactly the body the wrapper inspected", () => {
    // Node's formData() reads the last type in a combined header, Bun's the
    // first, so this runs on Node. A probe stands in for native and records
    // what native's own parsers (formData, and the OAuth provider's re-read
    // with clone().text()) recover from the forwarded request.
    const form = "application/x-www-form-urlencoded";
    const cases = [
      // A combined header: multipart to native's formData(), not to the wrapper.
      [
        "/oauth2/token",
        form + "; charset=UTF-8, multipart/form-data; boundary=abc",
        '--abc\r\nContent-Disposition: form-data; name="client_assertion"\r\n\r\nx.y.z\r\n--abc--\r\n',
      ],
      // Two BOMs: each decode strips one, so a re-decoded copy would find
      // the field name the wrapper saw with a BOM in front.
      [
        "/oauth2/token",
        form,
        "\uFEFF\uFEFFclient_assertion=x.y.z&grant_type=authorization_code",
      ],
      // Legitimate bodies keep order, empty values and Unicode.
      ["/oauth2/token", form, "b=1&a=&c=%C3%A9+%F0%9F%94%92&d=x%26y"],
      // Re-encoding grows this 6,032-byte body past the 16 KiB limit.
      [
        "/oauth2/token",
        form,
        "grant_type=authorization_code&x=" + "!".repeat(6000),
      ],
      [
        "/oauth2/register",
        "application/json",
        '{"redirect_uris":["https://client.example/callback"],"client_name":"Fictional \u00e9 \ud83d\udd12","token_endpoint_auth_method":"none","logo_uri":""}',
      ],
    ];
    const script = `
      const { createProvider } = await import(${JSON.stringify(import.meta.resolve("../src/provider.ts"))});
      const { fixtureConfig } = await import(${JSON.stringify(import.meta.resolve("./fixture-config.ts"))});
      let queries = 0;
      const pool = { on: () => pool, connect: async () => { throw new Error("refused"); },
        query: async (t) => (queries++, { rows: [{ allowed: [t.includes("take_rate")] }] }) };
      const service = createProvider(fixtureConfig(), { pool });
      let seen;
      service.provider.handler = async (r) => {
        const text = await r.clone().text();
        seen = r.headers.get("content-type") === "application/json"
          ? { json: Object.entries(JSON.parse(text)) }
          : { form: [...(await r.formData())], reread: [...new URLSearchParams(text)] };
        seen.stale = ["content-length", "content-encoding", "transfer-encoding", "content-md5", "digest", "content-digest"].filter((h) => r.headers.has(h));
        return new Response(null, { status: 204 });
      };
      const out = [];
      for (const [path, type, body] of ${JSON.stringify(cases)}) {
        seen = null;
        queries = 0;
        const r = await service.handler(new Request("https://auth.meetmilton.com/api/auth" + path,
          { method: "POST", headers: { "content-type": type, "content-length": String(Buffer.byteLength(body)),
            "content-encoding": "identity", "content-md5": "fictional", digest: "sha-256=fictional", "content-digest": "sha-256=:fictional:" }, body }), "127.0.0.1");
        out.push({ status: r.status, error: r.status === 204 ? null : (await r.json()).error, queries, seen });
      }
      console.log(JSON.stringify(out));`;
    const run = Bun.spawnSync(
      [
        "node",
        "--experimental-strip-types",
        "--input-type=module",
        "-e",
        script,
      ],
      { env: { PATH: process.env.PATH }, stderr: "pipe" },
    );
    expect(run.exitCode).toBe(0);
    const bom = [
      ["\uFEFFclient_assertion", "x.y.z"],
      ["grant_type", "authorization_code"],
    ];
    const entries = [
      ["b", "1"],
      ["a", ""],
      ["c", "é 🔒"],
      ["d", "x&y"],
    ];
    expect(
      JSON.parse(run.stdout.toString().trim().split("\n").at(-1)!),
    ).toEqual([
      { status: 415, error: "unsupported_media_type", queries: 0, seen: null },
      {
        status: 204,
        error: null,
        queries: 1,
        seen: { form: bom, reread: bom, stale: [] },
      },
      {
        status: 204,
        error: null,
        queries: 1,
        seen: { form: entries, reread: entries, stale: [] },
      },
      { status: 413, error: "request_too_large", queries: 0, seen: null },
      {
        status: 204,
        error: null,
        queries: 1,
        seen: {
          stale: [],
          json: [
            ["redirect_uris", ["https://client.example/callback"]],
            ["client_name", "Fictional é 🔒"],
            ["token_endpoint_auth_method", "none"],
            ["logo_uri", ""],
          ],
        },
      },
    ]);
  });
});

test("static assets cache by content version and keep the other security headers", async () => {
  const { rmSync } = await import("node:fs");
  const { createApp } = await import("../src/app.tsx");
  const { SECURITY_HEADERS } = await import("../src/http.ts");
  const assets = await versionedAssets();
  const app = createApp(
    {
      handler: async () => Response.json({ ok: true }),
    } as unknown as import("../src/provider.ts").AuthService,
    assets,
  );
  rmSync(assets, { recursive: true, force: true });
  const call = (path: string, headers: Record<string, string> = {}) =>
    app.request("https://auth.meetmilton.com" + path, { headers });
  const login = await call("/login");
  const html = await login.text();
  const css = html.match(/href="(\/auth\.css\?v=[\w-]{16})"/)?.[1];
  // Only the Latin JetBrains Mono is preloaded; the master loads on demand.
  expect(html).not.toContain("jetbrains-mono-regular");
  const fonts = ["geist-latin-variable", "jetbrains-mono-latin"].map(
    (font) =>
      html.match(
        new RegExp(
          `<link rel="preload" href="(/fonts/${font}\\.woff2\\?v=[\\w-]{16})" as="font" type="font/woff2" crossorigin="anonymous"`,
        ),
      )?.[1],
  );
  expect(html).toMatch(/href="\/favicon\.svg\?v=[\w-]{16}"/);
  expect(css).toBeDefined();
  expect(await (await call(css!)).text()).toContain(`url("${fonts[0]}")`);
  const immutable = "public, max-age=31536000, immutable";
  const others = Object.entries(SECURITY_HEADERS).filter(
    ([name]) => name !== "cache-control",
  );
  const compressed = await call(css!, { "accept-encoding": "br, gzip" });
  expect(compressed.headers.get("content-encoding")).toBe("br");
  expect(compressed.headers.get("vary")).toBe("Accept-Encoding");
  for (const r of [
    compressed,
    ...(await Promise.all(fonts.map((f) => call(f!)))),
  ]) {
    expect(r.status).toBe(200);
    expect(r.headers.get("cache-control")).toBe(immutable);
    for (const [name, value] of others) expect(r.headers.get(name)).toBe(value);
  }
  // Legacy URLs revalidate; pages, API, health and refusals stay no-store.
  for (const path of ["/auth.css", "/fonts/geist-latin-variable.woff2"]) {
    const r = await call(path);
    expect(r.headers.get("cache-control")).toBe("no-cache");
    for (const [name, value] of others) expect(r.headers.get(name)).toBe(value);
  }
  const ok = await call("/api/auth/ok");
  expect(await ok.json()).toEqual({ ok: true });
  for (const r of [
    login,
    ok,
    await call("/health"),
    await call("/missing"),
    await call("/fonts/missing.woff2"),
    await app.request("https://auth.meetmilton.com/auth.css", {
      method: "POST",
      headers: { origin: "https://evil.example" },
    }),
  ])
    for (const [name, value] of Object.entries(SECURITY_HEADERS))
      expect(r.headers.get(name)).toBe(value);
});

describe("auth mail queueing", () => {
  type State = import("../src/adapter.ts").RequestState;
  // A pool that records each statement; take_rate admits the first three.
  const queue = () => {
    const calls: { text: string; values: unknown[] }[] = [];
    let hits = 0;
    const pool = {
      query: async (text: string, values: unknown[] = []) => {
        calls.push({ text, values });
        return text.includes("take_rate")
          ? { rows: [{ allowed: ++hits <= 3 }] }
          : { rows: [] };
      },
    } as unknown as import("pg").Pool;
    // Per accept_mail call: whether it queued a message (a payload).
    const queued = () =>
      calls
        .filter((c) => c.text.includes("accept_mail"))
        .map((c) => c.values[6] !== null);
    return { pool, calls, queued };
  };
  const state = (to?: string, kind: "verify" | "reset" = "reset"): State => ({
    path: "/request-password-reset",
    cleanupPath: false,
    revokePath: false,
    users: new Map(),
    credentials: new Map(),
    admissions: new Map(),
    ...(to
      ? {
          mail: {
            kind,
            to,
            url: "https://auth.meetmilton.com/api/auth/reset-password/fictional",
            user: "fictional-user",
            incarnation: "fictional-incarnation",
            generation: "fictional-generation",
            proofExpiresAt: new Date(Date.now() + 3600000).toISOString(),
          },
        }
      : {}),
  });

  test("mail domain lookup: MX, null MX, A/AAAA fallback, and fail open", async () => {
    const { mailDomain } = await import("../src/mail-domain.ts");
    type Resolver = import("../src/mail-domain.ts").MailResolver;
    // A string answer is the resolver error code it throws.
    const answer = (v: unknown) => async () => {
      if (typeof v === "string") throw Object.assign(new Error(v), { code: v });
      return v;
    };
    const resolver = (mx: unknown, a: unknown = "ENODATA", aaaa = a) =>
      ({
        resolveMx: answer(mx),
        resolve4: answer(a),
        resolve6: answer(aaaa),
        cancel: () => {},
      }) as unknown as Resolver;
    const mx = (exchange: string) => [{ exchange, priority: 0 }];
    const cases: [Resolver, import("../src/mail-domain.ts").MailDomain][] = [
      [resolver(mx("mx.example.com")), "deliverable"],
      [resolver(mx("")), "undeliverable"],
      [resolver(mx(".")), "undeliverable"],
      [resolver("ENOTFOUND"), "undeliverable"],
      [resolver("ENODATA", ["192.0.2.1"], "ENODATA"), "deliverable"],
      [resolver("ENODATA", "ENODATA", ["2001:db8::1"]), "deliverable"],
      [resolver("ENODATA"), "undeliverable"],
      [resolver("ESERVFAIL"), "unknown"],
      [resolver("ETIMEOUT"), "unknown"],
      [resolver("ECONNREFUSED"), "unknown"],
      [resolver("ENODATA", "ESERVFAIL", "ENODATA"), "unknown"],
    ];
    for (const [r, expected] of cases)
      expect(await mailDomain("example.com", r)).toBe(expected);
    // A lookup that never answers is cancelled at the deadline and sends.
    let cancelled = false;
    const hang = {
      resolveMx: () => new Promise(() => {}),
      cancel: () => {
        cancelled = true;
      },
    } as unknown as Resolver;
    expect(await mailDomain("example.com", hang, 20)).toBe("unknown");
    expect(cancelled).toBe(true);
    expect(await mailDomain("", resolver(mx("")))).toBe("unknown");
  });

  test("mail to an undeliverable domain commits the no-op receipt, logging only a domain digest", async () => {
    const { acceptMail } = await import("../src/mail.ts");
    const { domainDigest } = await import("../src/mail-domain.ts");
    const config = fixtureConfig();
    const { pool, queued } = queue();
    const looked: string[] = [];
    const domain = async (d: string) => {
      looked.push(d);
      return d === "no-mail.example"
        ? ("undeliverable" as const)
        : d === "dns-down.example"
          ? ("unknown" as const)
          : ("deliverable" as const);
    };
    const logs: unknown[][] = [];
    const log = spyOn(console, "log").mockImplementation((...a) => {
      logs.push(a);
    });
    try {
      await acceptMail(pool, config, state("person@No-Mail.example."), {
        domain,
      });
      // An unknown address still looks its domain up, so both take as long.
      await acceptMail(pool, config, state(), {
        domain,
        requested: "nobody@no-mail.example",
      });
      await acceptMail(pool, config, state("person@example.com"), { domain });
      // DNS failing answers "unknown": the message is sent.
      await acceptMail(pool, config, state("person@dns-down.example"), {
        domain,
      });
      await acceptMail(pool, config, state("e2e@milton-test.invalid"), {
        domain,
      });
    } finally {
      log.mockRestore();
    }
    expect(queued()).toEqual([false, false, true, true, false]);
    expect(looked).toEqual([
      "no-mail.example",
      "no-mail.example",
      "example.com",
      "dns-down.example",
    ]);
    expect(logs.map((l) => JSON.parse(String(l[0])))).toEqual([
      {
        message: "auth_mail_skipped",
        reason: "undeliverable_domain",
        kind: "reset",
        domain: domainDigest("no-mail.example"),
      },
    ]);
    expect(JSON.stringify(logs)).not.toContain("no-mail");
  });

  test("each address gets at most 3 messages of a kind an hour; the fourth commits the no-op receipt", async () => {
    const { acceptMail } = await import("../src/mail.ts");
    const config = fixtureConfig();
    const { pool, calls, queued } = queue();
    const domain = async () => "deliverable" as const;
    const logs: string[] = [];
    const log = spyOn(console, "log").mockImplementation((line) => {
      logs.push(String(line));
    });
    try {
      for (const to of [
        "person@example.com",
        "Person@Example.com",
        "person@example.com",
        "person@example.com",
      ])
        await acceptMail(pool, config, state(to), { domain });
      await acceptMail(pool, config, state("person@example.com", "verify"), {
        domain,
      });
    } finally {
      log.mockRestore();
    }
    // The pool admits three takes in all, so the verify message is capped
    // too here; its bucket is still its own key.
    expect(queued()).toEqual([true, true, true, false, false]);
    const takes = calls.filter((c) => c.text.includes("take_rate"));
    expect(takes.map((c) => c.values.slice(1))).toEqual(
      Array(5).fill([3600, 3]),
    );
    const keys = takes.map((c) => c.values[0]);
    expect(new Set(keys.slice(0, 4)).size).toBe(1);
    expect(keys[4]).not.toBe(keys[0]);
    expect(String(keys[0])).toMatch(/^[0-9a-f]{64}$/);
    expect(logs.map((l) => JSON.parse(l))).toEqual([
      { message: "auth_mail_skipped", reason: "account_cap", kind: "reset" },
      { message: "auth_mail_skipped", reason: "account_cap", kind: "verify" },
    ]);
    expect(logs.join()).not.toContain("person");
  });
});
