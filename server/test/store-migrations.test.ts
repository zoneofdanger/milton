import { expect, test } from "bun:test";
import { localStore } from "./local-store";
import { seedUsers } from "./store-fixtures";
import { migrationUrl } from "../scripts/migrate";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { generateDrizzleJson, generateMigration } from "drizzle-kit/api";
import * as schema from "../src/store/schema";
import {
  pruneUsage,
  USAGE_PRUNE_BATCH,
  USAGE_PRUNE_BATCHES,
  USAGE_PRUNE_LOCK_TIMEOUT,
  USAGE_PRUNE_STATEMENT_TIMEOUT,
} from "../../apps/auth/scripts/prune-usage";
import { AUTH_MIGRATIONS } from "../../apps/auth/scripts/migrations";
import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// An approved sample in the pre-memo tables, as plain SQL.
async function seedSample(
  pg: PGlite,
  userId: string,
  id: string,
  report: string,
  kindId: string,
  context: Record<string, unknown>,
  body: string,
) {
  await pg.query(
    "INSERT INTO samples(user_id,id,client_json) VALUES ($1,$2,'{}')",
    [userId, id],
  );
  await pg.query(
    `INSERT INTO sample_versions(user_id,sample_id,version,report,kind_id,context,body,actor_json,request_id)
    VALUES ($1,$2,1,$3,$4,$5::jsonb,$6,'{}',$7)`,
    [
      userId,
      id,
      report,
      kindId,
      JSON.stringify(context),
      body,
      crypto.randomUUID(),
    ],
  );
}

const publicTables = async (pg: PGlite) =>
  (
    await pg.query<{ tablename: string }>(
      "SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename",
    )
  ).rows.map((row) => row.tablename);

// The public schema's shape, for migration tests. Columns sort by name: a drop
// and re-add moves a column, not its definition.
const schemaCatalog = async (pg: PGlite) => {
  const rows = async (statement: string) =>
    (await pg.query<Record<string, unknown>>(statement)).rows;
  return {
    tables: await publicTables(pg),
    columns: await rows(
      `SELECT table_name,column_name,data_type,udt_name,is_nullable,column_default,generation_expression FROM information_schema.columns WHERE table_schema='public' ORDER BY table_name,column_name`,
    ),
    constraints: await rows(
      "SELECT conrelid::regclass::text AS tbl,conname,pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE connamespace='public'::regnamespace ORDER BY tbl,conname",
    ),
    indexes: await rows(
      "SELECT indexname,indexdef FROM pg_indexes WHERE schemaname='public' ORDER BY indexname",
    ),
    triggers: await rows(
      "SELECT tgname,pg_get_triggerdef(oid) AS definition FROM pg_trigger WHERE NOT tgisinternal ORDER BY tgname",
    ),
    functions: await rows(
      "SELECT proname,pg_get_functiondef(oid) AS definition FROM pg_proc WHERE pronamespace='public'::regnamespace AND (proname LIKE 'milton_%' OR proname LIKE 'guard_%') ORDER BY proname",
    ),
    extensions: await rows(
      "SELECT extname FROM pg_extension WHERE extname<>'plpgsql' ORDER BY extname",
    ),
  };
};

test("a release passes the owner URL in its own variable, checked, and an empty one is refused", async () => {
  const url = "postgresql://owner:fixture@db.example.invalid/milton";
  expect(await migrationUrl({ MILTON_OWNER_DATABASE_URL: url })).toBe(url);
  for (const bad of [
    "",
    "postgresql://owner:fixture@db.example.invalid/other",
    "postgresql://owner:fixture@db.example.invalid/milton?ssl=false",
    "postgresql://owner:fixture@db.example.invalid/milton?sslmode=require&sslmode=disable",
    "postgresql://owner:fixture@db.example.invalid/milton?sslmode=require&uselibpqcompat=true",
  ]) {
    const refused = migrationUrl({ MILTON_OWNER_DATABASE_URL: bad });
    await expect(refused).rejects.toMatchObject({ code: "configuration" });
    expect(String(await refused.catch((error) => error.message))).not.toContain(
      "fixture",
    );
  }
});

test("the fresh baseline installs once and refuses populated pre-baseline databases atomically", async () => {
  const folder = new URL("../drizzle/", import.meta.url).pathname;
  const pg = new PGlite();
  try {
    const journal = (await Bun.file(folder + "meta/_journal.json").json()) as {
      entries: { idx: number; tag: string; when: number }[];
    };
    const baseline = journal.entries[0]!;
    expect(baseline).toMatchObject({
      idx: 0,
      tag: "0000_baseline",
      when: 1793815543500,
    });
    expect(
      journal.entries.filter((entry) => entry.tag.endsWith("_baseline")),
    ).toHaveLength(1);
    await migrate(drizzle(pg), { migrationsFolder: folder });
    expect(
      (await pg.query("SELECT * FROM drizzle.__drizzle_migrations")).rows,
    ).toHaveLength(journal.entries.length);
    await pg.exec(
      "DELETE FROM drizzle.__drizzle_migrations; INSERT INTO drizzle.__drizzle_migrations(hash,created_at) VALUES ('pre-baseline',1793779058436); INSERT INTO users(id) VALUES ('kept')",
    );
    const before = await schemaCatalog(pg);
    await expect(
      migrate(drizzle(pg), { migrationsFolder: folder }),
    ).rejects.toMatchObject({
      cause: { message: "baseline_requires_empty_database" },
    });
    expect(await schemaCatalog(pg)).toEqual(before);
    expect((await pg.query("SELECT id FROM users")).rows).toEqual([
      { id: "kept" },
    ]);
    expect(
      (
        await pg.query(
          "SELECT hash,created_at FROM drizzle.__drizzle_migrations",
        )
      ).rows,
    ).toEqual([{ hash: "pre-baseline", created_at: 1793779058436 }]);
    await pg.exec("DELETE FROM drizzle.__drizzle_migrations");
    await expect(
      migrate(drizzle(pg), { migrationsFolder: folder }),
    ).rejects.toMatchObject({
      cause: { message: "baseline_requires_empty_database" },
    });
    expect(await schemaCatalog(pg)).toEqual(before);
  } finally {
    await pg.close();
  }
});

