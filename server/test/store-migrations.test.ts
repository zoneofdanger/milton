import { expect, test } from "bun:test";
import { localStore, storeDatabase } from "./local-store";
import { fixtureStore, seedSample, seedUsers } from "./store-fixtures";
import { migrationUrl } from "../scripts/migrate";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { generateDrizzleJson, generateMigration } from "drizzle-kit/api";
import * as schema from "../src/store/schema";
import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
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
      deleted_identities: "INSERT,SELECT",
      guide_accounts: "SELECT",
      guide_budget_lock: "",
      guide_spend: "",
      identities: "INSERT,SELECT",
      instruction_card_versions: "INSERT,SELECT",
      instruction_cards: "INSERT,SELECT",
      report_guides: "SELECT",
      sample_kinds: "INSERT,SELECT",
      sample_versions: "INSERT,SELECT",
      samples: "INSERT,SELECT",
      save_requests: "INSERT,SELECT,UPDATE",
      store_config: "SELECT",
      stripe_events: "INSERT,SELECT,UPDATE",
      trial_accounts: "INSERT,SELECT,UPDATE",
      usage_daily: "INSERT,SELECT,UPDATE",
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
    const store = fixtureStore(storeDatabase(pg), "runtime", "assistant");
    try {
      expect((await pg.query("SELECT current_user AS role")).rows).toEqual([
        { role: "milton_app_fixture" },
      ]);
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
          context: { version: 1, summary: "runtime context" },
          text: "Runtime sample body.",
        },
      });
      expect(sample.status).toBe("saved");
      const activeSample = (await store.readDocuments()).reports.find(
        (r) => r.id === "email",
      )!.samples[0]!;
      const corrected = await store.saveMemo({
        text: "Correct fictional runtime context.",
        expected_version: sample.version!,
        request_id: crypto.randomUUID(),
        sample_context: {
          report: "email",
          sample_id: activeSample.id,
          context: {
            version: 1,
            summary: "Corrected runtime context.",
            purposes: ["request_review"],
          },
        },
      });
      expect(corrected.status).toBe("saved");
      expect(
        await store.saveMemo({
          text: "Retire a fictional runtime sample.",
          expected_version: corrected.version!,
          request_id: crypto.randomUUID(),
          retire_samples: [activeSample.id],
        }),
      ).toMatchObject({ status: "saved" });
      await expect(
        pg.query(
          "UPDATE sample_versions SET context=context || '{\"medium\":\"chat\"}'::jsonb,version=version+1 WHERE user_id='runtime'",
        ),
      ).rejects.toThrow("permission denied");
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
      ).toEqual(
        Array.from({ length: 3 }, () => ({ body: "Runtime sample body." })),
      );
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

