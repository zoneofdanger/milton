import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  readFileSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeJwt, jwtVerify, createLocalJWKSet } from "jose";
import { randomUUID, createHash, randomBytes } from "node:crypto";
import pg from "pg";
import { bundleFixture } from "./bundle-fixture.ts";
import { httpFixture } from "./http-fixture.ts";
import { checkRuntimeRole } from "../src/roles.ts";
import { disposable } from "./disposable.ts";
import { provisionFixedApp } from "./provision.ts";
import { fixtureConfig } from "../test/fixture-config.ts";
import { AUTH_MIGRATIONS } from "./migrations.ts";
import { deliverMail, openMail, type MailJob } from "../src/mail.ts";
import { createProvider } from "../src/provider.ts";
import { transport } from "../src/adapter.ts";
import { AUTH_ORIGIN, ISSUER, safeError } from "../src/config.ts";

const p = await disposable();
const secret = () => randomBytes(32).toString("hex");
// Direct handler calls come from one fixed client; network buckets key on it.
const TEST_PEER = "127.0.0.1";
const config = fixtureConfig();
const admissions: Record<string, unknown>[] = [];
// The app's answer to each admission; a test sets 503 to refuse one, and
// onAdmit runs inside the admitting request.
let admitStatus = 204;
let onAdmit: ((subject: string) => void) | undefined;
const mail: { to: string; url: string; kind: "reset" | "verify" }[] = [];
const boundaries = {
  fetch: async (input: string | URL | Request, init?: RequestInit) => {
    if (
      String(input) ===
      config.AUTH_ADMISSION_URL + "/internal/auth/preserve-eligibility"
    )
      return new Response(null, { status: 204 });
    if (String(input) === config.AUTH_ADMISSION_URL + "/internal/auth/admit") {
      const admission = JSON.parse(String(init?.body)) as Record<
        string,
        unknown
      >;
      admissions.push(admission);
      onAdmit?.(String(admission.subject));
      return new Response(null, { status: admitStatus });
    }
    throw new Error("external_network_refused");
  },
};
const pools: pg.Pool[] = [];
let groups = 0;
const group = (name: string) => {
  groups++;
  console.log(`PASS ${name}`);
};
try {
  const nativeUrl = new URL("../migrations/001-native.up.sql", import.meta.url);
  assert(existsSync(nativeUrl), "reviewed native baseline required");
  await p.owner.query(readFileSync(nativeUrl, "utf8"));
  // Fictional retained data, unrelated storage and native rows survive the upgrade.
  await p.owner.query(
    `CREATE SCHEMA fictional_writing; CREATE TABLE fictional_writing.saved(id text PRIMARY KEY,body text); INSERT INTO fictional_writing.saved VALUES('fictional','fictional writing'); CREATE SCHEMA neon_auth; CREATE TABLE neon_auth.retained(value text); INSERT INTO neon_auth.retained VALUES('fictional');`,
  );
  await p.owner.query(
    `INSERT INTO milton_auth."user"(id,name,email,"emailVerified","createdAt","updatedAt") VALUES('preserved','Fictional migration','preserved@example.com',true,now(),now());`,
  );
  await p.owner.query(
    `insert into milton_auth.account(id,"accountId","providerId","userId","createdAt","updatedAt") values('preserved-account','fictional-migration-subject','google','preserved',now(),now())`,
  );
  await p.owner.query(
    `insert into milton_auth.session(id,"userId",token,"expiresAt","createdAt","updatedAt") values('preserved-session','preserved',$1,now()+interval '1 day',now(),now());`,
    [secret()],
  );
  const preservedNative = await p.owner.query(
    `select (select row_to_json(a) from milton_auth.account a where id='preserved-account') as account,(select row_to_json(s) from milton_auth.session s where id='preserved-session') as session`,
  );
  const digest = (v: unknown) =>
    createHash("sha256").update(JSON.stringify(v)).digest("hex");
  await p.owner.query(
    `insert into milton_auth.verification(id,identifier,value,"expiresAt","createdAt","updatedAt") values('fictional-pre-upgrade','reset-password:fictional-pre-upgrade','preserved',now()+interval '1 hour',now(),now()),('fictional-non-recovery','fictional-non-recovery','fictional-non-recovery',now()+interval '1 hour',now(),now())`,
  );
  // The rest over rows 001 left; this suite never needs 007.
  for (const n of AUTH_MIGRATIONS.filter(
    (n) => n !== "001-native" && n !== "007-connection-key-status",
  ))
    await p.owner.query(
      readFileSync(
        new URL(`../migrations/${n}.up.sql`, import.meta.url),
        "utf8",
      ),
    );
  // Recovery005 retires only the pre-upgrade reset proof.
  for (const [id, n] of [
    ["fictional-pre-upgrade", 0],
    ["fictional-non-recovery", 1],
  ] as const)
    assert.equal(
      (
        await p.owner.query(
          "select count(*)::int n from milton_auth.verification where id=$1",
          [id],
        )
      ).rows[0].n,
      n,
    );
  assert.equal(
    (await p.owner.query('select count(*)::int as n from milton_auth."user"'))
      .rows[0].n,
    1,
  );
  // Every pre-upgrade column keeps its value; the upgrade only adds columns.
  const upgraded = (
    await p.owner.query(
      `select (select row_to_json(a) from milton_auth.account a where id='preserved-account') as account,(select row_to_json(s) from milton_auth.session s where id='preserved-session') as session`,
    )
  ).rows[0];
  for (const part of ["account", "session"] as const) {
    const before: Record<string, unknown> = preservedNative.rows[0][part];
    assert.equal(
      digest(Object.keys(before).map((column) => upgraded[part][column])),
      digest(Object.values(before)),
      part,
    );
  }
  assert.equal(
    (await p.owner.query("select body from fictional_writing.saved")).rows[0]
      .body,
    "fictional writing",
  );
  assert.equal(
    (await p.owner.query("select value from neon_auth.retained")).rows[0].value,
    "fictional",
  );
  group(
    "additive migrations preserve native rows and retire pre-upgrade reset proofs",
  );
  {
    // The real migrator, killed at its ledger write after 007's work: the
    // schema and the ledger must agree (both applied or neither).
    const o = p.configs.owner!;
    const ownerUrl = new URL(`postgresql://127.0.0.1:${o.port}/${o.database}`);
    ownerUrl.username = String(o.user);
    ownerUrl.password = String(o.password);
    ownerUrl.searchParams.set("options", "-c role=milton_auth_owner");
    let stderr = "";
    const migrate = (
      runner = new URL("./migrate.ts", import.meta.url).pathname,
    ) =>
      new Promise<number | null>((resolve) => {
        stderr = "";
        const child = spawn(
          process.execPath,
          ["--experimental-strip-types", runner, "up", "--apply"],
          {
            env: {
              PATH: process.env.PATH,
              LC_ALL: "C",
              NODE_EXTRA_CA_CERTS: p.caPath,
              AUTH_OWNER_DATABASE_URL: ownerUrl.href,
            },
            stdio: ["ignore", "ignore", "pipe"],
          },
        );
        child.stderr.on("data", (d) => (stderr += d));
        child.on("exit", resolve);
      });
    const admin = new pg.Pool({
      host: "127.0.0.1",
      port: o.port,
      user: "disposable_cluster",
      database: o.database,
      max: 2,
    });
    pools.push(admin);
    const agreed = async () => {
      const r = (
        await admin.query(
          "select to_regprocedure('milton_guard.connection_key_status(text,text,text)') is not null as schema, exists(select 1 from milton_credential.migration_ledger where name='007-connection-key-status') as ledger",
        )
      ).rows[0];
      assert.equal(r.schema, r.ledger, "native 007 schema and ledger disagree");
      return r.schema as boolean;
    };
    const killedAtLedgerWrite = async () => {
      const blocker = await admin.connect();
      try {
        // EXCLUSIVE blocks only the ledger insert, not its reads.
        await blocker.query(
          "begin; lock table milton_credential.migration_ledger in exclusive mode",
        );
        const exit = migrate();
        let pid: number | undefined;
        for (let n = 0; n < 400 && !pid; n++) {
          pid = (
            await admin.query(
              "select pid from pg_stat_activity where usename='fictional_migrator' and wait_event_type='Lock' and query ~* '^insert into milton_credential.migration_ledger'",
            )
          ).rows[0]?.pid;
          if (!pid) await new Promise((r) => setTimeout(r, 25));
        }
        assert(pid, "migrator reached its ledger write");
        await admin.query("select pg_terminate_backend($1)", [pid]);
        assert.notEqual(await exit, 0);
      } finally {
        await blocker.query("rollback");
        blocker.release();
      }
    };
    // 001-006 are applied above; record them so the runner has only 007 left.
    await p.owner.query(
      "create table milton_credential.migration_ledger(name text primary key)",
    );
    await p.owner.query(
      "insert into milton_credential.migration_ledger select unnest($1::text[])",
      [AUTH_MIGRATIONS.filter((n) => n !== "007-connection-key-status")],
    );
    await killedAtLedgerWrite();
    assert.equal(await agreed(), false);
    // A file that ends or rewinds the runner's transaction gets no ledger row
    // (a COMMIT is caught after the fact: its work is committed). A fixture
    // copy of the runner reads a 007 whose grant line carries the variant.
    const fixture = mkdtempSync(join(tmpdir(), "milton-migrate-fixture-"));
    try {
      mkdirSync(join(fixture, "scripts"));
      mkdirSync(join(fixture, "migrations"));
      const runner = readFileSync(
        new URL("./migrate.ts", import.meta.url),
        "utf8",
      );
      const fixtureRunner = runner
        .replaceAll('"../src/', `"${new URL("../src/", import.meta.url).href}`)
        .replace('from "pg"', `from "${import.meta.resolve("pg")}"`)
        .replace(
          '"./migrations.ts"',
          `"${new URL("./migrations.ts", import.meta.url).href}"`,
        );
      assert(
        !/"\.\.\/src\/|from "pg"|"\.\/migrations\.ts"/.test(fixtureRunner),
      );
      writeFileSync(join(fixture, "scripts", "migrate.ts"), fixtureRunner);
      for (const file of readdirSync(
        new URL("../migrations/", import.meta.url),
      ))
        writeFileSync(
          join(fixture, "migrations", file),
          readFileSync(
            new URL(`../migrations/${file}`, import.meta.url),
            "utf8",
          ),
        );
      const grant =
        /^(GRANT EXECUTE ON FUNCTION milton_guard\.connection_key_status.*;)$/m;
      const up = join(
        fixture,
        "migrations",
        "007-connection-key-status.up.sql",
      );
      const original = readFileSync(up, "utf8");
      assert.match(original, grant);
      for (const [suffix, refused] of [
        [" COMMIT;", true],
        // The chained transaction stays open and recreates a guessable name.
        [" COMMIT AND CHAIN; SAVEPOINT migration_file;", true],
        // Undoing the file's work in place must not leave its ledger row.
        [" ROLLBACK TO SAVEPOINT migration_file;", false],
      ] as const) {
        writeFileSync(up, original.replace(grant, `$1${suffix}`));
        assert.notEqual(
          await migrate(join(fixture, "scripts", "migrate.ts")),
          0,
          suffix,
        );
        if (refused)
          assert.match(
            stderr,
            /007-connection-key-status\.up\.sql .*MIGRATION_MUST_NOT_MANAGE_TRANSACTION/,
            suffix,
          );
        const r = (
          await admin.query(
            "select to_regprocedure('milton_guard.connection_key_status(text,text,text)') is not null as schema, exists(select 1 from milton_credential.migration_ledger where name='007-connection-key-status') as ledger",
          )
        ).rows[0];
        assert.equal(r.ledger, false, suffix);
        if (r.schema)
          await p.owner.query(
            "DROP FUNCTION milton_guard.connection_key_status(text,text,text)",
          );
      }
    } finally {
      rmSync(fixture, { recursive: true });
    }
    assert.equal(await migrate(), 0);
    assert.equal(await agreed(), true);
    assert.equal(
      (
        await admin.query(
          "select count(*)::int n from milton_credential.migration_ledger",
        )
      ).rows[0].n,
      AUTH_MIGRATIONS.length,
    );
    group(
      "native migrator killed at its ledger write leaves schema and ledger agreeing; a file ending its own transaction gets no ledger row",
    );
  }
  const authPool = new pg.Pool(p.configs.auth),
    appPool = new pg.Pool(p.configs.app),
    mcpPool = new pg.Pool(p.configs.mcp);
  pools.push(authPool, appPool, mcpPool);
  const client = await provisionFixedApp(p.owner, config);
  config.AUTH_APP_CLIENT_ID = client.AUTH_APP_CLIENT_ID;
  const service = createProvider(config, { pool: authPool, boundaries });
  let cookie = "";
  const cookies = new Map<string, string>();
  const drain = () =>
    deliverMail(authPool, config, async (_input, init) => {
      const message = JSON.parse(String(init?.body)) as {
        to: string[];
        text: string;
        subject: string;
      };
      mail.push({
        to: message.to[0]!,
        url: message.text.split("\n")[0]!.split(": ").slice(1).join(": "),
        kind: message.subject.startsWith("Verify") ? "verify" : "reset",
      });
      return new Response(null, { status: 200 });
    });
  const tokenOf = (url: string) =>
    new URL(url).searchParams.get("token") ??
    decodeURIComponent(new URL(url).pathname.split("/").at(-1)!);
  async function call(
    path: string,
    body?: Record<string, unknown>,
    headers: Record<string, string> = {},
  ) {
    const response = await service.handler(
      new Request(ISSUER + path, {
        method: body ? "POST" : "GET",
        headers: {
          origin: AUTH_ORIGIN,
          ...(cookie ? { cookie } : {}),
          ...(body ? { "content-type": "application/json" } : {}),
          ...headers,
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      }),
      TEST_PEER,
    );
    await drain();
    for (const update of response.headers.getSetCookie()) {
      const pair = update.split(";")[0]!;
      const i = pair.indexOf("=");
      const name = pair.slice(0, i);
      if (/max-age=0/i.test(update)) cookies.delete(name);
      else cookies.set(name, pair.slice(i + 1));
    }
    cookie = [...cookies].map(([k, v]) => k + "=" + v).join("; ");
    return response;
  }
  // Discovery advertises only the client authentication Milton accepts.
  for (const path of [
    "/.well-known/openid-configuration",
    "/.well-known/oauth-authorization-server",
  ]) {
    const response = await service.handler(
      new Request(ISSUER + path),
      TEST_PEER,
    );
    assert.equal(response.status, 200);
    const metadata = (await response.json()) as Record<string, unknown>;
    assert.deepEqual(metadata.token_endpoint_auth_methods_supported, [
      "none",
      "client_secret_basic",
      "client_secret_post",
    ]);
    assert.deepEqual(metadata.introspection_endpoint_auth_methods_supported, [
      "client_secret_post",
    ]);
    assert.deepEqual(metadata.revocation_endpoint_auth_methods_supported, [
      "client_secret_basic",
      "client_secret_post",
    ]);
    for (const key of [
      "dpop_signing_alg_values_supported",
      "token_endpoint_auth_signing_alg_values_supported",
      "introspection_endpoint_auth_signing_alg_values_supported",
      "revocation_endpoint_auth_signing_alg_values_supported",
    ])
      assert(!(key in metadata), key);
    assert.equal(metadata.backchannel_logout_supported, false);
    assert.equal(metadata.backchannel_logout_session_supported, false);
  }
  group("discovery metadata advertises only supported client authentication");
  let password = " Ｆｉｃｔｉｏｎａｌ 🌲 password with spaces ";
  const email = "person@example.com";
  assert.equal(
    (
      await call("/sign-up/email", {
        email,
        password,
        name: "Fictional Person",
      })
    ).status,
    200,
  );
  assert.equal(mail.length, 1);
  assert.equal(cookie, "");
  assert.equal((await call("/sign-in/email", { email, password })).status, 403);
  const verification = await service.handler(
    new Request(mail[0]!.url),
    TEST_PEER,
  );
  assert.equal(verification.status, 302);
  assert.equal(verification.headers.getSetCookie().length, 0);
  assert.equal(
    (
      await call("/sign-in/email", {
        email,
        password: password.normalize("NFKC"),
      })
    ).status,
    200,
  );
  assert(cookie.includes("__Secure-"));
  const session = (await (await call("/get-session")).json()) as {
    session: { id: string };
    user: { id: string };
  };
  assert(session.user.id);
  assert(session.session.id);
  const originalFence = (
    await authPool.query(
      'select "miltonIdentityIncarnation" as i,"miltonSecurityGeneration" as g from milton_auth.session where id=$1',
      [session.session.id],
    )
  ).rows[0];
  await p.owner.query(
    `update milton_auth.session set "updatedAt"=now()-interval '2 days',"expiresAt"=now()+interval '1 hour' where id=$1`,
    [session.session.id],
  );
  assert.equal((await call("/get-session")).status, 200);
  const renewed = (
    await authPool.query(
      `select "miltonIdentityIncarnation" as i,"miltonSecurityGeneration" as g,"expiresAt">now()+interval '6 days' as rolling from milton_auth.session where id=$1`,
      [session.session.id],
    )
  ).rows[0];
  assert.equal(renewed.i, originalFence.i);
  assert.equal(renewed.g, originalFence.g);
  assert.equal(renewed.rolling, true);

  group(
    "native signup/verification GET without login and verified password signin",
  );
  assert.equal(
    (
      await call("/change-password", {
        currentPassword: password,
        newPassword: "A different fictional password 123",
        revokeOtherSessions: false,
      })
    ).status,
    200,
  );
  assert.equal((await call("/get-session")).status, 200);
  password = "A different fictional password 123";
  group("native password CAS rotates current session even false flag");
  await call("/request-password-reset", { email });
  const reset = mail.findLast((m) => m.kind === "reset");
  assert(reset);
  assert(new URL(reset.url).pathname.startsWith("/api/auth/reset-password/"));
  const resetRowsBeforeGet = (
    await p.owner.query(
      "select count(*)::int n from milton_auth.verification where identifier like 'reset-password:%'",
    )
  ).rows[0].n;
  const resetRedirect = await service.handler(
    new Request(reset.url),
    TEST_PEER,
  );
  assert.equal(
    resetRedirect.status,
    302,
    "original native reset URL must redirect",
  );
  const resetLocation = new URL(resetRedirect.headers.get("location")!);
  assert.equal(resetLocation.origin, AUTH_ORIGIN);
  assert.equal(resetLocation.pathname, "/reset-password");
  assert.equal(resetLocation.searchParams.get("token"), tokenOf(reset.url));
  assert.equal(
    (
      await p.owner.query(
        "select count(*)::int n from milton_auth.verification where identifier like 'reset-password:%'",
      )
    ).rows[0].n,
    resetRowsBeforeGet,
    "native reset GET must not consume proof",
  );
  const unsafeReset = new URL(reset.url);
  unsafeReset.searchParams.set("callbackURL", "https://attacker.invalid/steal");
  assert.equal(
    (await service.handler(new Request(unsafeReset), TEST_PEER)).status,
    403,
    "native reset GET retains callback origin protection",
  );
  const resetToken = tokenOf(reset.url);
  assert(resetToken);
  assert.equal(
    (
      await call("/reset-password", {
        token: resetToken,
        newPassword: "Recovery fictional password 234",
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await call("/reset-password", {
        token: resetToken,
        newPassword: "Recovery fictional password 234",
      })
    ).status,
    400,
  );
  assert.equal(await (await call("/get-session")).json(), null);
  password = "Recovery fictional password 234";
  group("native recovery one-use consumes proof and fences previous session");
  assert.equal((await call("/sign-in/email", { email, password })).status, 200);
  // Independent flow group: reset fixture rate windows, never production configuration.
  await p.owner.query(
    'delete from milton_auth."rateLimit"; delete from milton_guard.rate_bucket',
  );
  const context = await service.provider.$context;
  const google = context.socialProviders.find((v) => v.id === "google");
  assert(google);
  google.validateAuthorizationCode = async () => ({
    accessToken: "fictional-boundary-only",
    scopes: ["openid", "email", "profile"],
  });
  google.getUserInfo = async () => ({
    user: { email, emailVerified: true, name: "Fictional Person" },
    data: { sub: "fictional-google-subject", email, email_verified: true },
  });
  async function social(link: boolean) {
    const start = await call(link ? "/link-social" : "/sign-in/social", {
      provider: "google",
      callbackURL: AUTH_ORIGIN + "/security",
    });
    assert.equal(start.status, 200);
    const data = (await start.json()) as { url: string };
    const state = new URL(data.url).searchParams.get("state");
    assert(state);
    return call(
      "/callback/google?code=fictional-code&state=" + encodeURIComponent(state),
    );
  }
  await call("/sign-out", {});
  const takeover = await social(false);
  assert.equal(takeover.status, 302);
  assert(
    (takeover.headers.get("location") ?? "").includes("account_not_linked"),
  );
  assert.equal(
    (
      await authPool.query(
        `select count(*)::int as n from milton_auth.account where "providerId"='google' and "userId"=$1`,
        [session.user.id],
      )
    ).rows[0].n,
    0,
  );
  assert.equal((await call("/sign-in/email", { email, password })).status, 200);
  assert.equal((await social(true)).status, 302);
  const linked = (
    await authPool.query(
      `select id from milton_auth.account where "providerId"='google' and "userId"=$1`,
      [session.user.id],
    )
  ).rows[0];
  assert(linked);
  assert.equal(
    (await call("/unlink-account", { accountId: linked.id })).status,
    200,
  );
  assert.equal(await (await call("/get-session")).json(), null);
  assert.equal((await call("/sign-in/email", { email, password })).status, 200);
  const credential = (
    await authPool.query(
      `select id from milton_auth.account where "providerId"='credential' and "userId"=$1`,
      [session.user.id],
    )
  ).rows[0];
  assert(credential);
  assert.equal(
    (await call("/unlink-account", { accountId: credential.id })).status,
    400,
  );
  assert(
    admissions.some(
      (v) =>
        Array.isArray(v.verifiedIdentities) &&
        v.verifiedIdentities.some(
          (i: { provider: string; subject: string }) =>
            i.provider === "google" && i.subject === "fictional-google-subject",
        ),
    ),
  );
  group(
    "native web social callback rejects implicit takeover; explicit link/unlink fences authority and protects last method",
  );
  const register = await call("/oauth2/register", {
    client_name: "Fictional assistant",
    redirect_uris: ["https://assistant.example.invalid/callback"],
    token_endpoint_auth_method: "client_secret_post",
    scope: "openid offline_access milton:read milton:write",
    grant_types: ["authorization_code", "refresh_token"],
  });
  assert.equal(register.status, 201);
  const assistant = (await register.json()) as {
    client_id: string;
    client_secret: string;
    basic?: boolean;
  };
  async function authorize(
    c: { client_id: string; client_secret: string; basic?: boolean },
    scope: string,
    resource?: string,
    consent = true,
  ) {
    const verifier = secret(),
      challenge = createHash("sha256").update(verifier).digest("base64url");
    const q = new URLSearchParams({
      client_id: c.client_id,
      redirect_uri:
        c.client_id === client.AUTH_APP_CLIENT_ID
          ? "https://app.meetmilton.com/auth/callback"
          : "https://assistant.example.invalid/callback",
      response_type: "code",
      scope,
      code_challenge: challenge,
      code_challenge_method: "S256",
      state: secret(),
      nonce: secret(),
    });
    if (resource) q.set("resource", resource);
    const r = await call("/oauth2/authorize?" + q.toString());
    let target = r.headers.get("location");
    if (!target) {
      const v = (await r.json()) as { url?: string };
      target = v.url ?? null;
    }
    assert(target);
    if (consent) {
      assert(new URL(target, AUTH_ORIGIN).pathname === "/consent");
      const chosen = await call("/oauth2/consent", {
        accept: true,
        scope,
        oauth_query: new URL(target, AUTH_ORIGIN).searchParams.toString(),
      });
      assert.equal(chosen.status, 200);
      target = ((await chosen.json()) as { url: string }).url;
    }
    const code = new URL(target, AUTH_ORIGIN).searchParams.get("code");
    assert(code);
    return token(
      {
        grant_type: "authorization_code",
        code,
        code_verifier: verifier,
        redirect_uri: q.get("redirect_uri")!,
        ...(resource ? { resource } : {}),
      },
      c,
    );
  }
  async function token(body: Record<string, string>, c = assistant) {
    const r = await service.handler(
      new Request(ISSUER + "/oauth2/token", {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          ...(c.basic
            ? {
                authorization:
                  "Basic " +
                  Buffer.from(
                    encodeURIComponent(c.client_id) +
                      ":" +
                      encodeURIComponent(c.client_secret),
                  ).toString("base64"),
              }
            : {}),
        },
        body: new URLSearchParams({
          ...body,
          ...(c.basic
            ? {}
            : { client_id: c.client_id, client_secret: c.client_secret }),
        }),
      }),
      TEST_PEER,
    );
    assert.equal(r.status, 200);
    return (await r.json()) as {
      access_token: string;
      refresh_token?: string;
      id_token?: string;
    };
  }
  {
    // Native asks for the flow twice in one authorize (postLogin.shouldRedirect,
    // then consentReferenceId) and twice in one consent accept. Each request
    // admits once (one admission_identity, one POST to the app) and binds at
    // each ask. A refused admission still refuses, the next request admits
    // afresh, and a differing input in the same request admits afresh.
    const statements: string[] = [];
    const query = authPool.query;
    authPool.query = ((...args: [string, unknown[]]) => {
      statements.push(args[0]);
      return query.apply(authPool, args as never);
    }) as never;
    const counted = async (run: () => Promise<Response>) => {
      statements.length = 0;
      const before = admissions.length;
      const response = await run();
      const of = (name: string) =>
        statements.filter((s) => s.includes(`milton_guard.${name}(`)).length;
      return {
        response,
        admits: admissions.length - before,
        identity: of("admission_identity"),
        bind: of("bind_flow"),
      };
    };
    const once = { admits: 1, identity: 1, bind: 2 };
    const scope = "openid offline_access milton:read";
    const start = () =>
      new URLSearchParams({
        client_id: assistant.client_id,
        redirect_uri: "https://assistant.example.invalid/callback",
        response_type: "code",
        scope,
        code_challenge: createHash("sha256")
          .update(secret())
          .digest("base64url"),
        code_challenge_method: "S256",
        state: secret(),
        nonce: secret(),
        resource: "https://mcp.meetmilton.com/mcp",
      });
    try {
      admitStatus = 503;
      const refused = await counted(() =>
        call("/oauth2/authorize?" + start().toString()),
      );
      admitStatus = 204;
      assert.equal(refused.response.status, 503);
      assert.equal(refused.response.headers.get("location"), null);
      // Refused at the app, before any binding, and never asked again.
      const { response: _, ...tried } = refused;
      assert.deepEqual(tried, { admits: 1, identity: 1, bind: 0 });
      const first = await counted(() =>
        call("/oauth2/authorize?" + start().toString()),
      );
      const { response, ...counts } = first;
      assert.deepEqual(counts, once);
      const target = new URL(response.headers.get("location")!, AUTH_ORIGIN);
      assert.equal(target.pathname, "/consent");
      const { response: chosen, ...accepted } = await counted(() =>
        call("/oauth2/consent", {
          accept: true,
          scope,
          oauth_query: target.searchParams.toString(),
        }),
      );
      assert.equal(chosen.status, 200);
      assert(
        new URL(
          ((await chosen.json()) as { url: string }).url,
        ).searchParams.get("code"),
      );
      assert.deepEqual(accepted, once);
      // The first ask's admission leaves a newer security generation in this
      // request's snapshot: the second ask admits afresh, and is refused.
      onAdmit = (subject) => {
        const state = transport.getStore()!;
        state.users.set(subject, {
          ...state.users.get(subject)!,
          miltonSecurityGeneration: "fictional-advanced-generation",
        });
      };
      const { response: changed, ...rechecked } = await counted(() =>
        call("/oauth2/authorize?" + start().toString()),
      );
      onAdmit = undefined;
      assert.equal(changed.status, 400);
      assert.deepEqual(rechecked, { admits: 1, identity: 2, bind: 1 });
    } finally {
      admitStatus = 204;
      onAdmit = undefined;
      authPool.query = query;
    }
  }
  group(
    "one authorize and one consent accept each admit once and bind at each ask; refusals and changed inputs refuse",
  );
  const grants = await authorize(
    assistant,
    "openid offline_access milton:read milton:write",
    "https://mcp.meetmilton.com/mcp",
  );
  assert(grants.refresh_token);
  const jwks = await (await call("/jwks")).json();
  const verified = await jwtVerify(
    grants.access_token,
    createLocalJWKSet(jwks),
    {
      issuer: ISSUER,
      audience: "https://mcp.meetmilton.com/mcp",
      algorithms: ["EdDSA"],
      typ: "at+jwt",
    },
  );
  assert.equal(verified.payload.client_id, assistant.client_id);
  assert.equal(verified.payload.azp, assistant.client_id);
  const claims = verified.payload;
  const status = () =>
    mcpPool.query(
      "select milton_guard.binding_status($1,$2,$3,$4,$5) as binding",
      [
        claims.miltonBinding,
        claims.sub,
        assistant.client_id,
        ["milton:read"],
        ["https://mcp.meetmilton.com/mcp"],
      ],
    );
  assert((await status()).rows[0].binding);
  const appGrant = await authorize(
    {
      client_id: client.AUTH_APP_CLIENT_ID,
      client_secret: client.AUTH_APP_CLIENT_SECRET,
    },
    "openid profile email",
    undefined,
    false,
  );
  assert.equal(appGrant.refresh_token, undefined);
  assert(!appGrant.access_token.includes("."));
  const identity = await jwtVerify(
    appGrant.id_token!,
    createLocalJWKSet(jwks),
    {
      issuer: ISSUER,
      audience: client.AUTH_APP_CLIENT_ID,
      algorithms: ["EdDSA"],
    },
  );
  assert(identity.payload.sid);
  assert.equal(
    (
      await appPool.query(
        "select milton_guard.app_status($1,$2,$3,$4,$5,$6) as active",
        [
          identity.payload.miltonBinding,
          identity.payload.sub,
          client.AUTH_APP_CLIENT_ID,
          identity.payload.sid,
          identity.payload.miltonIdentityIncarnation,
          identity.payload.miltonSecurityGeneration,
        ],
      )
    ).rows[0].active,
    true,
  );
  await call("/sign-out", {});
  await token({
    grant_type: "refresh_token",
    refresh_token: grants.refresh_token!,
    resource: "https://mcp.meetmilton.com/mcp",
  });
  assert((await status()).rows[0].binding);
  const operation = randomUUID();
  await appPool.query("select milton_guard.begin_operation($1,$2,$3,$4,$5)", [
    operation,
    claims.sub,
    claims.miltonIdentityIncarnation,
    assistant.client_id,
    "disconnect",
  ]);
  assert.equal((await status()).rows[0].binding, null);
  for (let n = 0; n < 64; n++) {
    const r = await appPool.query(
      "select milton_guard.cleanup_operation($1,2) as progress",
      [operation],
    );
    if (r.rows[0].progress === "complete") break;
    if (n === 63) throw new Error("bounded_cleanup_did_not_finish");
  }
  assert.equal((await call("/sign-in/email", { email, password })).status, 200);
  const reconnect = await authorize(
    assistant,
    "openid offline_access milton:read",
    "https://mcp.meetmilton.com/mcp",
  );
  assert(reconnect.refresh_token);
  await appPool.query("select milton_guard.cleanup_operation($1,2)", [
    operation,
  ]);
  assert.equal((await status()).rows[0].binding, null);
  const fresh = await jwtVerify(
    reconnect.access_token,
    createLocalJWKSet(jwks),
    {
      issuer: ISSUER,
      audience: "https://mcp.meetmilton.com/mcp",
      algorithms: ["EdDSA"],
      typ: "at+jwt",
    },
  );
  assert(!String(fresh.payload.scope).includes("milton:write"));
  group(
    "native code/S256/JWT/identity-only app; offline logout and durable disconnect/reconnect containment",
  );
  // UserInfo reads an account's claims only while the token's binding is
  // live: a disconnect (a), or a begun deletion that revokes every binding
  // and advances the generation while the native user still exists (b),
  // refuses at once a JWT access token with a live session, one with no
  // session and an opaque token, each answered with claims just before.
  // One binding per account and client, so each kind has its own client.
  {
    const jar = new Map(cookies),
      jarHeader = cookie;
    cookies.clear();
    cookie = "";
    const scope = "openid offline_access milton:read";
    const mcp = "https://mcp.meetmilton.com/mcp";
    const clients: (typeof assistant)[] = [];
    for (const kind of ["no-sid", "sid", "opaque"]) {
      const r = await call("/oauth2/register", {
        client_name: "Fictional UserInfo assistant " + kind,
        redirect_uris: ["https://assistant.example.invalid/callback"],
        token_endpoint_auth_method: "client_secret_post",
        scope,
        grant_types: ["authorization_code", "refresh_token"],
      });
      assert.equal(r.status, 201);
      clients.push((await r.json()) as typeof assistant);
    }
    const [noSidClient, sidClient, opaqueClient] = clients as [
      typeof assistant,
      typeof assistant,
      typeof assistant,
    ];
    const connect = async (address: string) => {
      await p.owner.query(
        'delete from milton_auth."rateLimit"; delete from milton_guard.rate_bucket',
      );
      const secretWord = "Fictional UserInfo binding password";
      const signIn = async () =>
        assert.equal(
          (
            await call("/sign-in/email", {
              email: address,
              password: secretWord,
            })
          ).status,
          200,
        );
      await call("/sign-up/email", {
        email: address,
        password: secretWord,
        name: "Fictional UserInfo person",
      });
      await service.handler(
        new Request(
          mail.findLast((m) => m.kind === "verify" && m.to === address)!.url,
        ),
        TEST_PEER,
      );
      await signIn();
      const offline = await authorize(noSidClient, scope, mcp);
      await call("/sign-out", {});
      // Refreshed after sign-out, the JWT names no session, so native's own
      // session check cannot refuse it.
      const noSid = await token(
        {
          grant_type: "refresh_token",
          refresh_token: offline.refresh_token!,
          resource: mcp,
        },
        noSidClient,
      );
      await signIn();
      const withSid = await authorize(sidClient, scope, mcp);
      const opaque = await authorize(opaqueClient, scope);
      const claims = decodeJwt(withSid.access_token);
      assert(!decodeJwt(noSid.access_token).sid);
      assert(claims.sid);
      assert(!opaque.access_token.includes("."));
      return {
        subject: String(claims.sub),
        incarnation: String(claims.miltonIdentityIncarnation),
        tokens: [noSid, withSid, opaque].map((t) => t.access_token),
      };
    };
    const userInfo = async (tokens: string[]) => {
      const outcomes: {
        status: number;
        challenge: string | null;
        body: Record<string, unknown>;
      }[] = [];
      for (const t of tokens) {
        const r = await call("/oauth2/userinfo", undefined, {
          authorization: "Bearer " + t,
        });
        outcomes.push({
          status: r.status,
          challenge:
            r.status === 401 ? r.headers.get("www-authenticate") : null,
          body: (await r.json()) as Record<string, unknown>,
        });
      }
      return outcomes;
    };
    const answered = async (tokens: string[], subject: string) => {
      for (const r of await userInfo(tokens)) {
        assert.equal(r.status, 200);
        assert.equal(r.body.sub, subject);
      }
    };
    // RFC 6750 §3: each refusal carries the Bearer challenge.
    const refused = Array(3).fill({
      status: 401,
      challenge: 'Bearer error="invalid_token"',
      body: { error: "invalid_token" },
    });
    const operations: string[] = [];
    const disconnected = await connect("userinfo-disconnect@example.com");
    await answered(disconnected.tokens, disconnected.subject);
    for (const c of clients) {
      operations.push(randomUUID());
      await appPool.query(
        "select milton_guard.begin_operation($1,$2,$3,$4,$5)",
        [
          operations.at(-1),
          disconnected.subject,
          disconnected.incarnation,
          c.client_id,
          "disconnect",
        ],
      );
    }
    const afterDisconnect = await userInfo(disconnected.tokens);
    const deleting = await connect("userinfo-deletion@example.com");
    await answered(deleting.tokens, deleting.subject);
    operations.push(randomUUID());
    await appPool.query(
      "select milton_guard.begin_operation($1,$2,$3,null,'delete')",
      [operations.at(-1), deleting.subject, deleting.incarnation],
    );
    assert.equal(
      (
        await authPool.query(
          'select count(*)::int as n from milton_auth."user" where id=$1',
          [deleting.subject],
        )
      ).rows[0].n,
      1,
    );
    // Each case lists the no-sid JWT, the sid JWT and the opaque token.
    assert.deepEqual(
      {
        disconnect: afterDisconnect,
        deletion: await userInfo(deleting.tokens),
      },
      { disconnect: refused, deletion: refused },
      "UserInfo refuses with no claims once the binding is revoked",
    );
    for (const operation of operations)
      for (let n = 0; n < 64; n++) {
        const r = await appPool.query(
          "select milton_guard.cleanup_operation($1,16) as progress",
          [operation],
        );
        if (r.rows[0].progress === "complete") break;
        if (n === 63) throw new Error("bounded_cleanup_did_not_finish");
      }
    cookies.clear();
    for (const [k, v] of jar) cookies.set(k, v);
    cookie = jarHeader;
  }
  group(
    "UserInfo refuses a JWT (with or without sid) or opaque token at once after a disconnect or a begun deletion",
  );
  await p.owner.query(
    'delete from milton_auth."rateLimit"; delete from milton_guard.rate_bucket',
  );
  const freshStatus = () =>
    mcpPool.query(
      "select milton_guard.binding_status($1,$2,$3,$4,$5) as binding",
      [
        fresh.payload.miltonBinding,
        fresh.payload.sub,
        assistant.client_id,
        ["milton:read"],
        ["https://mcp.meetmilton.com/mcp"],
      ],
    );
  assert((await freshStatus()).rows[0].binding);
  await call("/request-password-reset", { email });
  const grantReset = mail.findLast((v) => v.kind === "reset" && v.to === email);
  assert(grantReset);
  assert.equal(
    (
      await call("/reset-password", {
        token: tokenOf(grantReset.url),
        newPassword: "Final fictional recovered password 432",
      })
    ).status,
    200,
  );
  password = "Final fictional recovered password 432";
  assert.equal((await freshStatus()).rows[0].binding, null);
  const oldRefresh = await service.handler(
    new Request(ISSUER + "/oauth2/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: assistant.client_id,
        client_secret: assistant.client_secret,
        refresh_token: reconnect.refresh_token!,
        resource: "https://mcp.meetmilton.com/mcp",
      }),
    }),
    TEST_PEER,
  );
  assert(oldRefresh.status >= 400);
  assert.equal((await call("/sign-in/email", { email, password })).status, 200);
  const maintenanceGrant = await authorize(
    assistant,
    "openid offline_access milton:read",
    "https://mcp.meetmilton.com/mcp",
  );
  assert(maintenanceGrant.refresh_token);
  await p.owner.query(
    `update milton_auth.session set "expiresAt"=now()-interval '2 days' where "userId"=$1`,
    [session.user.id],
  );
  assert(
    (await p.owner.query("select milton_guard.cleanup_expired(16) as n"))
      .rows[0].n > 0,
  );
  await token({
    grant_type: "refresh_token",
    refresh_token: maintenanceGrant.refresh_token!,
    resource: "https://mcp.meetmilton.com/mcp",
  });
  group(
    "real password recovery invalidates existing native grants; bounded session expiry preserves independent offline refresh",
  );
  await p.owner.query(
    'delete from milton_auth."rateLimit"; delete from milton_guard.rate_bucket',
  );
  assert.equal((await call("/sign-in/email", { email, password })).status, 200);
  const basicRegistration = await call("/oauth2/register", {
    client_name: "Fictional basic assistant",
    redirect_uris: ["https://assistant.example.invalid/callback"],
    token_endpoint_auth_method: "client_secret_basic",
    scope: "openid offline_access milton:read",
    grant_types: ["authorization_code", "refresh_token"],
  });
  assert.equal(basicRegistration.status, 201);
  const basic = {
    ...((await basicRegistration.json()) as {
      client_id: string;
      client_secret: string;
    }),
    basic: true,
  };
  const basicGrant = await authorize(
    basic,
    "openid offline_access milton:read",
    "https://mcp.meetmilton.com/mcp",
  );
  assert(basicGrant.refresh_token);
  await token(
    {
      grant_type: "refresh_token",
      refresh_token: basicGrant.refresh_token!,
      resource: "https://mcp.meetmilton.com/mcp",
    },
    basic,
  );
  group(
    "native Basic client authentication keeps original caller/reference across refresh without body client_id",
  );
  // Independent session/social-only group uses real native state, with the external profile/token boundary mocked.
  await p.owner.query(
    'delete from milton_auth."rateLimit"; delete from milton_guard.rate_bucket',
  );
  const github = context.socialProviders.find((v) => v.id === "github");
  assert(github);
  github.validateAuthorizationCode = async () => ({
    accessToken: "fictional-github-boundary",
    scopes: ["read:user", "user:email"],
  });
  github.getUserInfo = async () => ({
    user: {
      email: "social-only@example.com",
      emailVerified: true,
      name: "Fictional Social",
    },
    data: { id: 71001, login: "fictional-social" },
  });
  await call("/sign-out", {});
  const githubStart = await call("/sign-in/social", {
    provider: "github",
    callbackURL: AUTH_ORIGIN + "/security",
  });
  assert.equal(githubStart.status, 200);
  const githubState = new URL(
    ((await githubStart.json()) as { url: string }).url,
  ).searchParams.get("state");
  assert(githubState);
  assert.equal(
    (
      await call(
        "/callback/github?code=fictional-github-code&state=" +
          encodeURIComponent(githubState),
      )
    ).status,
    302,
  );
  const socialUser = (await (await call("/get-session")).json()) as {
    user: { id: string };
    session: { id: string };
  };
  assert(socialUser.user.id);
  await call("/request-password-reset", {
    email: "social-only@example.com",
  });
  const firstPasswordMail = mail.findLast(
    (v) => v.to === "social-only@example.com" && v.kind === "reset",
  );
  assert(firstPasswordMail);
  const firstPasswordToken = tokenOf(firstPasswordMail.url);
  assert(firstPasswordToken);
  assert.equal(
    (
      await call("/reset-password", {
        token: firstPasswordToken,
        newPassword: "First fictional social password 321",
      })
    ).status,
    200,
  );
  assert.equal(await (await call("/get-session")).json(), null);
  assert.equal(
    (
      await call("/sign-in/email", {
        email: "social-only@example.com",
        password: "First fictional social password 321",
      })
    ).status,
    200,
  );
  const firstNative = (await (await call("/get-session")).json()) as {
    user: { id: string };
    session: { id: string };
  };
  assert.equal(firstNative.user.id, socialUser.user.id);
  assert.equal(
    (
      await call("/sign-in/email", {
        email: "social-only@example.com",
        password: "First fictional social password 321",
      })
    ).status,
    200,
  );
  const listed = (await (await call("/list-sessions")).json()) as {
    id: string;
    token?: string;
  }[];
  assert(listed.length >= 2);
  assert(listed.every((v) => !v.token));
  assert.equal((await call("/revoke-other-sessions", {})).status, 200);
  assert.equal(
    ((await (await call("/list-sessions")).json()) as unknown[]).length,
    1,
  );
  const currentSocial = (await (await call("/get-session")).json()) as {
    session: { id: string };
  };
  await p.owner.query(
    `update milton_auth.session set "createdAt"=now()-interval '6 minutes' where id=$1`,
    [currentSocial.session.id],
  );
  assert.equal((await call("/revoke-other-sessions", {})).status, 403);
  group(
    "native GitHub callback, social first password, sanitized session inventory/revocation and stale freshness refusal",
  );
  const rateKey = secret();
  assert.equal(
    (
      await authPool.query(
        "select milton_guard.take_rate($1,60,2) as allowed",
        [rateKey],
      )
    ).rows[0].allowed,
    true,
  );
  assert.equal(
    (
      await authPool.query(
        "select milton_guard.take_rate($1,60,2) as allowed",
        [rateKey],
      )
    ).rows[0].allowed,
    true,
  );
  const secondPool = new pg.Pool(p.configs.auth);
  try {
    assert.equal(
      (
        await secondPool.query(
          "select milton_guard.take_rate($1,60,2) as allowed",
          [rateKey],
        )
      ).rows[0].allowed,
      false,
    );
  } finally {
    await secondPool.end();
  }
  for (const [pool, role] of [
    [authPool, "milton_auth_runtime"],
    [appPool, "milton_app_runtime"],
    [mcpPool, "milton_mcp_runtime"],
  ] as const)
    await checkRuntimeRole(pool, role);
  group(
    "shared atomic rate bucket across pools and effective runtime privilege audits",
  );
  {
    // Server-side callers put many people behind one address. Each reply is
    // "status error-or-code", and runs of equal replies are counted, so a
    // limit's refusal and native's own answer are both asserted exactly.
    await p.owner.query(
      'delete from milton_auth."rateLimit"; delete from milton_guard.rate_bucket',
    );
    const send = (
      path: string,
      peer: string,
      body?: Record<string, unknown>,
      type = "application/x-www-form-urlencoded",
      authorization?: string,
    ) =>
      service.handler(
        new Request(ISSUER + path, {
          method: body ? "POST" : "GET",
          headers: {
            ...(body ? { "content-type": type } : {}),
            ...(["/sign-in/email", "/request-password-reset"].includes(path)
              ? { origin: AUTH_ORIGIN }
              : {}),
            ...(authorization ? { authorization } : {}),
          },
          ...(body
            ? {
                body:
                  type === "application/json"
                    ? JSON.stringify(body)
                    : new URLSearchParams(
                        body as Record<string, string>,
                      ).toString(),
              }
            : {}),
        }),
        peer,
      );
    const outcome = async (r: Response) => {
      const b = (await r.json().catch(() => ({}))) as {
        error?: string;
        code?: string;
      };
      return `${r.status} ${b.error ?? b.code ?? ""}`.trim();
    };
    // Runs of equal outcomes: [outcome, count][].
    const runs = (v: string[]) =>
      v.reduce<[string, number][]>((out, x) => {
        const last = out.at(-1);
        if (last?.[0] === x) last[1]++;
        else out.push([x, 1]);
        return out;
      }, []);
    const refresh = (c: { client_id: string; client_secret: string }) => ({
      grant_type: "refresh_token",
      refresh_token: secret(),
      client_id: c.client_id,
      client_secret: c.client_secret,
    });
    // One connector backend registers six connections in a minute; the
    // rest come from their own addresses, so (a) has its clients.
    const registered: { client_id: string; client_secret: string }[] = [];
    const registrations: string[] = [];
    for (let i = 0; i < 37; i++) {
      const r = await send(
        "/oauth2/register",
        i < 6 ? "198.51.100.1" : `198.51.100.${i + 10}`,
        {
          client_name: "Fictional connector",
          redirect_uris: ["https://assistant.example.invalid/callback"],
          token_endpoint_auth_method: "client_secret_post",
          grant_types: ["authorization_code", "refresh_token"],
        },
        "application/json",
      );
      if (r.status === 201) {
        registered.push(
          (await r.json()) as { client_id: string; client_secret: string },
        );
        registrations.push("201");
      } else registrations.push(await outcome(r));
    }
    // (a) Twenty-one authenticated clients refresh from one address, and
    // thirty-one revoke from another.
    const distinct: string[] = [];
    for (const c of registered.slice(0, 21))
      distinct.push(
        await outcome(await send("/oauth2/token", "198.51.100.2", refresh(c))),
      );
    const revoked: string[] = [];
    for (const c of registered.slice(0, 31))
      revoked.push(
        await outcome(
          await send("/oauth2/revoke", "198.51.100.6", {
            token: secret(),
            client_id: c.client_id,
            client_secret: c.client_secret,
          }),
        ),
      );
    // (b) One client from one address past its own limit.
    const same: string[] = [];
    for (let i = 0; i < 61; i++)
      same.push(
        await outcome(
          await send("/oauth2/token", "198.51.100.3", refresh(registered[0]!)),
        ),
      );
    // (c) The app's egress address has spent its network bucket. The app
    // still exchanges, introspects and reads UserInfo when it proves itself
    // (its secret, or its own access token that native would still accept,
    // however the header spaces it); requests that only name it, carry
    // another client's real token, or carry an app token that is expired,
    // revoked or no longer current, do not.
    const mintApp = () =>
      authorize(
        {
          client_id: client.AUTH_APP_CLIENT_ID,
          client_secret: client.AUTH_APP_CLIENT_SECRET,
        },
        "openid profile email",
        undefined,
        false,
      );
    const appGrant = await mintApp();
    const expiredGrant = await mintApp();
    const revokedGrant = await mintApp();
    const assistantToken = (
      await authorize(
        assistant,
        "openid offline_access milton:read",
        "https://mcp.meetmilton.com/mcp",
      )
    ).access_token;
    const tokenRow = (t: string) =>
      createHash("sha256").update(t).digest("base64url");
    // Token rows change only under their subject's parent lock (token_gate).
    const alterToken = async (t: string, change: string) => {
      const c = await p.owner.connect();
      try {
        await c.query("begin");
        await c.query(
          `select set_config('credential.locked',(select "userId" from milton_auth."oauthAccessToken" where token=$1),true)`,
          [tokenRow(t)],
        );
        await c.query(
          `update milton_auth."oauthAccessToken" set ${change} where token=$1`,
          [tokenRow(t)],
        );
        await c.query("commit");
      } finally {
        c.release();
      }
    };
    await alterToken(
      expiredGrant.access_token,
      `"expiresAt"=now()-interval '1 second'`,
    );
    await alterToken(revokedGrant.access_token, "revoked=now()");
    for (let i = 0; i < 120; i++) await send("/ok", "198.51.100.4");
    const userInfo = (authorization: string) =>
      send(
        "/oauth2/userinfo",
        "198.51.100.4",
        undefined,
        undefined,
        authorization,
      ).then(outcome);
    const app = {
      client_id: client.AUTH_APP_CLIENT_ID,
      client_secret: client.AUTH_APP_CLIENT_SECRET,
    };
    const firstParty: string[] = [];
    for (let i = 0; i < 25; i++)
      firstParty.push(
        await outcome(
          await send("/oauth2/token", "198.51.100.4", refresh(app)),
        ),
      );
    firstParty.push(
      await outcome(
        await send("/oauth2/introspect", "198.51.100.4", {
          token: secret(),
          ...app,
        }),
      ),
    );
    for (let i = 0; i < 3; i++)
      firstParty.push(await userInfo("Bearer " + appGrant.access_token));
    firstParty.push(await userInfo("Bearer\t" + appGrant.access_token));
    const named = [
      await outcome(
        await send("/oauth2/token", "198.51.100.4", {
          ...refresh(app),
          client_secret: secret(),
        }),
      ),
      await userInfo("Bearer " + secret()),
      await userInfo("Bearer " + assistantToken),
      await userInfo("Bearer " + expiredGrant.access_token),
      await userInfo("Bearer " + revokedGrant.access_token),
    ];
    // A password change advances the generation (002's credential gate);
    // the same app token then proves nothing. The generation is restored so
    // later groups keep their sessions.
    const subject = (
      await p.owner.query(
        `select "userId" as id from milton_auth."oauthAccessToken" where token=$1`,
        [tokenRow(appGrant.access_token)],
      )
    ).rows[0].id as string;
    const generation = (
      await p.owner.query(
        `select "miltonSecurityGeneration" as g from milton_auth."user" where id=$1`,
        [subject],
      )
    ).rows[0].g as string;
    await p.owner.query(
      `update milton_auth."user" set "miltonSecurityGeneration"=milton_credential.next_fence() where id=$1`,
      [subject],
    );
    named.push(await userInfo("Bearer " + appGrant.access_token));
    await p.owner.query(
      `update milton_auth."user" set "miltonSecurityGeneration"=$2 where id=$1`,
      [subject, generation],
    );
    // (e) Once the network bucket refuses, invented clients, tokens and
    // emails (and a targeted email's existing bucket) take nothing.
    const target = "targeted@example.com";
    await send(
      "/sign-in/email",
      "198.51.100.7",
      { email: target, password: "A fictional wrong password 000" },
      "application/json",
    );
    const buckets = async () =>
      (
        await p.owner.query(
          "select count(*)::int as n, sum(hits)::int as hits from milton_guard.rate_bucket",
        )
      ).rows[0];
    const before = await buckets();
    const spam: string[] = [];
    for (let i = 0; i < 10; i++) {
      spam.push(
        await outcome(
          await send("/oauth2/token", "198.51.100.4", {
            ...refresh({ client_id: secret(), client_secret: secret() }),
          }),
        ),
        await outcome(
          await send("/oauth2/revoke", "198.51.100.4", {
            token: secret(),
            client_id: secret(),
          }),
        ),
        await outcome(
          await send(
            "/oauth2/userinfo",
            "198.51.100.4",
            undefined,
            undefined,
            "Bearer " + secret(),
          ),
        ),
        await outcome(
          await send(
            "/sign-in/email",
            "198.51.100.4",
            {
              email: i % 2 ? target : `invented-${i}@example.com`,
              password: "A fictional wrong password 000",
            },
            "application/json",
          ),
        ),
      );
    }
    const after = await buckets();
    // (d) Native's per-path sign-in and mail limits, on the shared buckets.
    const signIn: string[] = [];
    for (let i = 0; i < 4; i++)
      signIn.push(
        await outcome(
          await send(
            "/sign-in/email",
            "198.51.100.5",
            {
              email: `limited-${i}@example.com`,
              password: "A fictional wrong password 000",
            },
            "application/json",
          ),
        ),
      );
    const resetMail: string[] = [];
    for (let i = 0; i < 4; i++)
      resetMail.push(
        await outcome(
          await send(
            "/request-password-reset",
            "198.51.100.5",
            { email: `limited-${i}@example.com` },
            "application/json",
          ),
        ),
      );
    await drain();
    const storage = (
      await p.owner.query(
        `select (select count(*)::int from milton_auth."rateLimit") as native, (select count(*)::int from milton_guard.rate_bucket where key !~ '^[0-9a-f]{64}$') as plain`,
      )
    ).rows[0];
    assert.deepEqual(
      {
        registrations: runs(registrations),
        distinct: runs(distinct),
        revoked: runs(revoked),
        same: runs(same),
        firstParty: runs(firstParty),
        named,
        spam: runs(spam),
        growth: { before, after },
        signIn: runs(signIn),
        resetMail: runs(resetMail),
        storage,
      },
      {
        registrations: [["201", 37]],
        // Native authenticated each client, then refused the unknown token.
        distinct: [["400 invalid_grant", 21]],
        revoked: [["400 invalid_request", 31]],
        same: [
          ["400 invalid_grant", 60],
          ["429 rate_limited", 1],
        ],
        firstParty: [
          ["400 invalid_grant", 25],
          ["200", 5],
        ],
        // Named app, invented token, another client's real token, expired,
        // revoked, and no-longer-current app tokens.
        named: Array(6).fill("429 rate_limited"),
        spam: [["429 rate_limited", 40]],
        growth: { before, after: before },
        signIn: [
          ["401 INVALID_EMAIL_OR_PASSWORD", 3],
          ["429", 1],
        ],
        resetMail: [
          ["200", 3],
          ["429", 1],
        ],
        storage: { native: 0, plain: 0 },
      },
    );
  }
  group(
    "server-side callers keep per-client token, revoke and UserInfo buckets, the proven app skips the network bucket, refused requests take no other bucket, and native limits use hashed shared buckets",
  );
  await p.owner.query(
    'delete from milton_auth."rateLimit"; delete from milton_guard.rate_bucket',
  );
  await httpFixture(service, {
    rateSecret: config.AUTH_RATE_SECRET,
    owner: p.owner,
  });
  group(
    "compiled Node HTTPS Hono mounting, canonical Host, local assets, escaped forms, Origin and host-only cookie/security handoff",
  );
  await bundleFixture(config, p.configs.auth!, p.caPath);
  group(
    "standalone Node production bundle starts with declared runtime closure behind TLS termination",
  );
  // PR-02: pause only the real native user lookup, after adapter provenance capture.
  await p.owner.query(
    'delete from milton_auth."rateLimit"; delete from milton_guard.rate_bucket',
  );
  await call("/sign-up/email", {
    email: "verification-race@example.com",
    password: "Fictional verification race password",
    name: "Fictional race",
  });
  const verificationMail = mail.findLast(
    (m) => m.kind === "verify" && m.to === "verification-race@example.com",
  );
  assert(verificationMail);
  const originalUser = (
    await authPool.query(
      'select id,"miltonIdentityIncarnation" as incarnation from milton_auth."user" where email=$1',
      ["verification-race@example.com"],
    )
  ).rows[0];
  assert(originalUser);
  let reached!: () => void, release!: () => void;
  const atRead = new Promise<void>((r) => {
      reached = r;
    }),
    continueRead = new Promise<void>((r) => {
      release = r;
    });
  const originalFind = context.internalAdapter.findUserByEmail;
  context.internalAdapter.findUserByEmail = async (...args) => {
    const result = await originalFind(...args);
    if (args[0] === "verification-race@example.com") {
      reached();
      await continueRead;
    }
    return result;
  };
  const pending = service.handler(new Request(verificationMail.url), TEST_PEER);
  await atRead;
  const deletion = randomUUID();
  await appPool.query("select milton_guard.begin_operation($1,$2,$3,null,$4)", [
    deletion,
    originalUser.id,
    originalUser.incarnation,
    "delete",
  ]);
  for (let n = 0; n < 8; n++) {
    const r = await appPool.query(
      "select milton_guard.cleanup_operation($1,2) as progress",
      [deletion],
    );
    if (r.rows[0].progress === "complete") break;
    if (n === 7) throw new Error("race_fixture_cleanup_bound");
  }
  await p.owner.query(
    `insert into milton_auth."user"(id,name,email,"emailVerified","createdAt","updatedAt") values('replacement-race','Fictional replacement','verification-race@example.com',false,now(),now())`,
  );
  release();
  await pending;
  context.internalAdapter.findUserByEmail = originalFind;
  assert.equal(
    (
      await authPool.query(
        'select "emailVerified" as verified from milton_auth."user" where id=$1',
        ["replacement-race"],
      )
    ).rows[0].verified,
    false,
  );
  await service.handler(new Request(verificationMail.url), TEST_PEER);
  assert.equal(
    (
      await authPool.query(
        'select "emailVerified" as verified from milton_auth."user" where id=$1',
        ["replacement-race"],
      )
    ).rows[0].verified,
    false,
  );
  group(
    "verification read/delete/recreate race and retained old proof cannot verify replacement",
  );
  // PR-03: actual native requests; private barriers/faults wrap native methods only.
  {
    const target = "reset-fence@example.com";
    let current = "Fictional reset fence original password";
    const resetCall = async (
      path: string,
      body: Record<string, unknown>,
      attached = "",
    ) => {
      const response = await service.handler(
        new Request(ISSUER + path, {
          method: "POST",
          headers: {
            origin: AUTH_ORIGIN,
            "content-type": "application/json",
            cookie: attached,
          },
          body: JSON.stringify(body),
        }),
        TEST_PEER,
      );
      await drain();
      return response;
    };
    const clearRates = () =>
      p.owner.query(
        'delete from milton_auth."rateLimit"; delete from milton_guard.rate_bucket',
      );
    const issue = async (address = target) => {
      assert.equal(
        (await resetCall("/request-password-reset", { email: address }, cookie))
          .status,
        200,
      );
      const message = mail.findLast(
        (m) => m.to === address && m.kind === "reset",
      );
      assert(message);
      return tokenOf(message.url);
    };
    const redeem = (
      token: string,
      next = "Fictional reset fence replacement password",
    ) => resetCall("/reset-password", { token, newPassword: next }, cookie);
    const signin = async () => {
      const response = await resetCall("/sign-in/email", {
        email: target,
        password: current,
      });
      assert.equal(response.status, 200);
      return response.headers
        .getSetCookie()
        .map((v) => v.split(";")[0])
        .join("; ");
    };
    await clearRates();
    await resetCall("/sign-up/email", {
      email: target,
      password: current,
      name: "Fictional reset fence",
    });
    await service.handler(
      new Request(
        mail.findLast((m) => m.to === target && m.kind === "verify")!.url,
      ),
      TEST_PEER,
    );
    const targetId = (
      await authPool.query('select id from milton_auth."user" where email=$1', [
        target,
      ])
    ).rows[0].id;
    const first = await issue(),
      second = await issue();
    const attached = await signin();
    assert.equal(
      (
        await resetCall(
          "/change-password",
          {
            currentPassword: current,
            newPassword: "Fictional reset fence changed password",
          },
          attached,
        )
      ).status,
      200,
    );
    current = "Fictional reset fence changed password";
    assert.equal(
      (await redeem(first)).status,
      400,
      "older unused link must not undo a later native password change",
    );
    assert.equal((await redeem(second)).status, 400);
    await clearRates();
    const sibling = await issue(),
      winner = await issue();
    assert.equal((await redeem(winner)).status, 200);
    current = "Fictional reset fence replacement password";
    assert.equal(
      (await redeem(sibling)).status,
      400,
      "native reset invalidates sibling link",
    );
    // A request paused after the original native user read cannot restamp authority.
    await clearRates();
    const originalLookup = context.internalAdapter.findUserByEmail;
    let read!: () => void, resume!: () => void;
    const atRead = new Promise<void>((r) => {
      read = r;
    });
    const continued = new Promise<void>((r) => {
      resume = r;
    });
    context.internalAdapter.findUserByEmail = async (...args) => {
      const result = await originalLookup(...args);
      if (args[0] === target) {
        read();
        await continued;
      }
      return result;
    };
    const before = mail.length;
    const late = resetCall("/request-password-reset", { email: target });
    await atRead;
    context.internalAdapter.findUserByEmail = originalLookup;
    try {
      const freshCookie = await signin();
      assert.equal(
        (
          await resetCall(
            "/change-password",
            {
              currentPassword: current,
              newPassword: "Fictional reset fence latest password",
            },
            freshCookie,
          )
        ).status,
        200,
      );
      current = "Fictional reset fence latest password";
    } finally {
      resume();
    }
    const lateResult = await late;
    assert(lateResult.status >= 400, "late issuance must refuse");
    assert.equal(mail.length, before, "stale issuance sends no proof");
    // A redemption that already read its row must still consume under the parent lock.
    await clearRates();
    const racing = await issue();
    const originalVerification = context.internalAdapter.findVerificationValue;
    let proofRead!: () => void, proofResume!: () => void;
    const proofBarrier = new Promise<void>((r) => {
      proofRead = r;
    });
    const proofContinued = new Promise<void>((r) => {
      proofResume = r;
    });
    context.internalAdapter.findVerificationValue = async (...args) => {
      const result = await originalVerification(...args);
      if (args[0] === "reset-password:" + racing) {
        proofRead();
        await proofContinued;
      }
      return result;
    };
    const pausedRedemption = redeem(racing);
    await proofBarrier;
    context.internalAdapter.findVerificationValue = originalVerification;
    try {
      const latestCookie = await signin();
      assert.equal(
        (
          await resetCall(
            "/change-password",
            {
              currentPassword: current,
              newPassword: "Fictional reset race winning password",
            },
            latestCookie,
          )
        ).status,
        200,
      );
      current = "Fictional reset race winning password";
    } finally {
      proofResume();
    }
    assert.equal(
      (await pausedRedemption).status,
      400,
      "already-read proof is invalidated before consumption",
    );
    // Another user's proof survives; failed post-write transaction restores all state.
    await clearRates();
    const independent = await issue(email);
    const retry = await issue(),
      retained = await issue();
    await signin();
    const snapshot = async () =>
      (
        await p.owner.query(
          `select
      (select row_to_json(u) from milton_auth."user" u where id=$1) as u,
      (select jsonb_agg(to_jsonb(a) order by id) from milton_auth.account a where "userId"=$1) as a,
      (select jsonb_agg(to_jsonb(s) order by id) from milton_auth.session s where "userId"=$1) as s,
      (select jsonb_agg(to_jsonb(v) order by id) from milton_auth.verification v where value=$1) as v`,
          [targetId],
        )
      ).rows;
    const beforeRollback = digest(await snapshot());
    const updatePassword = context.internalAdapter.updatePassword;
    context.internalAdapter.updatePassword = async (...args) => {
      await updatePassword(...args);
      throw new Error("fictional_post_write_failure");
    };
    try {
      assert.equal((await redeem(retry)).status, 503);
    } finally {
      context.internalAdapter.updatePassword = updatePassword;
    }
    assert.equal(
      digest(await snapshot()),
      beforeRollback,
      "consumption/password/generation/sessions/siblings rollback together",
    );
    assert.equal((await redeem(retry)).status, 200);
    assert.equal((await redeem(retained)).status, 400);
    assert.equal(
      (await redeem(independent, "Fictional independent recovered password"))
        .status,
      200,
      "unrelated SSO cookie does not bind public recovery target",
    );
    // First password and unlink are real native handlers too.
    await clearRates();
    const firstEmail = "social-only@example.com";
    const login = await resetCall("/sign-in/email", {
      email: firstEmail,
      password: "First fictional social password 321",
    });
    assert.equal(login.status, 200);
    const socialCookie = login.headers
      .getSetCookie()
      .map((v) => v.split(";")[0])
      .join("; ");
    const socialMethods = (
      await authPool.query(
        'select id,"providerId" as provider from milton_auth.account where "userId"=$1',
        [socialUser.user.id],
      )
    ).rows;
    const oldCredential = socialMethods.find(
      (v) => v.provider === "credential",
    );
    assert(oldCredential);
    const preUnlink = [await issue(firstEmail), await issue(firstEmail)];
    assert.equal(
      (
        await resetCall(
          "/unlink-account",
          { accountId: oldCredential.id },
          socialCookie,
        )
      ).status,
      200,
    );
    for (const token of preUnlink)
      assert.equal((await redeem(token)).status, 400);
    await clearRates();
    const preFirst = await issue(firstEmail),
      firstPassword = await issue(firstEmail);
    assert.equal(
      (await redeem(firstPassword, "Fictional fresh first social password"))
        .status,
      200,
    );
    assert.equal((await redeem(preFirst)).status, 400);
    await clearRates();
    const providerLogin = await resetCall("/sign-in/email", {
      email: firstEmail,
      password: "Fictional fresh first social password",
    });
    assert.equal(providerLogin.status, 200);
    const providerCookie = providerLogin.headers
      .getSetCookie()
      .map((v) => v.split(";")[0])
      .join("; ");
    const githubMethod = (
      await authPool.query(
        `select id from milton_auth.account where "userId"=$1 and "providerId"='github'`,
        [socialUser.user.id],
      )
    ).rows[0];
    assert(githubMethod);
    const preProviderUnlink = [
      await issue(firstEmail),
      await issue(firstEmail),
    ];
    assert.equal(
      (
        await resetCall(
          "/unlink-account",
          { accountId: githubMethod.id },
          providerCookie,
        )
      ).status,
      200,
    );
    for (const token of preProviderUnlink)
      assert.equal(
        (await redeem(token)).status,
        400,
        "native provider unlink retires retained proofs",
      );
    await clearRates();
    const preGlobal = await issue();
    await p.owner.query(
      'update milton_auth."user" set "miltonSecurityGeneration"=milton_credential.next_fence() where id=$1',
      [targetId],
    );
    assert.equal(
      (await redeem(preGlobal)).status,
      400,
      "all global generation paths invalidate reset proof",
    );
    const preDelete = await issue();
    const inc = (
      await authPool.query(
        'select "miltonIdentityIncarnation" as i from milton_auth."user" where id=$1',
        [targetId],
      )
    ).rows[0].i;
    const operation = randomUUID();
    await appPool.query(
      "select milton_guard.begin_operation($1,$2,$3,null,'delete')",
      [operation, targetId, inc],
    );
    for (let n = 0; n < 8; n++)
      if (
        (
          await appPool.query(
            "select milton_guard.cleanup_operation($1,16) as p",
            [operation],
          )
        ).rows[0].p === "complete"
      )
        break;
    assert.equal(
      (
        await authPool.query(
          "select count(*)::int as n from milton_auth.verification where value=$1",
          [targetId],
        )
      ).rows[0].n,
      0,
    );
    assert.equal((await redeem(preDelete)).status, 400);
    group(
      "reset issuance provenance, all generation advances, independence and atomic consumption rollback",
    );
  }
  // AR-01: one grouped real-native/PG regression; external provider only is fake.
  {
    const known = "mail-known@example.com",
      unverified = "mail-unverified@example.com";
    const probePassword = "Fictional mail acceptance password";
    const clearRates = () =>
      p.owner.query(
        'delete from milton_auth."rateLimit"; delete from milton_guard.rate_bucket',
      );
    const post = async (
      handler: typeof service.handler,
      path: string,
      address: string,
    ) => {
      await clearRates();
      return handler(
        new Request(ISSUER + path, {
          method: "POST",
          headers: { origin: AUTH_ORIGIN, "content-type": "application/json" },
          body: JSON.stringify({
            email: address,
            password: probePassword,
            name: "Fictional mail",
          }),
        }),
        TEST_PEER,
      );
    };
    let providerCalls = 0;
    const noNetwork = createProvider(config, {
      pool: authPool,
      boundaries: {
        fetch: async () => {
          providerCalls++;
          throw new Error("request_delivery_forbidden");
        },
      },
    });
    await post(noNetwork.handler, "/sign-up/email", known);
    await post(noNetwork.handler, "/sign-up/email", unverified);
    const last = async () =>
      (
        await p.owner.query<MailJob>(
          "select * from milton_guard.mail_job order by created_at desc,id desc limit 1",
        )
      ).rows[0]!;
    const knownJob = (
      await p.owner.query<MailJob>(
        'select j.* from milton_guard.mail_job j join milton_auth."user" u on u.id=j.origin_user where u.email=$1 order by j.created_at desc limit 1',
        [known],
      )
    ).rows[0]!;
    const knownMessage = await openMail(config.AUTH_SECRET, knownJob);
    const knownURL = knownMessage.text
      .split("\n")[0]!
      .split(": ")
      .slice(1)
      .join(": ");
    assert.equal(
      (await noNetwork.handler(new Request(knownURL), TEST_PEER)).status,
      302,
    );
    const states = (suffix: string) =>
      [
        ["reset-known", "/request-password-reset", known, true],
        [
          "reset-unknown",
          "/request-password-reset",
          "mail-unknown@example.com",
          false,
        ],
        ["reset-unverified", "/request-password-reset", unverified, true],
        [
          "reset-social",
          "/request-password-reset",
          "social-only@example.com",
          true,
        ],
        ["verify-known", "/send-verification-email", known, false],
        [
          "verify-unknown",
          "/send-verification-email",
          "mail-unknown@example.com",
          false,
        ],
        ["verify-unverified", "/send-verification-email", unverified, true],
        ["signup-duplicate-verified", "/sign-up/email", known, false],
        ["signup-duplicate-unverified", "/sign-up/email", unverified, false],
        [
          "signup-new",
          "/sign-up/email",
          `mail-new-${suffix}@example.com`,
          true,
        ],
      ] as const;
    let neutral = "";
    for (const [_label, path, address, real] of states("accepted")) {
      const before = (
        await p.owner.query("select count(*)::int n from milton_guard.mail_job")
      ).rows[0].n;
      const r = await post(noNetwork.handler, path, address);
      assert.equal(r.status, 200);
      const text = await r.text();
      if (!neutral) neutral = text;
      assert.equal(text, neutral);
      assert.equal(
        (
          await p.owner.query(
            "select count(*)::int n from milton_guard.mail_job",
          )
        ).rows[0].n,
        before + 1,
      );
      const job = await last();
      assert.equal(job.payload !== null, real);
      if (real) {
        assert(job.payload.startsWith("$ba$1$"));
        await openMail(config.AUTH_SECRET, job);
      } else {
        assert.equal(job.state, "noop");
        assert.equal(job.origin_user, null);
      }
    }
    assert.equal(providerCalls, 0);
    // Actual acceptance EXECUTE loss fails for all states, including native paths
    // that swallow callback exceptions and otherwise return generic success.
    const acceptSignature =
      "milton_guard.accept_mail(uuid,text,text,text,text,timestamptz,text)";
    await p.owner.query(
      `revoke execute on function ${acceptSignature} from milton_auth_runtime`,
    );
    try {
      const before = (
        await p.owner.query("select count(*)::int n from milton_guard.mail_job")
      ).rows[0].n;
      for (const [_label, path, address] of states("db-failure")) {
        const r = await post(noNetwork.handler, path, address);
        assert.equal(r.status, 503);
        assert.deepEqual(await r.json(), {
          error: "retryable_dependency_failure",
        });
      }
      assert.equal(
        (
          await p.owner.query(
            "select count(*)::int n from milton_guard.mail_job",
          )
        ).rows[0].n,
        before,
      );
    } finally {
      await p.owner.query(
        `grant execute on function ${acceptSignature} to milton_auth_runtime`,
      );
    }
    for (const fault of ["missing", "duplicate", "invalid", "throw"] as const) {
      const faulty = createProvider(config, {
        pool: authPool,
        boundaries: {
          beforeMailStash: (s) => {
            if (fault === "missing") s.users.clear();
            else if (fault === "duplicate")
              s.mail = {} as NonNullable<typeof s.mail>;
            else if (fault === "invalid")
              s.resetMailProof = { identifier: "wrong", expiresAt: NaN };
            else throw new Error("fictional_swallowed_callback");
          },
        },
      });
      assert.equal(
        (await post(faulty.handler, "/request-password-reset", known)).status,
        503,
      );
    }
    const nativeContext = await noNetwork.provider.$context;
    const originalSend =
      nativeContext.options.emailVerification!.sendVerificationEmail;
    nativeContext.options.emailVerification!.sendVerificationEmail =
      async () => {};
    try {
      assert.equal(
        (
          await post(
            noNetwork.handler,
            "/sign-up/email",
            "mail-missing-callback@example.com",
          )
        ).status,
        503,
      );
    } finally {
      nativeContext.options.emailVerification!.sendVerificationEmail =
        originalSend;
    }
    assert.equal(providerCalls, 0);
    // Isolate delivery cases; all fictional earlier jobs become terminal.
    const clearJobs = () =>
      p.owner.query(
        "update milton_guard.mail_job set state='failed',payload=null,lease=null,lease_until=null where state='pending'; update milton_guard.mail_delivery set paused_until='-infinity'",
      );
    const issue = async (address = known) => {
      assert.equal(
        (await post(noNetwork.handler, "/request-password-reset", address))
          .status,
        200,
      );
      return last();
    };
    const due = async (id: string) =>
      p.owner.query(
        "update milton_guard.mail_job set next_at=clock_timestamp()-interval '1 second',lease_until=case when lease is null then null else clock_timestamp()-interval '1 second' end where id=$1",
        [id],
      );
    const worker = (
      send: (
        input: string | URL | Request,
        init?: RequestInit,
      ) => Promise<Response>,
    ) => deliverMail(authPool, config, send);
    // No mail ever goes to a reserved .invalid address, such as the end-to-end
    // test account: a reset for an existing verified one answers exactly as any
    // reset does but queues only the no-op receipt, so delivery sends nothing.
    await clearJobs();
    const reserved = "reserved-reset@milton-test.invalid";
    await p.owner.query(
      `insert into milton_auth."user"(id,name,email,"emailVerified") values('fictional-reserved-user','Fictional',$1,true)`,
      [reserved],
    );
    const reservedReply = await post(
      noNetwork.handler,
      "/request-password-reset",
      reserved,
    );
    assert.equal(reservedReply.status, 200);
    assert.equal(await reservedReply.text(), neutral);
    const reservedReceipt = await last();
    assert.deepEqual(
      [
        reservedReceipt.state,
        reservedReceipt.payload,
        reservedReceipt.origin_user,
      ],
      ["noop", null, null],
      "a reserved recipient's reset queues no message",
    );
    let reservedSends = 0;
    const reservedPass = await worker(async () => {
      reservedSends++;
      return new Response(null, { status: 200 });
    });
    assert.deepEqual([reservedPass.claimed, reservedSends], [0, 0]);
    // L-1: issue and encrypt the original native proof on a clock 30s ahead
    // of PostgreSQL, without editing the proof, envelope or stored job later.
    await clearJobs();
    const dbNow = (
      await p.owner.query("select clock_timestamp() as t")
    ).rows[0].t.getTime();
    const nativeNow = Date.now;
    let skewed: MailJob;
    try {
      Date.now = () => dbNow + 30000;
      assert.equal(
        (
          await post(
            noNetwork.handler,
            "/request-password-reset",
            "skew-unknown@example.com",
          )
        ).status,
        200,
      );
      skewed = await issue();
    } finally {
      Date.now = nativeNow;
    }
    assert.equal(skewed.state, "pending");
    assert.equal(skewed.proof_expires_at.getTime(), dbNow + 3630000);
    assert.equal((await openMail(config.AUTH_SECRET, skewed)).to[0], known);
    assert(
      (
        await p.owner.query(
          "select expires_at<=created_at+interval '15 minutes' and expires_at<=proof_expires_at as bounded from milton_guard.mail_job where id=$1",
          [skewed.id],
        )
      ).rows[0].bounded,
    );
    await assert.rejects(
      authPool.query(
        "select milton_guard.accept_mail($1,$2,$3,$4,$5,'infinity',$6)",
        [
          randomUUID(),
          skewed.kind,
          skewed.origin_user,
          skewed.incarnation,
          skewed.generation,
          skewed.payload,
        ],
      ),
      /invalid mail acceptance/,
    );
    for (const failure of [
      "503",
      "timeout",
      "reject",
      "429",
      "429-anomalous",
    ] as const) {
      await clearJobs();
      const job = await issue();
      const throttled = failure.startsWith("429");
      const untouched = throttled ? await issue() : null;
      let originalBody = "",
        originalKey = "";
      const failed = await worker(async (input, init) => {
        assert.equal(String(input), "https://api.resend.com/emails");
        assert.equal(init?.redirect, "error");
        assert(init?.signal);
        originalBody = String(init.body);
        originalKey = new Headers(init.headers).get("idempotency-key")!;
        assert.equal(originalKey, job.id);
        // Visible committed lease, and no database lock over network I/O.
        await p.owner.query(
          "update milton_guard.mail_job set next_at=next_at where id=$1",
          [job.id],
        );
        if (failure === "timeout")
          await new Promise<never>((_, reject) =>
            init.signal!.addEventListener(
              "abort",
              () => reject(new Error("fictional_timeout")),
              { once: true },
            ),
          );
        if (failure === "reject") throw new Error("fictional_rejection");
        return new Response(null, {
          status: throttled ? 429 : Number(failure),
          headers: {
            "retry-after": failure === "429-anomalous" ? "2147483647" : "3000",
          },
        });
      });
      assert.equal(failed.claimed, 1);
      assert.equal(throttled ? failed.throttled : failed.retry, 1);
      if (untouched) {
        assert(
          (
            await p.owner.query(
              "select paused_until>clock_timestamp()+interval '2990 seconds' as paused from milton_guard.mail_delivery",
            )
          ).rows[0].paused,
          "Retry-After outlives a single payload's15-minute deadline",
        );
        const pause = (
          await p.owner.query(
            "select extract(epoch from paused_until-clock_timestamp())::float8 as seconds from milton_guard.mail_delivery",
          )
        ).rows[0].seconds;
        assert(
          pause <= (failure === "429-anomalous" ? 86400 : 3000),
          "an anomalous Retry-After must not store more than 24 hours",
        );
        assert.equal(
          (
            await p.owner.query(
              "select attempts from milton_guard.mail_job where id=$1",
              [untouched.id],
            )
          ).rows[0].attempts,
          0,
        );
        assert.equal(
          (
            await worker(async () => {
              throw new Error("throttled_claim_must_not_send");
            })
          ).claimed,
          0,
        );
        if (failure === "429-anomalous") {
          assert(pause > 86390, "worker caps an anomalous header at 24 hours");
          // The SQL boundary must independently cap an auth-runtime caller.
          await p.owner.query(
            "update milton_guard.mail_delivery set paused_until='-infinity'",
          );
          const direct = (
            await authPool.query<MailJob>(
              "select * from milton_guard.claim_mail(1)",
            )
          ).rows[0]!;
          assert.equal(direct.id, untouched!.id);
          assert.equal(
            (
              await authPool.query(
                "select milton_guard.finish_mail($1,$2,'throttled',2147483647) done",
                [direct.id, direct.lease],
              )
            ).rows[0].done,
            true,
          );
          assert(
            (
              await p.owner.query(
                "select paused_until>clock_timestamp()+interval '86390 seconds' and paused_until<=clock_timestamp()+interval '24 hours' as bounded from milton_guard.mail_delivery",
              )
            ).rows[0].bounded,
            "direct completion cannot persist an unbounded shared pause",
          );
        }
        await p.owner.query(
          "update milton_guard.mail_job set state='failed',payload=null where id=$1",
          [untouched.id],
        );
        await p.owner.query(
          "update milton_guard.mail_delivery set paused_until='-infinity'",
        );
      }
      await due(job.id);
      const success = await worker(async (_input, init) => {
        assert.equal(
          new Headers(init?.headers).get("idempotency-key"),
          originalKey,
        );
        assert.equal(String(init?.body), originalBody);
        return new Response(null, { status: 200 });
      });
      assert.equal(success.sent, 1);
      assert.equal(
        (
          await p.owner.query(
            "select payload from milton_guard.mail_job where id=$1",
            [job.id],
          )
        ).rows[0].payload,
        null,
      );
      assert.equal(
        (
          await worker(async () => {
            throw new Error("terminal_job_must_not_send");
          })
        ).claimed,
        0,
      );
    }
    // Crash after provider success but before local finish: lease and exact payload
    // survive; only the vendor's keyed semantics can deduplicate the retry.
    await clearJobs();
    const crash = await issue();
    const finishSignature = "milton_guard.finish_mail(uuid,uuid,text,integer)";
    let crashBody = "",
      crashKey = "";
    await p.owner.query(
      `revoke execute on function ${finishSignature} from milton_auth_runtime`,
    );
    try {
      await assert.rejects(
        worker(async (_input, init) => {
          crashBody = String(init?.body);
          crashKey = new Headers(init?.headers).get("idempotency-key")!;
          return new Response(null, { status: 200 });
        }),
      );
    } finally {
      await p.owner.query(
        `grant execute on function ${finishSignature} to milton_auth_runtime`,
      );
    }
    const oldLease = (
      await p.owner.query(
        "select lease from milton_guard.mail_job where id=$1",
        [crash.id],
      )
    ).rows[0].lease;
    assert.equal(
      (await authPool.query("select * from milton_guard.claim_mail(1)"))
        .rowCount,
      0,
    );
    await due(crash.id);
    assert.equal(
      (
        await worker(async (_input, init) => {
          assert.equal(String(init?.body), crashBody);
          assert.equal(
            new Headers(init?.headers).get("idempotency-key"),
            crashKey,
          );
          return new Response(null, { status: 200 });
        })
      ).sent,
      1,
    );
    assert.equal(
      (
        await authPool.query(
          "select milton_guard.finish_mail($1,$2,'failed',0) done",
          [crash.id, oldLease],
        )
      ).rows[0].done,
      false,
    );
    // Expiry, unreadable key and authenticated envelope/row binding failures.
    for (const failure of ["expiry", "key", "binding", "attempts"] as const) {
      await clearJobs();
      const job = await issue();
      if (failure === "expiry")
        await p.owner.query(
          "update milton_guard.mail_job set expires_at=clock_timestamp()-interval '1 second' where id=$1",
          [job.id],
        );
      if (failure === "attempts")
        await p.owner.query(
          "update milton_guard.mail_job set attempts=5 where id=$1",
          [job.id],
        );
      if (failure === "binding") {
        const different = await issue();
        await p.owner.query(
          "update milton_guard.mail_job set payload=$1 where id=$2",
          [different.payload, job.id],
        );
        await p.owner.query(
          "update milton_guard.mail_job set state='failed',payload=null where id=$1",
          [different.id],
        );
      }
      const result = await deliverMail(
        authPool,
        {
          ...config,
          AUTH_SECRET: failure === "key" ? secret() : config.AUTH_SECRET,
        },
        async () => {
          throw new Error("terminal_must_not_send");
        },
      );
      assert.equal(result.sent, 0);
      assert.equal(
        (
          await p.owner.query(
            "select payload from milton_guard.mail_job where id=$1",
            [job.id],
          )
        ).rows[0].payload,
        null,
      );
    }
    // Native password reset immediately retires sibling native proofs; queued
    // messages are fenced lazily, without a user FK/cascade or late re-binding.
    await clearJobs();
    const sibling = await issue(),
      redeemJob = await issue();
    const redeemBody = await openMail(config.AUTH_SECRET, redeemJob);
    const redeemURL = redeemBody.text
      .split("\n")[0]!
      .split(": ")
      .slice(1)
      .join(": ");
    const redemption = await noNetwork.handler(
      new Request(ISSUER + "/reset-password", {
        method: "POST",
        headers: { origin: AUTH_ORIGIN, "content-type": "application/json" },
        body: JSON.stringify({
          token: tokenOf(redeemURL),
          newPassword: "Fictional changed mail password",
        }),
      }),
      TEST_PEER,
    );
    assert.equal(redemption.status, 200);
    await worker(async () => {
      throw new Error("fenced_generation_must_not_send");
    });
    await worker(async () => {
      throw new Error("fenced_generation_must_not_send");
    });
    assert.equal(
      (
        await p.owner.query(
          "select state from milton_guard.mail_job where id=$1",
          [sibling.id],
        )
      ).rows[0].state,
      "fenced",
    );
    await clearJobs();
    const recreated = "mail-recreated@example.com";
    await post(noNetwork.handler, "/sign-up/email", recreated);
    const oldJob = await last(),
      operation = randomUUID();
    await appPool.query(
      "select milton_guard.begin_operation($1,$2,$3,null,'delete')",
      [operation, oldJob.origin_user, oldJob.incarnation],
    );
    let complete = false;
    for (let n = 0; n < 16; n++)
      if (
        (
          await appPool.query(
            "select milton_guard.cleanup_operation($1,16) result",
            [operation],
          )
        ).rows[0].result === "complete"
      ) {
        complete = true;
        break;
      }
    assert(complete);
    assert.equal(
      (await post(noNetwork.handler, "/sign-up/email", recreated)).status,
      200,
    );
    const replacement = await last();
    assert.notEqual(replacement.origin_user, oldJob.origin_user);
    assert.equal(
      (
        await worker(async (_input, init) => {
          assert.equal(
            new Headers(init?.headers).get("idempotency-key"),
            replacement.id,
            "only the replacement native message may send",
          );
          return new Response(null, { status: 200 });
        })
      ).sent,
      1,
    );
    assert.equal(
      (
        await p.owner.query(
          "select state from milton_guard.mail_job where id=$1",
          [oldJob.id],
        )
      ).rows[0].state,
      "fenced",
    );
    // Actual native unverified social registration calls verification inside its
    // own swallow boundary; the outer callback still durably accepts it.
    await clearJobs();
    const google = (await noNetwork.provider.$context).socialProviders.find(
      (p) => p.id === "google",
    )!;
    google.validateAuthorizationCode = async () => ({
      accessToken: "fictional-social-access",
    });
    google.getUserInfo = async () => ({
      user: {
        email: "mail-social-unverified@example.com",
        emailVerified: false,
        name: "Fictional social",
      },
      data: {
        sub: "fictional-unverified-mail-subject",
        email: "mail-social-unverified@example.com",
        email_verified: false,
      },
    });
    const start = await noNetwork.handler(
      new Request(ISSUER + "/sign-in/social", {
        method: "POST",
        headers: { origin: AUTH_ORIGIN, "content-type": "application/json" },
        body: JSON.stringify({
          provider: "google",
          callbackURL: AUTH_ORIGIN + "/security",
        }),
      }),
      TEST_PEER,
    );
    const state = new URL(
      ((await start.json()) as { url: string }).url,
    ).searchParams.get("state")!;
    const callback = await noNetwork.handler(
      new Request(
        ISSUER +
          "/callback/google?code=fictional&state=" +
          encodeURIComponent(state),
        {
          headers: {
            cookie: start.headers
              .getSetCookie()
              .map((v) => v.split(";")[0])
              .join("; "),
          },
        },
      ),
      TEST_PEER,
    );
    assert.equal(callback.status, 302);
    const socialJob = await last();
    assert.equal(socialJob.state, "pending");
    assert.equal(socialJob.kind, "verify");
    const socialBody = await openMail(config.AUTH_SECRET, socialJob);
    assert.equal(socialBody.to[0], "mail-social-unverified@example.com");
    const serialized = JSON.stringify(
      (await p.owner.query("select * from milton_guard.mail_job")).rows,
    );
    for (const raw of [
      known,
      unverified,
      recreated,
      knownURL,
      "mail-social-unverified@example.com",
      "/verify-email?token=",
      "/reset-password/",
    ])
      assert(!serialized.includes(raw));
    for (const runtime of [authPool, appPool, mcpPool])
      for (const query of [
        "select * from milton_guard.mail_job",
        "delete from milton_guard.mail_job",
        "update milton_guard.mail_delivery set paused_until=now()",
        "select milton_guard.cleanup_expired(1)",
      ])
        await assert.rejects(runtime.query(query));
    for (const runtime of [appPool, mcpPool])
      for (const query of [
        "select * from milton_guard.claim_mail(1)",
        "select milton_guard.finish_mail(gen_random_uuid(),gen_random_uuid(),'sent',0)",
        "select milton_guard.accept_mail(gen_random_uuid(),null,null,null,null,null,null)",
      ])
        await assert.rejects(runtime.query(query));
    // Lock/skip behavior is real PostgreSQL, including competing claims.
    await clearJobs();
    const locked = await issue(),
      skipped = await issue();
    const lock = await p.owner.connect();
    try {
      await lock.query("begin");
      await lock.query(
        "select id from milton_guard.mail_job where id=$1 for update",
        [locked.id],
      );
      const picked = (
        await authPool.query<MailJob>(
          "select * from milton_guard.claim_mail(1)",
        )
      ).rows[0]!;
      assert.equal(picked.id, skipped.id);
      await authPool.query(
        "select milton_guard.finish_mail($1,$2,'failed',0)",
        [picked.id, picked.lease],
      );
    } finally {
      await lock.query("rollback");
      lock.release();
    }
    // Expiry/fence and cleanup must LIMIT before mutations, even a large overdue
    // backlog or ciphertext that cannot match its copied job UUID.
    await p.owner.query(
      "insert into milton_guard.mail_job(id,kind,state,origin_user,incarnation,generation,proof_expires_at,payload,expires_at,next_at) select gen_random_uuid(),kind,'pending',origin_user,incarnation,generation,proof_expires_at,payload,clock_timestamp()-interval '1 second',clock_timestamp()-interval '10 minutes' from milton_guard.mail_job cross join generate_series(1,20) where id=$1",
      [locked.id],
    );
    const pendingBefore = (
      await p.owner.query(
        "select count(*)::int n from milton_guard.mail_job where state='pending'",
      )
    ).rows[0].n;
    assert.equal(
      (await authPool.query("select * from milton_guard.claim_mail(3)"))
        .rowCount,
      0,
    );
    assert.equal(
      (
        await p.owner.query(
          "select count(*)::int n from milton_guard.mail_job where state='pending'",
        )
      ).rows[0].n,
      pendingBefore - 3,
    );
    await p.owner.query("select milton_guard.cleanup_expired(3)");
    assert.equal(
      (
        await p.owner.query(
          "select count(*)::int n from milton_guard.mail_job where state='pending'",
        )
      ).rows[0].n,
      pendingBefore - 6,
    );
    for (const limit of [0, 17, null])
      await assert.rejects(
        authPool.query("select * from milton_guard.claim_mail($1)", [limit]),
      );
    await clearJobs();
    // Retention cleanup is bounded even with overdue/terminal receipt backlog.
    for (let n = 0; n < 20; n++)
      await authPool.query(
        "select milton_guard.accept_mail($1,null,null,null,null,null,null)",
        [randomUUID()],
      );
    await p.owner.query(
      "update milton_guard.mail_job set created_at=clock_timestamp()-interval '25 hours',expires_at=clock_timestamp()-interval '25 hours' where state<>'pending'",
    );
    const before = (
      await p.owner.query("select count(*)::int n from milton_guard.mail_job")
    ).rows[0].n;
    await p.owner.query("select milton_guard.cleanup_expired(3)");
    assert.equal(
      (await p.owner.query("select count(*)::int n from milton_guard.mail_job"))
        .rows[0].n,
      before - 3,
    );
    assert.equal(providerCalls, 0);
    group(
      "uniform durable native mail receipts, swallowed-callback/commit faults, social registration, bounded leased delivery/retry/fence/retention and real-role refusal",
    );
  }
  for (const pool of [appPool, mcpPool])
    for (const query of [
      "select * from milton_auth.account",
      "select * from milton_auth.jwks",
      "select * from milton_auth.verification",
      "select * from neon_auth.retained",
      "select * from milton_guard.authorization_binding",
      "select nextval('milton_credential.fence_ids')",
      "set role milton_auth_owner",
      "create temp table credential_bypass(id int)",
    ])
      await assert.rejects(pool.query(query));
  await assert.rejects(authPool.query("select * from fictional_writing.saved"));
  await assert.rejects(
    mcpPool.query(
      "select milton_guard.begin_operation('00000000-0000-0000-0000-000000000000','x','x','x','disconnect')",
    ),
  );
  group("actual distinct role storage/DDL/owner/lifecycle denials");
  console.log(
    `PASS ${groups}/${groups} product integration groups (Node ${process.versions.node}, real disposable PostgreSQL; mail/admission mocked only)`,
  );
} catch (error) {
  console.error(
    "product_integration_failed",
    error instanceof assert.AssertionError ? error.message : safeError(error),
  );
  process.exitCode = 1;
} finally {
  for (const pool of pools) await pool.end();
  await p.stop();
}