test("schema declarations generate the same surviving tables, constraints and indexes as the baseline", async () => {
  const local = await localStore();
  const generated = new PGlite();
  try {
    const statements = await generateMigration(
      generateDrizzleJson({}),
      generateDrizzleJson(schema),
    );
    await generated.exec("CREATE SEQUENCE instruction_card_position AS bigint");
    const contextMigration = await Bun.file(
      new URL("../drizzle/0001_sample_context.sql", import.meta.url),
    ).text();
    await generated.exec(
      contextMigration.split("--> statement-breakpoint")[0]!,
    );
    await generated.exec(statements.join("\n"));
    const actual = await schemaCatalog(local.pg),
      expected = await schemaCatalog(generated);
    for (const key of ["tables", "columns", "constraints", "indexes"] as const)
      expect(actual[key]).toEqual(expected[key]);
  } finally {
    await generated.close();
    await local.dispose();
  }
});

test("the runtime has only current grants, its guards hold, and later tables inherit limited privileges", async () => {
  const local = await localStore();
  const pg = local.pg;
  try {
    const roles = async (db: PGlite) =>
      (
        await db.query(
          "SELECT rolname,rolcanlogin,rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls FROM pg_roles WHERE rolname LIKE 'milton_%' ORDER BY rolname",
        )
      ).rows;
    // What the role may do: object privileges in public and drizzle, the
    // schema and database grants, and default privileges for later objects.
    const grants = async (db: PGlite) => ({
      objects: (
        await db.query(
          `SELECT c.relname,c.relkind::text,string_agg(a.privilege_type,',' ORDER BY a.privilege_type) AS privileges
           FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) a
           WHERE a.grantee='milton_runtime'::regrole AND c.relnamespace IN ('public'::regnamespace,'drizzle'::regnamespace)
           GROUP BY 1,2 ORDER BY 1`,
        )
      ).rows,
      columns: (
        await db.query(
          `SELECT c.relname,t.attname,string_agg(a.privilege_type,',' ORDER BY a.privilege_type) AS privileges
           FROM pg_attribute t JOIN pg_class c ON c.oid=t.attrelid CROSS JOIN LATERAL aclexplode(t.attacl) a
           WHERE a.grantee='milton_runtime'::regrole AND c.relnamespace IN ('public'::regnamespace,'drizzle'::regnamespace)
           GROUP BY 1,2 ORDER BY 1,2`,
        )
      ).rows,
      schemas: (
        await db.query(
          `SELECT nspname,has_schema_privilege('milton_runtime',oid,'USAGE') AS usage,has_schema_privilege('milton_runtime',oid,'CREATE') AS create
           FROM pg_namespace WHERE nspname IN ('public','drizzle') ORDER BY 1`,
        )
      ).rows,
      connect: (
        await db.query(
          "SELECT has_database_privilege('milton_runtime',current_database(),'CONNECT') AS connect",
        )
      ).rows,
      defaults: (
        await db.query(
          `SELECT d.defaclobjtype::text AS kind,string_agg(a.privilege_type,',' ORDER BY a.privilege_type) AS privileges
           FROM pg_default_acl d CROSS JOIN LATERAL aclexplode(d.defaclacl) a
           WHERE a.grantee='milton_runtime'::regrole AND d.defaclnamespace='public'::regnamespace
           GROUP BY 1 ORDER BY 1`,
        )
      ).rows,
    });
    // What the runtime and the triggers it fires run on each table. DELETE
    // only where the runtime deletes; store_config is read-only.
    const used: Record<string, string> = {
      accepted_changes: "INSERT",
      assistant_disconnects: "DELETE,INSERT,SELECT",
      connection_keys: "",
      cover_sheets: "",
      guide_accounts: "SELECT",
      guide_budget_lock: "",
      guide_spend: "",
      identities: "INSERT,SELECT",
      instruction_card_versions: "INSERT,SELECT",
      instruction_cards: "INSERT,SELECT",
      memo_kinds: "",
      memo_settings: "",
      memos: "",
      report_guides: "SELECT",
      sample_kinds: "INSERT,SELECT",
      sample_versions: "INSERT,SELECT",
      samples: "INSERT,SELECT",
      save_requests: "INSERT,SELECT,UPDATE",
      served_reports: "",
      store_config: "SELECT",
      stripe_events: "INSERT,SELECT,UPDATE",
      trial_accounts: "INSERT,SELECT,UPDATE",
      tweak_citations: "",
      tweaks: "",
      usage_calls: "",
      users: "DELETE,INSERT,SELECT,UPDATE",
    };
    expect(await roles(pg)).toEqual([
      {
        rolname: "milton_guide_worker",
        rolcanlogin: false,
        rolsuper: false,
        rolcreatedb: false,
        rolcreaterole: false,
        rolreplication: false,
        rolbypassrls: false,
      },
      {
        rolname: "milton_runtime",
        rolcanlogin: false,
        rolsuper: false,
        rolcreatedb: false,
        rolcreaterole: false,
        rolreplication: false,
        rolbypassrls: false,
      },
    ]);
    const granted = await grants(pg);
    // Every application table is listed; the sequence, USAGE only; nothing
    // in drizzle; no CREATE anywhere.
    expect(Object.keys(used)).toEqual(await publicTables(pg));
    expect(granted.objects).toEqual(
      [
        ...Object.entries(used)
          .filter(([, privileges]) => privileges)
          .map(([relname, privileges]) => ({
            relname,
            relkind: "r",
            privileges,
          })),
        {
          relname: "instruction_card_position",
          relkind: "S",
          privileges: "USAGE",
        },
      ].sort((a, b) => (a.relname < b.relname ? -1 : 1)),
    );
    expect(granted.columns).toEqual([]);
    expect(granted.schemas).toEqual([
      { nspname: "drizzle", usage: false, create: false },
      { nspname: "public", usage: true, create: false },
    ]);
    expect(granted.connect).toEqual([{ connect: true }]);
    expect(granted.defaults).toEqual([
      { kind: "S", privileges: "USAGE" },
      { kind: "r", privileges: "INSERT,SELECT,UPDATE" },
    ]);
    await seedUsers(pg, "runtime");
    // A login role in the group, as milton_app is in Neon. Membership
    // inherits: the session needs no SET ROLE milton_runtime. PGlite's session
    // user is a superuser, so SET ROLE stands in for logging in; what is checked
    // here is the current role's privileges, not the login itself.
    await pg.exec(
      "CREATE ROLE milton_app_fixture LOGIN IN ROLE milton_runtime; SET ROLE milton_app_fixture",
    );
    try {
      expect((await pg.query("SELECT current_user AS role")).rows).toEqual([
        { role: "milton_app_fixture" },
      ]);
      // The legacy group still writes the old writing tables through their
      // guards; it reaches no memo table (see 0012).
      await pg.exec(
        "INSERT INTO sample_kinds(user_id,id,report,label) VALUES ('runtime','kind','email','follow-up')",
      );
      await seedSample(
        pg,
        "runtime",
        "sample",
        "email",
        "kind",
        { version: 1, summary: "runtime context" },
        "Runtime sample body.",
      );
      await expect(
        pg.query(
          "UPDATE sample_versions SET context=context || '{\"medium\":\"chat\"}'::jsonb,version=version+1 WHERE user_id='runtime'",
        ),
      ).rejects.toThrow("permission denied");
      // Owner-only statements are refused.
      for (const statement of [
        "ALTER TABLE samples DISABLE TRIGGER samples_guard",
        "ALTER TABLE samples DISABLE TRIGGER ALL",
        "ALTER TABLE users DROP COLUMN status",
        "DROP TABLE samples",
        "DROP FUNCTION milton_sample_guard()",
        "TRUNCATE samples",
        "CREATE TABLE public.runtime_made (id int)",
        "SELECT * FROM drizzle.__drizzle_migrations",
        "SET session_replication_role = replica",
        "GRANT milton_runtime TO milton_app_fixture",
        // Deletes and updates no trigger guards, outside the runtime's grants.
        "DELETE FROM save_requests",
        "DELETE FROM usage_calls",
        "DELETE FROM trial_accounts",
        "DELETE FROM identities",
        "UPDATE identities SET user_id=user_id",
        "UPDATE store_config SET trials_enabled=true",
        "SELECT * FROM accepted_changes",
      ])
        await expect(pg.query(statement)).rejects.toThrow(
          /must be owner|permission denied/,
        );
      // Runtime grants refuse mutation; the owner is still bound by immutability.
      const edit =
        "UPDATE sample_versions SET body='Edited' WHERE user_id='runtime'";
      await expect(pg.query(edit)).rejects.toThrow("permission denied");
      await pg.exec("RESET ROLE");
      await expect(pg.query(edit)).rejects.toThrow(
        "sample_version_is_immutable",
      );
      expect(
        (
          await pg.query(
            "SELECT body FROM sample_versions WHERE user_id='runtime'",
          )
        ).rows,
      ).toEqual([{ body: "Runtime sample body." }]);
      // A table a later migration creates gets SELECT, INSERT and UPDATE by
      // default; DELETE only if that migration grants it.
      await pg.exec(
        "CREATE TABLE later_table (id int); SET ROLE milton_app_fixture; INSERT INTO later_table VALUES (1); UPDATE later_table SET id=2",
      );
      await expect(pg.query("DELETE FROM later_table")).rejects.toThrow(
        "permission denied",
      );
      await pg.exec("RESET ROLE; DROP TABLE later_table");
    } finally {
      await pg.exec("RESET ROLE");
    }
  } finally {
    await local.dispose();
  }
});

