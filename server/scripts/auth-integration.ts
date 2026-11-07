/** Explicit local rehearsal. Builds with Bun; executes under Node26. No env
 * files, inherited database credentials, external requests or live operations. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { pathToFileURL } from "node:url";
import { randomBytes, createHash, randomUUID } from "node:crypto";
import pg from "pg";
import * as oidc from "openid-client";
import { createMiltonHandler } from "../src/handler";
import { createAccessTokenVerifier } from "../src/token";
import { sql } from "drizzle-orm";
import { createMiltonApp } from "../src/index";
import { runtimeConfig, type RuntimeConfig } from "../src/config";
import {
  closeDatabasePools,
  POOL_IDLE_MS,
  postgresDatabase,
} from "../src/store/database";
import {
  database,
  lookupIdentityAccount,
  StoreError,
  storeForCurrentRequest,
} from "../src/store";
import {
  authenticateConnectionKey,
  createConnectionKey,
  listConnectionKeys,
  parseConnectionKey,
  revokeConnectionKey,
} from "../src/store/connection-keys";
import { fingerprintKeyCheck } from "../src/auth-admission";
import { hash } from "../src/auth-oidc";
import { appActive, bindingActive } from "../src/auth-authority";
import { checkProductRuntimeRole } from "./check-runtime-role";
import { guideWorkerRoleAllowed } from "../src/guides/store";
import { runGuideWorker } from "../src/guides/worker";
import type { GuideProvider } from "../src/guides/provider";
import { connections, lifecycle } from "../src/auth-lifecycle";
import type { SessionUser } from "../src/auth-session";
import { createProvider } from "../../apps/auth/src/provider";
import { ISSUER, AUTH_ORIGIN, type Config } from "../../apps/auth/src/config";

const port = 55623;
const sourceRoot = pathToFileURL(process.cwd() + "/");
for (const port of [55623, 20201, 20202, 20203, 20204])
  await new Promise<void>((resolve, reject) => {
    const s = createServer();
    s.once("error", () => reject(new Error("owned_fixture_port_in_use")));
    s.listen(port, "127.0.0.1", () => s.close(() => resolve()));
  });
assert.match(process.version, /^v26\./);
const root = mkdtempSync(join(tmpdir(), "milton-app-auth-"));
const data = join(root, "pgdata");
const bin = process.env.PG_BIN ?? "/opt/homebrew/opt/postgresql@18/bin";
const run = (cmd: string, args: string[]) => {
  const r = spawnSync(cmd, args, {
    encoding: "utf8",
    env: { PATH: process.env.PATH, LC_ALL: "C" },
  });
  assert.equal(r.status, 0, "fixture command failed: " + cmd.split("/").pop());
};
const secret = () => randomBytes(32).toString("hex");
const pools: pg.Pool[] = [];
let running = false,
  groups = 0,
  stage = "setup";
const pass = (name: string) => {
  groups++;
  console.log("PASS " + name);
};
try {
  run(join(bin, "initdb"), [
    "-D",
    data,
    "--username=disposable_cluster",
    "--auth-local=trust",
    "--auth-host=scram-sha-256",
    "--encoding=UTF8",
    "--no-locale",
  ]);
  const cert = join(root, "cert.pem"),
    key = join(root, "key.pem");
  run("openssl", [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    key,
    "-out",
    cert,
    "-days",
    "1",
    "-subj",
    "/CN=localhost",
    "-addext",
    "subjectAltName=DNS:localhost,IP:127.0.0.1",
  ]);
  writeFileSync(key, readFileSync(key), { mode: 0o600 });
  run("chmod", ["600", key]);
  writeFileSync(
    join(data, "postgresql.auto.conf"),
    `listen_addresses='127.0.0.1'\nport=${port}\nunix_socket_directories='${root}'\nssl=on\nssl_cert_file='${cert}'\nssl_key_file='${key}'\nlog_statement='none'\nlog_min_error_statement='panic'\nlog_min_messages='panic'\n`,
    { mode: 0o600 },
  );
  writeFileSync(
    join(data, "pg_hba.conf"),
    "local all all trust\nhost all disposable_cluster 127.0.0.1/32 trust\nhostssl all all 127.0.0.1/32 scram-sha-256\n",
    { mode: 0o600 },
  );
  run(join(bin, "pg_ctl"), [
    "-D",
    data,
    "-l",
    join(root, "pg.log"),
    "-w",
    "start",
  ]);
  running = true;
  const admin = new pg.Pool({
    host: root,
    port,
    user: "disposable_cluster",
    database: "postgres",
  });
  pools.push(admin);
  for (const owner of ["milton_auth_owner", "milton_app_owner"])
    await admin.query(`CREATE ROLE ${owner} NOLOGIN NOINHERIT`);
  const credentials: Record<string, string> = {};
  for (const service of ["auth", "app", "mcp", "guide"]) {
    const password = secret();
    credentials[service] = password;
    await admin.query(
      `CREATE ROLE milton_${service}_runtime LOGIN NOINHERIT PASSWORD '${password}'`,
    );
  }
  await admin.query("CREATE DATABASE milton");
  const owner = new pg.Pool({
    host: root,
    port,
    user: "disposable_cluster",
    database: "milton",
  });
  pools.push(owner);
  await owner.query(
    "REVOKE ALL ON DATABASE milton FROM PUBLIC; GRANT CONNECT ON DATABASE milton TO milton_auth_runtime,milton_app_runtime,milton_mcp_runtime,milton_guide_runtime; REVOKE CREATE ON SCHEMA public FROM PUBLIC; CREATE SCHEMA drizzle; CREATE TABLE drizzle.__drizzle_migrations(id serial,hash text,created_at bigint)",
  );
  for (const migration of [
    "0000_baseline",
    "0001_sample_context",
    "0002_sample_versions",
    "0003_report_guides",
    "0004_connection_keys",
  ])
    await owner.query(
      readFileSync(new URL(`./drizzle/${migration}.sql`, sourceRoot), "utf8"),
    );
  const authOwner = new pg.Pool({
    host: root,
    port,
    user: "disposable_cluster",
    database: "milton",
    options: "-c role=milton_auth_owner",
  });
  pools.push(authOwner);
  await owner.query(
    "GRANT CREATE ON DATABASE milton TO milton_auth_owner,milton_app_owner; GRANT USAGE ON SCHEMA public TO milton_app_owner; GRANT REFERENCES ON public.users TO milton_app_owner; ALTER DEFAULT PRIVILEGES FOR ROLE milton_auth_owner REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC",
  );
  await authOwner.query(
    "CREATE SCHEMA milton_auth AUTHORIZATION milton_auth_owner; GRANT USAGE ON SCHEMA milton_auth TO milton_auth_runtime",
  );
  for (const n of [
    "001-native",
    "002-credential",
    "003-mechanism",
    "004-product",
    "005-recovery",
    "006-mail",
    "007-connection-key-status",
  ])
    await authOwner.query(
      readFileSync(
        new URL(`../apps/auth/migrations/${n}.up.sql`, sourceRoot),
        "utf8",
      ),
    );
  const appOwner = new pg.Pool({
    host: root,
    port,
    user: "disposable_cluster",
    database: "milton",
    options: "-c role=milton_app_owner",
  });
  pools.push(appOwner);
  await owner.query(
    "CREATE SCHEMA neon_auth; CREATE TABLE neon_auth.retained(value text); INSERT INTO neon_auth.retained VALUES('fictional retained metadata'); INSERT INTO users(id) VALUES('m_00000000-0000-4000-8000-000000000001'); INSERT INTO identities(provider,subject,user_id) VALUES('neon','legacy-person','m_00000000-0000-4000-8000-000000000001'); INSERT INTO trial_accounts(user_id,started_at,subscription_status) VALUES('m_00000000-0000-4000-8000-000000000001',now()-interval '40 days','canceled');",
  );
  await appOwner.query(
    readFileSync(new URL("./migrations/005-app.up.sql", sourceRoot), "utf8"),
  );
  await owner.query(
    readFileSync(new URL("./migrations/005-app-roles.sql", sourceRoot), "utf8"),
  );
  // Applied twice: rerunning the owner grant file converges, never widens.
  for (let n = 0; n < 2; n++)
    await owner.query(
      readFileSync(
        new URL("./migrations/006-connection-keys-roles.sql", sourceRoot),
        "utf8",
      ),
    );
  // 007: runtime-login timeouts in this database only, nothing on any other
  // role. Up twice converges; down removes exactly these; up again restores.
  const roleTimeouts = async () =>
    (
      await owner.query(
        "SELECT r.rolname role,s.setconfig config FROM pg_db_role_setting s JOIN pg_roles r ON r.oid=s.setrole JOIN pg_database d ON d.oid=s.setdatabase WHERE d.datname='milton' ORDER BY 1",
      )
    ).rows;
  const bounded = ["statement_timeout=20s", "lock_timeout=10s"];
  const timeouts = [
    { role: "milton_app_runtime", config: bounded },
    { role: "milton_auth_runtime", config: ["statement_timeout=5s"] },
    { role: "milton_mcp_runtime", config: bounded },
  ];
  const roleTimeoutFile = (direction: string) =>
    readFileSync(
      new URL(`./migrations/007-role-timeouts.${direction}.sql`, sourceRoot),
      "utf8",
    );
  for (const direction of ["up", "up", "down", "down", "up"]) {
    await owner.query(roleTimeoutFile(direction));
    assert.deepEqual(
      await roleTimeouts(),
      direction === "up" ? timeouts : [],
      direction,
    );
  }
  // The guide job's plain login holds only main's NOLOGIN guide capability.
  await owner.query(
    "GRANT milton_guide_worker TO milton_guide_runtime WITH INHERIT TRUE",
  );
  const poolConfig = (service: string): pg.PoolConfig => ({
    host: "127.0.0.1",
    port,
    user: `milton_${service}_runtime`,
    password: credentials[service],
    database: "milton",
    ssl: { ca: readFileSync(cert, "utf8"), rejectUnauthorized: true },
  });
  const authPool = new pg.Pool(poolConfig("auth")),
    appPool = new pg.Pool(poolConfig("app")),
    mcpPool = new pg.Pool(poolConfig("mcp"));
  pools.push(authPool, appPool, mcpPool);
  // These pools pass no timeouts at connect, like every client through Neon's
  // proxy: the server limits come from 007's role settings alone.
  for (const [pool, statement, lock] of [
    [appPool, "20s", "10s"],
    [mcpPool, "20s", "10s"],
    [authPool, "5s", "0"],
  ] as const)
    assert.deepEqual(
      (
        await pool.query(
          "SELECT current_setting('statement_timeout') statement, current_setting('lock_timeout') lock",
        )
      ).rows[0],
      { statement, lock },
    );
  const url = (service: string) => {
    const u = new URL(
      `postgresql://milton_${service}_runtime@127.0.0.1:${port}/milton`,
    );
    u.password = credentials[service]!;
    u.searchParams.set("sslmode", "verify-full");
    u.searchParams.set("sslrootcert", cert);
    return u.href;
  };
  const ownerUrl = new URL(
    `postgresql://disposable_cluster@127.0.0.1:${port}/milton`,
  );
  ownerUrl.searchParams.set("sslmode", "verify-full");
  ownerUrl.searchParams.set("sslrootcert", cert);
  const ownerDb = postgresDatabase(ownerUrl.href);
  const personId = "m_00000000-0000-4000-8000-000000000001";
  const fingerprintKey = secret();
  // The trial-eligibility key and one verified mapping, as the cutover left them.
  await owner.query(
    "INSERT INTO milton_app.eligibility_policy(singleton,key_check) VALUES(true,$1)",
    [fingerprintKeyCheck(fingerprintKey)],
  );
  await owner.query(
    "INSERT INTO milton_app.legacy_mapping(legacy_hash,issuer,subject,user_id,deleted) VALUES($1,$2,'migrated-person',$3,false)",
    [
      createHash("sha256").update("neon:legacy-person").digest("hex"),
      ISSUER,
      personId,
    ],
  );
  await appOwner.query(
    readFileSync(new URL("./migrations/005-app.down.sql", sourceRoot), "utf8"),
  );
  const appMigrationUrl = new URL(ownerUrl);
  appMigrationUrl.searchParams.set("options", "-c role=milton_app_owner");
  const reapplied = spawnSync(
    "bun",
    ["--no-env-file", "scripts/migrate.ts", "--app-auth"],
    {
      cwd: process.cwd(),
      env: {
        PATH: process.env.PATH,
        LC_ALL: "C",
        MILTON_OWNER_DATABASE_URL: appMigrationUrl.href,
      },
      encoding: "utf8",
    },
  );
  assert.equal(
    reapplied.status,
    0,
    "actual owner-only app migration CLI reapply",
  );
  assert.equal(
    (await owner.query("SELECT count(*)::int n FROM milton_app.legacy_mapping"))
      .rows[0].n,
    1,
  );
  assert.equal(
    (await owner.query("SELECT value FROM neon_auth.retained")).rows[0].value,
    "fictional retained metadata",
  );
  assert.equal(
    (
      await owner.query(
        "SELECT subscription_status FROM trial_accounts WHERE user_id=$1",
        [personId],
      )
    ).rows[0].subscription_status,
    "canceled",
  );
  pass(
    "app migration up/down/reapply preserves writing IDs, trial history, managed rows and verified mappings",
  );
  for (const [pool, statement] of [
    [authPool, "SELECT * FROM public.users"],
    [authPool, "SELECT * FROM milton_app.session"],
    [mcpPool, "SELECT * FROM milton_app.session"],
    [appPool, "SELECT * FROM milton_auth.account"],
    [mcpPool, "SELECT * FROM milton_auth.jwks"],
    [appPool, "SELECT * FROM neon_auth.retained"],
  ] as const)
    await assert.rejects(
      pool.query(statement),
      (e) => (e as { code?: string }).code === "42501",
    );
  for (const pool of [authPool, appPool, mcpPool]) {
    assert.equal(
      (
        await pool.query(
          "SELECT rolinherit FROM pg_roles WHERE rolname=current_user",
        )
      ).rows[0].rolinherit,
      false,
    );
    await assert.rejects(pool.query("CREATE TEMP TABLE forbidden(id int)"));
    await assert.rejects(pool.query("CREATE TABLE public.forbidden(id int)"));
  }
  // One real-driver regression for the production factory's error boundary.
  stage = "production PostgreSQL error mapping";
  {
    const db = database({ DATABASE_URL: url("app") });
    const logs: string[] = [];
    const originalError = console.error;
    console.error = (...args) => {
      assert.equal(args.length, 1);
      logs.push(String(args[0]));
    };
    const mapped =
      (code: string, status: number, message: string) => (error: unknown) => {
        assert(
          error instanceof StoreError,
          `expected StoreError ${code}; got ${error instanceof Error ? error.constructor.name : typeof error}/${(error as { code?: string })?.code}`,
        );
        assert.deepEqual(
          { code: error.code, status: error.status, message: error.message },
          { code, status, message },
        );
        return true;
      };
    const unavailable = mapped(
      "store_unavailable",
      503,
      "The memo store is unavailable. Try again.",
    );
    const safeLog = (codes: (string | undefined)[]) => {
      assert.equal(logs.length, 1, "one sanitized log per driver failure");
      const entry = JSON.parse(logs.pop()!);
      assert.deepEqual(
        Object.keys(entry).sort(),
        (entry.code === undefined
          ? ["event", "where", "class"]
          : ["event", "where", "class", "code"]
        ).sort(),
      );
      assert.equal(entry.event, "unexpected_error");
      assert.equal(entry.where, "store");
      assert(["Error", "DatabaseError"].includes(entry.class));
      assert(codes.includes(entry.code));
    };
    const absent = async (id: string) => {
      assert.equal(
        (
          await owner.query("SELECT count(*)::int n FROM users WHERE id=$1", [
            id,
          ])
        ).rows[0].n,
        0,
        "failed transaction left no committed user",
      );
    };
    try {
      const id = personId;
      const cases = [
        [
          sql`UPDATE users SET id='fictional_changed_id' WHERE id=${id}`,
          "user_id_is_immutable",
          409,
          "The Milton user id cannot be changed.",
        ],
        [
          sql`INSERT INTO users(id) VALUES(${id})`,
          "unique_violation",
          409,
          "A record with these identifiers already exists.",
        ],
        [
          sql`INSERT INTO users(id,status) VALUES('fictional_check','fictional_invalid_status')`,
          "check_violation",
          422,
          "The record does not meet the store requirements.",
        ],
      ] as const;
      for (const mode of ["query", "transaction"] as const) {
        for (const [statement, code, status, message] of cases) {
          const marker = `m_${randomUUID()}`;
          await assert.rejects(
            mode === "query"
              ? db.query(statement)
              : db.transaction(async (tx) => {
                  await tx.query(sql`INSERT INTO users(id) VALUES(${marker})`);
                  await tx.query(statement);
                }),
            mapped(code, status, message),
          );
          await absent(marker);
        }
      }
      assert.deepEqual(logs, [], "recognized failures are not unexpected");
      for (const mode of ["query", "transaction"] as const) {
        await assert.rejects(
          mode === "query"
            ? db.query(sql`SELECT 1 / 0 AS fictional_private_sql`)
            : db.withConnection((connection) =>
                connection.transaction((tx) =>
                  tx.query(sql`SELECT 1 / 0 AS fictional_private_sql`),
                ),
              ),
          unavailable,
        );
        safeLog(["22012"]);
      }
      const disconnected = new URL(url("app"));
      disconnected.port = "20204"; // Preflighted, not started until later groups.
      await assert.rejects(
        database({ DATABASE_URL: disconnected.href }).query(sql`SELECT 1`),
        unavailable,
      );
      safeLog(["ECONNREFUSED"]);
      const defaultTlsUrl = new URL(url("app"));
      defaultTlsUrl.searchParams.delete("sslmode");
      defaultTlsUrl.searchParams.delete("sslrootcert");
      await assert.rejects(
        database({ DATABASE_URL: defaultTlsUrl.href }).query(sql`SELECT 1`),
        unavailable,
        "missing sslmode still negotiates verified TLS and refuses an untrusted fixture CA",
      );
      safeLog(["DEPTH_ZERO_SELF_SIGNED_CERT", "SELF_SIGNED_CERT_IN_CHAIN"]);

      for (const method of ["withConnection", "transaction"] as const) {
        for (const primary of [
          new StoreError("fixture_domain", "Fictional domain refusal.", 409),
          Object.assign(new Error("Fictional callback error."), {
            code: "23505",
          }),
          "fictional_callback",
          null,
          undefined,
        ]) {
          const marker = `m_${randomUUID()}`;
          await assert.rejects(
            db[method](async (session) => {
              if (method === "transaction")
                await session.query(
                  sql`INSERT INTO users(id) VALUES(${marker})`,
                );
              throw primary;
            }),
            (error) => {
              assert.strictEqual(error, primary, "callback rejection identity");
              return true;
            },
          );
          await absent(marker);
        }
      }
      assert.deepEqual(
        logs,
        [],
        "callback errors are never remapped or logged",
      );
      const commitMarker = `m_${randomUUID()}`;
      let reachedCommit = false,
        commitPid = 0;
      await assert.rejects(
        ownerDb.transaction(async (tx) => {
          commitPid = (
            await tx.query<{ pid: number }>(sql`SELECT pg_backend_pid() pid`)
          )[0]!.pid;
          await tx.query(sql`INSERT INTO users(id) VALUES(${commitMarker})`);
          await tx.query(sql`CREATE TEMP TABLE fictional_commit_check
          (id int UNIQUE DEFERRABLE INITIALLY DEFERRED) ON COMMIT DROP`);
          await tx.query(sql`INSERT INTO fictional_commit_check VALUES(1),(1)`);
          reachedCommit = true;
        }),
        mapped(
          "unique_violation",
          409,
          "A record with these identifiers already exists.",
        ),
      );
      assert(
        reachedCommit,
        "deferred constraint fails at COMMIT, after callback",
      );
      await absent(commitMarker);
      assert.notEqual(
        (
          await ownerDb.query<{ pid: number }>(sql`SELECT pg_backend_pid() pid`)
        )[0]!.pid,
        commitPid,
        "a connection whose COMMIT failed is not reused",
      );
      assert.deepEqual(
        logs,
        [],
        "COMMIT constraint failures keep their mapping",
      );

      const primary = new StoreError(
        "fixture_domain",
        "Fictional domain refusal.",
        409,
      );
      const rollbackMarker = `m_${randomUUID()}`;
      await assert.rejects(
        db.transaction(async (tx) => {
          await tx.query(sql`INSERT INTO users(id) VALUES(${rollbackMarker})`);
          const [backend] = await tx.query<{ pid: number }>(
            sql`SELECT pg_backend_pid() pid`,
          );
          assert(backend);
          assert.equal(
            (
              await owner.query("SELECT pg_terminate_backend($1,1000) ended", [
                backend.pid,
              ])
            ).rows[0].ended,
            true,
          );
          throw primary;
        }),
        (error) => {
          assert.strictEqual(
            error,
            primary,
            "failed rollback must preserve the callback error",
          );
          return true;
        },
      );
      safeLog([undefined, "57P01"]);
      await absent(rollbackMarker);
      assert.equal(
        await db.withConnection(async (connection) => {
          const [before] = await connection.query<{
            pid: number;
            ssl: boolean;
            statement: string;
            lock: string;
          }>(sql`
          SELECT pg_backend_pid() pid, ssl,
            current_setting('statement_timeout') statement, current_setting('lock_timeout') lock
          FROM pg_stat_ssl WHERE pid=pg_backend_pid()`);
          assert.equal(before!.ssl, true);
          assert.equal(before!.statement, "20s");
          assert.equal(before!.lock, "10s");
          return connection.transaction(async (tx) => {
            const [inside] = await tx.query<{ pid: number }>(
              sql`SELECT pg_backend_pid() pid`,
            );
            assert.equal(
              inside!.pid,
              before!.pid,
              "one connection across nested operations",
            );
            return 42;
          });
        }),
        42,
      );
      let clock = Date.now();
      const timed = postgresDatabase(url("app"), { now: () => clock });
      const backend = async () =>
        (
          await timed.query<{ pid: number }>(sql`SELECT pg_backend_pid() pid`)
        )[0]!.pid;
      const pooled = await backend();
      assert.equal(
        await backend(),
        pooled,
        "sequential operations share a connection",
      );
      clock += POOL_IDLE_MS + 1;
      assert.notEqual(
        await backend(),
        pooled,
        "a connection idle past the bound is not reused",
      );
      // A callback that rejects with its transaction still open.
      let opened!: () => void,
        resume!: () => void,
        openPid = 0;
      const open = new Promise<void>((resolve) => (opened = resolve));
      const held = new Promise<void>((resolve) => (resume = resolve));
      let leftover: Promise<unknown> | undefined;
      const early = new Error("Fictional early failure.");
      await assert.rejects(
        timed.withConnection(async (connection) => {
          leftover = connection.transaction(async (tx) => {
            openPid = (
              await tx.query<{ pid: number }>(sql`SELECT pg_backend_pid() pid`)
            )[0]!.pid;
            opened();
            await held;
            return tx.query(sql`SELECT 1`);
          });
          await open;
          throw early;
        }),
        (error) => error === early,
      );
      assert.notEqual(
        await backend(),
        openPid,
        "a connection with an open transaction is not reused",
      );
      resume();
      await assert.rejects(leftover!, unavailable);
      assert.deepEqual(logs, []);
    } finally {
      console.error = originalError;
    }
  }
  assert(await checkProductRuntimeRole(postgresDatabase(url("app")), "app"));
  assert(await checkProductRuntimeRole(postgresDatabase(url("mcp")), "mcp"));
  // Sample revisions and guides: app/MCP read, MCP appends, nothing else widens.
  const privileges = async (role: string) =>
    (
      await owner.query<{ p: string }>(
        `SELECT t||':'||p p FROM unnest(ARRAY['samples','sample_versions','guide_accounts','report_guides','guide_spend','guide_budget_lock']) t,
          unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE']) p
          WHERE has_table_privilege($1,'public.'||t,p) ORDER BY 1`,
        [role],
      )
    ).rows.map((r) => r.p);
  const reads = [
    "guide_accounts:SELECT",
    "report_guides:SELECT",
    "sample_versions:SELECT",
    "samples:SELECT",
  ];
  assert.deepEqual(await privileges("milton_app_runtime"), reads);
  assert.deepEqual(
    await privileges("milton_mcp_runtime"),
    [...reads, "sample_versions:INSERT", "samples:INSERT"].sort(),
  );
  assert.deepEqual(await privileges("milton_auth_runtime"), []);
  const guideDb = postgresDatabase(url("guide"));
  assert.equal(await guideWorkerRoleAllowed(guideDb), true);
  assert.equal(
    await guideWorkerRoleAllowed(postgresDatabase(url("mcp"))),
    false,
  );
  for (const statement of [
    "SELECT * FROM public.identities",
    "SELECT * FROM milton_auth.session",
    "SELECT * FROM milton_auth.jwks",
    "SELECT * FROM milton_app.session",
    "SELECT * FROM neon_auth.retained",
  ])
    await assert.rejects(
      guideDb.query(sql.raw(statement)),
      (e) => e instanceof StoreError,
    );
  const idle: GuideProvider = {
    count: () => assert.fail("no enrolled guide work"),
    generate: () => assert.fail("no enrolled guide work"),
  };
  assert.equal(await runGuideWorker(guideDb, idle), 0);
  await owner.query("GRANT milton_mcp_runtime TO milton_guide_runtime");
  assert.equal(await guideWorkerRoleAllowed(guideDb), false);
  await owner.query("REVOKE milton_mcp_runtime FROM milton_guide_runtime");
  // Connection keys (006): app creates, lists and revokes without reading a
  // hash; MCP reads and records last use only; auth and the guide get nothing.
  const keyPrivileges = async (role: string) =>
    (
      await owner.query<{ p: string }>(
        `SELECT p FROM (
          SELECT 'table:'||p p FROM unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) p
            WHERE has_table_privilege($1,'public.connection_keys',p)
          UNION ALL SELECT a.attname||':'||p FROM pg_attribute a CROSS JOIN unnest(ARRAY['SELECT','INSERT','UPDATE']) p
            WHERE a.attrelid='public.connection_keys'::regclass AND a.attnum>0 AND NOT a.attisdropped
            AND has_column_privilege($1,'public.connection_keys',a.attname,p)) x ORDER BY 1`,
        [role],
      )
    ).rows.map((r) => r.p);
  const keyColumns = [
    "created_at",
    "expires_at",
    "generation",
    "id",
    "incarnation",
    "issuer",
    "last_used_at",
    "name",
    "revoked_at",
    "scope",
    "subject",
    "user_id",
  ];
  assert.deepEqual(
    await keyPrivileges("milton_app_runtime"),
    [
      ...keyColumns.map((c) => c + ":INSERT"),
      ...keyColumns.map((c) => c + ":SELECT"),
      "revoked_at:UPDATE",
      "secret_hash:INSERT",
      "table:INSERT",
    ].sort(),
  );
  assert.deepEqual(
    await keyPrivileges("milton_mcp_runtime"),
    [
      ...[...keyColumns, "secret_hash"].map((c) => c + ":SELECT"),
      "last_used_at:UPDATE",
      "table:SELECT",
    ].sort(),
  );
  for (const role of [
    "milton_auth_runtime",
    "milton_guide_runtime",
    "milton_runtime",
  ])
    assert.deepEqual(await keyPrivileges(role), [], role);
  // Native 007: one narrow SECURITY DEFINER status function with a fixed path,
  // EXECUTE for MCP and app only, never PUBLIC, auth or the guide.
  const keyStatus = "milton_guard.connection_key_status(text,text,text)";
  const keyStatusShape = async () =>
    (
      await owner.query<{
        definer: boolean;
        config: string[];
        public: boolean;
        app: boolean;
        mcp: boolean;
        auth: boolean;
        guide: boolean;
      }>(
        `SELECT p.prosecdef definer,p.proconfig config,
          EXISTS(SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee=0) public,
          has_function_privilege('milton_app_runtime',p.oid,'EXECUTE') app,
          has_function_privilege('milton_mcp_runtime',p.oid,'EXECUTE') mcp,
          has_function_privilege('milton_auth_runtime',p.oid,'EXECUTE') auth,
          has_function_privilege('milton_guide_runtime',p.oid,'EXECUTE') guide
          FROM pg_proc p WHERE p.oid=to_regprocedure($1)`,
        [keyStatus],
      )
    ).rows[0];
  const keyStatusGrants = {
    definer: true,
    config: ["search_path=pg_catalog, pg_temp"],
    public: false,
    app: true,
    mcp: true,
    auth: false,
    guide: false,
  };
  assert.deepEqual(await keyStatusShape(), keyStatusGrants);
  {
    const keyUser = "m_00000000-0000-4000-8000-0000000000c0";
    await owner.query("INSERT INTO users(id) VALUES($1)", [keyUser]);
    // A real native subject maps to the account; keys bind to its snapshot.
    const nativeKeyUser = (
      await authOwner.query<{
        id: string;
        incarnation: string;
        generation: string;
      }>(
        `INSERT INTO milton_auth."user"(id,name,email,"emailVerified") VALUES('fictional-key-subject','Fictional','keys@example.invalid',true) RETURNING id,"miltonIdentityIncarnation" incarnation,"miltonSecurityGeneration" generation`,
      )
    ).rows[0]!;
    await owner.query(
      "INSERT INTO identities(provider,subject,user_id) VALUES($1,$2,$3)",
      [ISSUER, nativeKeyUser.id, keyUser],
    );
    const keyBinding = {
      issuer: ISSUER,
      subject: nativeKeyUser.id,
      incarnation: nativeKeyUser.incarnation,
      generation: nativeKeyUser.generation,
    };
    const appDb = postgresDatabase(url("app")),
      mcpDb = postgresDatabase(url("mcp"));
    const keyCheck = (key: string) =>
      authenticateConnectionKey(mcpDb, ISSUER, parseConnectionKey(key)!);
    const made = await createConnectionKey(appDb, keyUser, keyBinding, {
      name: "Fictional nightly job",
      scope: "read",
      expiry: 30,
    });
    assert.deepEqual(
      (await listConnectionKeys(appDb, keyUser, keyBinding)).active.map(
        (k) => k.id,
      ),
      [made.record.id],
    );
    assert.deepEqual(await keyCheck(made.key), {
      ok: true,
      userId: keyUser,
      keyId: made.record.id,
      scope: "read",
    });
    assert.equal(
      (
        await owner.query(
          "SELECT last_used_at IS NOT NULL AS used FROM connection_keys WHERE id=$1",
          [made.record.id],
        )
      ).rows[0].used,
      true,
    );
    // A key presented for another issuer is refused.
    assert.equal(
      (
        await authenticateConnectionKey(
          mcpDb,
          "https://other.example/auth",
          parseConnectionKey(made.key)!,
        )
      ).ok,
      false,
    );
    for (const [pool, statement] of [
      [
        mcpPool,
        `INSERT INTO connection_keys(id,user_id,issuer,subject,incarnation,generation,secret_hash,name,scope) VALUES('${"B".repeat(22)}','${keyUser}','${ISSUER}','${nativeKeyUser.id}','${nativeKeyUser.incarnation}','${nativeKeyUser.generation}','${"0".repeat(64)}','Forged','read_write')`,
      ],
      [mcpPool, "UPDATE connection_keys SET revoked_at=NULL"],
      [mcpPool, "UPDATE connection_keys SET scope='read_write'"],
      [mcpPool, "UPDATE connection_keys SET generation='f:999999'"],
      [mcpPool, "DELETE FROM connection_keys"],
      [appPool, "UPDATE connection_keys SET last_used_at=now()"],
      [appPool, "UPDATE connection_keys SET scope='read_write'"],
      [appPool, "UPDATE connection_keys SET generation='f:999999'"],
      [appPool, "UPDATE connection_keys SET incarnation='f:999999'"],
      [appPool, "UPDATE connection_keys SET subject='other'"],
      [appPool, "SELECT secret_hash FROM connection_keys"],
      [appPool, "SELECT * FROM connection_keys"],
      [appPool, "DELETE FROM connection_keys"],
      [authPool, "SELECT id FROM connection_keys"],
      [authPool, `SELECT milton_guard.connection_key_status('a','b','c')`],
    ] as const)
      await assert.rejects(
        pool.query(statement),
        (e: { code?: string }) => e.code === "42501",
        statement,
      );
    // Without the native 007 function (a database restored from before it),
    // every key is refused as an outage (fail closed), with nothing stored.
    await authOwner.query(`DROP FUNCTION ${keyStatus}`);
    assert.equal(await keyStatusShape(), undefined);
    await assert.rejects(keyCheck(made.key), (e) => e instanceof StoreError);
    await assert.rejects(
      createConnectionKey(appDb, keyUser, keyBinding, {
        name: "Fictional refused",
        scope: "read",
        expiry: 30,
      }),
      (e) => e instanceof StoreError,
    );
    await authOwner.query(
      readFileSync(
        new URL(
          "../apps/auth/migrations/007-connection-key-status.up.sql",
          sourceRoot,
        ),
        "utf8",
      ),
    );
    assert.deepEqual(await keyStatusShape(), keyStatusGrants);
    assert.equal((await keyCheck(made.key)).ok, true);
    assert.equal(
      await revokeConnectionKey(appDb, keyUser, made.record.id),
      true,
    );
    assert.deepEqual(await keyCheck(made.key), { ok: false });
    // Account deletion by the app runtime removes the account's keys.
    await createConnectionKey(appDb, keyUser, keyBinding, {
      name: "Fictional CI",
      scope: "read_write",
      expiry: null,
    });
    await appPool.query("DELETE FROM users WHERE id=$1", [keyUser]);
    assert.equal(
      (
        await owner.query(
          "SELECT count(*)::int n FROM connection_keys WHERE user_id=$1",
          [keyUser],
        )
      ).rows[0].n,
      0,
    );
    await authOwner.query(`DELETE FROM milton_auth."user" WHERE id=$1`, [
      nativeKeyUser.id,
    ]);
  }
  pass(
    "real TLS login roles separate native secrets, app credentials and writing with no DDL/TEMP path; connection-key grants hold on real roles; production DB errors map safely and preserve callbacks/rollback",
  );
  const nativeConfig: Config = {
    AUTH_DATABASE_URL: url("auth"),
    AUTH_SECRET: secret(),
    AUTH_ADMISSION_SECRET: secret(),
    AUTH_RATE_SECRET: secret(),
    AUTH_APP_CLIENT_ID: "before-provision",
    AUTH_GOOGLE_CLIENT_ID: "fictional-google",
    AUTH_GOOGLE_CLIENT_SECRET: secret(),
    AUTH_GITHUB_CLIENT_ID: "fictional-github",
    AUTH_GITHUB_CLIENT_SECRET: secret(),
    AUTH_RESEND_API_KEY: "fictional-not-sent",
    AUTH_MAIL_FROM: "auth@notifications.meetmilton.com",
    PORT: 20203,
  };
  // TLS regression uses production defaults, never the injected fixture pool.
  const omitted = new URL(url("auth"));
  omitted.searchParams.delete("sslmode");
  omitted.searchParams.delete("sslrootcert");
  const defaults = createProvider({
    ...nativeConfig,
    AUTH_DATABASE_URL: omitted.href,
  });
  try {
    await assert.rejects(
      defaults.pool.query("SELECT 1"),
      (error) =>
        ["DEPTH_ZERO_SELF_SIGNED_CERT", "SELF_SIGNED_CERT_IN_CHAIN"].includes(
          String((error as { code?: string }).code),
        ),
      "native default pool must negotiate TLS and reject an untrusted CA when mode is omitted",
    );
  } finally {
    await defaults.pool.end();
  }
  for (const query of [
    "sslmode=disable",
    "sslmode=prefer",
    "sslmode=verify-ca",
    "sslmode=no-verify",
    "ssl=false",
    "ssl=true",
    "uselibpqcompat=true",
    "sslmode=verify-full&sslmode=disable",
    "sslmode=require&sslrootcert=a&sslrootcert=b",
    "SSLMODE=disable",
    "sslcert=a",
    "options=a&options=b",
  ])
    assert.throws(
      () =>
        createProvider({
          ...nativeConfig,
          AUTH_DATABASE_URL: omitted.href + "?" + query,
        }),
      /verified_auth_database_tls_required/,
    );
  const childEnv = {
    PATH: process.env.PATH!,
    LC_ALL: "C",
    NODE_EXTRA_CA_CERTS: cert,
    ...Object.fromEntries(
      Object.entries(nativeConfig).map(([k, v]) => [k, String(v)]),
    ),
    AUTH_DATABASE_URL: omitted.href,
  };
  const child = (args: string[], extra: Record<string, string> = {}) => {
    const result = spawnSync(process.execPath, args, {
      env: { ...childEnv, ...extra },
      encoding: "utf8",
    });
    assert.equal(
      result.status,
      0,
      "verified TLS child: " + result.stderr.slice(0, 300),
    );
    return result;
  };
  child([
    "--input-type=module",
    "-e",
    `import assert from 'node:assert/strict'; import { createProvider } from ${JSON.stringify(new URL("../apps/auth/src/provider.ts", sourceRoot).href)}; import { readConfig } from ${JSON.stringify(new URL("../apps/auth/src/config.ts", sourceRoot).href)}; const service=createProvider(readConfig(process.env)); try { const r=await service.pool.query('select ssl from pg_stat_ssl where pid=pg_backend_pid()'); assert.equal(r.rows[0].ssl,true); } finally { await service.pool.end(); }`,
  ]);
  const nativeOwnerUrl = new URL(ownerUrl);
  nativeOwnerUrl.searchParams.delete("sslmode");
  nativeOwnerUrl.searchParams.delete("sslrootcert");
  nativeOwnerUrl.searchParams.set("options", "-c role=milton_auth_owner");
  // A ledger from before native 007: the owner CLI applies only 007.
  await authOwner.query(
    `DROP FUNCTION ${keyStatus}; create table milton_credential.migration_ledger(name text primary key); insert into milton_credential.migration_ledger values('001-native'),('002-credential'),('003-mechanism'),('004-product'),('005-recovery'),('006-mail')`,
  );
  const ownerEnv = { AUTH_OWNER_DATABASE_URL: nativeOwnerUrl.href };
  child(
    [
      new URL("../apps/auth/scripts/migrate.ts", sourceRoot).pathname,
      "up",
      "--apply",
    ],
    ownerEnv,
  );
  child(
    [
      new URL("../apps/auth/scripts/maintain.ts", sourceRoot).pathname,
      "--apply",
    ],
    ownerEnv,
  );
  const ledger = async () =>
    (
      await owner.query<{ name: string }>(
        "SELECT name FROM milton_credential.migration_ledger ORDER BY name",
      )
    ).rows.map((r) => r.name);
  const nativeNames = [
    "001-native",
    "002-credential",
    "003-mechanism",
    "004-product",
    "005-recovery",
    "006-mail",
    "007-connection-key-status",
  ];
  assert.deepEqual(await keyStatusShape(), keyStatusGrants);
  assert.deepEqual(await ledger(), nativeNames);
  const provisionOutput = join(root, "fictional-fixed-client.json");
  child(
    [
      new URL("../apps/auth/scripts/provision.ts", sourceRoot).pathname,
      "--apply",
      provisionOutput,
    ],
    ownerEnv,
  );
  const fixed = JSON.parse(readFileSync(provisionOutput, "utf8")) as {
    AUTH_APP_CLIENT_ID: string;
    AUTH_APP_CLIENT_SECRET: string;
  };
  pass(
    "native default and owner CLI pools use verified TLS with omitted mode; unsafe/duplicate options and untrusted CA refuse",
  );
  nativeConfig.AUTH_APP_CLIENT_ID = fixed.AUTH_APP_CLIENT_ID;
  let app: ReturnType<typeof createMiltonApp>;
  const mail: { url: string; kind: string }[] = [];
  const { deliverMail } = await import("../../apps/auth/src/mail.ts");
  const drainMail = () =>
    deliverMail(authPool, nativeConfig, async (_input, init) => {
      const m = JSON.parse(String(init?.body)) as {
        text: string;
        subject: string;
      };
      mail.push({
        url: m.text.split("\n")[0]!.split(": ").slice(1).join(": "),
        kind: m.subject.startsWith("Verify") ? "verify" : "reset",
      });
      return new Response(null, { status: 200 });
    });
  let dropLinkNotification = false;
  let preservationFailure: "none" | "before" | "after" = "none";
  let preservationCalls = 0;
  const nativeService = createProvider(nativeConfig, {
    pool: authPool,
    boundaries: {
      fetch: async (input, init) => {
        if (
          String(input) ===
          "https://app.meetmilton.com/internal/auth/preserve-eligibility"
        ) {
          preservationCalls++;
          if (preservationFailure === "before")
            throw new Error("fictional_before_callback");
          const response = await app(
            new Request(String(input), {
              ...init,
              headers: {
                ...Object.fromEntries(new Headers(init?.headers)),
                Host: "app.meetmilton.com",
              },
            }),
          );
          if (preservationFailure === "after")
            throw new Error("fictional_after_callback");
          return response;
        }
        if (
          String(input) === "https://app.meetmilton.com/internal/auth/admit"
        ) {
          if (dropLinkNotification)
            throw new Error("fictional_link_notification_lost");
          const handoff = new Request(String(input), {
            ...init,
            headers: {
              ...Object.fromEntries(new Headers(init?.headers)),
              Host: "app.meetmilton.com",
            },
          });
          const [first, second] = await Promise.all([
            app(handoff.clone()),
            app(handoff.clone()),
          ]);
          assert.equal(first.status, 204, "native admission contract");
          assert.equal(second.status, 204, "concurrent native admission");
          return first;
        }
        throw new Error("external_network_refused");
      },
    },
  });
  // Native requests here come from one fixed client; network buckets key on it.
  const native = {
    ...nativeService,
    handler: (request: Request) => nativeService.handler(request, "127.0.0.1"),
  };
  const transport: NonNullable<RuntimeConfig["authFetch"]> = async (
    input,
    init,
  ) => {
    const u = new URL(String(input));
    assert.equal(u.origin, AUTH_ORIGIN);
    return native.handler(
      new Request(u, {
        method: init.method,
        headers: init.headers,
        body: init.body as BodyInit | undefined,
        signal: init.signal,
      }),
    );
  };
  const config = runtimeConfig({
    NODE_ENV: "production",
    AUTH_ISSUER: ISSUER,
    APP_ORIGIN: "https://app.meetmilton.com",
    MCP_RESOURCE: "https://mcp.meetmilton.com/mcp",
    DATABASE_URL: url("app"),
    AUTH_APP_CLIENT_ID: fixed.AUTH_APP_CLIENT_ID,
    AUTH_APP_CLIENT_SECRET: fixed.AUTH_APP_CLIENT_SECRET,
    AUTH_ADMISSION_SECRET: nativeConfig.AUTH_ADMISSION_SECRET,
    MILTON_TRIAL_FINGERPRINT_KEY: fingerprintKey,
  });
  // Drives an account change for a session the script already holds. As before,
  // only the native proof at the start of a deletion checks freshness.
  const lifecycleFor = (user: SessionUser, token: string) =>
    lifecycle({
      config,
      token,
      signedIn: async () => user,
      fresh: async () => {},
    });
  const stripe = {
    customers: 0,
    subscriptions: 0,
    deleteDown: false,
    deleted: false,
  };
  config.billing = {
    secretKey: "rk_test_fixtureNotAKey",
    webhookSecret: "whsec_fixtureNotASecret",
    priceId: "price_fixture",
    fetch: async (input, init) => {
      const path = new URL(input).pathname;
      if (path === "/v1/customers" && init.method === "POST") {
        stripe.customers++;
        return Response.json({ id: "cus_fixture" });
      }
      if (path === "/v1/subscriptions" && init.method === "GET")
        return Response.json({ data: [] });
      if (path === "/v1/subscriptions" && init.method === "POST") {
        stripe.subscriptions++;
        const now = Math.floor(Date.now() / 1000);
        return Response.json({
          id: "sub_fixture",
          status: "trialing",
          created: now,
          trial_end: now + 30 * 86400,
          items: {
            data: [
              {
                current_period_start: now,
                current_period_end: now + 30 * 86400,
              },
            ],
          },
        });
      }
      if (path === "/v1/customers/cus_fixture" && init.method === "DELETE") {
        if (stripe.deleteDown) return Response.json({}, { status: 503 });
        stripe.deleted = true;
        return Response.json({ deleted: true });
      }
      if (path === "/v1/customers/cus_fixture" && init.method === "GET")
        return Response.json({ deleted: stripe.deleted });
      throw new Error("unexpected_fictional_stripe_request");
    },
  };
  await owner.query("UPDATE public.store_config SET trials_enabled=true");
  config.authFetch = transport;
  app = createMiltonApp(config, true);
  const authCookies = new Map<string, string>(),
    appCookies = new Map<string, string>();
  const request = async (
    handler: (r: Request) => Promise<Response>,
    url: string,
    jar: Map<string, string>,
    body?: Record<string, unknown>,
    form = false,
  ) => {
    const u = new URL(url),
      headers = new Headers({
        Host: u.host,
        Origin: u.origin,
        Accept: "text/html",
        Cookie: [...jar].map(([k, v]) => k + "=" + v).join("; "),
      });
    if (body)
      headers.set(
        "Content-Type",
        form ? "application/x-www-form-urlencoded" : "application/json",
      );
    const response = await handler(
      new Request(u, {
        method: body ? "POST" : "GET",
        headers,
        ...(body
          ? {
              body: form
                ? new URLSearchParams(
                    Object.fromEntries(
                      Object.entries(body).map(([k, v]) => [k, String(v)]),
                    ),
                  )
                : JSON.stringify(body),
            }
          : {}),
      }),
    );
    await drainMail();
    for (const cookie of response.headers.getSetCookie()) {
      assert(!/;\s*Domain=/i.test(cookie));
      const pair = cookie.split(";")[0]!;
      const i = pair.indexOf("=");
      if (/Max-Age=0/i.test(cookie)) jar.delete(pair.slice(0, i));
      else jar.set(pair.slice(0, i), pair.slice(i + 1));
    }
    return response;
  };
  const password = "Fictional forest password with spaces 239";
  assert.equal(
    (
      await request(native.handler, ISSUER + "/sign-up/email", authCookies, {
        name: "Fictional Person",
        email: "person@example.invalid",
        password,
      })
    ).status,
    200,
  );
  assert.equal(authCookies.size, 0);
  assert.equal((await native.handler(new Request(mail[0]!.url))).status, 302);
  assert.equal(
    (
      await request(native.handler, ISSUER + "/sign-in/email", authCookies, {
        email: "person@example.invalid",
        password,
      })
    ).status,
    200,
  );
  const session = (await (
    await request(native.handler, ISSUER + "/get-session", authCookies)
  ).json()) as { user: { id: string }; session: { id: string } };
  assert(session.user.id && session.session.id);
  pass(
    "actual native verified password signup/signin establishes independent host-only auth cookie",
  );
  const login = await request(
    app,
    "https://app.meetmilton.com/login",
    appCookies,
  );
  assert.equal(login.status, 303);
  const authorized = await request(
    native.handler,
    login.headers.get("Location")!,
    authCookies,
  );
  assert(
    [302, 303].includes(authorized.status),
    "native admission and fixed-app authorization must succeed (verifiedIdentities contract required)",
  );
  const callback = authorized.headers.get("Location");
  assert(callback && callback.startsWith(config.appOrigin + "/auth/callback?"));
  const returned = await request(app, callback, appCookies);
  assert.equal(
    returned.status,
    303,
    "actual maintained-client native callback",
  );
  assert([...appCookies.keys()].includes("__Host-milton-session"));
  assert(![...appCookies.keys()].some((k) => authCookies.has(k)));
  assert.equal(
    (await request(app, config.appOrigin + "/tps-report", appCookies)).status,
    200,
  );
  assert.equal((await request(app, callback, appCookies)).status, 401);
  assert.equal(stripe.customers, 1);
  assert.equal(stripe.subscriptions, 1);
  pass(
    "actual product callback, app-only cookie, writing read, one-use replay and concurrent admission/one trial",
  );
  await owner.query(
    'delete from milton_auth."rateLimit"; delete from milton_guard.rate_bucket',
  );
  const registration = await request(
    native.handler,
    ISSUER + "/oauth2/register",
    authCookies,
    {
      client_name: "Fictional controlled assistant",
      redirect_uris: ["https://assistant.example.invalid/callback"],
      token_endpoint_auth_method: "client_secret_post",
      scope: "openid offline_access milton:read milton:write",
      grant_types: ["authorization_code", "refresh_token"],
    },
  );
  assert.equal(registration.status, 201);
  const assistant = (await registration.json()) as {
    client_id: string;
    client_secret: string;
  };
  const assistantClient = await oidc.discovery(
    new URL(ISSUER),
    assistant.client_id,
    { id_token_signed_response_alg: "EdDSA" },
    oidc.ClientSecretPost(assistant.client_secret),
    {
      [oidc.customFetch]: transport,
      execute: [oidc.enableNonRepudiationChecks],
      timeout: 5,
    },
  );
  const authorizeAssistant = async (scope: string) => {
    const state = oidc.randomState(),
      nonce = oidc.randomNonce(),
      verifier = oidc.randomPKCECodeVerifier();
    const authorize = oidc.buildAuthorizationUrl(assistantClient, {
      redirect_uri: "https://assistant.example.invalid/callback",
      scope,
      resource: config.resource,
      state,
      nonce,
      code_challenge: await oidc.calculatePKCECodeChallenge(verifier),
      code_challenge_method: "S256",
    });
    const response = await request(native.handler, authorize.href, authCookies);
    let destination = response.headers.get("Location");
    if (!destination)
      destination = ((await response.json()) as { url: string }).url;
    assert(destination);
    if (new URL(destination, AUTH_ORIGIN).pathname === "/consent") {
      const choice = await request(
        native.handler,
        ISSUER + "/oauth2/consent",
        authCookies,
        {
          accept: true,
          scope,
          oauth_query: new URL(
            destination,
            AUTH_ORIGIN,
          ).searchParams.toString(),
        },
      );
      assert.equal(choice.status, 200);
      destination = ((await choice.json()) as { url: string }).url;
    }
    return oidc.authorizationCodeGrant(
      assistantClient,
      new URL(destination, AUTH_ORIGIN),
      {
        expectedState: state,
        expectedNonce: nonce,
        pkceCodeVerifier: verifier,
      },
      { resource: config.resource },
    );
  };
  const grant = await authorizeAssistant(
    "openid offline_access milton:read milton:write",
  );
  assert(grant.refresh_token);
  const mcpConfig = {
    issuer: ISSUER,
    resource: config.resource,
    appOrigin: config.appOrigin,
    DATABASE_URL: url("mcp"),
  };
  const verifier = createAccessTokenVerifier(mcpConfig, async (input, init) =>
    native.handler(new Request(input, init)),
  );
  const mcp = createMiltonHandler(mcpConfig, verifier, () => {});
  const rpc = (
    access: string,
    method: string,
    params: unknown = {},
    extra: Record<string, string> = {},
  ) =>
    mcp(
      new Request(config.resource, {
        method: "POST",
        headers: {
          ...extra,
          Host: "mcp.meetmilton.com",
          Authorization: "Bearer " + access,
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      }),
    );
  const result = async (response: Response) => {
    assert.equal(response.status, 200, "MCP HTTP response");
    const text = await response.text();
    const messages =
      text.startsWith("event:") || text.startsWith("data:")
        ? text
            .split("\n")
            .filter((line) => line.startsWith("data: "))
            .map((line) => JSON.parse(line.slice(6)))
        : [JSON.parse(text)];
    const message = messages.find((value: { id?: number }) => value.id === 1);
    assert(
      message?.result,
      "MCP request result must follow any tool-change notifications",
    );
    return message as {
      result: {
        tools?: { name: string }[];
        content?: { text: string }[];
        isError?: boolean;
      };
    };
  };
  stage = "MCP tools/list";
  const list = await rpc(grant.access_token, "tools/list");
  assert.equal(list.status, 200, "actual native JWT profile and MCP role");
  assert.equal((await result(list)).result.tools?.length, 4);
  stage = "MCP cover sheet";
  const read = await result(
    await rpc(grant.access_token, "tools/call", {
      name: "get_cover_sheet",
      arguments: {},
    }),
  );
  assert.equal(read.result.isError, undefined);
  const cover = JSON.parse(read.result.content![0]!.text) as {
    version: string;
  };
  stage = "MCP save";
  const save = await result(
    await rpc(grant.access_token, "tools/call", {
      name: "create_memo",
      arguments: {
        text: "Keep fictional measurements explicit.",
        rules: [
          { report: "cover", text: "Keep fictional measurements explicit." },
        ],
        sample: {
          report: "email",
          new_kind: "fictional note",
          context: { version: 1, summary: "Fictional pickup note" },
          text: "Collect the fictional trays on Saturday.",
        },
        expected_version: cover.version,
        request_id: crypto.randomUUID(),
      },
    }),
  );
  assert.equal(
    save.result.isError,
    undefined,
    "real-role model-free writing save",
  );
  stage = "MCP charge against account deletion";
  {
    // A deletion that holds the account lock first: the charge waits for it,
    // then refuses with account_unavailable.
    const raced = "m_00000000-0000-4000-8000-0000000000c3";
    await owner.query("INSERT INTO users(id) VALUES($1)", [raced]);
    await owner.query(
      "INSERT INTO identities(provider,subject,user_id) VALUES('fictional-charge','charge-race',$1)",
      [raced],
    );
    const store = await storeForCurrentRequest(
      mcpConfig,
      await lookupIdentityAccount(mcpConfig, {
        provider: "fictional-charge",
        subject: "charge-race",
      }),
    );
    assert.deepEqual(await store.chargeToolCall(), { allowed: true });
    const deletion = await owner.connect();
    let settled = false;
    let charge: Promise<unknown> = Promise.resolve();
    try {
      await deletion.query("BEGIN");
      await deletion.query("SELECT id FROM users WHERE id=$1 FOR UPDATE", [
        raced,
      ]);
      charge = store.chargeToolCall().finally(() => (settled = true));
      charge.catch(() => {});
      await new Promise((resolve) => setTimeout(resolve, 300));
      assert.equal(settled, false, "the charge waits on the account lock");
      await deletion.query("DELETE FROM users WHERE id=$1", [raced]);
      await deletion.query("COMMIT");
    } finally {
      deletion.release();
    }
    await assert.rejects(
      charge,
      (error) =>
        error instanceof StoreError && error.code === "account_unavailable",
    );
  }
  stage = "read-only native authorization";
  const readGrant = await authorizeAssistant(
    "openid offline_access milton:read",
  );
  const roList = await rpc(readGrant.access_token, "tools/list");
  assert.equal(roList.status, 200);
  assert.equal((await result(roList)).result.tools?.length, 3);
  assert.equal(
    (
      await rpc(readGrant.access_token, "tools/call", {
        name: "create_memo",
        arguments: {},
      })
    ).status,
    403,
  );
  await authOwner.query(
    "REVOKE EXECUTE ON FUNCTION milton_guard.binding_status(text,text,text,text[],text[]) FROM milton_mcp_runtime",
  );
  assert.equal((await rpc(readGrant.access_token, "tools/list")).status, 503);
  await authOwner.query(
    "GRANT EXECUTE ON FUNCTION milton_guard.binding_status(text,text,text,text[],text[]) TO milton_mcp_runtime",
  );
  assert.equal((await rpc(readGrant.access_token, "tools/list")).status, 200);
  await authOwner.query(
    "REVOKE EXECUTE ON FUNCTION milton_guard.app_status(text,text,text,text,text,text) FROM milton_app_runtime",
  );
  assert.equal(
    (await request(app, config.appOrigin + "/tps-report", appCookies)).status,
    503,
  );
  await authOwner.query(
    "GRANT EXECUTE ON FUNCTION milton_guard.app_status(text,text,text,text,text,text) TO milton_app_runtime",
  );
  assert.equal(
    (await request(app, config.appOrigin + "/tps-report", appCookies)).status,
    200,
  );
  pass(
    "actual native controlled code/refresh grant reaches scoped product MCP: four/three tools and model-free save",
  );
  // Connection keys against real native authority (native 007): created through
  // the app from a fresh session, checked by the real MCP role on every call.
  stage = "connection keys bound to native authority";
  // Each key call comes from its own client behind the load balancer (TEST-NET
  // addresses), so failed lookups never drain one shared "unknown" bucket.
  let keyClients = 0;
  const keyCall = async (key: string) => {
    const response = await rpc(
      key,
      "tools/list",
      {},
      { "X-Forwarded-For": `198.51.100.${++keyClients}, 192.0.2.1` },
    );
    await response.body?.cancel();
    return response.status;
  };
  const appKey = async (name: string) => {
    await request(app, config.appOrigin + "/assistants", appCookies);
    const created = await request(
      app,
      config.appOrigin + "/assistants/keys",
      appCookies,
      {
        csrf: appCookies.get("__Host-milton-csrf")!,
        name,
        scope: "read_write",
        expiry: "never",
      },
      true,
    );
    assert.equal(created.status, 200, "app creates a key from a fresh session");
    return /mk_[A-Za-z0-9_-]{22}_[A-Za-z0-9_-]{43}/.exec(
      await created.text(),
    )![0];
  };
  // A key row as it would be committed, with any binding (owner fixture only).
  const storedKey = async (
    userId: string,
    b: { subject: string; incarnation: string; generation: string },
  ) => {
    const id = randomBytes(16).toString("base64url"),
      keySecret = randomBytes(32).toString("base64url");
    await owner.query(
      "INSERT INTO connection_keys(id,user_id,issuer,subject,incarnation,generation,secret_hash,name,scope) VALUES($1,$2,$3,$4,$5,$6,$7,'Fictional fixture','read')",
      [
        id,
        userId,
        ISSUER,
        b.subject,
        b.incarnation,
        b.generation,
        createHash("sha256").update(keySecret).digest("hex"),
      ],
    );
    return `mk_${id}_${keySecret}`;
  };
  const keyRevoked = async (key: string) =>
    (
      await owner.query(
        "SELECT revoked_at IS NOT NULL AS revoked FROM connection_keys WHERE id=$1",
        [key.slice(3, 25)],
      )
    ).rows[0].revoked as boolean;
  const personAccount = await lookupIdentityAccount(config, {
    provider: ISSUER,
    subject: session.user.id,
  });
  const racedKeys: string[] = [];
  const beforeRecoveryKey = await appKey("Fictional nightly job");
  assert.equal(await keyCall(beforeRecoveryKey), 200);
  // An unrelated account, with its own native subject and key.
  const unrelated = (
    await authOwner.query<{
      id: string;
      incarnation: string;
      generation: string;
    }>(
      `INSERT INTO milton_auth."user"(id,name,email,"emailVerified") VALUES('fictional-unrelated-subject','Fictional','unrelated@example.invalid',true) RETURNING id,"miltonIdentityIncarnation" incarnation,"miltonSecurityGeneration" generation`,
    )
  ).rows[0]!;
  const unrelatedUser = "m_00000000-0000-4000-8000-0000000000c1";
  await owner.query("INSERT INTO users(id) VALUES($1)", [unrelatedUser]);
  await owner.query(
    "INSERT INTO identities(provider,subject,user_id) VALUES($1,$2,$3)",
    [ISSUER, unrelated.id, unrelatedUser],
  );
  const unrelatedKey = (
    await createConnectionKey(
      postgresDatabase(url("app")),
      unrelatedUser,
      {
        issuer: ISSUER,
        subject: unrelated.id,
        incarnation: unrelated.incarnation,
        generation: unrelated.generation,
      },
      { name: "Fictional unrelated", scope: "read", expiry: null },
    )
  ).key;
  assert.equal(await keyCall(unrelatedKey), 200);
  let row = (
    await appPool.query(
      "SELECT subject,sid,binding,incarnation,generation FROM milton_app.session ORDER BY created_at DESC LIMIT 1",
    )
  ).rows[0];
  assert(row);
  assert(await appActive(config, row));
  let user = { ...row, id: row.subject };
  let token = appCookies.get("__Host-milton-session")!;
  const disconnect = crypto.randomUUID();
  const disconnects = lifecycleFor(user, token);
  assert.equal(
    (
      await disconnects.run(
        "disconnect",
        disconnect,
        (await connections(config, user)).items.find(
          (c) => c.client_id === assistant.client_id,
        )?.reference,
      )
    ).operation.progress,
    "complete",
  );
  assert.equal((await rpc(grant.access_token, "tools/list")).status, 401);
  assert.equal((await rpc(readGrant.access_token, "tools/list")).status, 401);
  const reconnect = await authorizeAssistant(
    "openid offline_access milton:read",
  );
  assert(reconnect.refresh_token);
  assert.equal(
    (await disconnects.run("disconnect", disconnect)).operation.progress,
    "complete",
  );
  assert.equal((await rpc(reconnect.access_token, "tools/list")).status, 200);
  assert.equal((await rpc(grant.access_token, "tools/list")).status, 401);
  pass(
    "app-owned persisted disconnect/reconnect retries cannot revive old bindings or remove a new grant",
  );
  stage = "fixed-client app/native RP logout";
  // Ordinary native logout must leave offline assistants independent of sid.
  await request(app, config.appOrigin + "/tps-report", appCookies);
  const logout = await request(
    app,
    config.appOrigin + "/logout",
    appCookies,
    { csrf: appCookies.get("__Host-milton-csrf")! },
    true,
  );
  assert.equal(logout.status, 200);
  const logoutUrl = /content="0;url=([^"]+)"/
    .exec(await logout.text())?.[1]
    ?.replaceAll("&amp;", "&");
  assert(logoutUrl);
  assert.equal(
    new URL(logoutUrl).searchParams.get("post_logout_redirect_uri"),
    config.appOrigin + "/auth/logged-out",
  );
  const confirmation = await request(native.handler, logoutUrl, authCookies);
  assert.equal(confirmation.status, 200);
  const completed = await request(
    native.handler,
    ISSUER + "/oauth2/end-session/confirm",
    authCookies,
    { action: "confirm" },
    true,
  );
  assert.equal(completed.status, 302);
  assert.equal(
    completed.headers.get("Location"),
    config.appOrigin + "/auth/logged-out",
  );
  assert.equal(await appActive(config, row), false);
  assert.equal(
    (await request(app, config.appOrigin + "/tps-report", appCookies)).status,
    403,
  );
  const refreshed = await oidc.refreshTokenGrant(
    assistantClient,
    reconnect.refresh_token,
    { resource: config.resource },
  );
  assert.equal((await rpc(refreshed.access_token, "tools/list")).status, 200);
  await request(
    native.handler,
    ISSUER + "/request-password-reset",
    authCookies,
    { email: "person@example.invalid" },
  );
  const reset = mail.findLast((m) => m.kind === "reset");
  assert(reset);
  const recovery = decodeURIComponent(
    new URL(reset.url).pathname.split("/").at(-1)!,
  );
  assert(recovery);
  const nextPassword = "A new fictional forest password 974";
  assert.equal(
    (
      await request(native.handler, ISSUER + "/reset-password", authCookies, {
        token: recovery,
        newPassword: nextPassword,
      })
    ).status,
    200,
  );
  assert.equal((await rpc(refreshed.access_token, "tools/list")).status, 401);
  await assert.rejects(
    oidc.refreshTokenGrant(assistantClient, refreshed.refresh_token!, {
      resource: config.resource,
    }),
  );
  // Recovery fences connection keys too, and only this account's.
  assert.equal(await keyCall(beforeRecoveryKey), 401);
  assert.equal(await keyCall(unrelatedKey), 200);
  pass(
    "actual offline refresh survives ordinary browser logout; native recovery fences access and refresh",
  );
  assert.equal(
    (
      await request(native.handler, ISSUER + "/sign-in/email", authCookies, {
        email: "person@example.invalid",
        password: nextPassword,
      })
    ).status,
    200,
  );
  // Owner fixture ages only the original native session; the new app cookie
  // must not turn this old SSO proof into a fresh destructive-action proof.
  await authOwner.query(
    `UPDATE milton_auth.session SET "createdAt"=now()-interval '10 minutes' WHERE "userId"=$1`,
    [session.user.id],
  );
  const newLogin = await request(app, config.appOrigin + "/login", appCookies);
  assert.equal(newLogin.status, 303);
  const newAuthorization = await request(
    native.handler,
    newLogin.headers.get("Location")!,
    authCookies,
  );
  const newCallback = newAuthorization.headers.get("Location");
  assert(newCallback);
  assert.equal((await request(app, newCallback, appCookies)).status, 303);
  row = (
    await appPool.query(
      "SELECT subject,sid,binding,incarnation,generation FROM milton_app.session ORDER BY created_at DESC LIMIT 1",
    )
  ).rows[0];
  assert(row);
  user = { ...row, id: row.subject };
  token = appCookies.get("__Host-milton-session")!;
  const firstDeletePage = await request(
    app,
    config.appOrigin + "/account/delete",
    appCookies,
  );
  const staleOperation = /name="operation" value="([^"]+)"/.exec(
    await firstDeletePage.text(),
  )?.[1];
  assert(staleOperation);
  const deleteForm = (operation: string) => ({
    csrf: appCookies.get("__Host-milton-csrf")!,
    operation,
    confirm: "delete my account",
  });
  assert.equal(
    (
      await request(
        app,
        config.appOrigin + "/account/delete",
        appCookies,
        deleteForm(staleOperation),
        true,
      )
    ).status,
    403,
    "new local cookie cannot freshen old native SSO",
  );
  assert.equal(
    (
      await appPool.query(
        "SELECT count(*)::int n FROM milton_app.lifecycle WHERE kind='delete'",
      )
    ).rows[0].n,
    0,
  );
  {
    // A security-generation change (as the native credential/method triggers
    // make it) stops a key; a key created racing it is refused at creation, and
    // one whose insert committed after the change never authenticates.
    const snapshot = {
      issuer: ISSUER,
      subject: row.subject,
      incarnation: row.incarnation,
      generation: row.generation,
    };
    const appDb = postgresDatabase(url("app"));
    const current = await createConnectionKey(
      appDb,
      personAccount.userId,
      snapshot,
      { name: "Fictional current", scope: "read", expiry: 30 },
    );
    assert.equal(await keyCall(current.key), 200);
    await authOwner.query(
      `UPDATE milton_auth."user" SET "miltonSecurityGeneration"=milton_credential.next_fence() WHERE id=$1`,
      [row.subject],
    );
    assert.equal(await keyCall(current.key), 401);
    await assert.rejects(
      createConnectionKey(appDb, personAccount.userId, snapshot, {
        name: "Fictional racing",
        scope: "read",
        expiry: 30,
      }),
      (e) => e instanceof StoreError && e.code === "session_required",
    );
    const committedLate = await storedKey(personAccount.userId, snapshot);
    assert.equal(await keyCall(committedLate), 401);
    assert.equal(await keyCall(unrelatedKey), 200);
    racedKeys.push(current.key, committedLate);
  }
  assert.equal(
    (
      await request(native.handler, ISSUER + "/sign-in/email", authCookies, {
        email: "person@example.invalid",
        password: nextPassword,
      })
    ).status,
    200,
  );
  const freshLogin = await request(
    app,
    config.appOrigin + "/login",
    appCookies,
  );
  const freshAuthorization = await request(
    native.handler,
    freshLogin.headers.get("Location")!,
    authCookies,
  );
  assert.equal(
    (
      await request(
        app,
        freshAuthorization.headers.get("Location")!,
        appCookies,
      )
    ).status,
    303,
  );
  row = (
    await appPool.query(
      "SELECT subject,sid,binding,incarnation,generation FROM milton_app.session ORDER BY created_at DESC LIMIT 1",
    )
  ).rows[0];
  assert(row);
  token = appCookies.get("__Host-milton-session")!;
  // A fresh session after the changes creates a working key; doing so retires
  // the keys bound to earlier generations, which can never work again.
  const deletionKey = await appKey("Fictional after recovery");
  assert.equal(await keyCall(deletionKey), 200);
  for (const dead of [beforeRecoveryKey, ...racedKeys])
    assert.equal(await keyRevoked(dead), true, "dead key retired");
  assert.equal(await keyRevoked(unrelatedKey), false);
  const deletePage = await request(
    app,
    config.appOrigin + "/account/delete",
    appCookies,
  );
  assert.equal(deletePage.status, 200);
  const operation = /name="operation" value="([^"]+)"/.exec(
    await deletePage.text(),
  )?.[1];
  assert(operation);
  assert.equal(
    (
      await request(
        app,
        config.appOrigin + "/account/delete",
        appCookies,
        { ...deleteForm(operation), confirm: "wrong confirmation" },
        true,
      )
    ).status,
    400,
  );
  stripe.deleteDown = true;
  const failedDeletion = await request(
    app,
    config.appOrigin + "/account/delete",
    appCookies,
    deleteForm(operation),
    true,
  );
  assert.equal(failedDeletion.status, 503);
  await failedDeletion.body?.cancel();
  const deletions = lifecycleFor(user, token);
  const [deletion] = await deletions.pending("delete");
  assert(deletion);
  const retry = await request(
    app,
    config.appOrigin + "/account/delete",
    appCookies,
  );
  assert.equal(retry.status, 503);
  assert((await retry.text()).includes(operation));
  assert.equal(
    (
      await owner.query("SELECT count(*)::int n FROM users WHERE id=$1", [
        deletion.user_id,
      ])
    ).rows[0].n,
    1,
    "Stripe failure preserves writing account",
  );
  // Deletion has begun natively; the writing account is still active, yet
  // the key is refused, as is a key bound to the post-deletion snapshot.
  assert.equal(
    (
      await owner.query("SELECT status FROM users WHERE id=$1", [
        deletion.user_id,
      ])
    ).rows[0].status,
    "active",
  );
  assert.equal(await keyCall(deletionKey), 401);
  const afterBegin = (
    await authOwner.query<{ incarnation: string; generation: string }>(
      `SELECT "miltonIdentityIncarnation" incarnation,"miltonSecurityGeneration" generation FROM milton_auth."user" WHERE id=$1 AND "emailVerified"`,
      [row.subject],
    )
  ).rows[0]!;
  assert.equal(
    await keyCall(
      await storedKey(deletion.user_id, {
        subject: row.subject,
        ...afterBegin,
      }),
    ),
    401,
    "pending deletion refuses even an exactly current snapshot",
  );
  assert.equal(await keyCall(unrelatedKey), 200);
  pass(
    "connection keys follow native authority: recovery, a generation change, a creation race and a begun deletion each refuse; dead keys retire; an unrelated account's key keeps working",
  );
  assert.equal(
    (
      await appPool.query(
        "SELECT progress FROM milton_app.lifecycle WHERE operation_id=$1",
        [deletion.operation_id],
      )
    ).rows[0].progress,
    "refused",
  );
  const rollbackProbe = await appOwner.connect();
  try {
    await assert.rejects(
      rollbackProbe.query(
        readFileSync(
          new URL("./migrations/005-app.down.sql", sourceRoot),
          "utf8",
        ),
      ),
    );
    await rollbackProbe.query("ROLLBACK");
  } finally {
    rollbackProbe.release();
  }
  stripe.deleteDown = false;
  const completedDeletion = await request(
    app,
    config.appOrigin + "/account/delete",
    appCookies,
    deleteForm(operation),
    true,
  );
  assert.equal(completedDeletion.status, 200);
  assert((await completedDeletion.text()).includes("Account deleted"));
  const { operation: finished } = await deletions.run(
    "delete",
    deletion.operation_id,
  );
  assert.equal(finished.progress, "complete");
  assert.equal(await appActive(config, row), false);
  assert.equal(
    (
      await owner.query(
        'SELECT count(*)::int n FROM milton_auth."user" WHERE id=$1',
        [row.subject],
      )
    ).rows[0].n,
    0,
  );
  assert.equal(
    (
      await appPool.query(
        "SELECT progress FROM milton_app.lifecycle WHERE operation_id=$1",
        [deletion.operation_id],
      )
    ).rows[0].progress,
    "complete",
  );
  assert.equal(
    (await deletions.run("delete", deletion.operation_id)).operation.progress,
    "complete",
  );
  assert(stripe.deleted);
  pass(
    "Stripe-first failure/retry preserves writing, then actual native refusal/cleanup keeps the original operation",
  );
  await owner.query(
    'delete from milton_auth."rateLimit"; delete from milton_guard.rate_bucket',
  );
  assert.equal(
    (
      await request(native.handler, ISSUER + "/sign-up/email", authCookies, {
        name: "Fictional replacement",
        email: "person@example.invalid",
        password,
      })
    ).status,
    200,
  );
  const newMail = mail.findLast((m) => m.kind === "verify");
  assert(newMail);
  assert.equal((await native.handler(new Request(newMail.url))).status, 302);
  assert.equal(
    (
      await request(native.handler, ISSUER + "/sign-in/email", authCookies, {
        email: "person@example.invalid",
        password,
      })
    ).status,
    200,
  );
  const replacement = (await (
    await request(native.handler, ISSUER + "/get-session", authCookies)
  ).json()) as { user: { id: string } };
  assert.notEqual(replacement.user.id, row.subject);
  const replacementLogin = await request(
    app,
    config.appOrigin + "/login",
    appCookies,
  );
  const replacementAuth = await request(
    native.handler,
    replacementLogin.headers.get("Location")!,
    authCookies,
  );
  assert.equal(
    (await request(app, replacementAuth.headers.get("Location")!, appCookies))
      .status,
    303,
  );
  const replacementAccount = await lookupIdentityAccount(config, {
    provider: ISSUER,
    subject: replacement.user.id,
  });
  assert.notEqual(replacementAccount.userId, deletion.user_id);
  assert.equal(
    (
      await appPool.query(
        "SELECT subscription_status FROM trial_accounts WHERE user_id=$1",
        [replacementAccount.userId],
      )
    ).rows[0].subscription_status,
    "canceled",
  );
  assert.equal(stripe.customers, 1);
  assert.equal(stripe.subscriptions, 1);
  assert.equal(
    (await deletions.run("delete", deletion.operation_id)).operation.progress,
    "complete",
  );
  assert.equal(
    (
      await authPool.query(
        'SELECT count(*)::int n FROM milton_auth."user" WHERE id=$1',
        [replacement.user.id],
      )
    ).rows[0].n,
    1,
  );
  pass(
    "auth deletion/recreation keeps trial eligibility and replay cannot target the replacement account",
  );
  // PR-01: native callback commits, app notification never arrives, unlink, delete,
  // then the same stable provider with a changed email must not earn a new trial.
  {
    stage = "unlink eligibility preservation";
    const clearRates = () =>
      owner.query(
        'delete from milton_auth."rateLimit"; delete from milton_guard.rate_bucket',
      );
    const freshEmail = "unlink-preserve@example.invalid";
    const identity = "fictional-unlink-stable-google";
    const freshPassword = "Fictional unlink preservation password";
    authCookies.clear();
    appCookies.clear();
    const signIn = async (address = freshEmail) => {
      assert.equal(
        (
          await request(
            native.handler,
            ISSUER + "/sign-in/email",
            authCookies,
            { email: address, password: freshPassword },
          )
        ).status,
        200,
      );
    };
    const appLogin = async () => {
      const start = await request(app, config.appOrigin + "/login", appCookies);
      const authorized = await request(
        native.handler,
        start.headers.get("Location")!,
        authCookies,
      );
      assert.equal(
        (await request(app, authorized.headers.get("Location")!, appCookies))
          .status,
        303,
      );
    };
    await clearRates();
    await request(native.handler, ISSUER + "/sign-up/email", authCookies, {
      email: freshEmail,
      password: freshPassword,
      name: "Fictional unlink",
    });
    await native.handler(
      new Request(mail.findLast((m) => m.kind === "verify")!.url),
    );
    await signIn();
    await appLogin();
    const original = (
      await appPool.query(
        "select subject from milton_app.session order by created_at desc limit 1",
      )
    ).rows[0].subject;
    const originalAccount = await lookupIdentityAccount(config, {
      provider: ISSUER,
      subject: original,
    });
    const trialBefore = stripe.subscriptions;
    const nativeContext = await native.provider.$context;
    const google = nativeContext.socialProviders.find(
      (p) => p.id === "google",
    )!;
    google.validateAuthorizationCode = async () => ({
      accessToken: "fictional-only",
      scopes: ["openid", "email", "profile"],
    });
    let socialEmail = freshEmail;
    google.getUserInfo = async () => ({
      user: {
        email: socialEmail,
        emailVerified: true,
        name: "Fictional social",
      },
      data: { sub: identity, email: socialEmail, email_verified: true },
    });
    const social = async (link: boolean) => {
      const start = await request(
        native.handler,
        ISSUER + (link ? "/link-social" : "/sign-in/social"),
        authCookies,
        { provider: "google", callbackURL: AUTH_ORIGIN + "/security" },
      );
      assert.equal(start.status, 200);
      const state = new URL(
        ((await start.json()) as { url: string }).url,
      ).searchParams.get("state");
      return request(
        native.handler,
        ISSUER +
          "/callback/google?code=fictional-code&state=" +
          encodeURIComponent(state!),
        authCookies,
      );
    };
    dropLinkNotification = true;
    assert.equal((await social(true)).status, 503);
    dropLinkNotification = false;
    const linked = (
      await authPool.query(
        `select id from milton_auth.account where "userId"=$1 and "providerId"='google'`,
        [original],
      )
    ).rows[0];
    assert(linked, "link committed despite lost notification");
    await owner.query(
      "update trial_accounts set subscription_status='canceled' where user_id=$1",
      [originalAccount.userId],
    );
    const eligibilityCount = async () =>
      (
        await appPool.query(
          "select count(*)::int n from milton_app.account_fingerprint where user_id=$1",
          [originalAccount.userId],
        )
      ).rows[0].n;
    const beforePreservation = await eligibilityCount();
    preservationFailure = "before";
    assert.equal(
      (
        await request(native.handler, ISSUER + "/unlink-account", authCookies, {
          accountId: linked.id,
        })
      ).status,
      503,
    );
    assert.equal(await eligibilityCount(), beforePreservation);
    preservationFailure = "after";
    assert.equal(
      (
        await request(native.handler, ISSUER + "/unlink-account", authCookies, {
          accountId: linked.id,
        })
      ).status,
      503,
    );
    const afterPreservation = await eligibilityCount();
    assert(
      afterPreservation > beforePreservation,
      "callback committed eligibility before response was lost",
    );
    assert.equal(
      (
        await authPool.query(
          "select count(*)::int n from milton_auth.account where id=$1",
          [linked.id],
        )
      ).rows[0].n,
      1,
    );
    preservationFailure = "none";
    assert.equal(
      (
        await request(native.handler, ISSUER + "/unlink-account", authCookies, {
          accountId: linked.id,
        })
      ).status,
      200,
      "expired billing cannot prevent security removal",
    );
    assert.equal(
      await eligibilityCount(),
      afterPreservation,
      "retry is idempotent",
    );
    await clearRates();
    await signIn();
    await appLogin();
    const authority = (
      await appPool.query(
        "select subject,sid,binding,incarnation,generation from milton_app.session order by created_at desc limit 1",
      )
    ).rows[0];
    assert.equal(
      (
        await lifecycleFor(
          { ...authority, id: authority.subject },
          appCookies.get("__Host-milton-session")!,
        ).run("delete", randomUUID())
      ).operation.progress,
      "complete",
    );
    authCookies.clear();
    appCookies.clear();
    socialEmail = "unlink-changed@example.invalid";
    await clearRates();
    assert.equal((await social(false)).status, 302);
    await appLogin();
    const recreated = (
      await appPool.query(
        "select subject from milton_app.session order by created_at desc limit 1",
      )
    ).rows[0].subject;
    assert.notEqual(recreated, original);
    const recreatedAccount = await lookupIdentityAccount(config, {
      provider: ISSUER,
      subject: recreated,
    });
    assert.notEqual(
      recreatedAccount.userId,
      originalAccount.userId,
      "provider eligibility never merges writing",
    );
    assert.equal(
      (
        await appPool.query(
          "select subscription_status from trial_accounts where user_id=$1",
          [recreatedAccount.userId],
        )
      ).rows[0].subscription_status,
      "canceled",
      "removed stable identity must survive lost link notification and changed email",
    );
    assert.equal(stripe.subscriptions, trialBefore, "no second trial");
    // Unadmitted native-only subject: callback uncertainty cannot create writing or a trial.
    await clearRates();
    authCookies.clear();
    appCookies.clear();
    const nativeOnly = "unlink-native-only@example.invalid";
    await request(native.handler, ISSUER + "/sign-up/email", authCookies, {
      email: nativeOnly,
      password: freshPassword,
      name: "Fictional native only",
    });
    await native.handler(
      new Request(mail.findLast((m) => m.kind === "verify")!.url),
    );
    await signIn(nativeOnly);
    socialEmail = nativeOnly;
    google.getUserInfo = async () => ({
      user: { email: socialEmail, emailVerified: true, name: "Fictional only" },
      data: {
        sub: "fictional-native-only-google",
        email: socialEmail,
        email_verified: true,
      },
    });
    dropLinkNotification = true;
    assert.equal((await social(true)).status, 503);
    dropLinkNotification = false;
    const only = (
      await authPool.query(
        `select u.id,a.id as account from milton_auth."user" u join milton_auth.account a on a."userId"=u.id where u.email=$1 and a."providerId"='google'`,
        [nativeOnly],
      )
    ).rows[0];
    const counts = async () =>
      JSON.stringify(
        (
          await owner.query(
            "select (select count(*) from users) as users,(select count(*) from trial_accounts) as trials,(select count(*) from milton_app.trial_fingerprint) as fingerprints",
          )
        ).rows,
      );
    const unchanged = await counts();
    for (const failure of ["before", "after"] as const) {
      preservationFailure = failure;
      assert.equal(
        (
          await request(
            native.handler,
            ISSUER + "/unlink-account",
            authCookies,
            { accountId: only.account },
          )
        ).status,
        503,
      );
      assert.equal(
        (
          await authPool.query(
            "select count(*)::int n from milton_auth.account where id=$1",
            [only.account],
          )
        ).rows[0].n,
        1,
      );
      assert.equal(await counts(), unchanged);
    }
    preservationFailure = "none";
    assert.equal(
      (
        await request(native.handler, ISSUER + "/unlink-account", authCookies, {
          accountId: only.account,
        })
      ).status,
      200,
    );
    assert.equal(await counts(), unchanged);
    assert(preservationCalls >= 4);
    pass(
      "lost native link notification -> unlink -> delete -> changed-email recreation preserves trial eligibility; callback uncertainty is safe and native-only unlink admits nobody",
    );
  }
  console.log(
    `PASS ${groups} product integration groups (Node26/PostgreSQL18 TLS, no external network)`,
  );
} catch (error) {
  console.error(
    "FAIL product integration",
    stage,
    error instanceof assert.AssertionError
      ? error.message
      : error instanceof Error
        ? error.name
        : "unknown",
  );
  process.exitCode = 1;
} finally {
  await Promise.allSettled([
    ...pools.map((pool) => pool.end()),
    closeDatabasePools(),
  ]);
  if (running)
    run(join(bin, "pg_ctl"), ["-D", data, "-m", "fast", "-w", "stop"]);
  rmSync(root, { recursive: true, force: true });
}
