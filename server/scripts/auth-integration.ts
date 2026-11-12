/** Explicit local rehearsal. Builds with Bun; executes under Node26. No env
 * files, inherited database credentials, external requests or live operations. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import http, { request as httpRequest } from "node:http";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { randomBytes, createHash, randomUUID } from "node:crypto";
import pg from "pg";
import * as oidc from "openid-client";
import { createMiltonHandler } from "../src/handler";
import { createAccessTokenVerifier } from "../src/token";
import { sql, type SQL } from "drizzle-orm";
import { createAdmitApp, createMcpApp, createMiltonApp } from "../src/index";
import { cloudRequests } from "../src/cloud-app";
import {
  serve,
  type Http2Bindings,
  type HttpBindings,
  type ServerType,
} from "@hono/node-server";
import {
  admitRuntimeConfig,
  runtimeConfig,
  type RuntimeConfig,
} from "../src/config";
import {
  backgroundSettled,
  closeDatabasePools,
  POOL_IDLE_MS,
  postgresDatabase,
  type StoreDatabase,
  type StoreSession,
} from "../src/store/database";
import { PgDialect } from "drizzle-orm/pg-core";
import {
  database,
  lockActiveAccount,
  lookupIdentityAccount,
  StoreError,
} from "../src/store";
import { storeForCurrentRequest } from "../test/store-fixtures";
import { recordToolUsage } from "../src/store/usage";
import {
  authenticateConnectionKey,
  createConnectionKey,
  parseConnectionKey,
} from "../src/store/connection-keys";
import { fingerprintKeyCheck } from "../src/auth-admission";
import { hash } from "../src/auth-oidc";
import { appActive } from "../src/auth-authority";
import { checkProductRuntimeRole } from "./check-runtime-role";
import { connections, lifecycle } from "../src/auth-lifecycle";
import { ensureSubscription } from "../src/billing";
import type { SessionUser } from "../src/auth-session";
import { createProvider } from "../../apps/auth/src/provider";
import { ISSUER, AUTH_ORIGIN } from "../../apps/auth/src/config";
import { assertPortFree, startCluster } from "../../apps/auth/scripts/cluster";
import { fixtureConfig } from "../../apps/auth/test/fixture-config";
import { AUTH_MIGRATIONS } from "../../apps/auth/scripts/migrations";
import { createApp as createAuthPages } from "../../apps/auth/src/app";
import { createCloudApp as createAuthCloudApp } from "../../apps/auth/src/cloud-app";
import { versionAssets } from "@milton/theme/assets";
import {
  mintKey,
  ownerPools,
  provisionTestAccount,
  TEST_EMAIL,
} from "./test-account";
import {
  browser,
  CheckError,
  PRODUCTION,
  signIn,
  type Fetch,
} from "./e2e-http";
import { readSecrets, runE2E, type Line } from "./e2e";

const port = 55623;
// The milton-admit service's deterministic run.app URL; never fetched here.
const ADMIT_ORIGIN = "https://milton-admit-419545871671.us-east4.run.app";
const sourceRoot = pathToFileURL(process.cwd() + "/");
for (const port of [20201, 20202, 20203, 20204])
  await assertPortFree(port, "owned_fixture_port_in_use");
assert.match(process.version, /^v26\./);
const cluster = await startCluster({
  port,
  prefix: "milton-app-auth-",
  portRefusal: "owned_fixture_port_in_use",
  hba: "hostssl all all 127.0.0.1/32 scram-sha-256\n",
});
const root = cluster.dir,
  cert = cluster.cert;
const secret = () => randomBytes(32).toString("hex");
const pools: pg.Pool[] = [];
const servers: ServerType[] = [];
// Undoes the propagation groups' outbound guard; run in the final cleanup.
let restoreOutbound = () => {};
let groups = 0,
  stage = "setup";
const pass = (name: string) => {
  groups++;
  console.log("PASS " + name);
};
try {
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
  // Every writing migration the journal lists, in order, so a new one's tables
  // exist here too. Production applied the owner grant files before 0013 dropped
  // the old writing tables that 005-app-roles.sql names, so the entries from 0013
  // on run after those files and 015 (below), in the release's order.
  const journal = JSON.parse(
    readFileSync(new URL("./drizzle/meta/_journal.json", sourceRoot), "utf8"),
  ) as { entries: { tag: string }[] };
  assert.deepEqual(
    journal.entries.map((e) => e.tag + ".sql"),
    readdirSync(new URL("./drizzle/", sourceRoot))
      .filter((f) => f.endsWith(".sql"))
      .sort(),
    "the journal lists every writing migration file",
  );
  const dropAt = journal.entries.findIndex(
    (e) => e.tag === "0013_drop_old_writing",
  );
  assert.ok(dropAt > 0, "the journal lists the old writing tables' drop");
  const writing = (tag: string) =>
    owner.query(
      readFileSync(new URL(`./drizzle/${tag}.sql`, sourceRoot), "utf8"),
    );
  for (const { tag } of journal.entries.slice(0, dropAt)) await writing(tag);
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
  for (const n of AUTH_MIGRATIONS)
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
  const ownerUrl = new URL(
    `postgresql://disposable_cluster@127.0.0.1:${port}/milton`,
  );
  ownerUrl.searchParams.set("sslmode", "verify-full");
  ownerUrl.searchParams.set("sslrootcert", cert);
  // The real owner-only CLI installs 005 once, after native 004 above.
  const appMigrationUrl = new URL(ownerUrl);
  appMigrationUrl.searchParams.set("options", "-c role=milton_app_owner");
  const applied = spawnSync(
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
  assert.equal(applied.status, 0, "actual owner-only app migration CLI");
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
  // 009, 010, 011 and 014: rerunning converges too.
  for (const file of [
    "009-usage-calls-roles.sql",
    "010-usage-retention-roles.sql",
    "011-test-account-roles.sql",
    "014-memos-roles.sql",
  ])
    for (let n = 0; n < 2; n++)
      await owner.query(
        readFileSync(new URL(`./migrations/${file}`, sourceRoot), "utf8"),
      );
  // 007: runtime-login timeouts in this database only, nothing on any other
  // role. Up twice converges.
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
  for (let n = 0; n < 2; n++) {
    await owner.query(
      readFileSync(
        new URL("./migrations/007-role-timeouts.up.sql", sourceRoot),
        "utf8",
      ),
    );
    assert.deepEqual(await roleTimeouts(), timeouts);
  }
  // The guide job's plain login held only main's NOLOGIN guide capability.
  await owner.query(
    "GRANT milton_guide_worker TO milton_guide_runtime WITH INHERIT TRUE",
  );
  // 015 drops both guide roles first; then 0013 drops the old writing tables,
  // with rows in them as production has, and the old store's receipts. Every
  // later step runs on that schema. Applied twice: rerunning 015 converges.
  for (let n = 0; n < 2; n++)
    await owner.query(
      readFileSync(
        new URL("./migrations/015-drop-guide-roles.sql", sourceRoot),
        "utf8",
      ),
    );
  for (const statement of [
    "INSERT INTO instruction_cards(user_id,id) VALUES($1,'legacy-card')",
    "INSERT INTO sample_kinds(user_id,id,report,label) VALUES($1,'legacy-kind','email','fictional legacy note')",
    "INSERT INTO samples(user_id,id,client_json) VALUES($1,'legacy-sample','{}')",
    "INSERT INTO guide_accounts(user_id) VALUES($1)",
    // An old store's receipt, which 0013 deletes, and a memo-era one it keeps.
    `INSERT INTO save_requests(user_id,request_id,input_hash,result_json) VALUES($1,gen_random_uuid()::text,repeat('a',64),'{"status":"saved","request_id":"r","version":"v"}')`,
    `INSERT INTO save_requests(user_id,request_id,input_hash,result_json) VALUES($1,gen_random_uuid()::text,repeat('a',64),'{"status":"saved","request_id":"r","forgotten":["m"]}')`,
  ])
    await owner.query(statement, ["m_00000000-0000-4000-8000-000000000001"]);
  for (const { tag } of journal.entries.slice(dropAt)) await writing(tag);
  // 016 after 0015, its table's migration; it restates 014, so 014 then 016,
  // each twice, converges on 016's set.
  for (const file of [
    "014-memos-roles.sql",
    "016-memo-evidence-roles.sql",
    "016-memo-evidence-roles.sql",
  ])
    await owner.query(
      readFileSync(new URL(`./migrations/${file}`, sourceRoot), "utf8"),
    );
  assert.deepEqual(
    (
      await owner.query(
        `SELECT
          (SELECT count(*) FROM pg_class WHERE relnamespace='public'::regnamespace AND relname IN ('accepted_changes','instruction_card_versions','instruction_cards','instruction_card_position','sample_versions','samples','sample_kinds','report_guides','guide_accounts','guide_spend','guide_budget_lock'))::int old_relations,
          (SELECT string_agg(proname,',' ORDER BY proname) FROM pg_proc WHERE pronamespace='public'::regnamespace) functions,
          (SELECT count(*) FROM pg_roles WHERE rolname LIKE 'milton_guide%')::int guide_roles,
          (SELECT count(*) FROM save_requests)::int receipts,
          (SELECT count(*) FROM users)::int users`,
      )
    ).rows[0],
    {
      old_relations: 0,
      functions:
        "milton_save_request_guard,milton_user_id_guard,prune_usage_calls",
      guide_roles: 0,
      receipts: 1,
      users: 1,
    },
    "015 and 0013 leave no old writing table, function, old-store receipt or guide role",
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
  const ownerDb = postgresDatabase(ownerUrl.href);
  const personId = "m_00000000-0000-4000-8000-000000000001";
  const fingerprintKey = secret();
  // The trial-eligibility key, as the cutover left it.
  await owner.query(
    "INSERT INTO milton_app.eligibility_policy(singleton,key_check) VALUES(true,$1)",
    [fingerprintKeyCheck(fingerprintKey)],
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
  pass("app migration preserves writing IDs, trial history and managed rows");
  // 0005 and 008 drop the unread trial tables. 008 is a no-op on a database
  // 005-app.up.sql installed, which no longer creates legacy_mapping.
  const sourceFile = (path: string) =>
    readFileSync(new URL(path, sourceRoot), "utf8");
  const trialTableGrants = async () =>
    (
      await owner.query(
        "SELECT c.oid::regclass::text tbl,a.grantee::regrole::text grantee,string_agg(a.privilege_type,',' ORDER BY a.privilege_type) privileges FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) a WHERE c.oid IN (to_regclass('public.deleted_identities'),to_regclass('milton_app.legacy_mapping')) AND a.grantee<>c.relowner GROUP BY 1,2 ORDER BY 1,2",
      )
    ).rows;
  assert.deepEqual(await trialTableGrants(), []);
  await appOwner.query(
    sourceFile("./migrations/008-drop-legacy-mapping.up.sql"),
  );
  assert.deepEqual(await trialTableGrants(), []);
  pass("0005 and 008 drop the unread trial tables, leaving no grants behind");
  // 012 then 013: sessions no longer store the native access token, and the
  // column is gone. Rerunning each converges.
  const tokenColumn = async () =>
    (
      await owner.query(
        "SELECT is_nullable FROM information_schema.columns WHERE table_schema='milton_app' AND table_name='session' AND column_name='access_token'",
      )
    ).rows;
  for (let n = 0; n < 2; n++)
    await appOwner.query(
      sourceFile("./migrations/012-session-token-nullable.up.sql"),
    );
  assert.deepEqual(await tokenColumn(), [{ is_nullable: "YES" }]);
  for (let n = 0; n < 2; n++)
    await appOwner.query(
      sourceFile("./migrations/013-drop-session-access-token.up.sql"),
    );
  assert.deepEqual(await tokenColumn(), []);
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
  // Memos (014, restated by 016): exactly the privileges 016 grants, and no
  // runtime can change a memo's words or a stored change.
  const memoTables = [
    "memo_changes",
    "memos",
    "memo_kinds",
    "tweaks",
    "tweak_citations",
    "served_reports",
    "cover_sheets",
    "memo_settings",
  ];
  const privileges = async (role: string) =>
    (
      await owner.query<{ p: string }>(
        `SELECT t||':'||p p FROM unnest($2::text[]) t,
          unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE']) p
          WHERE has_table_privilege($1,'public.'||t,p) ORDER BY 1`,
        [role, memoTables],
      )
    ).rows.map((r) => r.p);
  const columnUpdates = async (role: string) =>
    (
      await owner.query<{ c: string }>(
        `SELECT t||'.'||a.attname c FROM unnest($2::text[]) t
          JOIN pg_attribute a ON a.attrelid=('public.'||t)::regclass AND a.attnum>0 AND NOT a.attisdropped
          WHERE has_column_privilege($1,'public.'||t,a.attname,'UPDATE') ORDER BY 1`,
        [role, memoTables],
      )
    ).rows.map((r) => r.c);
  assert.deepEqual(await privileges("milton_mcp_runtime"), [
    "cover_sheets:INSERT",
    "cover_sheets:SELECT",
    "memo_changes:INSERT",
    "memo_changes:SELECT",
    "memo_kinds:INSERT",
    "memo_kinds:SELECT",
    "memo_settings:SELECT",
    "memos:DELETE",
    "memos:INSERT",
    "memos:SELECT",
    "served_reports:INSERT",
    "served_reports:SELECT",
    "tweak_citations:INSERT",
    "tweak_citations:SELECT",
    "tweaks:DELETE",
    "tweaks:INSERT",
    "tweaks:SELECT",
  ]);
  assert.deepEqual(await columnUpdates("milton_mcp_runtime"), [
    "memos.audience",
    "memos.context_updated_at",
    "memos.kind_id",
    "memos.medium",
    "memos.purpose",
    "memos.summary",
  ]);
  assert.deepEqual(await privileges("milton_app_runtime"), [
    "cover_sheets:INSERT",
    "cover_sheets:SELECT",
    "memo_changes:SELECT",
    "memo_kinds:DELETE",
    "memo_kinds:SELECT",
    "memo_settings:INSERT",
    "memo_settings:SELECT",
    "memos:DELETE",
    "memos:SELECT",
    "tweak_citations:SELECT",
    "tweaks:DELETE",
    "tweaks:SELECT",
  ]);
  assert.deepEqual(await columnUpdates("milton_app_runtime"), [
    "memo_settings.keep_memos",
    "memo_settings.updated_at",
    "memos.request",
    "tweaks.norm",
    "tweaks.text",
    "tweaks.text_changed_at",
  ]);
  for (const role of ["milton_auth_runtime", "milton_runtime"])
    assert.deepEqual(await privileges(role), [], role);
  // Connection keys (006): app creates, lists and revokes without reading a
  // hash; MCP reads and records last use only; auth gets nothing.
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
  for (const role of ["milton_auth_runtime", "milton_runtime"])
    assert.deepEqual(await keyPrivileges(role), [], role);
  // 0009 and 011: only the owner marks a test account. No runtime login can
  // set users.test_account, by UPDATE or at INSERT; app still creates accounts.
  for (const role of [
    "milton_app_runtime",
    "milton_mcp_runtime",
    "milton_auth_runtime",
  ])
    assert.deepEqual(
      (
        await owner.query(
          "SELECT has_column_privilege($1,'public.users','test_account','INSERT') i,has_column_privilege($1,'public.users','test_account','UPDATE') u",
          [role],
        )
      ).rows[0],
      { i: false, u: false },
      role,
    );
  for (const [pool, statement] of [
    [appPool, "UPDATE users SET test_account=true WHERE false"],
    [mcpPool, "UPDATE users SET test_account=true WHERE false"],
    [
      appPool,
      "INSERT INTO users(id,test_account) VALUES('m_fictional_flagged',true)",
    ],
  ] as const)
    await assert.rejects(
      pool.query(statement),
      (e) => (e as { code?: string }).code === "42501",
      statement,
    );
  {
    const created = `m_${randomUUID()}`;
    await appPool.query("INSERT INTO users(id) VALUES($1)", [created]);
    assert.equal(
      (
        await owner.query("SELECT test_account FROM users WHERE id=$1", [
          created,
        ])
      ).rows[0].test_account,
      false,
    );
    await appPool.query("DELETE FROM users WHERE id=$1", [created]);
  }
  // Native 007: one narrow SECURITY DEFINER status function with a fixed path,
  // EXECUTE for MCP and app only, never PUBLIC or auth.
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
      }>(
        `SELECT p.prosecdef definer,p.proconfig config,
          EXISTS(SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee=0) public,
          has_function_privilege('milton_app_runtime',p.oid,'EXECUTE') app,
          has_function_privilege('milton_mcp_runtime',p.oid,'EXECUTE') mcp,
          has_function_privilege('milton_auth_runtime',p.oid,'EXECUTE') auth
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
        `INSERT INTO milton_auth."user"(id,name,email,"emailVerified") VALUES('fictional-key-subject','Fictional','keys@example.com',true) RETURNING id,"miltonIdentityIncarnation" incarnation,"miltonSecurityGeneration" generation`,
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
    await appPool.query("DELETE FROM users WHERE id=$1", [keyUser]);
    await authOwner.query(`DELETE FROM milton_auth."user" WHERE id=$1`, [
      nativeKeyUser.id,
    ]);
  }
  pass(
    "real TLS login roles separate native secrets, app credentials and writing with no DDL/TEMP path; connection-key grants hold on real roles; production DB errors map safely and preserve callbacks/rollback",
  );
  const nativeConfig = fixtureConfig({
    AUTH_DATABASE_URL: url("auth"),
    AUTH_APP_CLIENT_ID: "before-provision",
    // Production's shape: auth fetches a Google ID token for this audience.
    AUTH_ADMISSION_URL: ADMIT_ORIGIN,
    PORT: 20203,
  });
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
    `DROP FUNCTION ${keyStatus}; create table milton_credential.migration_ledger(name text primary key)`,
  );
  for (const name of AUTH_MIGRATIONS.filter(
    (n) => n !== "007-connection-key-status",
  ))
    await authOwner.query(
      "insert into milton_credential.migration_ledger values($1)",
      [name],
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
  // Usage retention through the real maintenance job and role: rows past 90
  // days go, newer ones stay. The prune skips a row an erasure has locked
  // instead of waiting on it, and no runtime may run it.
  const retainedUser = "m_00000000-0000-4000-8000-000000000001";
  await owner.query(
    "INSERT INTO usage_calls(user_id,at,tool) VALUES ($1,now()-interval '91 days','get_report'),($1,now()-interval '90 days 1 minute','list_reports'),($1,now()-interval '89 days','get_cover_sheet')",
    [retainedUser],
  );
  for (const pool of [authPool, appPool, mcpPool])
    await assert.rejects(
      pool.query("SELECT public.prune_usage_calls(1)"),
      (e) => (e as { code?: string }).code === "42501",
    );
  {
    const erasure = await owner.connect();
    try {
      await erasure.query("BEGIN");
      await erasure.query(
        "SELECT 1 FROM usage_calls WHERE tool='list_reports' FOR UPDATE",
      );
      const skipped = await Promise.race([
        authOwner.query("SELECT public.prune_usage_calls(10) AS removed"),
        new Promise<"waited">((resolve) =>
          setTimeout(() => resolve("waited"), 2000),
        ),
      ]);
      assert.notEqual(skipped, "waited", "prune never waits on a row lock");
      assert.equal((skipped as pg.QueryResult).rows[0].removed, 1);
    } finally {
      await erasure.query("ROLLBACK");
      erasure.release();
    }
  }
  child(
    [
      new URL("../apps/auth/scripts/maintain.ts", sourceRoot).pathname,
      "--apply",
    ],
    ownerEnv,
  );
  assert.deepEqual(
    (await owner.query("SELECT tool FROM usage_calls ORDER BY at")).rows,
    [{ tool: "get_cover_sheet" }],
  );
  await owner.query("DELETE FROM usage_calls");
  pass(
    "the maintenance job, as milton_auth_owner, prunes usage rows past 90 days and skips locked rows; no runtime may prune",
  );
  const ledger = async () =>
    (
      await owner.query<{ name: string }>(
        "SELECT name FROM milton_credential.migration_ledger ORDER BY name",
      )
    ).rows.map((r) => r.name);
  assert.deepEqual(await keyStatusShape(), keyStatusGrants);
  assert.deepEqual(await ledger(), AUTH_MIGRATIONS);
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
  let admit: ReturnType<typeof createAdmitApp>;
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
  let identityCalls = 0;
  // A fictional Google ID token for the admission service, as the metadata
  // server would mint for auth's service account; nothing verifies its signature
  // here, since Cloud Run's front end does that in production.
  const idToken = [
    { alg: "RS256" },
    { aud: ADMIT_ORIGIN, exp: Math.floor(Date.now() / 1000) + 3600 },
    "fictional-signature",
  ]
    .map((p) =>
      Buffer.from(typeof p === "string" ? p : JSON.stringify(p)).toString(
        "base64url",
      ),
    )
    .join(".");
  // Stands in for Cloud Run's invoker check: no token for this audience, 403.
  const invoke = (request: Request) =>
    request.headers.get("x-serverless-authorization") === `Bearer ${idToken}`
      ? admit(request)
      : Promise.resolve(new Response(null, { status: 403 }));
  // How auth's admission calls reach `invoke`: in process here; the loopback
  // propagation groups below send them over HTTP to the admit role's own
  // listener, which runs the same stand-in.
  let admitVia: (request: Request) => Promise<Response> = invoke;
  const nativeService = createProvider(nativeConfig, {
    pool: authPool,
    boundaries: {
      // No real DNS: every fixture domain takes mail.
      mailDomain: async () => "deliverable",
      fetch: async (input, init) => {
        if (
          String(input) ===
          "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity?audience=" +
            encodeURIComponent(ADMIT_ORIGIN)
        ) {
          assert.equal(
            new Headers(init?.headers).get("metadata-flavor"),
            "Google",
          );
          identityCalls++;
          return new Response(idToken);
        }
        if (
          String(input) ===
          ADMIT_ORIGIN + "/internal/auth/preserve-eligibility"
        ) {
          preservationCalls++;
          if (preservationFailure === "before")
            throw new Error("fictional_before_callback");
          const response = await admitVia(new Request(String(input), init));
          if (preservationFailure === "after")
            throw new Error("fictional_after_callback");
          return response;
        }
        if (String(input) === ADMIT_ORIGIN + "/internal/auth/admit") {
          if (dropLinkNotification)
            throw new Error("fictional_link_notification_lost");
          const handoff = new Request(String(input), init);
          const [first, second] = await Promise.all([
            admitVia(handoff.clone()),
            admitVia(handoff.clone()),
          ]);
          // Admitted, or refused for a deletion that has begun (410).
          assert(
            [204, 410].includes(first.status),
            "native admission contract",
          );
          assert.equal(
            second.status,
            first.status,
            "concurrent native admission",
          );
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
    // Every Stripe request of any kind.
    requests: 0,
  };
  config.billing = {
    secretKey: "rk_test_fixtureNotAKey",
    webhookSecret: "whsec_fixtureNotASecret",
    priceId: "price_fixture",
    fetch: async (input, init) => {
      stripe.requests++;
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
  // The admission service, on the app's database login, sharing the Stripe stub.
  const admitConfig = admitRuntimeConfig({
    NODE_ENV: "production",
    AUTH_ISSUER: ISSUER,
    DATABASE_URL: url("app"),
    AUTH_ADMISSION_SECRET: nativeConfig.AUTH_ADMISSION_SECRET,
    MILTON_TRIAL_FINGERPRINT_KEY: fingerprintKey,
  });
  admitConfig.billing = config.billing;
  admit = createAdmitApp(admitConfig);
  // The public app no longer answers admission, even with the right bearer.
  for (const path of [
    "/internal/auth/admit",
    "/internal/auth/preserve-eligibility",
  ])
    assert.equal(
      (
        await app(
          new Request("https://app.meetmilton.com" + path, {
            method: "POST",
            headers: {
              Host: "app.meetmilton.com",
              Authorization: `Bearer ${nativeConfig.AUTH_ADMISSION_SECRET}`,
              "Content-Type": "application/json",
            },
            body: "{}",
          }),
        )
      ).status,
      404,
      "public app serves no admission route",
    );
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
        email: "person@example.com",
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
        email: "person@example.com",
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
  assert.equal((await result(list)).result.tools?.length, 3);
  stage = "MCP cover sheet";
  const read = await result(
    await rpc(grant.access_token, "tools/call", {
      name: "get_cover_sheet",
      arguments: {},
    }),
  );
  assert.equal(read.result.isError, undefined);
  const cover = JSON.parse(read.result.content![0]!.text) as {
    version: number;
  };
  stage = "MCP report";
  const served = await result(
    await rpc(grant.access_token, "tools/call", {
      name: "get_report",
      arguments: {
        intent: {
          situation: "arranging a fictional pickup",
          medium: "email",
          audience: "a neighbor",
          purpose: "arrange a pickup",
        },
      },
    }),
  );
  assert.equal(served.result.isError, undefined, "real-role report read");
  const reportId = (
    JSON.parse(served.result.content![0]!.text) as { report_id: string }
  ).report_id;
  stage = "MCP save";
  // A memo with a new kind, its request and a tweak, citing the report it was
  // drafted from, so code stores its changes, then a cover sheet line: every
  // memo table the MCP role writes.
  for (const change of [
    {
      memo: {
        final: "Collect the fictional trays on Saturday.",
        first_draft: "Hi! Hope you're well. Collect the fictional trays.",
        mode: "draft",
        rounds: 1,
        new_kind: "fictional note",
        request: "Write a fictional pickup note for the trays.",
        tweaks: [{ text: "pickup notes: no warm-up opener" }],
        context: { summary: "Fictional pickup note", medium: "email" },
        report_id: reportId,
      },
    },
    {
      cover_sheet: {
        add: "Keep fictional measurements explicit.",
        expected_version: cover.version,
      },
    },
  ]) {
    const save = await result(
      await rpc(grant.access_token, "tools/call", {
        name: "create_memo",
        arguments: { ...change, request_id: crypto.randomUUID() },
      }),
    );
    assert.equal(
      save.result.isError,
      undefined,
      "real-role model-free memo save",
    );
    assert.equal(
      (JSON.parse(save.result.content![0]!.text) as { status: string }).status,
      "saved",
    );
  }
  stage = "MCP usage alongside the work";
  // As the real MCP role: each admitted call appended one row (drained here
  // only so a slow first connection cannot flake this check), and the role
  // can neither read nor change the rows.
  await backgroundSettled();
  const usage = (
    await owner.query("SELECT user_id,tool FROM usage_calls ORDER BY at")
  ).rows as { user_id: string; tool: string }[];
  assert.deepEqual(
    usage.map((r) => r.tool),
    ["get_cover_sheet", "get_report", "create_memo", "create_memo"],
  );
  const usageUser = usage[0]!.user_id;
  for (const statement of [
    "SELECT * FROM usage_calls",
    "UPDATE usage_calls SET tool=tool",
    "DELETE FROM usage_calls",
  ])
    await assert.rejects(mcpPool.query(statement), /permission denied/);
  // No usage statement is ever waiting on a row lock.
  const usageLockWaiters = async () =>
    (
      await owner.query(
        "SELECT count(*)::int n FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE 'WITH r AS%usage_calls%'",
      )
    ).rows[0].n as number;
  // Until a usage statement has finished since `since` (its backend idle
  // with that statement as its last query).
  const usageRan = async (since: Date) => {
    for (let n = 0; n < 250; n++) {
      const [row] = (
        await owner.query(
          "SELECT count(*)::int n FROM pg_stat_activity WHERE state='idle' AND query LIKE 'WITH r AS%usage_calls%' AND state_change > $1",
          [since],
        )
      ).rows;
      if (row.n > 0) return;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error("usage statement never ran");
  };
  const within = <T>(work: Promise<T>, ms: number) =>
    Promise.race([
      work,
      new Promise<"waited">((resolve) =>
        setTimeout(() => resolve("waited"), ms),
      ),
    ]);
  const usageDb = () => database(mcpConfig);
  const usageRows = async (...ids: string[]) =>
    (
      await owner.query(
        "SELECT user_id FROM usage_calls WHERE user_id = ANY($1) ORDER BY user_id",
        [ids],
      )
    ).rows.map((r: { user_id: string }) => r.user_id);
  stage = "MCP usage append against account deletion";
  {
    // The deletion holds the doomed account's FOR UPDATE. One batch for both
    // accounts lands the other account's row at once and skips the doomed
    // one, which skips again on its retry and is dropped; nothing waits.
    const doomed = "m_00000000-0000-4000-8000-0000000000c3",
      kept = "m_00000000-0000-4000-8000-0000000000c4";
    await owner.query("INSERT INTO users(id) VALUES($1),($2)", [doomed, kept]);
    const deletion = await owner.connect();
    let settled: unknown,
      landed: string[] = [],
      waiters = -1;
    try {
      await deletion.query("BEGIN");
      await deletion.query("SELECT id FROM users WHERE id=$1 FOR UPDATE", [
        doomed,
      ]);
      const appended = Promise.all([
        recordToolUsage(mcpConfig.DATABASE_URL, usageDb, doomed, "get_report"),
        recordToolUsage(mcpConfig.DATABASE_URL, usageDb, kept, "get_report"),
      ]);
      settled = await within(appended, 1000);
      waiters = await usageLockWaiters();
      landed = await usageRows(doomed, kept);
      await deletion.query("DELETE FROM users WHERE id=$1", [doomed]);
      await deletion.query("COMMIT");
    } finally {
      deletion.release();
    }
    await backgroundSettled();
    assert.equal(waiters, 0, "no usage statement waits on a lock");
    assert.notEqual(
      settled,
      "waited",
      "the batch settles while deletion is open",
    );
    assert.deepEqual(landed, [kept], "the other account's row lands at once");
    assert.deepEqual(await usageRows(doomed, kept), [kept]);
    await owner.query("DELETE FROM users WHERE id=$1", [kept]);
  }
  stage =
    "usage rows skipped behind short FOR UPDATEs land on their own retries";
  {
    // Two accounts under short FOR UPDATEs (as a sign-in holds it), skipped
    // at different times. Each row retries 50 ms after its own skip: the first
    // lands once its lock ends; the second, skipped about 25 ms later while
    // the first was waiting, must not retry with the first (its lock is still
    // held then), and lands after its own lock ends.
    const first = "m_00000000-0000-4000-8000-0000000000c7",
      second = "m_00000000-0000-4000-8000-0000000000c8";
    await owner.query("INSERT INTO users(id) VALUES($1),($2)", [first, second]);
    const [lockFirst, lockSecond] = [
      await owner.connect(),
      await owner.connect(),
    ];
    const now = async () =>
      (await owner.query("SELECT clock_timestamp() t")).rows[0].t as Date;
    let appended: Promise<unknown> = Promise.resolve();
    try {
      for (const [client, id] of [
        [lockFirst, first],
        [lockSecond, second],
      ] as const) {
        await client.query("BEGIN");
        await client.query("SELECT id FROM users WHERE id=$1 FOR UPDATE", [id]);
      }
      const sinceFirst = await now();
      const firstRow = recordToolUsage(
        mcpConfig.DATABASE_URL,
        usageDb,
        first,
        "get_cover_sheet",
      );
      await usageRan(sinceFirst);
      await lockFirst.query("COMMIT");
      await new Promise((resolve) => setTimeout(resolve, 25));
      const sinceSecond = await now();
      const secondRow = recordToolUsage(
        mcpConfig.DATABASE_URL,
        usageDb,
        second,
        "get_cover_sheet",
      );
      appended = Promise.all([firstRow, secondRow]);
      await usageRan(sinceSecond);
      // The first row's retry has landed; the second's is still to come.
      for (let n = 0; n < 200; n++) {
        if ((await usageRows(first)).length) break;
        await new Promise((resolve) => setTimeout(resolve, 2));
      }
      await lockSecond.query("COMMIT");
    } finally {
      lockFirst.release();
      lockSecond.release();
    }
    await appended;
    assert.deepEqual(
      await usageRows(first, second),
      [first, second].sort(),
      "each lands on its own retry",
    );
    await owner.query("DELETE FROM users WHERE id IN ($1,$2)", [first, second]);
  }
  stage = "account A's save and FOR UPDATE against account B's deletion";
  {
    // B's deletion holds B's FOR UPDATE, and A's save is paused holding its
    // FOR NO KEY UPDATE on A. A usage batch for A and B then lands A at once
    // (a key share does not conflict with the save's lock) and skips B, with
    // no statement waiting. A's save then finishes, and A's FOR UPDATE (as
    // sign-in, eligibility, lifecycle and deletion take it) follows promptly.
    const saverId = "m_00000000-0000-4000-8000-0000000000c5",
      leaving = "m_00000000-0000-4000-8000-0000000000c6";
    await owner.query("INSERT INTO users(id) VALUES($1),($2)", [
      saverId,
      leaving,
    ]);
    await owner.query(
      "INSERT INTO identities(provider,subject,user_id) VALUES('fictional-usage','saver',$1)",
      [saverId],
    );
    await owner.query(
      "INSERT INTO trial_accounts(user_id,started_at,subscription_status) VALUES($1,now(),'active')",
      [saverId],
    );
    // The MCP database, pausing a save right after it takes its account lock.
    const dialect = new PgDialect();
    const base = postgresDatabase(mcpConfig.DATABASE_URL);
    let pauseSave = false;
    let locked!: () => void, resume!: () => void;
    const saveLocked = new Promise<void>((resolve) => (locked = resolve));
    const resumed = new Promise<void>((resolve) => (resume = resolve));
    const pausing = (session: StoreSession): StoreSession => ({
      async query<Row extends Record<string, unknown>>(statement: SQL) {
        const rows = await session.query<Row>(statement);
        if (
          pauseSave &&
          / FOR NO KEY UPDATE$/.test(dialect.sqlToQuery(statement).sql)
        ) {
          pauseSave = false;
          locked();
          await resumed;
        }
        return rows;
      },
    });
    const saverDb: StoreDatabase = {
      ...base,
      transaction: (work) => base.transaction((tx) => work(pausing(tx))),
    };
    const saver = await storeForCurrentRequest(
      { ...mcpConfig, storeDatabase: saverDb },
      await lookupIdentityAccount(mcpConfig, {
        provider: "fictional-usage",
        subject: "saver",
      }),
      { issuer: "fixture", clientId: "fictional-saver" },
    );
    const deletion = await owner.connect();
    let saved: unknown, lockedA: unknown, usageSettled: unknown;
    let landedDuringSave: string[] = [],
      waiters = -1;
    try {
      await deletion.query("BEGIN");
      await deletion.query("SELECT id FROM users WHERE id=$1 FOR UPDATE", [
        leaving,
      ]);
      pauseSave = true;
      const saving = saver
        .saveMemo({
          request_id: randomUUID(),
          cover_sheet: {
            add: "Keep fictional measurements explicit.",
            expected_version: 0,
          },
        })
        .then((outcome) => outcome.status);
      await saveLocked;
      usageSettled = await within(
        Promise.all([
          recordToolUsage(
            mcpConfig.DATABASE_URL,
            usageDb,
            saverId,
            "get_report",
          ),
          recordToolUsage(
            mcpConfig.DATABASE_URL,
            usageDb,
            leaving,
            "get_report",
          ),
        ]),
        1000,
      );
      landedDuringSave = await usageRows(saverId, leaving);
      waiters = await usageLockWaiters();
      resume();
      saved = await within(saving, 3000);
      lockedA = await within(
        database(config).transaction((tx) =>
          lockActiveAccount(tx, "fictional-usage", "saver"),
        ),
        3000,
      );
      await deletion.query("DELETE FROM users WHERE id=$1", [leaving]);
      await deletion.query("COMMIT");
    } finally {
      resume();
      deletion.release();
    }
    await backgroundSettled();
    assert.notEqual(
      usageSettled,
      "waited",
      "the batch settles during the save",
    );
    assert.deepEqual(
      landedDuringSave,
      [saverId],
      "A lands while A's save holds its lock",
    );
    assert.equal(waiters, 0, "no usage statement waits on a lock");
    assert.equal(saved, "saved", "A's save never waits on B's deletion");
    assert.equal(
      lockedA,
      saverId,
      "A's FOR UPDATE never waits on B's deletion",
    );
    assert.deepEqual(await usageRows(saverId, leaving), [saverId]);
    await owner.query("DELETE FROM users WHERE id=$1", [saverId]);
  }
  stage = "read-only native authorization";
  const readGrant = await authorizeAssistant(
    "openid offline_access milton:read",
  );
  const roList = await rpc(readGrant.access_token, "tools/list");
  assert.equal(roList.status, 200);
  assert.equal((await result(roList)).result.tools?.length, 2);
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
    "actual native controlled code/refresh grant reaches scoped product MCP: three/two tools, a report and model-free memo and cover sheet saves",
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
      `INSERT INTO milton_auth."user"(id,name,email,"emailVerified") VALUES('fictional-unrelated-subject','Fictional','unrelated@example.com',true) RETURNING id,"miltonIdentityIncarnation" incarnation,"miltonSecurityGeneration" generation`,
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
  // "Switch account" is that logout carrying native's echoed fixed state.
  await request(app, config.appOrigin + "/tps-report", appCookies);
  const logout = await request(
    app,
    config.appOrigin + "/logout",
    appCookies,
    { csrf: appCookies.get("__Host-milton-csrf")!, next: "login" },
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
    config.appOrigin + "/auth/logged-out?state=switch-account",
  );
  assert.equal(await appActive(config, row), false);
  assert.equal(
    (await request(app, config.appOrigin + "/tps-report", appCookies)).status,
    403,
  );
  const switched = await request(
    app,
    completed.headers.get("Location")!,
    appCookies,
  );
  assert.equal(switched.status, 303);
  assert.equal(
    switched.headers.get("Location"),
    config.appOrigin + "/login?fresh=1",
  );
  const chooser = await request(
    app,
    switched.headers.get("Location")!,
    appCookies,
  );
  assert.equal(chooser.status, 303);
  const chooserAuthorize = new URL(chooser.headers.get("Location")!);
  assert.equal(chooserAuthorize.searchParams.get("prompt"), "login");
  const chooserPage = await request(
    native.handler,
    chooserAuthorize.href,
    authCookies,
  );
  assert.equal(
    new URL(chooserPage.headers.get("Location")!, ISSUER).pathname,
    "/login",
    "switch account reaches the native sign-in page",
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
    { email: "person@example.com" },
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
    "actual offline refresh survives browser logout (Switch account reaches native sign-in); native recovery fences access and refresh",
  );
  assert.equal(
    (
      await request(native.handler, ISSUER + "/sign-in/email", authCookies, {
        email: "person@example.com",
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
        email: "person@example.com",
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
  assert.equal(
    (
      await owner.query(
        "SELECT count(*)::int n FROM usage_calls WHERE user_id=$1",
        [usageUser],
      )
    ).rows[0].n,
    0,
    "account erasure deletes its usage rows",
  );
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
        email: "person@example.com",
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
        email: "person@example.com",
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
    const freshEmail = "unlink-preserve@example.com";
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
    socialEmail = "unlink-changed@example.com";
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
    const nativeOnly = "unlink-native-only@example.com";
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
    // One cached ID token served every admission and preservation call.
    assert.equal(identityCalls, 1);
    pass(
      "lost native link notification -> unlink -> delete -> changed-email recreation preserves trial eligibility; callback uncertainty is safe and native-only unlink admits nobody",
    );
  }
  // Account deletion racing an enrolment or a checkout, on real PostgreSQL row
  // locks, each case on a fresh account.
  {
    stage = "deletion during an enrolment or a checkout";
    const signedUp = async (email: string) => {
      await owner.query(
        'delete from milton_auth."rateLimit"; delete from milton_guard.rate_bucket',
      );
      authCookies.clear();
      appCookies.clear();
      const racePassword = "Fictional deletion race password";
      await request(native.handler, ISSUER + "/sign-up/email", authCookies, {
        email,
        password: racePassword,
        name: "Fictional race",
      });
      await native.handler(
        new Request(mail.findLast((m) => m.kind === "verify")!.url),
      );
      assert.equal(
        (
          await request(
            native.handler,
            ISSUER + "/sign-in/email",
            authCookies,
            { email, password: racePassword },
          )
        ).status,
        200,
      );
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
      const authority = (
        await appPool.query(
          "select subject,sid,binding,incarnation,generation from milton_app.session order by created_at desc limit 1",
        )
      ).rows[0];
      const { userId } = await lookupIdentityAccount(config, {
        provider: ISSUER,
        subject: authority.subject,
      });
      // Waiting for its trial, as the subscription backfill finds an account.
      await owner.query(
        "update trial_accounts set stripe_customer_id=null,stripe_subscription_id=null,subscription_status=null where user_id=$1",
        [userId],
      );
      const deletions = lifecycleFor(
        { ...authority, id: authority.subject },
        appCookies.get("__Host-milton-session")!,
      );
      const erased = async () =>
        (
          await owner.query("select count(*)::int n from users where id=$1", [
            userId,
          ])
        ).rows[0].n === 0;
      return { userId, deletions, erased };
    };
    // Until `n` lock requests are waiting.
    const lockWaiters = async (n: number, what: string) => {
      for (let waited = 0; ; waited += 20) {
        const waiting = (
          await owner.query<{ n: number }>(
            "select count(*)::int n from pg_locks where not granted",
          )
        ).rows[0]!.n;
        if (waiting >= n) return;
        assert(waited < 5000, what);
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    };
    const gate = () => {
      let open = () => {};
      const opened = new Promise<void>((resolve) => (open = resolve));
      return { open: () => open(), opened };
    };
    // The Stripe stub for these cases: each call is recorded, and a customer or
    // subscription create awaits its hook before it answers.
    const billing = config.billing!;
    const shared = billing.fetch;
    const calls: string[] = [];
    const hooks = { customer: async () => {}, subscription: async () => {} };
    const stub: typeof shared = async (input, init) => {
      const path = new URL(input).pathname;
      calls.push(`${init.method} ${path}`);
      if (path === "/v1/customers" && init.method === "POST") {
        await hooks.customer();
        return Response.json({ id: "cus_race" });
      }
      if (path === "/v1/subscriptions" && init.method === "GET")
        return Response.json({ data: [] });
      if (path === "/v1/checkout/sessions" && init.method === "POST")
        return Response.json({
          id: "cs_test_race",
          url: "https://checkout.stripe.com/c/pay/cs_test_race",
        });
      if (path === "/v1/checkout/sessions/cs_test_race/expire")
        return Response.json({ id: "cs_test_race", status: "expired" });
      if (path === "/v1/subscriptions" && init.method === "POST") {
        await hooks.subscription();
        const now = Math.floor(Date.now() / 1000);
        return Response.json({
          id: "sub_race",
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
      if (path === "/v1/customers/cus_race" && init.method === "DELETE")
        return Response.json({ id: "cus_race", deleted: true });
      throw new Error("unexpected_fictional_stripe_request");
    };
    // The enrolment has linked its customer and is starting the trial,
    // uncommitted, when the deletion reads the customer.
    const raceEmail = "deletion-race@example.com";
    const { userId: raceUser, deletions, erased } = await signedUp(raceEmail);
    const subscribing = gate();
    const release = gate();
    hooks.subscription = async () => {
      subscribing.open();
      await release.opened;
    };
    calls.length = 0;
    billing.fetch = stub;
    try {
      const enrolment = ensureSubscription(config, raceUser, raceEmail).then(
        () => true,
        () => false,
      );
      await subscribing.opened;
      const id = randomUUID();
      const deletion = deletions.run("delete", id);
      // The deletion reaches a row the enrolment holds, then the trial starts.
      await lockWaiters(1, "the deletion waits on a row lock");
      release.open();
      const enrolled = await enrolment;
      const first = await deletion;
      // A failed deletion gets the retry its page offers.
      const { operation } = first.failed
        ? await deletions.run("delete", id)
        : first;
      assert.equal(operation.progress, "complete");
      assert.deepEqual(
        calls,
        [
          "POST /v1/customers",
          "GET /v1/subscriptions",
          "POST /v1/subscriptions",
          "DELETE /v1/customers/cus_race",
        ],
        "the deletion deletes the customer the enrolment linked",
      );
      // Neither side deadlocks: the deletion waits for the enrolment's row.
      assert.equal(enrolled, true, "the enrolment commits");
      assert.equal(first.failed, false, "the deletion finishes first time");
      assert(await erased());
    } finally {
      release.open();
      hooks.subscription = async () => {};
      billing.fetch = shared;
    }
    // The enrolment is creating its customer, not yet linked, when the
    // deletion begins: its link is refused, it deletes that customer and says
    // the account is being deleted, not to try again.
    {
      const email = "enrolment-race@example.com";
      const { userId, deletions, erased } = await signedUp(email);
      const creating = gate();
      const release = gate();
      hooks.customer = async () => {
        creating.open();
        await release.opened;
      };
      calls.length = 0;
      billing.fetch = stub;
      try {
        const enrolment = ensureSubscription(config, userId, email).then(
          () => undefined,
          (error: unknown) => error,
        );
        await creating.opened;
        const deletion = deletions.run("delete", randomUUID());
        await lockWaiters(1, "the deletion waits on the enrolment's row");
        release.open();
        const refusal = (await enrolment) as
          { code?: string; status?: number } | undefined;
        assert.deepEqual(
          [refusal?.code, refusal?.status],
          ["account_deleting", 409],
          "the enrolment answers that the account is being deleted",
        );
        const { operation, failed } = await deletion;
        assert.equal(failed, false);
        assert.equal(operation.progress, "complete");
        assert.deepEqual(calls, [
          "POST /v1/customers",
          "DELETE /v1/customers/cus_race",
        ]);
        assert(await erased());
      } finally {
        release.open();
        hooks.customer = async () => {};
        billing.fetch = shared;
      }
    }
    // The same through a native sign-in: its admission is enrolling the account
    // when the deletion begins, and native refuses the sign-in as an account
    // being deleted rather than asking for a retry.
    {
      const { deletions, erased } = await signedUp("signin-race@example.com");
      const start = await request(app, config.appOrigin + "/login", appCookies);
      const creating = gate();
      const release = gate();
      hooks.customer = async () => {
        creating.open();
        await release.opened;
      };
      calls.length = 0;
      billing.fetch = stub;
      try {
        const authorizing = request(
          native.handler,
          start.headers.get("Location")!,
          authCookies,
        );
        // Native sends each admission twice at once (see the harness above):
        // one holds the row while Stripe creates its customer, the other waits.
        await creating.opened;
        await lockWaiters(1, "the second admission waits on the row");
        const deletion = deletions.run("delete", randomUUID());
        await lockWaiters(2, "the deletion waits on the admission's row");
        release.open();
        const refused = await authorizing;
        const answer = await refused.text();
        assert.deepEqual(
          [refused.status, answer.includes("account_deleting")],
          [403, true],
          `native refuses the sign-in as an account being deleted: ${refused.status} ${answer.slice(0, 200)}`,
        );
        const { operation, failed } = await deletion;
        assert.equal(failed, false);
        assert.equal(operation.progress, "complete");
        // Each admission's link is refused and it deletes its own customer.
        assert.deepEqual(calls, [
          "POST /v1/customers",
          "DELETE /v1/customers/cus_race",
          "POST /v1/customers",
          "DELETE /v1/customers/cus_race",
        ]);
        assert(await erased());
      } finally {
        release.open();
        hooks.customer = async () => {};
        billing.fetch = shared;
      }
    }
    // A checkout's link waits behind a row another transaction holds while the
    // deletion begins: it reads the deletion once it has the row, so it links
    // nothing and opens no session.
    {
      const { userId, deletions, erased } = await signedUp(
        "checkout-race@example.com",
      );
      await owner.query(
        "update trial_accounts set subscription_status='canceled' where user_id=$1",
        [userId],
      );
      await request(app, config.appOrigin + "/account/delete", appCookies);
      const holder = await owner.connect();
      calls.length = 0;
      billing.fetch = stub;
      try {
        await holder.query("begin");
        await holder.query(
          "select 1 from trial_accounts where user_id=$1 for update",
          [userId],
        );
        const checkout = request(
          app,
          config.appOrigin + "/billing/checkout",
          appCookies,
          { csrf: appCookies.get("__Host-milton-csrf")! },
          true,
        );
        await lockWaiters(1, "the checkout's link waits on the held row");
        const deletion = deletions.run("delete", randomUUID());
        await lockWaiters(2, "the deletion waits on it too");
        await holder.query("commit");
        const answer = await checkout;
        assert.equal(answer.status, 409);
        await answer.body?.cancel();
        const { operation, failed } = await deletion;
        assert.equal(failed, false);
        assert.equal(operation.progress, "complete");
        assert.deepEqual(
          calls,
          ["POST /v1/customers", "DELETE /v1/customers/cus_race"],
          "the link sees the deletion: nothing is linked and no session opens",
        );
        assert(await erased());
      } finally {
        await holder.query("rollback").catch(() => {});
        holder.release();
        billing.fetch = shared;
      }
    }
    pass(
      "a deletion that begins while an enrolment holds the account's billing row waits for it and deletes the customer it linked; an enrolment or checkout whose link comes after it begins links nothing, deletes its new customer and answers 409",
    );
  }
  // The test account and its check, through the real auth pages, app and MCP,
  // with billing configured (the Stripe fixture counts every call) and the
  // native mail queue watched.
  stage = "test account provisioning";
  const authAssets = join(root, "auth-assets");
  mkdirSync(join(authAssets, "fonts"), { recursive: true });
  const theme = new URL("../packages/theme/public/", sourceRoot).pathname;
  cpSync(join(theme, "fonts"), join(authAssets, "fonts"), { recursive: true });
  cpSync(join(theme, "favicon.svg"), join(authAssets, "favicon.svg"));
  writeFileSync(join(authAssets, "auth.css"), "body{}\n");
  versionAssets(authAssets, [
    "/auth.css",
    "/favicon.svg",
    "/fonts/geist-latin-variable.woff2",
    "/fonts/jetbrains-mono-latin.woff2",
    "/fonts/jetbrains-mono-regular.woff2",
  ]);
  const authPages = createAuthPages(nativeService, authAssets);
  // Each run is its own client behind the load balancer, as daily runs are
  // for the key-lookup limits.
  let checkClient = 200,
    mcpRequests = 0;
  const dispatch: Fetch = async (target, init) => {
    const u = new URL(target);
    const headers = new Headers(init.headers);
    headers.set("Host", u.host);
    if (u.host === "mcp.meetmilton.com") {
      mcpRequests++;
      headers.set("X-Forwarded-For", `198.51.100.${checkClient}, 192.0.2.1`);
    }
    const forwarded = new Request(u, {
      method: init.method,
      headers,
      body: init.body as BodyInit | undefined,
      signal: init.signal,
    });
    if (u.origin === AUTH_ORIGIN) return authPages.fetch(forwarded);
    if (u.origin === config.appOrigin) return app(forwarded);
    if (u.host === "mcp.meetmilton.com") return mcp(forwarded);
    throw new Error("external_network_refused");
  };
  const testOwnerNative = new URL(ownerUrl);
  testOwnerNative.searchParams.set("options", "-c role=milton_auth_owner");
  const owners = ownerPools(testOwnerNative.href, ownerUrl.href);
  pools.push(owners.native, owners.writing);
  await owner.query(
    'delete from milton_auth."rateLimit"; delete from milton_guard.rate_bucket',
  );
  const quiet = async () =>
    JSON.stringify(
      (
        await owner.query(
          "select (select count(*) from milton_guard.mail_job) mail,(select count(*) from users where test_account) marked",
        )
      ).rows[0],
    ) + JSON.stringify([stripe.customers, stripe.subscriptions, mail.length]);
  const before = await quiet();
  const secrets = join(root, "test-account.env");
  const lines: string[] = [];
  const provisioned = await provisionTestAccount({
    email: TEST_EMAIL,
    output: secrets,
    owners,
    fetch: dispatch,
    report: (...step) => lines.push(JSON.stringify(step)),
  });
  // No mail queued or sent and no Stripe call; exactly one marked account.
  assert.equal(
    await quiet(),
    before.replace('"marked":"0"', '"marked":"1"'),
    "provisioning queues no mail and calls no Stripe API",
  );
  assert.equal(statSync(secrets).mode & 0o777, 0o600);
  const values = Object.fromEntries(
    readFileSync(secrets, "utf8")
      .trim()
      .split("\n")
      .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
  );
  assert.deepEqual(Object.keys(values), [
    "E2E_EMAIL",
    "E2E_PASSWORD",
    "E2E_CONNECTION_KEY",
  ]);
  assert.equal(values.E2E_EMAIL, TEST_EMAIL);
  assert.match(values.E2E_CONNECTION_KEY!, /^mk_/);
  assert(
    !lines.some(
      (l) =>
        l.includes(values.E2E_PASSWORD!) ||
        l.includes(values.E2E_CONNECTION_KEY!.slice(26)),
    ),
    "steps print no password or key",
  );
  assert.deepEqual(
    (
      await owner.query(
        `select n."emailVerified" verified,u.status,u.test_account marked,t.subscription_status status_value,t.user_id is null no_trial
         from milton_auth."user" n join identities i on i.provider=$1 and i.subject=n.id
         join users u on u.id=i.user_id left join trial_accounts t on t.user_id=u.id
         where n.email=$2`,
        [ISSUER, TEST_EMAIL],
      )
    ).rows,
    [
      {
        verified: true,
        status: "active",
        marked: true,
        status_value: null,
        no_trial: true,
      },
    ],
  );
  assert.equal(provisioned.subject.length, 32);
  // Refusals, each before any write: an existing email, an existing file and
  // an address outside .invalid.
  const unchanged = await quiet();
  for (const [email, output, code] of [
    [TEST_EMAIL, join(root, "again.env"), "test_email_exists"],
    ["other@milton-test.invalid", secrets, "output_exists"],
    [
      "person@example.com",
      join(root, "real.env"),
      "test_email_must_end_invalid",
    ],
  ] as const) {
    await assert.rejects(
      provisionTestAccount({
        email,
        output,
        owners,
        fetch: dispatch,
        report: () => {},
      }),
      (e) => e instanceof CheckError && e.code === code,
      code,
    );
    assert.equal(await quiet(), unchanged);
  }
  assert(
    !existsSync(join(root, "again.env")) && !existsSync(join(root, "real.env")),
  );
  pass(
    "test account provisioning: verified .invalid user, no mail, no Stripe call, marked active account with no trial, 0600 file; refuses existing email, existing file and real addresses",
  );
  stage = "test account partial provisioning";
  // A failure at either commit leaves nothing anyone can sign in to, so no
  // unmarked account, trial or Stripe call can follow; --resume converges.
  {
    const refused = new Error("fictional_connection_lost");
    const broken = (pool: pg.Pool) =>
      ({
        query: pool.query.bind(pool),
        connect: async () => {
          throw refused;
        },
      }) as unknown as pg.Pool;
    const counts = async () =>
      JSON.stringify(
        (
          await owner.query(
            "select (select count(*) from users where not test_account) unmarked,(select count(*) from trial_accounts t join users u on u.id=t.user_id where u.test_account) trials",
          )
        ).rows[0],
      ) + JSON.stringify([stripe.customers, stripe.subscriptions]);
    const held = await counts();
    for (const side of ["writing", "native"] as const) {
      const email = `e2e-partial-${side}@milton-test.invalid`;
      const file = join(root, `partial-${side}.env`);
      await assert.rejects(
        provisionTestAccount({
          email,
          output: file,
          owners: { ...owners, [side]: broken(owners[side]) },
          fetch: dispatch,
          report: () => {},
        }),
        (e) => e === refused,
      );
      await owner.query(
        'delete from milton_auth."rateLimit"; delete from milton_guard.rate_bucket',
      );
      const password = /^E2E_PASSWORD=(.+)$/m.exec(
        readFileSync(file, "utf8"),
      )![1]!;
      await assert.rejects(
        signIn(browser(PRODUCTION, dispatch), PRODUCTION, email, password),
        (e) => e instanceof CheckError && e.code === "sign_in_refused",
        `${side}: nobody can sign in after a partial run`,
      );
      assert.equal(await counts(), held, `${side}: no unmarked account`);
      await provisionTestAccount({
        email,
        output: file,
        owners,
        fetch: dispatch,
        report: () => {},
        resume: true,
      });
      assert.match(readFileSync(file, "utf8"), /^E2E_CONNECTION_KEY=mk_/m);
    }
    // The native COMMIT succeeds but its acknowledgment is lost: the native
    // user exists, already bound to the marked account, and --resume takes the
    // existing-user branch without creating another.
    // The pool keeps its clients, so each patched query is restored afterwards.
    const patched: [pg.PoolClient, pg.PoolClient["query"]][] = [];
    const ackLost = {
      query: owners.native.query.bind(owners.native),
      connect: async () => {
        const client = await owners.native.connect();
        patched.push([client, client.query]);
        const query = client.query.bind(client) as (
          ...args: unknown[]
        ) => Promise<unknown>;
        return Object.assign(client, {
          query: async (...args: unknown[]) => {
            const done = await query(...args);
            if (args[0] === "commit") throw refused;
            return done;
          },
        });
      },
    } as unknown as pg.Pool;
    const lostEmail = "e2e-partial-ack@milton-test.invalid";
    const lostFile = join(root, "partial-ack.env");
    try {
      await assert.rejects(
        provisionTestAccount({
          email: lostEmail,
          output: lostFile,
          owners: { ...owners, native: ackLost },
          fetch: dispatch,
          report: () => {},
        }),
        (e) => e === refused,
      );
    } finally {
      for (const [client, query] of patched) client.query = query;
    }
    const nativeRows = async () =>
      (
        await owner.query(
          `select u.test_account marked,exists(select 1 from trial_accounts t where t.user_id=u.id) trial
           from milton_auth."user" n join identities i on i.provider=$1 and i.subject=n.id
           join users u on u.id=i.user_id where n.email=$2`,
          [ISSUER, lostEmail],
        )
      ).rows;
    assert.deepEqual(await nativeRows(), [{ marked: true, trial: false }]);
    assert.equal(await counts(), held, "ack lost: no unmarked account");
    await owner.query(
      'delete from milton_auth."rateLimit"; delete from milton_guard.rate_bucket',
    );
    const steps: [string, boolean, object?][] = [];
    await provisionTestAccount({
      email: lostEmail,
      output: lostFile,
      owners,
      fetch: dispatch,
      report: (step, ok, _ms, extra) => steps.push([step, ok, extra]),
      resume: true,
    });
    assert.deepEqual(
      steps.find(([step]) => step === "native_user"),
      ["native_user", true, { created: false }],
    );
    assert.deepEqual(await nativeRows(), [{ marked: true, trial: false }]);
    assert.match(readFileSync(lostFile, "utf8"), /^E2E_CONNECTION_KEY=mk_/m);
    assert.equal(await counts(), held, "resumed accounts stay marked");
    assert.equal(
      (
        await owner.query(
          `select count(*)::int n from users u join identities i on i.user_id=u.id
           where u.test_account and not exists(select 1 from milton_auth."user" n where n.id=i.subject)`,
        )
      ).rows[0].n,
      0,
      "no marked account is left without its native user",
    );
  }
  pass(
    "partial provisioning before or between the commits leaves no account anyone can sign in to, a lost native commit acknowledgment leaves it marked; --resume converges on the marked, trial-free account",
  );
  stage = "e2e check";
  // What one run adds to the account, by table: the runbook's daily footprint.
  const footprint = async () =>
    (
      await owner.query(
        `select (select count(*) from memos where user_id=$1)::int memos,
          (select count(*) from memo_kinds where user_id=$1)::int kinds,
          (select count(*) from tweaks where user_id=$1)::int tweaks,
          (select count(*) from memo_changes where user_id=$1)::int changes,
          (select count(*) from cover_sheets where user_id=$1)::int covers,
          (select count(*) from served_reports where user_id=$1)::int reports,
          (select count(*) from save_requests where user_id=$1)::int receipts,
          (select count(*) from usage_calls where user_id=$1)::int usage`,
        [provisioned.userId],
      )
    ).rows[0] as Record<string, number>;
  const grew = (a: Record<string, number>, b: Record<string, number>) =>
    Object.fromEntries(Object.keys(a).map((k) => [k, b[k]! - a[k]!]));
  const checkLines: Line[] = [];
  const check = async (fetcher = dispatch) => {
    await owner.query(
      'delete from milton_auth."rateLimit"; delete from milton_guard.rate_bucket',
    );
    checkClient++;
    checkLines.length = 0;
    const counted = await footprint();
    try {
      await runE2E({
        secrets,
        fetch: fetcher,
        report: (l) => checkLines.push(l),
      });
    } finally {
      await backgroundSettled();
    }
    return grew(counted, await footprint());
  };
  // A run leaves no memo behind: it saves two and forgets them, with the
  // drafted one's change. Its receipts (two saves, forget) and served-report
  // records (three reads) stay.
  const perRun = {
    memos: 0,
    kinds: 0,
    tweaks: 0,
    changes: 0,
    covers: 0,
    reports: 3,
    receipts: 3,
    usage: 9,
  };
  // First run: the kind is made once; every later run reuses it.
  assert.deepEqual(await check(), { ...perRun, kinds: 1 });
  assert.deepEqual(
    checkLines.map((l) => [l.step, l.ok]),
    [
      "secrets",
      "sign_in",
      "key_owner",
      "mcp_connect",
      "safety_gate",
      "forget_leftovers",
      "baseline",
      "save_memo",
      "fresh_read",
      "save_drafted",
      "drafted_changes",
      "forget_memo",
      "cleanup",
      "done",
    ].map((step) => [step, true]),
  );
  assert.deepEqual(await check(), perRun);
  // Node's fetch (production's runtime) sends Sec-Fetch-Mode: cors whatever the
  // caller sets, so native answers some hops with JSON instead of a redirect.
  assert.deepEqual(
    await check((target, init) => {
      const headers = new Headers(init.headers);
      headers.set("Sec-Fetch-Mode", "cors");
      return dispatch(target, { ...init, headers });
    }),
    perRun,
    "the check passes when every request says Sec-Fetch-Mode: cors, as Node's fetch does",
  );
  const printed = JSON.stringify(checkLines);
  assert(
    !printed.includes(values.E2E_PASSWORD!) &&
      !printed.includes(values.E2E_CONNECTION_KEY!.slice(26)) &&
      !printed.includes("tide table"),
    "lines carry no password, key or memo text",
  );
  // A crashed run's marked leftover is forgotten first and reported, and a key
  // under 30 days from expiry warns without failing.
  const testKeyCall = async (name: string, args: object) =>
    JSON.parse(
      (
        await result(
          await rpc(
            values.E2E_CONNECTION_KEY!,
            "tools/call",
            { name, arguments: args },
            { "X-Forwarded-For": "198.51.100.199, 192.0.2.1" },
          ),
        )
      ).result.content![0]!.text,
    );
  const testSave = async (args: object) =>
    assert.equal(
      (
        await testKeyCall("create_memo", {
          request_id: randomUUID(),
          ...args,
        })
      ).status,
      "saved",
    );
  await testSave({
    memo: {
      final: "Fictional leftover the crashed run saved.",
      context: {
        summary: "Milton e2e check, run crashed0",
        medium: "document",
      },
      new_kind: "e2e check",
    },
  });
  await owner.query(
    "update connection_keys set expires_at=now()+interval '20 days' where user_id=$1",
    [provisioned.userId],
  );
  assert.equal((await check()).memos, -1, "leftover forgotten, then the run");
  const owned = checkLines.find((l) => l.step === "key_owner")!;
  assert.deepEqual(
    [owned.severity, owned.warning, owned.key_days_left],
    ["WARNING", "key_expires_within_30_days", 19],
  );
  assert.equal(checkLines.find((l) => l.step === "safety_gate")!.leftovers, 1);
  assert.equal(
    checkLines.find((l) => l.step === "forget_leftovers")!.forgotten,
    1,
  );
  assert.equal(checkLines.at(-1)!.step, "done");
  // Another account's key, supplied by mistake with the test account's
  // password, is refused before any MCP request, so that key is never used.
  const foreignSecrets = join(root, "foreign-key.env");
  writeFileSync(
    foreignSecrets,
    `E2E_EMAIL=${values.E2E_EMAIL}\nE2E_PASSWORD=${values.E2E_PASSWORD}\nE2E_CONNECTION_KEY=${unrelatedKey}\n`,
    { mode: 0o600 },
  );
  await owner.query(
    "update connection_keys set last_used_at=now()-interval '1 day' where id=$1",
    [unrelatedKey.slice(3, 25)],
  );
  const foreignUse = async () =>
    (
      await owner.query(
        "select last_used_at from connection_keys where id=$1",
        [unrelatedKey.slice(3, 25)],
      )
    ).rows[0].last_used_at.getTime();
  const foreignBefore = await foreignUse();
  const mcpBefore = mcpRequests;
  await owner.query(
    'delete from milton_auth."rateLimit"; delete from milton_guard.rate_bucket',
  );
  checkLines.length = 0;
  await assert.rejects(
    runE2E({
      secrets: foreignSecrets,
      fetch: dispatch,
      report: (l) => checkLines.push(l),
    }),
    (e) => e instanceof CheckError && e.code === "key_not_on_account",
  );
  assert.deepEqual(
    [mcpRequests - mcpBefore, await foreignUse()],
    [0, foreignBefore],
    "a foreign key makes no MCP request and is never touched",
  );
  // A memo of the check's kind without the run marker is the person's, not a
  // leftover: the gate refuses and forgets nothing.
  const unmarked = (
    await testKeyCall("create_memo", {
      request_id: randomUUID(),
      memo: {
        final: "Fictional note someone filed under the check's kind.",
        context: {
          summary: "Fictional notes on the e2e check",
          medium: "document",
        },
        new_kind: "e2e check",
      },
    })
  ).memo.memo_id as string;
  const beforeUnmarked = await footprint();
  await assert.rejects(
    check(),
    (e) => e instanceof CheckError && e.code === "account_holds_foreign_data",
  );
  assert.equal(
    grew(beforeUnmarked, await footprint()).memos,
    0,
    "an unmarked memo of the check's kind is not forgotten",
  );
  await testSave({ forget_memos: [unmarked] });
  // Foreign data (a cover sheet line nobody marked) refuses before any save;
  // only the gate's own report read is recorded.
  await testSave({
    cover_sheet: { add: "Fictional foreign line.", expected_version: 0 },
  });
  const held = await footprint();
  await assert.rejects(
    check(),
    (e) => e instanceof CheckError && e.code === "account_holds_foreign_data",
  );
  assert.deepEqual(
    { ...grew(held, await footprint()), usage: 0 },
    { ...perRun, reports: 1, receipts: 0, usage: 0 },
    "refused without saving",
  );
  assert.deepEqual(checkLines.at(-1), {
    ...checkLines.at(-1),
    step: "safety_gate",
    ok: false,
    severity: "ERROR",
    error: "account_holds_foreign_data",
  });
  pass(
    "e2e check: browser sign-in, MCP key, safety gate, a marked memo saved and read fresh, a marked drafted memo saved with its one change listed on its page, both forgotten, restored baseline; bounded per-run footprint; marked leftovers forgotten; expiring key warns; an unmarked memo of its kind and other foreign data refused without saving",
  );
  stage = "test account exempt from trials and billing";
  // Trials stay on. The test account's access never depends on a trial: repeated
  // sign-ins, one with the account 31 days old, create no trial row and make no
  // Stripe request, and saves stay allowed. Even a trial row put on it by
  // mistake changes nothing: no subscription starts, an ended status does not
  // close it, no trial notice is offered and checkout refuses without Stripe.
  {
    const testUser = provisioned.userId;
    const signedIn = async () => {
      await owner.query(
        'delete from milton_auth."rateLimit"; delete from milton_guard.rate_bucket',
      );
      const b = browser(PRODUCTION, dispatch);
      await signIn(b, PRODUCTION, TEST_EMAIL, values.E2E_PASSWORD!);
      return b;
    };
    const trialRow = async () =>
      (
        await owner.query(
          "select subscription_status status from trial_accounts where user_id=$1",
          [testUser],
        )
      ).rows;
    const requests = stripe.requests;
    await owner.query(
      "update users set created_at=now()-interval '31 days' where id=$1",
      [testUser],
    );
    for (let n = 0; n < 3; n++) await signedIn();
    assert.deepEqual(await trialRow(), []);
    await testSave({
      memo: {
        final: "Fictional memo after 31 days.",
        context: { summary: "Fictional note after 31 days", medium: "chat" },
      },
    });
    await owner.query(
      "insert into trial_accounts(user_id,started_at) values($1,now()-interval '31 days')",
      [testUser],
    );
    const b = await signedIn();
    assert.deepEqual(await trialRow(), [{ status: null }], "no trial started");
    await owner.query(
      "update trial_accounts set subscription_status='canceled' where user_id=$1",
      [testUser],
    );
    await testSave({
      memo: {
        final: "Fictional memo after an ended status.",
        context: {
          summary: "Fictional note after an ended status",
          medium: "chat",
        },
      },
    });
    await owner.query(
      "update trial_accounts set subscription_status='trialing',trial_end=now()+interval '12 hours' where user_id=$1",
      [testUser],
    );
    assert.equal(
      (await testKeyCall("get_cover_sheet", {})).notice,
      undefined,
      "no trial notice",
    );
    const page = await b.follow(PRODUCTION.app + "/assistants");
    const checkout = await b.go(PRODUCTION.app + "/billing/checkout", {
      csrf: /name="csrf" value="([A-Za-z0-9_-]{43})"/.exec(page.html)![1]!,
    });
    await checkout.body?.cancel();
    assert.equal(checkout.status, 409, "checkout refuses a test account");
    assert.equal(stripe.requests, requests, "no Stripe request at all");
  }
  pass(
    "test accounts are exempt from trials and billing: repeated sign-ins past 30 days make no trial or Stripe request; a stray trial row neither starts a subscription, closes access, offers a notice nor opens checkout",
  );
  stage = "propagation: edits and retirements reach every read surface";
  // Two more fictional accounts, each filing rules and samples that carry its
  // own marker, read on every surface (the three read tools, get_report for each
  // of the five reports, the TPS.md download and the web report) with that
  // account's own key and browser session. Every request these groups make goes
  // over loopback HTTP: app, auth and MCP run their production request
  // wrappers under @hono/node-server on 127.0.0.1 ports, as Cloud Run serves
  // them, and each request carries the canonical Host and X-Forwarded-For that
  // Google's load balancer forwards. The client is node:http rather than
  // fetch, since Node's fetch replaces Host and forces Sec-Fetch-Mode: cors,
  // which no browser navigation sends. Native's admission calls go over loopback
  // to the admit role's own listener; only the metadata server's ID token stays
  // a stub in the fixture's native service.
  {
    const clearRates = () =>
      owner.query(
        'delete from milton_auth."rateLimit"; delete from milton_guard.rate_bucket',
      );
    const listen = (
      service: (
        request: Request,
        env: HttpBindings | Http2Bindings,
      ) => Response | Promise<Response>,
    ) =>
      new Promise<number>((resolve) => {
        servers.push(
          serve({ fetch: service, port: 0, hostname: "127.0.0.1" }, (info) =>
            resolve(info.port),
          ),
        );
      });
    // Each canonical origin's loopback port.
    const ports = new Map<string, number>();
    // One HTTP/1.1 request to a service's loopback port, from client address
    // `from` behind the load balancer (which appends its own address). Never a
    // redirect followed; the body is read whole.
    const loopback =
      (from: string): Fetch =>
      (target, init) =>
        new Promise<Response>((resolve, reject) => {
          const u = new URL(target);
          const port = ports.get(u.origin);
          if (!port) return reject(new Error("external_network_refused"));
          const headers = new Headers(init.headers);
          headers.set("Host", u.host);
          if (!headers.has("X-Forwarded-For"))
            headers.set("X-Forwarded-For", `${from}, 192.0.2.1`);
          const body =
            init.body === undefined || init.body === null
              ? undefined
              : typeof init.body === "string" ||
                  init.body instanceof URLSearchParams
                ? String(init.body)
                : init.body instanceof Uint8Array
                  ? init.body
                  : reject(new Error("unsupported_body"));
          if (
            init.body instanceof URLSearchParams &&
            !headers.has("Content-Type")
          )
            headers.set("Content-Type", "application/x-www-form-urlencoded");
          if (body !== undefined)
            headers.set(
              "Content-Length",
              String(Buffer.byteLength(body as string)),
            );
          const sent = httpRequest(
            {
              host: "127.0.0.1",
              port,
              method: init.method ?? "GET",
              path: u.pathname + u.search,
              headers: Object.fromEntries(headers),
              signal: init.signal ?? undefined,
            },
            (incoming) => {
              const chunks: Buffer[] = [];
              incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
              incoming.on("error", reject);
              incoming.on("end", () => {
                const received = new Headers();
                for (const [name, value] of Object.entries(incoming.headers))
                  for (const one of [value ?? []].flat())
                    received.append(name, one);
                const status = incoming.statusCode!;
                resolve(
                  new Response(
                    [101, 204, 205, 304].includes(status)
                      ? null
                      : Buffer.concat(chunks),
                    { status, headers: received },
                  ),
                );
              });
            },
          );
          sent.on("error", reject);
          sent.end(body);
        });
    // The app's own calls to auth (token, UserInfo) go over loopback too.
    const loopConfig: RuntimeConfig = {
      ...config,
      authFetch: ((input: string, init: RequestInit) =>
        loopback("203.0.113.250")(
          String(input),
          init,
        )) as RuntimeConfig["authFetch"],
    };
    ports.set(
      config.appOrigin,
      await listen(
        cloudRequests(loopConfig, createMiltonApp(loopConfig, true)),
      ),
    );
    ports.set(
      AUTH_ORIGIN,
      await listen(createAuthCloudApp(nativeService, authAssets)),
    );
    ports.set(
      new URL(config.resource).origin,
      await listen(createMcpApp(mcpConfig)),
    );
    // The admit role on its own listener, behind the invoker stand-in (403
    // without the stub metadata token), as milton-admit sits behind Cloud Run's
    // front end; auth's admission calls now reach it over loopback HTTP.
    ports.set(ADMIT_ORIGIN, await listen(invoke));
    let admittedOverLoopback = 0;
    admitVia = async (request) => {
      admittedOverLoopback++;
      return loopback("203.0.113.252")(request.url, {
        method: request.method,
        headers: request.headers,
        body: await request.text(),
        signal: request.signal,
      });
    };
    const refused = await loopback("203.0.113.253")(
      ADMIT_ORIGIN + "/internal/auth/admit",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${nativeConfig.AUTH_ADMISSION_SECRET}`,
          "Content-Type": "application/json",
        },
        body: "{}",
      },
    );
    assert.equal(refused.status, 403, "no ID token, no admission");
    // Nothing these groups run may leave the machine. Global fetch and
    // node:http/https requests to anything but loopback are refused and
    // recorded (a caller may swallow the error: the MCP verifier turns a failed
    // key fetch into a 401), and the record must stay empty. Auth's canonical
    // origin is the local auth listener: createMcpApp builds its verifier with
    // the default fetch, so its JWKS request is routed here, not to production.
    const outbound: string[] = [];
    const local = (host: string) =>
      ["127.0.0.1", "localhost", "::1", "[::1]"].includes(host);
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      const target = new URL(input instanceof Request ? input.url : input);
      if (target.origin === AUTH_ORIGIN)
        return loopback("203.0.113.251")(target.href, {
          method: input instanceof Request ? input.method : init?.method,
          headers: input instanceof Request ? input.headers : init?.headers,
          body: init?.body,
          signal: init?.signal,
        });
      if (!local(target.hostname)) {
        outbound.push(target.origin);
        throw new Error("outbound_request_refused");
      }
      return realFetch(input, init);
    }) as typeof fetch;
    const guarded = <T extends (...args: never[]) => unknown>(
      original: T,
      scheme: string,
    ) =>
      ((...args: unknown[]) => {
        const [first, second] = args;
        const options = (
          typeof first === "string" || first instanceof URL
            ? new URL(first)
            : (first ?? second ?? {})
        ) as { hostname?: string | null; host?: string | null };
        const host = options.hostname ?? options.host ?? "localhost";
        if (!local(host)) {
          outbound.push(`${scheme}://${host}`);
          throw new Error("outbound_request_refused");
        }
        return (original as unknown as (...all: unknown[]) => unknown)(...args);
      }) as unknown as T;
    const builtins = [
      [http, "http"],
      [https, "https"],
    ] as const;
    const saved = builtins.map(([module]) => [module.request, module.get]);
    for (const [module, scheme] of builtins) {
      module.request = guarded(module.request, scheme);
      module.get = guarded(module.get, scheme);
    }
    syncBuiltinESMExports();
    restoreOutbound = () => {
      globalThis.fetch = realFetch;
      builtins.forEach(([module], i) => {
        module.request = saved[i]![0]!;
        module.get = saved[i]![1]!;
      });
      syncBuiltinESMExports();
    };
    const intent = {
      situation: "declining a fictional vendor's meeting request",
      medium: "email",
      audience: "a vendor",
      purpose: "decline",
    } as const;
    const surfaceNames = [
      "get_cover_sheet",
      "get_report",
      "download",
      "web",
    ] as const;
    type Surface = (typeof surfaceNames)[number];
    type Surfaces = Record<Surface, string>;
    // Each call is its own client behind the load balancer, so the key-lookup
    // limits never refuse one.
    let clients = 0;
    const mcpPost = (key: string, method: string, params: unknown) => {
      const n = ++clients;
      return loopback(`198.18.${n >> 8}.${n & 255}`)(config.resource, {
        method: "POST",
        headers: {
          Authorization: "Bearer " + key,
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      });
    };
    const callTool = async (key: string, name: string, args: object = {}) => {
      const reply = (
        await result(
          await mcpPost(key, "tools/call", { name, arguments: args }),
        )
      ).result;
      return { text: reply.content![0]!.text, isError: reply.isError === true };
    };
    const readTool = async (key: string, name: string, args: object = {}) => {
      const reply = await callTool(key, name, args);
      assert(!reply.isError, `${name} reads`);
      return reply.text;
    };
    // One person's browser traffic, from its own client address: every cookie
    // it is sent, by host, is kept so a session can be replayed after the
    // browser itself has dropped it.
    const person = (name: string, from: string) => {
      const cookies = new Map<string, string>();
      const web: Fetch = async (target, init) => {
        const response = await loopback(from)(target, init);
        for (const cookie of response.headers.getSetCookie()) {
          const pair = cookie.split(";")[0]!;
          const i = pair.indexOf("=");
          cookies.set(
            `${new URL(target).host}\t${pair.slice(0, i)}`,
            pair.slice(i + 1),
          );
        }
        return response;
      };
      return { marker: `${name.toUpperCase()}MARK`, cookies, web };
    };
    const side = async (
      p: ReturnType<typeof person>,
      email: string,
      password: string,
      // Known in advance, or found once the first sign-in has made it.
      account: () => Promise<{ userId: string; subject: string }>,
      key?: string,
    ) => {
      const signedIn = async () => {
        const b = browser(PRODUCTION, p.web);
        await signIn(b, PRODUCTION, email, password);
        return b;
      };
      const b = await signedIn();
      return {
        ...p,
        ...(await account()),
        email,
        password,
        key: key ?? (await mintKey(b, PRODUCTION, "Fictional propagation")),
        browser: b,
        signedIn,
      };
    };
    // Alder, the account deleted later, signs up as a person does (an
    // example.com address, so native queues its mail), with a trial; Birch is
    // provisioned as the test account is.
    await clearRates();
    const alder = await (async () => {
      const p = person("alder", "203.0.113.11");
      const email = "propagation-alder@example.com",
        password = "Fictional alder propagation password 518";
      const json = (path: string, body: object) =>
        p.web(ISSUER + path, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
            Origin: AUTH_ORIGIN,
          },
          body: JSON.stringify(body),
        });
      const signedUp = await json("/sign-up/email", {
        name: "Fictional Alder",
        email,
        password,
      });
      assert.equal(signedUp.status, 200, "native sign-up");
      await drainMail();
      const verified = await p.web(
        mail.findLast((m) => m.kind === "verify")!.url,
        { method: "GET" },
      );
      assert.equal(verified.status, 302, "verification link");
      const subject = (
        await owner.query<{ id: string }>(
          'SELECT id FROM milton_auth."user" WHERE email=$1',
          [email],
        )
      ).rows[0]!.id;
      return side(p, email, password, async () => ({
        subject,
        userId: (
          await lookupIdentityAccount(config, { provider: ISSUER, subject })
        ).userId,
      }));
    })();
    const birch = await (async () => {
      const p = person("birch", "203.0.113.12");
      const email = "propagation-birch@milton-test.invalid";
      const output = join(root, "propagation-birch.env");
      const account = await provisionTestAccount({
        email,
        output,
        owners,
        fetch: p.web,
        report: () => {},
      });
      const { key, password } = await readSecrets(output);
      return side(p, email, password, async () => account, key);
    })();
    type Side = typeof alder | typeof birch;
    const both = [alder, birch];
    const other = (s: Side) => (s === alder ? birch : alder);
    // The latest report each account was served, by its report_id.
    const lastReport = new Map<Side, string>();
    const surfaces = async (s: Side): Promise<Surfaces> => {
      const { report_id, ...report } = JSON.parse(
        await readTool(s.key, "get_report", { intent }),
      ) as { report_id: string };
      lastReport.set(s, report_id);
      const seen = {
        get_cover_sheet: await readTool(s.key, "get_cover_sheet"),
        // Every read is served under a fresh report_id; the rest is what it
        // served.
        get_report: JSON.stringify(report),
      } as Surfaces;
      const download = await s.browser.go(PRODUCTION.app + "/download");
      assert.equal(download.status, 200, "TPS.md download");
      seen.download = await download.text();
      const web = await s.browser.follow(PRODUCTION.app + "/tps-report");
      assert.equal(web.status, 200, "web TPS page");
      seen.web = web.html;
      return seen;
    };
    // What the AI surfaces and the download serve, byte for byte (the web
    // page also prints a random joke).
    const served = (seen: Surfaces) =>
      JSON.stringify(
        surfaceNames.filter((s) => s !== "web").map((s) => seen[s]),
      );
    type Outcome = {
      status?: string;
      error?: string;
      memo?: {
        memo_id: string;
        kind_id?: string;
        tweaks: { tweak_id: string }[];
      };
    };
    const save = async (s: Side, args: object) =>
      JSON.parse(
        (
          await callTool(s.key, "create_memo", {
            request_id: randomUUID(),
            ...args,
          })
        ).text,
      ) as Outcome;
    const coverLine = async (
      s: Side,
      change: { add: string } | { remove: string },
    ) =>
      save(s, {
        cover_sheet: {
          ...change,
          expected_version: (
            JSON.parse(await readTool(s.key, "get_cover_sheet")) as {
              version: number;
            }
          ).version,
        },
      });
    // Where each kind of filed text shows: a cover sheet line everywhere; a
    // final in the report and TPS.md; a memo's summary and its tweaks also on
    // the web page.
    const cover: Surface[] = [
      "get_cover_sheet",
      "get_report",
      "download",
      "web",
    ];
    const final: Surface[] = ["get_report", "download"];
    const listed: Surface[] = ["get_report", "download", "web"];
    const line = (m: string, age: "old" | "new") =>
      `Sign fictional notes with ${m} cover ${age}.`;
    const drafted = (
      m: string,
      n: "one" | "two",
      body: string,
      tweak: string,
    ) => ({
      memo: {
        final: `Fictional ${m} memo ${n}: ${body}`,
        first_draft: `Hi! Hope you are well. Fictional ${m} draft ${n}.`,
        mode: "draft",
        rounds: 1,
        new_kind: "fictional note",
        tweaks: [{ text: `${m} tweak ${n}: ${tweak}` }],
        context: {
          summary: `${m} summary ${n === "one" ? "old" : "two"}`,
          medium: "email",
          audience: "a vendor",
          purpose: "decline",
        },
      },
    });
    // Each filed text and the surfaces that must show it.
    const filed = (m: string): [string, Surface[]][] => [
      [`${m} cover old`, cover],
      [`${m} memo one`, final],
      [`${m} summary old`, listed],
      [`${m} tweak one`, listed],
      [`${m} memo two`, final],
      [`${m} summary two`, listed],
      [`${m} tweak two`, listed],
    ];
    // After a line replaced, memo one's context corrected and memo two
    // forgotten (with the tweak only it cited).
    const edited = (m: string): [string, Surface[]][] => [
      [`${m} cover new`, cover],
      [`${m} memo one`, final],
      [`${m} summary new`, listed],
      [`${m} tweak one`, listed],
    ];
    const removed = (m: string) => [
      `${m} cover old`,
      `${m} summary old`,
      `${m} memo two`,
      `${m} summary two`,
      `${m} tweak two`,
    ];
    // Every miss at once, as surface and text, so a failure names them all.
    const shows = (
      seen: Surfaces,
      texts: [string, Surface[]][],
      when: string,
    ) =>
      assert.deepEqual(
        texts.flatMap(([text, where]) =>
          where
            .filter((s) => !seen[s].includes(text))
            .map((s) => `missing from ${s}: ${text}`),
        ),
        [],
        `${when}: each surface shows the text it should`,
      );
    const never = (seen: Surfaces, texts: string[], when: string) =>
      assert.deepEqual(
        texts.flatMap((text) =>
          surfaceNames
            .filter((s) => seen[s].includes(text))
            .map((s) => `${s}: ${text}`),
        ),
        [],
        `${when}: no surface shows the text`,
      );
    // Nothing of the other account: its marker, account id, native subject or
    // email.
    const isolated = (s: Side, seen: Surfaces, when: string) => {
      const o = other(s);
      never(
        seen,
        [o.marker, o.userId, o.subject, o.email],
        when + " isolation",
      );
    };
    const ids = new Map<
      Side,
      { one: string; two: string; kind: string; tweak: string }
    >();
    for (const s of both) {
      const m = s.marker;
      assert.equal(
        (await coverLine(s, { add: line(m, "old") })).status,
        "saved",
      );
      const one = await save(
        s,
        drafted(m, "one", "the ladder hangs in the barn.", "no warm-up opener"),
      );
      const two = await save(
        s,
        drafted(m, "two", "the gate sticks after rain.", "name the day"),
      );
      assert.deepEqual([one.status, two.status], ["saved", "saved"]);
      ids.set(s, {
        one: one.memo!.memo_id,
        two: two.memo!.memo_id,
        kind: one.memo!.kind_id!,
        tweak: one.memo!.tweaks[0]!.tweak_id,
      });
    }
    for (const s of both) {
      const seen = await surfaces(s);
      shows(seen, filed(s.marker), "filed");
      isolated(s, seen, "filed");
    }
    for (const s of both) {
      const m = s.marker;
      const own = ids.get(s)!;
      for (const outcome of [
        await coverLine(s, { add: line(m, "new") }),
        await coverLine(s, { remove: line(m, "old") }),
        await save(s, {
          memo_context: {
            memo_id: own.one,
            context: {
              summary: `${m} summary new`,
              medium: "email",
              audience: "a vendor",
              purpose: "decline",
            },
          },
        }),
        await save(s, { forget_memos: [own.two] }),
      ])
        assert.equal(outcome.status, "saved");
    }
    const settled = new Map<Side, Surfaces>();
    for (const s of both) {
      const seen = await surfaces(s);
      shows(seen, edited(s.marker), "edited");
      never(seen, removed(s.marker), "edited");
      isolated(s, seen, "edited");
      settled.set(s, seen);
    }
    pass(
      "over loopback HTTP to the production app, auth and MCP wrappers: a cover sheet line replaced, a memo's context corrected and a memo forgotten reach get_cover_sheet, get_report, the TPS.md download and the web TPS page: the old text is gone from all, the new text shows where it belongs",
    );
    stage = "isolation: one account's key and session cannot address another's";
    {
      // Alder's key aims at Birch's memo, kind, tweak, report and cover sheet
      // line; Alder's session names Birch's account and memo. Nothing lands,
      // nothing leaks, and both accounts still serve exactly what they did.
      const target = ids.get(birch)!;
      const context = {
        summary: "Fictional takeover",
        medium: "email",
      };
      const takeover = { final: "Fictional takeover.", context };
      for (const [args, error] of [
        [{ memo_context: { memo_id: target.one, context } }, "invalid_memo"],
        [{ forget_memos: [target.one] }, "invalid_memo"],
        [{ memo: { ...takeover, kind_id: target.kind } }, "invalid_kind"],
        [
          {
            memo: {
              ...takeover,
              first_draft: "Fictional takeover draft.",
              mode: "draft",
              rounds: 1,
              tweaks: [{ tweak_id: target.tweak }],
            },
          },
          "invalid_tweak",
        ],
        [
          { memo: { ...takeover, report_id: lastReport.get(birch)! } },
          "invalid_report",
        ],
      ] as const) {
        const outcome = await save(alder, args);
        assert.deepEqual(
          [outcome.status, outcome.error],
          ["failed", error],
          "a save never reaches another account's memos, kinds, tweaks or reports",
        );
      }
      const foreignLine = await coverLine(alder, {
        remove: line(birch.marker, "new"),
      });
      assert.deepEqual(
        [foreignLine.status, foreignLine.error],
        ["failed", "line_not_found"],
        "a save never removes another account's cover sheet line",
      );
      const aimed = await callTool(alder.key, "get_report", {
        intent: { ...intent, kind_id: target.kind },
      });
      assert.deepEqual(
        [aimed.isError, (JSON.parse(aimed.text) as Outcome).error],
        [true, "invalid_kind"],
        "another account's kind is refused on read",
      );
      assert(
        !aimed.text.includes(birch.marker),
        "another account's kind serves nothing of it",
      );
      const memoPath = `/tps/memo/${target.one}`;
      const own = await birch.browser.follow(PRODUCTION.app + memoPath);
      assert(
        own.status === 200 && own.html.includes(`${birch.marker} memo one`),
        "the memo page shows its own account's memo",
      );
      for (const path of ["/download", "/tps-report", memoPath]) {
        const page = await alder.browser.follow(
          `${PRODUCTION.app}${path}?user=${birch.userId}&subject=${birch.subject}`,
        );
        assert(
          !page.html.includes(birch.marker),
          `${path} names no other account`,
        );
      }
      for (const s of both) {
        const seen = await surfaces(s);
        isolated(s, seen, "after foreign attempts");
        assert.equal(
          served(seen),
          served(settled.get(s)!),
          "both accounts serve exactly what they did",
        );
      }
    }
    pass(
      "two accounts' reads (three tools, TPS.md, web) never show each other's markers, ids or emails, before or after a forget and a context edit; one account's key cannot correct, forget, cite or read another's memos, kind, tweaks, report or cover sheet, and its session cannot name another account or open its memo",
    );
    stage = "account deletion leaves nothing of the account";
    {
      // Every foreign key to an account (public.users) or to a native user,
      // read from the catalog, so a new table is covered without a list here.
      const references = (
        await owner.query<{
          tbl: string;
          col: string;
          to: "writing" | "native";
          width: number;
        }>(
          `SELECT format('%I.%I',n.nspname,c.relname) tbl, format('%I',a.attname) col,
            CASE WHEN k.confrelid='public.users'::regclass THEN 'writing' ELSE 'native' END "to",
            cardinality(k.conkey) width
          FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace
          JOIN pg_attribute a ON a.attrelid=k.conrelid AND a.attnum=k.conkey[1]
          WHERE k.contype='f' AND k.confrelid IN ('public.users'::regclass,'milton_auth."user"'::regclass)
          ORDER BY 1,2`,
        )
      ).rows;
      assert(
        references.every((r) => r.width === 1),
        "every account reference is one column",
      );
      const owned = async (s: Side) =>
        Object.fromEntries(
          await Promise.all(
            references.map(async (r) => [
              `${r.tbl}.${r.col}`,
              (
                await owner.query<{ n: number }>(
                  `SELECT count(*)::int n FROM ${r.tbl} WHERE ${r.col}=$1`,
                  [r.to === "writing" ? s.userId : s.subject],
                )
              ).rows[0]!.n,
            ]),
          ),
        ) as Record<string, number>;
      // Every column of every base table in every schema, as text, for the
      // account id, the native subject, the email and the marker: a count per
      // column and value. This also finds what a table without a foreign key
      // keeps, but only when it holds rows of this account: a user-owned table
      // with no foreign key that these fixtures never fill is not caught.
      const columns = (
        await owner.query<{ tbl: string; col: string }>(
          `SELECT format('%I.%I',c.table_schema,c.table_name) tbl, format('%I',c.column_name) col
          FROM information_schema.columns c JOIN information_schema.tables t USING (table_schema,table_name)
          WHERE t.table_type='BASE TABLE' AND c.table_schema NOT IN ('pg_catalog','information_schema') ORDER BY 1,2`,
        )
      ).rows;
      const needles = ["account", "subject", "email", "marker"] as const;
      type Found = Partial<Record<(typeof needles)[number], number>>;
      const scan = async (s: Side) => {
        const rows = (
          await owner.query<
            Record<(typeof needles)[number], number> & { at: string }
          >(
            columns
              .map(
                ({ tbl, col }) =>
                  `SELECT '${`${tbl}.${col}`.replaceAll("'", "''")}' AS at,` +
                  needles
                    .map(
                      (needle, i) =>
                        `count(*) FILTER (WHERE strpos(${col}::text,$${i + 1})>0)::int ${needle}`,
                    )
                    .join(",") +
                  ` FROM ${tbl}`,
              )
              .join(" UNION ALL "),
            [s.userId, s.subject, s.email, s.marker],
          )
        ).rows;
        return Object.fromEntries(
          rows
            .map(
              (r) =>
                [
                  r.at,
                  Object.fromEntries(
                    needles.filter((n) => r[n] > 0).map((n) => [n, r[n]]),
                  ) as Found,
                ] as const,
            )
            .filter(([, found]) => Object.keys(found).length),
        );
      };
      // What these flows leave empty: the Keep memos switch; an AI connected
      // through native OAuth (its client, consent and tokens); a
      // password-reset mail (its mail job and reset proof).
      await owner.query(
        "INSERT INTO memo_settings(user_id,keep_memos) VALUES($1,false)",
        [alder.userId],
      );
      const authCookie = (s: Side) =>
        [...s.cookies]
          .filter(([k, v]) => k.startsWith("auth.meetmilton.com\t") && v)
          .map(([k, v]) => `${k.split("\t")[1]}=${v}`)
          .join("; ");
      const nativeJson = (s: Side, path: string, body: object) =>
        s.web(ISSUER + path, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
            Origin: AUTH_ORIGIN,
            Cookie: authCookie(s),
          },
          body: JSON.stringify(body),
        });
      // An anonymous registration with a name and a contact, as an assistant
      // registers itself.
      const register = async (client_name: string, contact: string) => {
        await clearRates();
        const registered = await nativeJson(alder, "/oauth2/register", {
          client_name,
          contacts: [contact],
          redirect_uris: ["https://assistant.example.invalid/callback"],
          token_endpoint_auth_method: "client_secret_post",
          scope: "openid offline_access milton:read milton:write",
          grant_types: ["authorization_code", "refresh_token"],
        });
        assert.equal(registered.status, 201, `${client_name} registers`);
        const registration = (await registered.json()) as {
          client_id: string;
          client_secret: string;
        };
        const oauth = await oidc.discovery(
          new URL(ISSUER),
          registration.client_id,
          { id_token_signed_response_alg: "EdDSA" },
          oidc.ClientSecretPost(registration.client_secret),
          {
            [oidc.customFetch]: (target, options) =>
              loopback("203.0.113.13")(target, options as RequestInit),
            execute: [oidc.enableNonRepudiationChecks],
            timeout: 5,
          },
        );
        return { clientId: registration.client_id, oauth };
      };
      type Registration = Awaited<ReturnType<typeof register>>;
      const assistantScope = "openid offline_access milton:read milton:write";
      // One authorization by `s`, consent included, up to the code it returns.
      const authorize = async (s: Side, client: Registration) => {
        await clearRates();
        const state = oidc.randomState(),
          nonce = oidc.randomNonce(),
          pkce = oidc.randomPKCECodeVerifier();
        const authorization = await s.web(
          oidc.buildAuthorizationUrl(client.oauth, {
            redirect_uri: "https://assistant.example.invalid/callback",
            scope: assistantScope,
            resource: config.resource,
            state,
            nonce,
            code_challenge: await oidc.calculatePKCECodeChallenge(pkce),
            code_challenge_method: "S256",
          }).href,
          {
            method: "GET",
            headers: { Accept: "text/html", Cookie: authCookie(s) },
          },
        );
        let destination =
          authorization.headers.get("Location") ??
          ((await authorization.json()) as { url: string }).url;
        if (new URL(destination, AUTH_ORIGIN).pathname === "/consent") {
          const choice = await nativeJson(s, "/oauth2/consent", {
            accept: true,
            scope: assistantScope,
            oauth_query: new URL(
              destination,
              AUTH_ORIGIN,
            ).searchParams.toString(),
          });
          assert.equal(choice.status, 200, "assistant consent");
          destination = ((await choice.json()) as { url: string }).url;
        }
        const callback = new URL(destination, AUTH_ORIGIN);
        assert(callback.searchParams.get("code"), "an authorization code");
        return () =>
          oidc.authorizationCodeGrant(
            client.oauth,
            callback,
            {
              expectedState: state,
              expectedNonce: nonce,
              pkceCodeVerifier: pkce,
            },
            { resource: config.resource },
          );
      };
      const connect = async (s: Side, client: Registration) => {
        const grant = await (await authorize(s, client))();
        const refresh_token = grant.refresh_token;
        assert(refresh_token, "an offline assistant grant");
        return { access_token: grant.access_token, refresh_token };
      };
      // A JWT at MCP: its verifier fetches native's JWKS, from the local listener.
      const toolsWith = async (accessToken: string) => {
        const response = await mcpPost(accessToken, "tools/list", {});
        assert.deepEqual(outbound, [], "no request left the machine");
        return response.status === 200
          ? (await result(response)).result.tools?.length
          : response.status;
      };
      // Three registrations: one only this account authorizes, one Birch
      // authorizes too, and one this account disconnected long ago. Alder
      // connects the first and holds an unredeemed code for the second.
      const solo = await register(
        "Fictional propagation assistant",
        "solo-assistant@example.invalid",
      );
      const shared = await register(
        "Fictional shared assistant",
        "shared-assistant@example.invalid",
      );
      const gone = await register(
        "Fictional disconnected assistant",
        "gone-assistant@example.invalid",
      );
      const grant = await connect(alder, solo);
      const outstandingCode = await authorize(alder, shared);
      const birchGrant = await connect(birch, shared);
      // The third is disconnected, and its binding then expires and is swept,
      // as if a month had passed: no consent, token or binding of it is left,
      // and the account's link to it alone remains.
      await connect(alder, gone);
      const disconnect = randomUUID();
      await owner.query(
        `SELECT milton_guard.begin_operation($1,id,"miltonIdentityIncarnation",$2,'disconnect') FROM milton_auth."user" WHERE id=$3`,
        [disconnect, gone.clientId, alder.subject],
      );
      for (let n = 0; ; n++) {
        const { progress } = (
          await owner.query<{ progress: string }>(
            "SELECT milton_guard.cleanup_operation($1,16) AS progress",
            [disconnect],
          )
        ).rows[0]!;
        if (progress === "complete") break;
        assert(n < 8, "the disconnect's cleanup finishes");
      }
      await owner.query(
        "UPDATE milton_guard.authorization_binding SET expires_at=now()-interval '2 days' WHERE client_id=$1",
        [gone.clientId],
      );
      await owner.query("SELECT milton_guard.cleanup_expired(64)");
      assert.deepEqual(
        (
          await owner.query(
            `SELECT (SELECT count(*) FROM milton_guard.authorization_binding WHERE client_id=$1)::int bindings,
             (SELECT count(*) FROM milton_auth."oauthConsent" WHERE "clientId"=$1)::int consents,
             (SELECT count(*) FROM milton_auth."oauthRefreshToken" WHERE "clientId"=$1)::int refresh,
             (SELECT count(*) FROM milton_guard.client_link WHERE client_id=$1)::int links`,
            [gone.clientId],
          )
        ).rows[0],
        { bindings: 0, consents: 0, refresh: 0, links: 1 },
        "after disconnect and expiry only the account's link names the registration",
      );
      const registrations = async () =>
        (
          await owner.query<{
            clientId: string;
            name: string | null;
            contacts: unknown;
          }>(
            'SELECT "clientId",name,contacts FROM milton_auth."oauthClient" WHERE "clientId"=ANY($1) ORDER BY name NULLS LAST',
            [[solo.clientId, shared.clientId, gone.clientId]],
          )
        ).rows;
      assert.deepEqual(
        await registrations(),
        [
          {
            clientId: gone.clientId,
            name: "Fictional disconnected assistant",
            contacts: ["gone-assistant@example.invalid"],
          },
          {
            clientId: solo.clientId,
            name: "Fictional propagation assistant",
            contacts: ["solo-assistant@example.invalid"],
          },
          {
            clientId: shared.clientId,
            name: "Fictional shared assistant",
            contacts: ["shared-assistant@example.invalid"],
          },
        ],
        "every registration keeps the name and contact it sent",
      );
      const soloDependents = async () =>
        (
          await owner.query<Record<string, number>>(
            `SELECT (SELECT count(*) FROM milton_auth."oauthClientResource" WHERE "clientId"=$1)::int resources,
             (SELECT count(*) FROM milton_auth."oauthConsent" WHERE "clientId"=$1)::int consents,
             (SELECT count(*) FROM milton_auth."oauthRefreshToken" WHERE "clientId"=$1)::int refresh,
             (SELECT count(*) FROM milton_guard.authorization_binding WHERE client_id=$1)::int bindings`,
            [solo.clientId],
          )
        ).rows[0]!;
      assert(
        Object.values(await soloDependents()).every((n) => n > 0),
        "the solo registration has dependents before deletion",
      );
      const userInfo = async () =>
        (
          await alder.web(ISSUER + "/oauth2/userinfo", {
            method: "GET",
            headers: { Authorization: "Bearer " + grant.access_token },
          })
        ).status;
      assert.equal(await userInfo(), 200, "the assistant's token works");
      const assistantTools = () => toolsWith(grant.access_token);
      assert.equal(await assistantTools(), 3, "the assistant reaches MCP");
      assert.equal(
        await toolsWith(birchGrant.access_token),
        3,
        "Birch's assistant reaches MCP",
      );
      assert.equal(
        (
          await nativeJson(alder, "/request-password-reset", {
            email: alder.email,
          })
        ).status,
        200,
        "a reset mail",
      );
      await drainMail();
      // Every reference to an account or native user, from the catalog, holds
      // rows of this one, and so do the account-linked columns that have no
      // foreign key; these listed ones only appear during the deletion itself.
      const unreferenced = [
        "milton_app.admission.subject",
        "milton_app.admission.user_id",
        "milton_app.session.subject",
        "milton_auth.verification.value",
        "milton_guard.authorization_binding.origin_user",
        "milton_guard.mail_job.origin_user",
      ];
      // Excluded, with the reason: only native's user-owned client creation
      // sets it, and no exposed endpoint offers that (dynamic registration is
      // anonymous, so the assistant's client above has no owner).
      const unreachable = ['milton_auth."oauthClient"."userId"'];
      const found = await scan(alder);
      assert.deepEqual(
        [
          ...Object.entries(await owned(alder))
            .filter(([at, n]) => n === 0 && !unreachable.includes(at))
            .map(([column]) => column),
          ...unreferenced.filter((at) => !found[at]),
        ],
        [],
        "every account table and column holds rows of it before deletion, so the checks below are not vacuous",
      );
      assert(
        found["public.memos.final"]?.marker &&
          found['milton_auth."user".email']?.email,
        "before deletion the scan finds the account's text and email",
      );
      const birchRows = await owned(birch);
      // The browser session, as the deletion form needs it fresh, kept for replay.
      await clearRates();
      const deleting = await alder.signedIn();
      const held = new Map(alder.cookies);
      const replay = async (target: string) => {
        const u = new URL(target);
        const cookie = [...held]
          .filter(([k, v]) => k.startsWith(u.host + "\t") && v)
          .map(([k, v]) => `${k.slice(u.host.length + 1)}=${v}`)
          .join("; ");
        const response = await loopback("203.0.113.14")(target, {
          method: "GET",
          headers: { Accept: "text/html", Cookie: cookie },
        });
        return { status: response.status, body: await response.text() };
      };
      const download = await replay(PRODUCTION.app + "/download");
      assert(
        download.status === 200 && download.body.includes(alder.marker),
        "replayed session reads",
      );
      assert(
        (await replay(ISSUER + "/get-session")).body.includes(alder.subject),
        "replayed native session",
      );
      const confirm = await deleting.follow(PRODUCTION.app + "/account/delete");
      assert.equal(confirm.status, 200, "the deletion page");
      const field = (name: string) =>
        new RegExp(`name="${name}" value="([^"]+)"`).exec(confirm.html)![1]!;
      const operation = field("operation");
      const deleted = await deleting.follow(
        PRODUCTION.app + "/account/delete",
        {
          csrf: field("csrf"),
          operation,
          confirm: "delete my account",
        },
      );
      assert(
        deleted.status === 200 && deleted.html.includes("Account deleted"),
        "the app's deletion completes",
      );
      await backgroundSettled();
      assert.equal(
        (
          await owner.query(
            "SELECT progress FROM milton_app.lifecycle WHERE operation_id=$1",
            [operation],
          )
        ).rows[0].progress,
        "complete",
      );
      // The key, the assistant's grant, the app session and the native session
      // no longer authenticate.
      for (const [method, params] of [
        ["tools/list", {}],
        ["tools/call", { name: "get_cover_sheet", arguments: {} }],
      ] as const) {
        const response = await mcpPost(alder.key, method, params);
        assert.equal(
          response.status,
          401,
          `the deleted account's key: ${method}`,
        );
        assert(
          !(await response.text()).includes(alder.marker),
          `${method} serves nothing of it`,
        );
      }
      assert.notEqual(await userInfo(), 200, "the assistant's token");
      assert.equal(await assistantTools(), 401, "the assistant at MCP");
      await assert.rejects(
        oidc.refreshTokenGrant(solo.oauth, grant.refresh_token, {
          resource: config.resource,
        }),
        "the assistant's refresh token",
      );
      await assert.rejects(outstandingCode(), "the unredeemed code");
      for (const path of ["/", "/tps-report", "/download"]) {
        const page = await replay(PRODUCTION.app + path);
        if (path !== "/")
          assert.notEqual(
            page.status,
            200,
            `the deleted account's session: ${path}`,
          );
        assert(
          !page.body.includes(alder.marker),
          `${path} serves nothing of it`,
        );
      }
      const nativeSession = (await replay(ISSUER + "/get-session")).body;
      assert(
        !nativeSession.includes(alder.subject) &&
          !nativeSession.includes(alder.email),
        "native session ended",
      );
      await clearRates();
      await assert.rejects(
        signIn(
          browser(PRODUCTION, loopback("203.0.113.15")),
          PRODUCTION,
          alder.email,
          alder.password,
        ),
        (e) => e instanceof CheckError && e.code === "sign_in_refused",
        "the deleted account's password signs in to nothing",
      );
      // No row references the account, and only what deletion keeps by design
      // still names it, by its opaque ids alone (never its email or text).
      assert.deepEqual(
        Object.entries(await owned(alder)).filter(([, n]) => n > 0),
        [],
        "no row in a table referencing the account or its native user remains",
      );
      // Each column that may still name it, with its row count: one admission
      // per sign-in and assistant authorization, one mail job per mail sent
      // (verification and reset). No sign-in grant binding remains. Any other
      // column, or another row, fails.
      assert.deepEqual(
        await scan(alder),
        {
          // Admission correlations, reclaimed by later logins after 24 hours.
          "milton_app.admission.subject": { subject: 5 },
          "milton_app.admission.user_id": { account: 5 },
          // The original deletion operation, kept so a retry stays safe.
          "milton_app.lifecycle.subject": { subject: 1 },
          "milton_app.lifecycle.user_id": { account: 1 },
          // The trial-eligibility fingerprint's first claimant.
          "milton_app.trial_fingerprint.first_user_id": { account: 1 },
          // Sent mail jobs, their payloads already cleared; owner maintenance
          // clears their receipts after 24 hours.
          "milton_guard.mail_job.origin_user": { subject: 2 },
          // Native's records of the deletion and the earlier disconnect.
          "milton_guard.security_operation.origin_user": { subject: 2 },
        },
        "nothing else names the account or holds its text",
      );
      // The registrations only it authorized, the long-disconnected one
      // included, are gone with their dependents; the one Birch also
      // authorized stays, without its name or contact.
      assert.deepEqual(
        await registrations(),
        [{ clientId: shared.clientId, name: null, contacts: null }],
        "the solo and disconnected registrations are deleted and the shared one cleared",
      );
      // A metadata-document refresh writing them back keeps them cleared.
      await owner.query(
        `UPDATE milton_auth."oauthClient" SET name='Fictional restored name',contacts='["restored@example.invalid"]' WHERE "clientId"=$1`,
        [shared.clientId],
      );
      assert.deepEqual(
        await registrations(),
        [{ clientId: shared.clientId, name: null, contacts: null }],
        "a cleared registration stays cleared",
      );
      // So does a deleted one stored again under its client ID, as a client
      // metadata document's rediscovery would.
      await owner.query(
        `INSERT INTO milton_auth."oauthClient"(id,"clientId","redirectUris",name,contacts) VALUES($1,$1,'[]','Fictional restored name','["restored@example.invalid"]')`,
        [solo.clientId],
      );
      assert.deepEqual(
        (
          await owner.query(
            `SELECT name,contacts FROM milton_auth."oauthClient" WHERE "clientId"=$1`,
            [solo.clientId],
          )
        ).rows,
        [{ name: null, contacts: null }],
        "a deleted registration stored again gets no name or contacts",
      );
      await owner.query(
        `DELETE FROM milton_auth."oauthClient" WHERE "clientId"=$1`,
        [solo.clientId],
      );
      assert.deepEqual(
        await soloDependents(),
        { resources: 0, consents: 0, refresh: 0, bindings: 0 },
        "nothing of the solo registration remains",
      );
      // The other account is untouched.
      assert.deepEqual(
        await owned(birch),
        birchRows,
        "the other account keeps every row",
      );
      const seen = await surfaces(birch);
      isolated(birch, seen, "after deletion");
      assert.equal(
        served(seen),
        served(settled.get(birch)!),
        "the other account serves exactly what it did",
      );
      // Birch's connection through the cleared registration keeps working, and
      // Birch can authorize it again.
      assert.equal(
        await toolsWith(birchGrant.access_token),
        3,
        "Birch's assistant still reaches MCP",
      );
      const refreshed = await oidc.refreshTokenGrant(
        shared.oauth,
        birchGrant.refresh_token,
        { resource: config.resource },
      );
      assert.equal(
        await toolsWith(refreshed.access_token),
        3,
        "Birch's refreshed token reaches MCP",
      );
      assert.equal(
        await toolsWith((await connect(birch, shared)).access_token),
        3,
        "Birch reconnects the cleared registration",
      );
      assert.deepEqual(outbound, [], "no request left the machine");
      assert(
        admittedOverLoopback > 0,
        "sign-ins admitted through milton-admit",
      );
    }
    pass(
      "account deletion through the app leaves no row referencing the account or its native user (catalog-derived, every one populated first, one listed exclusion), no sign-in grant binding, only pinned id-only leftovers (table, column, rows) and none of its email or text; its key, assistant grant, unredeemed code, app session, native session and password stop working; the assistant registration only it authorized is deleted and a shared one keeps working for the other account without its name or contacts; the other account is untouched",
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
  restoreOutbound();
  for (const server of servers)
    if ("closeAllConnections" in server) {
      server.closeAllConnections();
      server.close();
    }
  await Promise.allSettled([
    ...pools.map((pool) => pool.end()),
    closeDatabasePools(),
  ]);
  cluster.stop();
}