test("guide migration preserves populated approved sources, defaults off and isolates worker capabilities", async () => {
  const folder = new URL("../drizzle/", import.meta.url).pathname;
  const scratch = await mkdtemp(join(tmpdir(), "milton-guides-"));
  const pg = new PGlite();
  try {
    await cp(folder, scratch, { recursive: true });
    const journal = await Bun.file(join(scratch, "meta/_journal.json")).json();
    journal.entries = journal.entries.filter((e: { idx: number }) => e.idx < 3);
    await writeFile(
      join(scratch, "meta/_journal.json"),
      JSON.stringify(journal),
    );
    await migrate(drizzle(pg), { migrationsFolder: scratch });
    await seedUsers(pg, "upgrade");
    await pg.exec(
      "INSERT INTO sample_kinds(user_id,id,report,label) VALUES ('upgrade','kind','email','Fictional note')",
    );
    await seedSample(
      pg,
      "upgrade",
      "example",
      "email",
      "kind",
      { version: 1, summary: "Fictional note" },
      "Collect the seedlings on Saturday.",
    );
    const before = (await pg.query("SELECT * FROM sample_versions")).rows;
    await migrate(drizzle(pg), { migrationsFolder: folder });
    await migrate(drizzle(pg), { migrationsFolder: folder });
    expect((await pg.query("SELECT * FROM sample_versions")).rows).toEqual(
      before,
    );
    expect((await pg.query("SELECT * FROM guide_accounts")).rows).toHaveLength(
      0,
    );
    expect(
      (await pg.query("SELECT source_version,status FROM report_guides")).rows,
    ).toEqual([{ source_version: 1, status: "queued" }]);
    const allowed = (
      await pg.query<{ table_name: string; privilege_type: string }>(
        "SELECT table_name,privilege_type FROM information_schema.role_table_grants WHERE grantee='milton_guide_worker' ORDER BY 1,2",
      )
    ).rows;
    expect(
      allowed.filter((r) =>
        [
          "identities",
          "instruction_cards",
          "instruction_card_versions",
          "assistant_disconnects",
        ].includes(r.table_name),
      ),
    ).toEqual([]);
    expect(
      allowed
        .filter((r) => r.privilege_type !== "SELECT")
        .map((r) => `${r.table_name}:${r.privilege_type}`),
    ).toEqual([
      "guide_budget_lock:UPDATE",
      "guide_spend:INSERT",
      "guide_spend:UPDATE",
      "report_guides:UPDATE",
    ]);
    await pg.exec("SET ROLE milton_runtime");
    await expect(
      pg.query(
        "INSERT INTO guide_accounts(user_id,enabled,epoch,opted_in_at,opt_in_reference) VALUES ('upgrade',true,1,now(),'fictional-consent')",
      ),
    ).rejects.toThrow("permission denied");
    await expect(
      pg.query(
        "UPDATE guide_accounts SET enabled=true,epoch=epoch+1,opted_in_at=now(),opt_in_reference='fictional-consent'",
      ),
    ).rejects.toThrow("permission denied");
    await pg.exec("RESET ROLE");
    await pg.exec("SET ROLE milton_guide_worker");
    await expect(
      pg.query("UPDATE sample_versions SET body='changed'"),
    ).rejects.toThrow("permission denied");
    await expect(pg.query("SELECT * FROM identities")).rejects.toThrow(
      "permission denied",
    );
    await expect(
      pg.query("UPDATE guide_accounts SET enabled=true"),
    ).rejects.toThrow("permission denied");
    await pg.exec("RESET ROLE");
  } finally {
    await pg.close();
    await rm(scratch, { recursive: true, force: true });
  }
});

