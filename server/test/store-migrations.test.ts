import { expect, test } from "bun:test";
import { localStore, storeDatabase } from "./local-store";
import { fixtureStore, seedUsers } from "./store-fixtures";
import { checkRuntimeRole } from "../scripts/check-runtime-role";
import { migrationUrl } from "../scripts/migrate";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { generateDrizzleJson, generateMigration } from "drizzle-kit/api";
import * as schema from "../src/store/schema";
import { cp, mkdtemp, rm, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
    await migrate(drizzle(pg), { migrationsFolder: folder });
    expect(
      (await pg.query("SELECT * FROM drizzle.__drizzle_migrations")).rows,
    ).toHaveLength(journal.entries.length);
    // Drizzle skips an equal timestamp even with a different hash. The one-time
    // transition writes the baseline timestamp; future migrations work normally.
    await pg.exec(
      "UPDATE drizzle.__drizzle_migrations SET hash='ignored-by-drizzle'",
    );
    await migrate(drizzle(pg), { migrationsFolder: folder });
    expect(
      (await pg.query("SELECT hash FROM drizzle.__drizzle_migrations")).rows,
    ).toEqual(journal.entries.map(() => ({ hash: "ignored-by-drizzle" })));
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
    // A failing baseline rolls back its DDL and journal row together.
    const scratch = await mkdtemp(join(tmpdir(), "milton-baseline-"));
    const empty = new PGlite();
    try {
      await cp(folder, scratch, { recursive: true });
      await appendFile(
        join(scratch, baseline.tag + ".sql"),
        "\n--> statement-breakpoint\nSELECT 1/0;\n",
      );
      await expect(
        migrate(drizzle(empty), { migrationsFolder: scratch }),
      ).rejects.toMatchObject({ cause: { code: "22012" } });
      expect(await publicTables(empty)).toEqual([]);
      expect(
        (await empty.query("SELECT * FROM drizzle.__drizzle_migrations")).rows,
      ).toEqual([]);
    } finally {
      await empty.close();
      await rm(scratch, { recursive: true, force: true });
    }
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
      deleted_identities: "INSERT,SELECT",
      identities: "INSERT,SELECT",
      instruction_card_versions: "INSERT,SELECT",
      instruction_cards: "INSERT,SELECT",
      sample_kinds: "INSERT,SELECT",
      samples: "INSERT,SELECT,UPDATE",
      save_requests: "INSERT,SELECT,UPDATE",
      store_config: "SELECT",
      stripe_events: "INSERT,SELECT,UPDATE",
      trial_accounts: "INSERT,SELECT,UPDATE",
      usage_daily: "INSERT,SELECT,UPDATE",
      users: "DELETE,INSERT,SELECT,UPDATE",
    };
    expect(await roles(pg)).toEqual([
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
        ...Object.entries(used).map(([relname, privileges]) => ({
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
    const store = fixtureStore(storeDatabase(pg), "runtime", "assistant");
    try {
      expect((await pg.query("SELECT current_user AS role")).rows).toEqual([
        { role: "milton_app_fixture" },
      ]);
      // The release check passes for the member and fails for any other role.
      expect(
        await checkRuntimeRole(storeDatabase(pg), "milton_app_fixture"),
      ).toBe(true);
      expect(await checkRuntimeRole(storeDatabase(pg))).toBe(false);
      const empty = await store.getTpsReport();
      const rule = await store.saveMemo({
        text: "Add a rule.",
        rules: [{ report: "cover", text: "Be concise." }],
        expected_version: empty.version,
        request_id: crypto.randomUUID(),
      });
      expect(rule.status).toBe("saved");
      const sample = await store.saveMemo({
        text: "Keep this approved email.",
        expected_version: rule.version!,
        request_id: crypto.randomUUID(),
        sample: {
          report: "email",
          new_kind: "follow-up",
          context: "runtime context",
          text: "Runtime sample body.",
        },
      });
      expect(sample.status).toBe("saved");
      expect((await store.getTpsReport()).text).toContain("Be concise.");
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
        "DELETE FROM usage_daily",
        "DELETE FROM trial_accounts",
        "DELETE FROM deleted_identities",
        "DELETE FROM identities",
        "UPDATE identities SET user_id=user_id",
        "UPDATE store_config SET trials_enabled=true",
        "SELECT * FROM accepted_changes",
      ])
        await expect(pg.query(statement)).rejects.toThrow(
          /must be owner|permission denied/,
        );
      // A write a trigger forbids is refused by that trigger, as for the owner.
      const edit = "UPDATE samples SET body='Edited' WHERE user_id='runtime'";
      await expect(pg.query(edit)).rejects.toThrow("sample_is_append_only");
      await pg.exec("RESET ROLE");
      await expect(pg.query(edit)).rejects.toThrow("sample_is_append_only");
      // The owner session is a superuser here, not a runtime member.
      expect(
        await checkRuntimeRole(storeDatabase(pg), "milton_app_fixture"),
      ).toBe(false);
      expect(
        (await pg.query("SELECT body FROM samples WHERE user_id='runtime'"))
          .rows,
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