test("sample context upgrade preserves baseline writing and labels and guards the result", async () => {
  const folder = new URL("../drizzle/", import.meta.url).pathname;
  const pg = new PGlite();
  // This historical migration's rollback contract is tested at its own schema.
  const contextFolder = await mkdtemp(join(tmpdir(), "milton-context-"));
  await cp(folder, contextFolder, { recursive: true });
  const journal = await Bun.file(folder + "meta/_journal.json").json();
  journal.entries = journal.entries.slice(0, 2);
  await writeFile(
    join(contextFolder, "meta/_journal.json"),
    JSON.stringify(journal),
  );
  try {
    await pg.exec(
      "CREATE SCHEMA drizzle; CREATE TABLE drizzle.__drizzle_migrations(id serial PRIMARY KEY, hash text NOT NULL, created_at bigint)",
    );
    await pg.exec(await Bun.file(folder + "0000_baseline.sql").text());
    await pg.exec(
      "INSERT INTO drizzle.__drizzle_migrations(hash,created_at) VALUES ('fixture-baseline',1793815543500)",
    );
    await seedUsers(pg, "upgrade-fixture");
    await pg.exec(`INSERT INTO sample_kinds(user_id,id,report,label) VALUES ('upgrade-fixture','k','chat','note');
      INSERT INTO samples(user_id,id,report,kind_id,context,body,client_json,audience,purpose,register) VALUES ('upgrade-fixture','a','chat','k','Original summary.','  Original body.\r\n\n😀  ','{}','boss','follow up','casual');
      INSERT INTO samples(user_id,id,report,kind_id,context,body,client_json,retired_at,retire_reason) VALUES ('upgrade-fixture','r','chat','k','Retired summary.','Retired body.','{}',now(),'removed');`);
    await migrate(drizzle(pg), { migrationsFolder: contextFolder });
    expect(
      (
        await pg.query(
          "SELECT created_at FROM drizzle.__drizzle_migrations ORDER BY created_at",
        )
      ).rows,
    ).toEqual([{ created_at: 1793815543500 }, { created_at: 1793901943500 }]);
    expect(
      (
        await pg.query(
          "SELECT id,body,context,context_revision FROM samples ORDER BY id",
        )
      ).rows,
    ).toMatchObject([
      {
        id: "a",
        body: "  Original body.\r\n\n😀  ",
        context: {
          version: 1,
          summary: "Original summary.",
          audience: { relationship: "boss" },
          purposes: ["follow up"],
          register: "casual",
        },
        context_revision: 1,
      },
      {
        id: "r",
        context: { version: 1, summary: "Retired summary." },
        context_revision: 1,
      },
    ]);
    await expect(
      pg.query("UPDATE samples SET context_revision=2 WHERE id='r'"),
    ).rejects.toThrow("sample_is_append_only");
    await expect(
      pg.query(
        "UPDATE samples SET context=context || '{\"medium\":\"slack\"}'::jsonb WHERE id='a'",
      ),
    ).rejects.toThrow("sample_is_append_only");
    // Identity-only lineage permits later reclassification, but insertion must
    // still replace a sample of the same kind, including for direct SQL writers.
    await pg.exec(
      "INSERT INTO sample_kinds(user_id,id,report,label) VALUES ('upgrade-fixture','k2','chat','expert request')",
    );
    await expect(
      pg.query(`INSERT INTO samples(user_id,id,report,kind_id,context,body,client_json,replaces_id)
      VALUES ('upgrade-fixture','bad-link','chat','k2','{"version":1,"summary":"A fictional replacement."}','Replacement.','{}','a')`),
    ).rejects.toThrow("sample_replacement_kind");
    for (const context of [
      { version: 1, summary: "A note.", unknown: "value" },
      { version: 1, summary: "A note.", purposes: ["ask", "ask"] },
      {
        version: 1,
        summary: "A note.",
        scope: { unit: "whole", role: "closing" },
      },
      { version: 1, summary: "A note.", audience: { role: "expert\nreader" } },
    ])
      await expect(
        pg.query(
          "INSERT INTO samples(user_id,id,report,kind_id,context,body,client_json) VALUES ('upgrade-fixture','bad-context','chat','k',$1::jsonb,'A note.','{}')",
          [JSON.stringify(context)],
        ),
      ).rejects.toThrow("samples_context");
  } finally {
    await pg.close();
    await rm(contextFolder, { recursive: true, force: true });
  }
});