test("0005 drops the unread deleted_identities table", async () => {
  const folder = new URL("../drizzle/", import.meta.url).pathname;
  const scratch = await mkdtemp(join(tmpdir(), "milton-0005-"));
  const pg = new PGlite();
  // A fresh install through 0005, so later migrations leave this test alone.
  const current = new PGlite();
  try {
    await cp(folder, scratch, { recursive: true });
    const journal = await Bun.file(join(scratch, "meta/_journal.json")).json();
    const through = async (idx: number) =>
      writeFile(
        join(scratch, "meta/_journal.json"),
        JSON.stringify({
          ...journal,
          entries: journal.entries.filter((e: { idx: number }) => e.idx <= idx),
        }),
      );
    await through(4);
    await migrate(drizzle(pg), { migrationsFolder: scratch });
    await seedUsers(pg, "kept");
    await pg.exec(
      `INSERT INTO deleted_identities(identity_hash) VALUES ('${"a".repeat(64)}')`,
    );
    await through(5);
    await migrate(drizzle(pg), { migrationsFolder: scratch });
    await migrate(drizzle(current), { migrationsFolder: scratch });
    const after = await schemaCatalog(current);
    expect(await schemaCatalog(pg)).toEqual(after);
    expect(after.tables).not.toContain("deleted_identities");
    expect((await pg.query("SELECT id FROM users")).rows).toEqual([
      { id: "kept" },
    ]);
  } finally {
    await current.close();
    await pg.close();
    await rm(scratch, { recursive: true, force: true });
  }
});

test("0006 drops payload_bytes and source_hash's NOT NULL", async () => {
  const folder = new URL("../drizzle/", import.meta.url).pathname;
  const scratch = await mkdtemp(join(tmpdir(), "milton-0006-"));
  const pg = new PGlite();
  // A fresh install through 0006, so later migrations leave this test alone.
  const current = new PGlite();
  try {
    await cp(folder, scratch, { recursive: true });
    const journal = await Bun.file(join(scratch, "meta/_journal.json")).json();
    const through = async (idx: number) =>
      writeFile(
        join(scratch, "meta/_journal.json"),
        JSON.stringify({
          ...journal,
          entries: journal.entries.filter((e: { idx: number }) => e.idx <= idx),
        }),
      );
    await through(5);
    await migrate(drizzle(pg), { migrationsFolder: scratch });
    // A receipt as every recorded revision writes it.
    await seedUsers(pg, "kept");
    await pg.query(
      "INSERT INTO save_requests(user_id,request_id,input_hash,source_hash,result_json) VALUES ('kept',$1,repeat('a',64),repeat('b',64),'{\"status\":\"saved\"}')",
      [crypto.randomUUID()],
    );
    await through(6);
    await migrate(drizzle(pg), { migrationsFolder: scratch });
    await migrate(drizzle(current), { migrationsFolder: scratch });
    const after = await schemaCatalog(current);
    expect(await schemaCatalog(pg)).toEqual(after);
    expect(
      after.columns.filter((c) => c.column_name === "payload_bytes"),
    ).toEqual([]);
    expect(
      after.columns.find(
        (c) =>
          c.table_name === "save_requests" && c.column_name === "source_hash",
      ),
    ).toMatchObject({ is_nullable: "YES" });
    // A receipt without source_hash, as code from this release writes it.
    await pg.query(
      "INSERT INTO save_requests(user_id,request_id,input_hash,result_json) VALUES ('kept',$1,repeat('a',64),'{\"status\":\"saved\"}')",
      [crypto.randomUUID()],
    );
    expect(
      (await pg.query("SELECT count(*)::int AS n FROM save_requests")).rows,
    ).toEqual([{ n: 2 }]);
  } finally {
    await current.close();
    await pg.close();
    await rm(scratch, { recursive: true, force: true });
  }
});

test("0007 adds an empty usage_calls table the legacy group cannot reach and moves the writer guards to FOR NO KEY UPDATE", async () => {
  const folder = new URL("../drizzle/", import.meta.url).pathname;
  const scratch = await mkdtemp(join(tmpdir(), "milton-0007-"));
  const pg = new PGlite();
  // A fresh install through 0007, so later migrations leave this test alone.
  const current = new PGlite();
  try {
    await cp(folder, scratch, { recursive: true });
    const journal = await Bun.file(join(scratch, "meta/_journal.json")).json();
    const through = async (idx: number) =>
      writeFile(
        join(scratch, "meta/_journal.json"),
        JSON.stringify({
          ...journal,
          entries: journal.entries.filter((e: { idx: number }) => e.idx <= idx),
        }),
      );
    await through(6);
    await migrate(drizzle(pg), { migrationsFolder: scratch });
    const before = await schemaCatalog(pg);
    const fns = async () =>
      (
        await pg.query(
          "SELECT proname,proowner::regrole::text AS owner,proacl::text AS acl,prosecdef,proconfig::text AS config FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname LIKE 'milton_%' ORDER BY proname",
        )
      ).rows;
    const fnsBefore = await fns();
    await seedUsers(pg, "kept");
    await pg.exec(
      "INSERT INTO usage_daily(user_id,day_utc,tool_calls) VALUES ('kept','2026-11-07',3)",
    );
    await through(7);
    await migrate(drizzle(pg), { migrationsFolder: scratch });
    await migrate(drizzle(current), { migrationsFolder: scratch });
    const after = await schemaCatalog(current);
    expect(await schemaCatalog(pg)).toEqual(after);
    expect(
      (
        await pg.query(
          "SELECT count(*)::int AS n,has_table_privilege('milton_runtime','public.usage_calls','SELECT,INSERT,UPDATE,DELETE') AS reachable FROM usage_calls",
        )
      ).rows,
    ).toEqual([{ n: 0, reachable: false }]);
    // Each guard changed only its account lock; owner, privileges, security
    // and settings are as they were.
    const guards = before.functions as {
      proname: string;
      definition: string;
    }[];
    const lock = "status='active' FOR UPDATE;";
    const moved = guards.filter((g) => g.definition.includes(lock));
    expect(moved.map((g) => g.proname)).toEqual([
      "milton_accepted_change_guard",
      "milton_card_guard",
      "milton_card_version_guard",
      "milton_sample_guard",
      "milton_sample_kind_guard",
      "milton_sample_version_guard",
    ]);
    expect((after.functions as typeof guards).map((g) => g.definition)).toEqual(
      guards.map((g) =>
        g.definition.replace(lock, "status='active' FOR NO KEY UPDATE;"),
      ),
    );
    expect(
      (after.functions as typeof guards).some((g) =>
        / FOR (UPDATE|SHARE)\b/.test(g.definition),
      ),
    ).toBe(false);
    expect(await fns()).toEqual(fnsBefore);
    expect(
      (await pg.query("SELECT user_id,tool_calls FROM usage_daily")).rows,
    ).toEqual([{ user_id: "kept", tool_calls: 3 }]);
  } finally {
    await current.close();
    await pg.close();
    await rm(scratch, { recursive: true, force: true });
  }
});

