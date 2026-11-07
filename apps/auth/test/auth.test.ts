import { describe, expect, spyOn, test } from "bun:test";
import { validPassword } from "../src/password.ts";
import { readConfig } from "../src/config.ts";
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

test("the encrypted payload decrypts as dotenvx does, refusing what dotenvx would rewrite", async () => {
  const { spawnSync } = await import("node:child_process");
  const { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } =
    await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { config } = await import("@dotenvx/dotenvx");
  const root = mkdtempSync(join(tmpdir(), "milton-auth-env-"));
  // Mint fictional payloads as the release procedure does: the dotenvx CLI
  // with an explicit keys file, outside the working directory.
  const mint = (name: string, lines: string[]) => {
    const dir = join(root, name);
    mkdirSync(dir);
    writeFileSync(join(dir, ".env"), lines.join("\n") + "\n", { mode: 0o600 });
    const cli = new URL("../node_modules/.bin/dotenvx", import.meta.url);
    const r = spawnSync(
      cli.pathname,
      ["encrypt", "-f", `${name}/.env`, "--env-keys-file", `${name}/keys`],
      { cwd: root, env: { PATH: process.env.PATH } },
    );
    expect(r.status).toBe(0);
    const keys = readFileSync(join(dir, "keys"), "utf8");
    return {
      file: join(dir, ".env"),
      text: readFileSync(join(dir, ".env"), "utf8"),
      key: keys.match(/^DOTENV_PRIVATE_KEY="?([0-9a-f]{64})"?$/m)![1]!,
    };
  };
  const dotenvx = (text: string, env: Record<string, string>) => {
    const out = { ...env };
    config({
      envs: [
        { type: "env", value: text, privateKeyName: "DOTENV_PRIVATE_KEY" },
      ],
      processEnv: out,
      strict: true,
      quiet: true,
      noArmor: true,
      noNative: true,
      no1Password: true,
      noBitwarden: true,
    });
    return out;
  };
  try {
    const good = mint("good", [
      `AUTH_DATABASE_URL="postgresql://fictional:pw@db.example.invalid/milton?sslmode=verify-full&a=1"`,
      `AUTH_SECRET="${"f".repeat(64)}"`,
      `AUTH_MAIL_FROM="auth@notifications.meetmilton.com"`,
      `FICTIONAL_TEXT="ünï # = 'q' spaced"`,
      `FICTIONAL_LINES="one\\ntwo"`,
      `FICTIONAL_BOM="﻿bom"`,
      `FICTIONAL_LITERAL='a$X\\b$(echo kept)'`,
      `FICTIONAL_SLASH="back\\slash"`,
      "FICTIONAL_TICK=`tick`",
      `FICTIONAL_BARE=bare-value # a comment`,
      `export FICTIONAL_SPACED = 'spaced'`,
      `1FICTIONAL.NAME-X="n"`,
      `FICTIONAL_DUP="first"`,
      `FICTIONAL_DUP="second"`,
      `PORT="9999"`,
    ]);
    expect(good.text).toMatch(/^DOTENV_PUBLIC_KEY="[0-9a-f]{66}" # -fk /m);
    expect(good.text).toMatch(/^export FICTIONAL_SPACED='encrypted:/m);
    expect(good.text).toMatch(/^FICTIONAL_TICK=`encrypted:/m);
    const env = {
      AUTH_ENCRYPTED_ENV_FILE: good.file,
      DOTENV_PRIVATE_KEY: good.key,
      PORT: "8080",
    };
    // The same payload with bare-CR line ends and an uppercase public key.
    const accepted = [
      good.text,
      good.text.replace(/\n/g, "\r"),
      good.text.replace(
        /^(DOTENV_PUBLIC_KEY=")([0-9a-f]+)/m,
        (_, a, b) => a + b.toUpperCase(),
      ),
    ];
    // dotenvx would expand or run these, or they are not dotenvx output.
    const rewritten = mint("rewritten", [
      `A="$(echo substituted)"`,
      `B="x\${PORT}y"`,
      `C="pass$word"`,
      "D=`x$PORT`",
      `G=x$PORT`,
    ]);
    const assignment = /^(?:[A-DG])=/;
    const header = rewritten.text
      .split("\n")
      .filter((l) => !assignment.test(l));
    const variants = [
      ...rewritten.text.split("\n").filter((l) => assignment.test(l)),
      `E="plaintext"`,
      good.text.split("\n").find((l) => l.startsWith("AUTH_SECRET="))!,
      `F="${rewritten.text.match(/^A="(encrypted:[^"]+)"$/m)![1]!.slice(0, -4)}AAAA"`,
    ];
    expect(variants).toHaveLength(8);
    const cases: Record<string, string>[] = [];
    for (const [n, text] of accepted.entries()) {
      const file = join(root, `accepted-${n}.env`);
      writeFileSync(file, text, { mode: 0o600 });
      cases.push({ ...env, AUTH_ENCRYPTED_ENV_FILE: file });
    }
    for (const [n, line] of variants.entries()) {
      const file = join(root, `variant-${n}.env`);
      writeFileSync(file, [...header, line].join("\n"), { mode: 0o600 });
      cases.push({
        AUTH_ENCRYPTED_ENV_FILE: file,
        DOTENV_PRIVATE_KEY: rewritten.key,
      });
    }
    // Production runs Node; Bun's crypto has no secp256k1.
    const run = spawnSync(
      "node",
      [
        "--experimental-strip-types",
        "--input-type=module",
        "-e",
        `const { loadEnvironment } = await import(${JSON.stringify(new URL("../src/environment.ts", import.meta.url).href)});
        const out = JSON.parse(process.argv[1]).map((env) => {
          try { return loadEnvironment(env); } catch (e) { return [e.message, e.code]; }
        });
        process.stdout.write(JSON.stringify(out));`,
        JSON.stringify(cases),
      ],
      { env: { PATH: process.env.PATH }, encoding: "utf8" },
    );
    expect(run.status).toBe(0);
    const out = JSON.parse(run.stdout) as unknown[];
    for (const [n, text] of accepted.entries())
      expect(out[n]).toEqual(dotenvx(text, cases[n]!));
    expect(out[0]).toMatchObject({
      PORT: "8080",
      FICTIONAL_TEXT: "ünï # = 'q' spaced",
      FICTIONAL_LINES: "one\ntwo",
      FICTIONAL_BOM: "﻿bom",
      FICTIONAL_LITERAL: "a$X\\b$(echo kept)",
      FICTIONAL_SLASH: "back\\slash",
      FICTIONAL_DUP: "second",
      "1FICTIONAL.NAME-X": "n",
    });
    expect(out.slice(accepted.length)).toEqual(
      variants.map(() => [
        "auth_runtime_secrets_unavailable",
        "AUTH_RUNTIME_SECRETS_UNAVAILABLE",
      ]),
    );
    // The mail job logs the refusal's code, and no key material.
    const mail = spawnSync(
      "node",
      [
        "--experimental-strip-types",
        new URL("../scripts/deliver.ts", import.meta.url).pathname,
        "--apply",
      ],
      { env: { PATH: process.env.PATH, ...cases.at(-1)! }, encoding: "utf8" },
    );
    expect(mail.status).toBe(1);
    expect(mail.stderr).toContain(
      "auth_mail_pass { class: 'Error', code: 'AUTH_RUNTIME_SECRETS_UNAVAILABLE' }",
    );
    expect(mail.stdout + mail.stderr).not.toContain(rewritten.key);
  } finally {
    rmSync(root, { recursive: true });
  }
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
  const { randomBytes } = await import("node:crypto");
  const secret = () => randomBytes(32).toString("hex");
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
      return { rows: [{ allowed: count <= 1 }] };
    },
    connect: async () => {
      throw new Error("fixture_database_refused");
    },
  };
  const app = createApp(
    createProvider(
      {
        AUTH_DATABASE_URL: "postgresql://unused.invalid/fixture",
        AUTH_SECRET: secret(),
        AUTH_ADMISSION_SECRET: secret(),
        AUTH_RATE_SECRET: secret(),
        AUTH_APP_CLIENT_ID: "fixed-app-fixture",
        AUTH_GOOGLE_CLIENT_ID: "fictional-google",
        AUTH_GOOGLE_CLIENT_SECRET: secret(),
        AUTH_GITHUB_CLIENT_ID: "fictional-github",
        AUTH_GITHUB_CLIENT_SECRET: secret(),
        AUTH_RESEND_API_KEY: "fictional-not-sent",
        AUTH_MAIL_FROM: "auth@notifications.meetmilton.com",
        PORT: 19911,
      },
      { pool: pool as unknown as import("pg").Pool },
    ),
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
  // A pool that never connects: it records the network rate-limit query that
  // every admitted request makes first, and refuses it.
  const fixture = async () => {
    const { createProvider } = await import("../src/provider.ts");
    const { randomBytes } = await import("node:crypto");
    const secret = () => randomBytes(32).toString("hex");
    const queries: string[] = [];
    const pool = {
      on: () => pool,
      query: async (text: string) => {
        queries.push(text);
        if (!text.includes("milton_guard.take_rate"))
          throw new Error("fixture_database_refused");
        return { rows: [{ allowed: false }] };
      },
      connect: async () => {
        throw new Error("fixture_database_refused");
      },
    };
    const { handler } = createProvider(
      {
        AUTH_DATABASE_URL: "postgresql://unused.invalid/fixture",
        AUTH_SECRET: secret(),
        AUTH_ADMISSION_SECRET: secret(),
        AUTH_RATE_SECRET: secret(),
        AUTH_APP_CLIENT_ID: "fixed-app-fixture",
        AUTH_GOOGLE_CLIENT_ID: "fictional-google",
        AUTH_GOOGLE_CLIENT_SECRET: secret(),
        AUTH_GITHUB_CLIENT_ID: "fictional-github",
        AUTH_GITHUB_CLIENT_SECRET: secret(),
        AUTH_RESEND_API_KEY: "fictional-not-sent",
        AUTH_MAIL_FROM: "auth@notifications.meetmilton.com",
        PORT: 19911,
      },
      { pool: pool as unknown as import("pg").Pool },
    );
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