test("stable revision upgrade preserves known snapshots and provenance, refuses ambiguous lineage atomically", async () => {
  const folder = new URL("../drizzle/", import.meta.url).pathname;
  const pg = new PGlite();
  try {
    await pg.exec(
      "CREATE SCHEMA drizzle; CREATE TABLE drizzle.__drizzle_migrations(id serial PRIMARY KEY,hash text NOT NULL,created_at bigint)",
    );
    await pg.exec(await Bun.file(folder + "0000_baseline.sql").text());
    await pg.exec(await Bun.file(folder + "0001_sample_context.sql").text());
    await pg.exec(`INSERT INTO drizzle.__drizzle_migrations(hash,created_at) VALUES ('fixture-context',1793901943500);
      INSERT INTO users(id) VALUES ('upgrade'),('other');
      INSERT INTO sample_kinds(user_id,id,report,label) VALUES ('upgrade','k','chat','note'),('upgrade','k2','chat','expert note'),('upgrade','mail','email','note'),('other','k','chat','note');
      INSERT INTO samples(user_id,id,report,kind_id,context,body,client_json,created_at) VALUES
      ('upgrade','root','chat','k','{"version":1,"summary":"Original summary."}',E'  Original body.\\r\\n\\n😀  ',' { "issuer": "fictional" } ','2026-01-01'),
      ('upgrade','removed','chat','k','{"version":1,"summary":"Removed summary."}','Removed body.','{}','2026-01-01'),
      ('upgrade','consolidated','chat','k','{"version":1,"summary":"Consolidated summary."}','Consolidated body.','{}','2026-01-01'),
      ('upgrade','duplicate-target','chat','k','{"version":1,"summary":"Independent target."}','Same approved text.','{}','2026-01-01');
      UPDATE samples SET retired_at='2026-01-02',retire_reason='replaced',retired_request_id='11111111-1111-4111-8111-111111111111' WHERE id='root';
      INSERT INTO samples(user_id,id,report,kind_id,context,body,client_json,replaces_id,created_at)
      VALUES ('upgrade','child','chat','k','{"version":1,"summary":"Child summary."}','Same approved text.','{"client":"second"}','root','2026-01-02');
      UPDATE samples SET context='{"version":1,"summary":"Corrected context.","scope":{"unit":"excerpt","role":"closing"}}',kind_id='k2',context_revision=2 WHERE id='child';
      UPDATE samples SET retired_at='2026-01-03',retire_reason='removed' WHERE id='removed';
      UPDATE samples SET retired_at='2026-01-03',retire_reason='replaced' WHERE id='consolidated';`);
    const before = (
      await pg.query<
        Record<string, unknown> & { id: string; created_at: Date }
      >("SELECT * FROM samples ORDER BY user_id,id")
    ).rows;
    // Accepted-change evidence stays untouched, even when it uses old IDs/API.
    await pg.query(
      `INSERT INTO accepted_changes(user_id,request_id,operation,request_json,actor_json,transformation_json,affected_json,before_tps,after_tps,before_source,after_source)
      VALUES ('upgrade',$1,'save_memo','{"sample_context":{"sample_id":"child"}}','{}','{}','[]',repeat('a',64),repeat('b',64),repeat('c',64),repeat('d',64))`,
      [crypto.randomUUID()],
    );
    const evidence = (await pg.query("SELECT * FROM accepted_changes")).rows;
    const baseline = await pg.dumpDataDir("none");
    await migrate(drizzle(pg), { migrationsFolder: folder });
    const identities = (
      await pg.query<{ id: string; created_at: Date; client_json: string }>(
        "SELECT id,created_at,client_json FROM samples WHERE user_id='upgrade' ORDER BY id",
      )
    ).rows;
    expect(identities).toHaveLength(4);
    expect(identities.find((s) => s.id === "root")).toEqual({
      id: "root",
      created_at: before.find((s) => s.id === "root")!.created_at,
      client_json: ' { "issuer": "fictional" } ',
    });
    const versions = (
      await pg.query<Record<string, unknown>>(
        "SELECT * FROM sample_versions ORDER BY sample_id,version",
      )
    ).rows;
    expect(versions).toHaveLength(before.length);
    for (const old of before) {
      const v = versions.find(
        (v) => (v.provenance as Record<string, unknown>).legacy_id === old.id,
      )!;
      expect(v).toMatchObject({
        body: old.body,
        context: old.context,
        kind_id: old.kind_id,
        report: old.report,
        actor_json: old.client_json,
        provenance: {
          legacy_context_revision: old.context_revision,
          legacy_retire_reason: old.retire_reason,
          legacy_retired_request_id: old.retired_request_id,
        },
      });
      const provenance = v.provenance as Record<string, unknown>;
      expect(new Date(provenance.legacy_created_at as string)).toEqual(
        old.created_at,
      );
      expect(provenance.context_history).toContain("not reconstructed");
    }
    expect(versions.filter((v) => v.sample_id === "root")).toMatchObject([
      { version: 1, retired: false },
      { version: 2, retired: false, kind_id: "k2" },
    ]);
    expect(versions.find((v) => v.sample_id === "consolidated")).toMatchObject({
      retired: true,
      retire_reason: "replaced",
    });
    expect((await pg.query("SELECT * FROM accepted_changes")).rows).toEqual(
      evidence,
    );
    const store = fixtureStore(storeDatabase(pg), "upgrade");
    const current = (await store.readDocuments()).reports.find(
      (r) => r.id === "chat",
    )!;
    expect(current.samples.map((s) => s.id).sort()).toEqual([
      "duplicate-target",
      "root",
    ]);
    expect(current.samples.find((s) => s.id === "root")).toMatchObject({
      revision: 2,
      body: "Same approved text.",
      context: { summary: "Corrected context." },
    });
    expect(await store.exportTpsReport()).not.toContain("Original body.");
    expect(await store.exportTpsReport()).not.toContain("Removed body.");
    await pg.query("DELETE FROM users WHERE id='upgrade'");
    expect((await pg.query("SELECT * FROM samples")).rows).toEqual([]);
    expect((await pg.query("SELECT * FROM sample_versions")).rows).toEqual([]);
    const retiredChain = await PGlite.create({ loadDataDir: baseline });
    try {
      await retiredChain.query(
        "UPDATE samples SET retired_at='2026-01-04',retire_reason='removed' WHERE id='child'",
      );
      await migrate(drizzle(retiredChain), { migrationsFolder: folder });
      const retiredStore = fixtureStore(storeDatabase(retiredChain), "upgrade");
      expect(
        (await retiredStore.readDocuments()).reports
          .find((r) => r.id === "chat")!
          .samples.map((s) => s.id),
      ).toEqual(["duplicate-target"]);
      expect(
        (
          await retiredChain.query(
            "SELECT version,retired,retire_reason FROM sample_versions WHERE sample_id='root' ORDER BY version",
          )
        ).rows,
      ).toEqual([
        { version: 1, retired: false, retire_reason: null },
        { version: 2, retired: true, retire_reason: "removed" },
      ]);
    } finally {
      await retiredChain.close();
    }
    for (const [mutation, reason] of [
      [
        "UPDATE samples SET replaces_id='absent' WHERE id='child'",
        "sample_lineage_invalid_parent",
      ],
      [
        "UPDATE samples SET user_id='other' WHERE id='child'",
        "sample_lineage_invalid_parent",
      ],
      [
        "UPDATE samples SET report='email',kind_id='mail' WHERE id='child'",
        "sample_lineage_invalid_parent",
      ],
      [
        "UPDATE samples SET retired_at=NULL,retire_reason=NULL,retired_request_id=NULL WHERE id='root'",
        "sample_lineage_invalid_parent",
      ],
      [
        "INSERT INTO samples(user_id,id,report,kind_id,context,body,client_json,replaces_id) VALUES ('upgrade','branch','chat','k','{\"version\":1,\"summary\":\"Branch.\"}','Branch.','{}','root')",
        "sample_lineage_branch",
      ],
      [
        "UPDATE samples SET replaces_id='child' WHERE id='root'; UPDATE samples SET retired_at=now(),retire_reason='replaced' WHERE id='child'",
        "sample_lineage_cycle",
      ],
    ]) {
      const invalid = await PGlite.create({ loadDataDir: baseline });
      try {
        await invalid.exec(
          "ALTER TABLE samples DISABLE TRIGGER ALL;" +
            mutation +
            ";ALTER TABLE samples ENABLE TRIGGER ALL",
        );
        const rows = (
          await invalid.query("SELECT * FROM samples ORDER BY user_id,id")
        ).rows;
        await expect(
          migrate(drizzle(invalid), { migrationsFolder: folder }),
        ).rejects.toMatchObject({ cause: { message: reason } });
        expect(
          (await invalid.query("SELECT * FROM samples ORDER BY user_id,id"))
            .rows,
        ).toEqual(rows);
        expect(await publicTables(invalid)).not.toContain("sample_versions");
        expect(
          (await invalid.query("SELECT * FROM drizzle.__drizzle_migrations"))
            .rows,
        ).toHaveLength(1);
      } finally {
        await invalid.close();
      }
    }
  } finally {
    await pg.close();
  }
}, 30000);

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