test("0008 drops usage_daily and the stored daily_calls; the maintenance job deletes usage rows past 90 days in bounded batches", async () => {
  const folder = new URL("../drizzle/", import.meta.url).pathname;
  const scratch = await mkdtemp(join(tmpdir(), "milton-0008-"));
  const pg = new PGlite();
  // A fresh install through 0008, so later migrations leave this test alone.
  const current = new PGlite();
  try {
    await cp(folder, scratch, { recursive: true });
    const journal = await Bun.file(join(scratch, "meta/_journal.json")).json();
    const through = async (idx: number) =>
      writeFile(
        join(scratch, "meta/_journal.json"),
        JSON.stringify({
          ...journal,
          entries: journal.entries.filter((e: { idx: number }) => e.idx <= idx),
        }),
      );
    await through(7);
    await migrate(drizzle(pg), { migrationsFolder: scratch });
    // Production's shape before 0008: a usage_daily row, the stored
    // daily_calls key and usage rows on both sides of 90 days.
    await seedUsers(pg, "kept", "other");
    await pg.exec(
      "INSERT INTO usage_daily(user_id,day_utc,tool_calls) VALUES ('kept','2026-11-07',3)",
    );
    const limits = async () =>
      (await pg.query<{ l: unknown }>("SELECT limits_json l FROM store_config"))
        .rows;
    expect(await limits()).toEqual([
      {
        l: {
          body_bytes: 131072,
          description_bytes: 500,
          reason_bytes: 500,
          report_body_bytes: 262144,
          daily_calls: 10000,
        },
      },
    ]);
    const old = 20005;
    await pg.query(
      `INSERT INTO usage_calls(user_id,at,tool)
       SELECT CASE WHEN n%2=0 THEN 'kept' ELSE 'other' END,now()-interval '91 days'-n*interval '1 second','get_report'
       FROM generate_series(1,$1) n`,
      [old],
    );
    await pg.exec(
      "INSERT INTO usage_calls(user_id,at,tool) VALUES ('kept',now()-interval '89 days','get_cover_sheet'),('other',now(),'create_memo')",
    );
    await through(8);
    await migrate(drizzle(pg), { migrationsFolder: scratch });
    await migrate(drizzle(current), { migrationsFolder: scratch });
    const after = await schemaCatalog(current);
    expect(await schemaCatalog(pg)).toEqual(after);
    expect(after.tables).not.toContain("usage_daily");
    expect(await limits()).toEqual([
      {
        l: {
          body_bytes: 131072,
          description_bytes: 500,
          reason_bytes: 500,
          report_body_bytes: 262144,
        },
      },
    ]);
    expect(
      (await current.query("SELECT limits_json l FROM store_config")).rows,
    ).toEqual(await limits());
    expect(
      (await pg.query("SELECT count(*)::int n FROM usage_calls")).rows,
    ).toEqual([{ n: old + 2 }]);
    // The owner grant file, twice: rerunning converges. Only the
    // maintenance job's role may run the prune, and nothing else on the table.
    await pg.exec(
      "CREATE ROLE milton_auth_owner NOLOGIN NOINHERIT; CREATE ROLE milton_app_runtime NOLOGIN NOINHERIT; CREATE ROLE milton_mcp_runtime NOLOGIN NOINHERIT",
    );
    const grantFile = await Bun.file(
      new URL("../migrations/010-usage-retention-roles.sql", import.meta.url),
    ).text();
    await pg.exec(grantFile);
    await pg.exec(grantFile);
    const prune = "public.prune_usage_calls(integer)";
    expect(
      (
        await pg.query(
          `SELECT r.rolname,has_function_privilege(r.rolname,'${prune}','EXECUTE') AS run FROM pg_roles r WHERE r.rolname IN ('milton_auth_owner','milton_app_runtime','milton_mcp_runtime','milton_runtime','milton_guide_worker') ORDER BY 1`,
        )
      ).rows,
    ).toEqual([
      { rolname: "milton_app_runtime", run: false },
      { rolname: "milton_auth_owner", run: true },
      { rolname: "milton_guide_worker", run: false },
      { rolname: "milton_mcp_runtime", run: false },
      { rolname: "milton_runtime", run: false },
    ]);
    expect(
      (
        await pg.query(
          `SELECT prosecdef,proconfig::text config FROM pg_proc WHERE oid='${prune}'::regprocedure`,
        )
      ).rows,
    ).toEqual([
      { prosecdef: true, config: '{"search_path=pg_catalog, pg_temp"}' },
    ]);
    await pg.exec("SET ROLE milton_mcp_runtime");
    await expect(
      pg.query("SELECT public.prune_usage_calls(1)"),
    ).rejects.toThrow("permission denied");
    await pg.exec("RESET ROLE; SET ROLE milton_auth_owner");
    for (const statement of [
      "SELECT * FROM usage_calls",
      "DELETE FROM usage_calls",
    ])
      await expect(pg.query(statement)).rejects.toThrow("permission denied");
    for (const batch of [0, -1, 10001])
      await expect(
        pg.query("SELECT public.prune_usage_calls($1)", [batch]),
      ).rejects.toThrow("usage_prune_batch_invalid");
    // The maintenance job's prune, as its role: one run stops at its bound,
    // the next finishes; rows from the last 90 days stay.
    // Each batch's server-side limits, read inside its transaction right
    // before its delete.
    const seen: Record<string, unknown>[] = [];
    const run = () =>
      pruneUsage(async (text, values) => {
        const result = await pg.query<Record<string, unknown>>(text, values);
        if (text.startsWith("select public.prune_usage_calls"))
          seen.push(
            (
              await pg.query<Record<string, unknown>>(
                "SELECT current_setting('statement_timeout') s,current_setting('lock_timeout') l",
              )
            ).rows[0]!,
          );
        return result;
      });
    // A connection that drops the settings (as Neon drops connect-time ones)
    // refuses before deleting anything.
    await expect(
      pruneUsage((text, values) =>
        pg.query<Record<string, unknown>>(
          text.startsWith("set local") ? "SELECT 1" : text,
          text.startsWith("set local") ? [] : values,
        ),
      ),
    ).rejects.toThrow("usage_prune_timeouts_unset");
    expect(await run()).toBe(USAGE_PRUNE_BATCH * USAGE_PRUNE_BATCHES);
    expect(seen).toEqual(
      Array.from({ length: USAGE_PRUNE_BATCHES }, () => ({
        s: USAGE_PRUNE_STATEMENT_TIMEOUT,
        l: USAGE_PRUNE_LOCK_TIMEOUT,
      })),
    );
    // Session settings are untouched between batches.
    expect(
      (await pg.query("SELECT current_setting('lock_timeout') l")).rows,
    ).toEqual([{ l: "0" }]);
    expect(await run()).toBe(old - USAGE_PRUNE_BATCH * USAGE_PRUNE_BATCHES);
    expect(await run()).toBe(0);
    await pg.exec("RESET ROLE");
    expect(
      (await pg.query("SELECT user_id,tool FROM usage_calls ORDER BY at")).rows,
    ).toEqual([
      { user_id: "kept", tool: "get_cover_sheet" },
      { user_id: "other", tool: "create_memo" },
    ]);
  } finally {
    await pg.exec("RESET ROLE").catch(() => {});
    await current.close();
    await pg.close();
    await rm(scratch, { recursive: true, force: true });
  }
}, 60000);

test("0010 parks the guide pilot: drops only its trigger and keeps every guide row", async () => {
  const folder = new URL("../drizzle/", import.meta.url).pathname;
  const scratch = await mkdtemp(join(tmpdir(), "milton-0010-"));
  const pg = new PGlite();
  try {
    await cp(folder, scratch, { recursive: true });
    const journal = await Bun.file(join(scratch, "meta/_journal.json")).json();
    const through = async (idx: number) =>
      writeFile(
        join(scratch, "meta/_journal.json"),
        JSON.stringify({
          ...journal,
          entries: journal.entries.filter((e: { idx: number }) => e.idx <= idx),
        }),
      );
    await through(9);
    await migrate(drizzle(pg), { migrationsFolder: scratch });
    // Production's shape before 0010: guide rows the trigger wrote, a completed
    // guide, and an enrollment row that is off.
    await seedUsers(pg, "parked", "idle");
    for (const [user, report, id] of [
      ["parked", "email", "e1"],
      ["parked", "chat", "c1"],
      ["idle", "email", "i1"],
    ] as const) {
      await pg.query(
        "INSERT INTO sample_kinds(user_id,id,report,label) VALUES ($1,$2,$2,'Fictional kind')",
        [user, report],
      );
      await seedSample(
        pg,
        user,
        id,
        report,
        report,
        { version: 1, summary: "Fictional note" },
        `Fictional sample ${id}.`,
      );
    }
    await pg.exec(
      // Completed guides on email and chat, and every row with spent retries
      // scheduled a day ahead.
      "UPDATE report_guides SET guide_text='Fictional guide.',completed_version=1,status='ready',reason='completed' WHERE user_id='parked' AND report IN ('email','chat'); UPDATE report_guides SET attempts=2,next_attempt_at=clock_timestamp()+interval '1 day'; INSERT INTO guide_accounts(user_id) VALUES ('idle')",
    );
    const kept = async () => ({
      guides: (
        await pg.query("SELECT * FROM report_guides ORDER BY user_id,report")
      ).rows,
      accounts: (await pg.query("SELECT * FROM guide_accounts")).rows,
      function: (
        await pg.query(
          "SELECT proowner::regrole::text AS owner,proacl::text AS acl,prosecdef,proconfig::text AS config FROM pg_proc WHERE proname='milton_guide_source_changed'",
        )
      ).rows,
      grants: (
        await pg.query(
          "SELECT grantee,table_name,privilege_type FROM information_schema.role_table_grants WHERE table_name IN ('guide_accounts','report_guides','guide_spend','guide_budget_lock') ORDER BY 1,2,3",
        )
      ).rows,
    });
    const before = await schemaCatalog(pg);
    const prior = await kept();
    expect(before.triggers).toContainEqual(
      expect.objectContaining({ tgname: "report_guide_source" }),
    );
    await through(10);
    await migrate(drizzle(pg), { migrationsFolder: scratch });
    expect(await schemaCatalog(pg)).toEqual({
      ...before,
      triggers: before.triggers.filter(
        (t) => t.tgname !== "report_guide_source",
      ),
    });
    expect(await kept()).toEqual(prior);
  } finally {
    await pg.close();
    await rm(scratch, { recursive: true, force: true });
  }
}, 30000);

test("no request path deletes usage rows: only the maintenance job's prune does", async () => {
  // Request-serving code (server/src, apps/auth/src) never deletes from
  // usage_calls and never calls the prune; account erasure removes rows only
  // through the foreign key's cascade.
  const roots = ["../src/", "../../apps/auth/src/"].map(
    (path) => new URL(path, import.meta.url).pathname,
  );
  const deletes =
    /\bDELETE\s+FROM\s+(?:ONLY\s+)?(?:"?public"?\.)?"?usage_calls\b|prune_usage_calls|prune-usage/i;
  const offenders: string[] = [];
  let scanned = 0;
  for (const root of roots)
    for await (const file of new Bun.Glob("**/*.{ts,tsx}").scan(root)) {
      scanned++;
      if (deletes.test(await Bun.file(root + file).text()))
        offenders.push(root + file);
    }
  expect(scanned).toBeGreaterThan(20);
  expect(offenders).toEqual([]);
  // The one caller is the maintenance entry point.
  expect(
    await Bun.file(
      new URL("../../apps/auth/scripts/maintain.ts", import.meta.url),
    ).text(),
  ).toContain("pruneUsage(");
});

test("0011 adds stripe_revision; existing trial rows keep their state and start at 0", async () => {
  const folder = new URL("../drizzle/", import.meta.url).pathname;
  const scratch = await mkdtemp(join(tmpdir(), "milton-0011-"));
  const pg = new PGlite();
  try {
    await cp(folder, scratch, { recursive: true });
    const journal = await Bun.file(join(scratch, "meta/_journal.json")).json();
    const through = async (tag: string) =>
      writeFile(
        join(scratch, "meta/_journal.json"),
        JSON.stringify({
          ...journal,
          entries: journal.entries.slice(
            0,
            journal.entries.findIndex((e: { tag: string }) => e.tag === tag) +
              1,
          ),
        }),
      );
    await through("0009_test_account");
    await migrate(drizzle(pg), { migrationsFolder: scratch });
    // Production's shape before 0010: one row waiting on its trial, one paid.
    await seedUsers(pg, "waiting", "paid");
    await pg.exec(
      "INSERT INTO trial_accounts(user_id,started_at) VALUES ('waiting',now()); INSERT INTO trial_accounts(user_id,started_at,stripe_customer_id,stripe_subscription_id,subscription_status) VALUES ('paid',now()-interval '40 days','cus_kept','sub_kept','active')",
    );
    const rows = async () =>
      (
        await pg.query(
          "SELECT user_id,stripe_customer_id,stripe_subscription_id,subscription_status FROM trial_accounts ORDER BY user_id",
        )
      ).rows;
    const before = await rows();
    await through("0011_stripe_revision");
    await migrate(drizzle(pg), { migrationsFolder: scratch });
    expect(await rows()).toEqual(before);
    expect(
      (
        await pg.query(
          "SELECT data_type,is_nullable,column_default FROM information_schema.columns WHERE table_name='trial_accounts' AND column_name='stripe_revision'",
        )
      ).rows,
    ).toEqual([
      { data_type: "bigint", is_nullable: "NO", column_default: "0" },
    ]);
    expect(
      (
        await pg.query(
          "SELECT count(*)::int AS n FROM trial_accounts WHERE stripe_revision=0",
        )
      ).rows,
    ).toEqual([{ n: 2 }]);
  } finally {
    await pg.close();
    await rm(scratch, { recursive: true, force: true });
  }
});

test("0012 adds empty memo tables the legacy group cannot reach; 014 grants the app and MCP runtimes exactly their privileges", async () => {
  const local = await localStore();
  const pg = local.pg;
  const tables = [
    "cover_sheets",
    "memo_kinds",
    "memo_settings",
    "memos",
    "served_reports",
    "tweak_citations",
    "tweaks",
  ];
  // Each role's table and column privileges on the memo tables.
  const privileges = async (role: string) => ({
    tables: (
      await pg.query(
        `SELECT c.relname,string_agg(a.privilege_type,',' ORDER BY a.privilege_type) AS privileges
         FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) a
         WHERE a.grantee=$1::regrole AND c.relname=ANY($2) AND c.relnamespace='public'::regnamespace
         GROUP BY 1 ORDER BY 1`,
        [role, tables],
      )
    ).rows,
    columns: (
      await pg.query(
        `SELECT c.relname,t.attname,string_agg(a.privilege_type,',' ORDER BY a.privilege_type) AS privileges
         FROM pg_attribute t JOIN pg_class c ON c.oid=t.attrelid CROSS JOIN LATERAL aclexplode(t.attacl) a
         WHERE a.grantee=$1::regrole AND c.relname=ANY($2) AND c.relnamespace='public'::regnamespace
         GROUP BY 1,2 ORDER BY 1,2`,
        [role, tables],
      )
    ).rows,
  });
  try {
    for (const table of tables)
      expect([
        table,
        (await pg.query(`SELECT count(*)::int AS n FROM "${table}"`)).rows,
      ]).toEqual([table, [{ n: 0 }]]);
    expect(await privileges("milton_runtime")).toEqual({
      tables: [],
      columns: [],
    });
    await pg.exec(
      "CREATE ROLE milton_app_runtime NOLOGIN NOINHERIT; CREATE ROLE milton_mcp_runtime NOLOGIN NOINHERIT",
    );
    const grantFile = await Bun.file(
      new URL("../migrations/014-memos-roles.sql", import.meta.url),
    ).text();
    await pg.exec(grantFile);
    // Rerunning converges, dropping a stray grant.
    await pg.exec("GRANT UPDATE ON memos TO milton_mcp_runtime");
    await pg.exec(grantFile);
    const table = (relname: string, privileges: string) => ({
      relname,
      privileges,
    });
    const column = (relname: string, attname: string) => ({
      relname,
      attname,
      privileges: "UPDATE",
    });
    expect(await privileges("milton_mcp_runtime")).toEqual({
      tables: [
        table("cover_sheets", "INSERT,SELECT"),
        table("memo_kinds", "INSERT,SELECT"),
        table("memo_settings", "SELECT"),
        table("memos", "DELETE,INSERT,SELECT"),
        table("served_reports", "INSERT,SELECT"),
        table("tweak_citations", "DELETE,INSERT,SELECT"),
        table("tweaks", "DELETE,INSERT,SELECT"),
      ],
      // Context only: never final or first_draft.
      columns: [
        "audience",
        "context_updated_at",
        "kind_id",
        "medium",
        "purpose",
        "summary",
      ].map((attname) => column("memos", attname)),
    });
    expect(await privileges("milton_app_runtime")).toEqual({
      tables: [
        table("cover_sheets", "INSERT,SELECT"),
        table("memo_kinds", "DELETE,SELECT"),
        table("memo_settings", "INSERT,SELECT"),
        table("memos", "DELETE,SELECT"),
        table("tweak_citations", "DELETE,SELECT"),
        table("tweaks", "DELETE,SELECT"),
      ],
      columns: [
        column("memo_settings", "keep_memos"),
        column("memo_settings", "updated_at"),
        column("tweaks", "norm"),
        column("tweaks", "text"),
      ],
    });
    expect(await privileges("milton_runtime")).toEqual({
      tables: [],
      columns: [],
    });
  } finally {
    await local.dispose();
  }
});

test("native 008 links each authorized registration from what survives, by identity incarnation, and applies deletion's rule to deleted identities' registrations", async () => {
  const native = (name: string) =>
    Bun.file(
      new URL(`../../apps/auth/migrations/${name}`, import.meta.url),
    ).text();
  const pg = new PGlite();
  try {
    await migrate(drizzle(pg), {
      migrationsFolder: new URL("../drizzle/", import.meta.url).pathname,
    });
    await pg.query("SELECT set_config('milton.retained_logins','[]',false)");
    await pg.exec(await native("000-owner-prerequisites.sql"));
    for (const name of AUTH_MIGRATIONS.filter((n) => n < "008"))
      await pg.exec(await native(`${name}.up.sql`));
    // Rows 001-007 left behind, written directly (the gates are bypassed): two
    // live accounts; one deleted before 008, whose consents and tokens went
    // with it; and an earlier identity under u1's ID (incarnation "old"),
    // deleted before u1 was made. Each client's name says what 008 should do.
    await pg.exec(`SET session_replication_role=replica;
      INSERT INTO milton_auth."user"(id,name,email,"emailVerified","createdAt","updatedAt","miltonIdentityIncarnation") VALUES
        ('u1','A','a@example.invalid',true,now(),now(),'i1'),('u2','B','b@example.invalid',true,now(),now(),'i2');
      INSERT INTO milton_auth."oauthClient"(id,"clientId","redirectUris",name,contacts) VALUES
        ('c1','consented','[]','keep','["c@example.invalid"]'),('c2','bound','[]','keep',NULL),
        ('c3','disconnected','[]','keep',NULL),('c4','app','[]','keep',NULL),('c5','pending','[]','keep',NULL),
        ('c6','gone-bound','[]','delete',NULL),('c7','gone-disconnected','[]','delete',NULL),
        ('c8','gone-shared','[]','clear','["s@example.invalid"]'),('c9','earlier-identity','[]','delete',NULL);
      INSERT INTO milton_guard.first_party_policy VALUES('app');
      INSERT INTO milton_auth."oauthConsent"(id,"clientId","userId",scopes,"createdAt","updatedAt") VALUES('k1','consented','u1','[]',now(),now());
      INSERT INTO milton_guard.authorization_binding(reference,flow_key,origin_user,origin_session,"miltonIdentityIncarnation","miltonSecurityGeneration",client_id,resources,requested_scopes,final_scopes,state) VALUES
        ('r1','f1','u2','s','i2','g','bound','{}','{}','{milton:read}','revoked'),
        ('r2','f2','u1','s','i1','g','app','{}','{}','{openid}','active'),
        ('r3','f3','u1','s','i1','g','pending','{}','{}',NULL,'pending'),
        ('r4','f4','gone','s','i','g','gone-bound','{}','{}','{milton:read}','revoked'),
        ('r5','f5','gone','s','i','g','pending','{}','{}',NULL,'revoked'),
        ('r6','f6','u1','s','old','g','pending','{}','{}',NULL,'revoked');
      INSERT INTO milton_guard.security_operation(operation_id,origin_user,incarnation,client_id,kind,targets,progress) VALUES
        ('o1','u1','i1','disconnected','disconnect','{}','complete'),
        ('o2','gone','i','gone-disconnected','disconnect','{}','complete'),
        ('o3','gone','i','gone-shared','disconnect','{}','complete'),
        ('o4','u2','i2','gone-shared','disconnect','{}','complete'),
        ('o5','gone','i',NULL,'delete','{r5}','tokens-cleaned'),
        ('o6','u1','old','earlier-identity','disconnect','{}','complete');
      SET session_replication_role=origin;`);
    await pg.exec(await native("008-deletion-links.up.sql"));
    // Even a disconnected registration whose binding and consent are gone is
    // linked; Milton's app, an unconsented flow and an earlier identity's
    // registration are not.
    expect(
      (
        await pg.query(
          "SELECT origin_user,client_id FROM milton_guard.client_link ORDER BY 1,2",
        )
      ).rows,
    ).toEqual([
      { origin_user: "u1", client_id: "consented" },
      { origin_user: "u1", client_id: "disconnected" },
      { origin_user: "u2", client_id: "bound" },
      { origin_user: "u2", client_id: "gone-shared" },
    ]);
    // A refresh cannot restore what was cleared.
    await pg.exec(
      `UPDATE milton_auth."oauthClient" SET name='restored',contacts='["r@example.invalid"]' WHERE "clientId"='gone-shared'`,
    );
    expect(
      (
        await pg.query(
          `SELECT "clientId",name,contacts FROM milton_auth."oauthClient" ORDER BY 1`,
        )
      ).rows,
    ).toEqual([
      { clientId: "app", name: "keep", contacts: null },
      { clientId: "bound", name: "keep", contacts: null },
      { clientId: "consented", name: "keep", contacts: ["c@example.invalid"] },
      { clientId: "disconnected", name: "keep", contacts: null },
      { clientId: "gone-shared", name: null, contacts: null },
      { clientId: "pending", name: "keep", contacts: null },
    ]);
    // The deleted account's bindings go, except one an unfinished operation names.
    expect(
      (
        await pg.query(
          "SELECT reference FROM milton_guard.authorization_binding ORDER BY 1",
        )
      ).rows,
    ).toEqual([
      { reference: "r1" },
      { reference: "r2" },
      { reference: "r3" },
      { reference: "r5" },
    ]);
  } finally {
    await pg.close();
  }
});
