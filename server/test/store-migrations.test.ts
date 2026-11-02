import { expect, test } from "bun:test";
import { drizzleSql, migratedThrough, migrationsThrough } from "./local-store";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { appendFile, cp, mkdtemp, rm } from "node:fs/promises";
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
      "SELECT proname,pg_get_functiondef(oid) AS definition FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname LIKE 'milton_%' ORDER BY proname",
    ),
    extensions: await rows(
      "SELECT extname FROM pg_extension WHERE extname<>'plpgsql' ORDER BY extname",
    ),
  };
};

test("filing-kinds migration files every version and gives samples kinds; rollback restores the previous shape", async () => {
  const pg = await migratedThrough(19);
  try {
    await pg.exec(`INSERT INTO users(id) VALUES ('kinds');
      INSERT INTO instruction_cards(user_id,id,report) VALUES ('kinds','c1',NULL),('kinds','c2','email');
      INSERT INTO instruction_card_versions(user_id,card_id,version,description,body,reason,actor_json) VALUES
      ('kinds','c1',1,'One','- Cover rule.','Fixture','{}'),('kinds','c2',1,'Two','- Email rule.','Fixture','{}'),
      ('kinds','c2',2,'Two','- Email rule, edited.','Fixture','{}');
      INSERT INTO samples(user_id,id,report,kind,context,body,client_json,created_at,retired_at) VALUES
      ('kinds','s1','email','Follow-up','after a call','One','{}','2026-01-01',now()),
      ('kinds','s2','email','follow-up','after a call','Two','{}','2026-01-02',NULL),
      ('kinds','s3','chat','follow-up','after a call','Three','{}','2026-01-03',NULL);`);
    const up = await Bun.file(
      new URL("../drizzle/0020_filing_kinds.sql", import.meta.url),
    ).text();
    const down = await Bun.file(
      new URL("../drizzle/rollback/0020_filing_kinds.sql", import.meta.url),
    ).text();
    const forward = async () => {
      await pg.exec("BEGIN;" + up + "COMMIT;");
      expect(
        (
          await pg.query(
            "SELECT card_id,version,report FROM instruction_card_versions ORDER BY card_id,version",
          )
        ).rows,
      ).toEqual([
        { card_id: "c1", version: 1, report: "cover" },
        { card_id: "c2", version: 1, report: "email" },
        { card_id: "c2", version: 2, report: "email" },
      ]);
      expect(
        (
          await pg.query(
            "SELECT s.id,s.report,k.label,s.retire_reason,s.retired_request_id FROM samples s JOIN sample_kinds k ON k.user_id=s.user_id AND k.id=s.kind_id ORDER BY s.id",
          )
        ).rows,
      ).toEqual([
        {
          id: "s1",
          report: "email",
          label: "Follow-up",
          retire_reason: "evicted",
          retired_request_id: null,
        },
        {
          id: "s2",
          report: "email",
          label: "Follow-up",
          retire_reason: null,
          retired_request_id: null,
        },
        {
          id: "s3",
          report: "chat",
          label: "follow-up",
          retire_reason: null,
          retired_request_id: null,
        },
      ]);
    };
    await forward();
    await expect(
      pg.query("UPDATE sample_kinds SET label='Other'"),
    ).rejects.toThrow("sample_kind_is_immutable");
    await pg.exec(down);
    expect(
      (await pg.query("SELECT id,report FROM instruction_cards ORDER BY id"))
        .rows,
    ).toEqual([
      { id: "c1", report: null },
      { id: "c2", report: "email" },
    ]);
    expect(
      (await pg.query("SELECT id,kind FROM samples ORDER BY id")).rows,
    ).toEqual([
      { id: "s1", kind: "Follow-up" },
      { id: "s2", kind: "Follow-up" },
      { id: "s3", kind: "follow-up" },
    ]);
    await forward();
  } finally {
    await pg.close();
  }
}, 30000);

test("0018 removes derived systems without changing retained data, refuses a live lease, and rolls back to the empty pre-0018 shape", async () => {
  // Rehearse 0018 as the newest migration; later migrations are out of scope.
  const folder = await migrationsThrough(18);
  const pg = await migratedThrough(17);
  const derived = [
    "card_embeddings",
    "card_graphs",
    "card_links",
    "card_retrieval_embeddings",
    "gardening_jobs",
    "retrieval_enrollments",
  ];
  const derivedColumns = [
    "derivation_account_budget_micros",
    "derivation_global_budget_micros",
    "derivation_budget_revision",
    "derivation_cursor",
  ];
  const rows = async (statement: string) =>
    (await pg.query<Record<string, unknown>>(statement)).rows;
  // Full row dumps of every retained table. store_config loses only the four
  // derivation columns; users.retained_bytes is checked on its own.
  const retained = async () => {
    const dump: Record<string, unknown> = {};
    for (const table of (await publicTables(pg)).filter(
      (t) => !derived.includes(t),
    )) {
      const strip =
        table === "store_config"
          ? derivedColumns.map((c) => ` - '${c}'`).join("")
          : table === "users"
            ? " - 'retained_bytes'"
            : "";
      dump[table] = (
        await rows(
          `SELECT coalesce(jsonb_agg(r ORDER BY r::text),'[]') AS rows FROM (SELECT to_jsonb(t)${strip} AS r FROM ${table} t) x`,
        )
      )[0]!.rows;
    }
    return dump;
  };
  const bytes = async () =>
    Object.fromEntries(
      (
        await pg.query<{ id: string; retained_bytes: number }>(
          "SELECT id,retained_bytes::bigint::float8 AS retained_bytes FROM users ORDER BY id",
        )
      ).rows.map((row) => [row.id, row.retained_bytes]),
    );
  const catalog = () => schemaCatalog(pg);
  try {
    // Populate every derived table and both frozen ledgers at journal 17.
    const unit = `('[1' || repeat(',0',767) || ']')::vector`;
    await pg.exec(`INSERT INTO users(id) VALUES ('derived-a'),('derived-b');
      INSERT INTO memos(user_id,id,name) VALUES ('derived-a','a','writing'),('derived-a','b','narrative'),('derived-b','a','other');
      INSERT INTO memo_versions(user_id,memo_id,version,description,body,reason,actor_json) VALUES
      ('derived-a','a',1,'Review format','In code reviews, use bullets.','Fixture','{}'),
      ('derived-a','b',1,'Narrative format','Use prose for narrative reviews.','Fixture','{}'),
      ('derived-b','a',1,'Other account','Never send without approval.','Fixture','{}');
      INSERT INTO tps_reports(user_id,revision,body,source_hash) VALUES
      ('derived-a',1,'In code reviews, use bullets.',repeat('c',64)),('derived-b',1,'Never send without approval.',repeat('d',64));
      INSERT INTO samples(user_id,id,report,kind,context,body,client_json) VALUES ('derived-a','s1','email','follow-up','after a call','Hi there','{}');
      INSERT INTO save_requests(user_id,request_id,input_hash,source_hash,reserved_micros,deadline,completed,result_json) VALUES
      ('derived-a','00000000-0000-4000-8000-000000000001',repeat('a',64),repeat('c',64),100,now(),true,'{"status":"saved"}'),
      ('derived-a','00000000-0000-4000-8000-000000000002',repeat('b',64),repeat('c',64),100,now(),true,'{"status":"saved"}');
      UPDATE store_config SET derivation_account_budget_micros=100,derivation_global_budget_micros=1000,derivation_budget_revision=1,derivation_cursor=1;
      INSERT INTO card_embeddings(user_id,card_id,version,model,body_hash,embedding,status,attempt_id,lease_until) VALUES
      ('derived-a','a',1,'fixture-embedding',repeat('e',64),${unit},'ready','00000000-0000-4000-8000-0000000000e1',now()),
      ('derived-b','a',1,'fixture-embedding',repeat('e',64),NULL,'failed','00000000-0000-4000-8000-0000000000e2',now());
      INSERT INTO retrieval_enrollments(user_id,baseline) VALUES ('derived-a','[{"id":"a","version":1}]');
      INSERT INTO card_retrieval_embeddings(user_id,card_id,version,model,body_hash,embedding,status,attempt_id,lease_until) VALUES
      ('derived-a','a',1,'fixture-embedding',repeat('e',64),${unit},'ready','00000000-0000-4000-8000-0000000000e3',now());
      INSERT INTO card_graphs(user_id,source_hash,model,status,attempt_id,lease_until,finished_at) VALUES
      ('derived-a',repeat('c',64),'fixture-graph','ready','00000000-0000-4000-8000-0000000000e4',now(),now());
      INSERT INTO card_links(user_id,from_id,from_version,to_id,to_version,source_hash,kind,from_quote,to_quote,reason) VALUES
      ('derived-a','b',1,'a',1,repeat('c',64),'possible_exception','narrative reviews','code reviews','Fictional advisory link.');
      INSERT INTO derivation_usage(user_id,day_utc,reserved_micros) VALUES ('derived-a','2026-11-01',110);
      INSERT INTO gardening_usage(user_id,day_utc,reserved_micros) VALUES ('derived-a','2026-11-01',90);`);
    const before = await bytes();
    // A pending job carries reserved bytes on the account.
    await pg.exec(`INSERT INTO gardening_jobs(user_id,request_id,payload_json,report_revision,source_hash)
      VALUES ('derived-a','00000000-0000-4000-8000-000000000001','{"request":{"text":"Keep context."},"before":[],"after":[{"id":"a","version":1}]}',1,repeat('c',64))`);
    const [job] = await rows(
      "SELECT payload_bytes::float8 AS n FROM gardening_jobs",
    );
    const jobBytes = job!.n as number;
    expect(jobBytes).toBeGreaterThan(0);
    expect((await bytes())["derived-a"]).toBe(before["derived-a"]! + jobBytes);
    for (const table of derived)
      expect(
        (await rows(`SELECT count(*)::int AS n FROM ${table}`))[0]!.n,
      ).toBeGreaterThan(0);
    // A live lease refuses the whole migration; nothing changes.
    await pg.exec(`INSERT INTO gardening_jobs(user_id,request_id,payload_json,report_revision,source_hash)
      VALUES ('derived-a','00000000-0000-4000-8000-000000000002','{"request":{"text":"Leased."},"before":[],"after":[]}',1,repeat('c',64));
      UPDATE gardening_jobs SET status='running',attempt_id='00000000-0000-4000-8000-0000000000f1',attempted_at=now(),lease_until=now()+interval '5 minutes',reserved_micros=10
      WHERE request_id='00000000-0000-4000-8000-000000000002';`);
    const leased = await retained();
    const leasedCatalog = await catalog();
    const leasedBytes = await bytes();
    await expect(
      migrate(drizzle(pg), { migrationsFolder: folder }),
    ).rejects.toMatchObject({
      cause: { message: "remove_derived_requires_no_live_gardening_lease" },
    });
    expect(await retained()).toEqual(leased);
    expect(await catalog()).toEqual(leasedCatalog);
    expect(await bytes()).toEqual(leasedBytes);
    expect(
      (
        await rows(
          "SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations",
        )
      )[0]!.n,
    ).toBe(18);
    // Clear the leased job; its delete returns its bytes.
    await pg.exec(
      "DELETE FROM gardening_jobs WHERE request_id='00000000-0000-4000-8000-000000000002'",
    );
    expect((await bytes())["derived-a"]).toBe(before["derived-a"]! + jobBytes);
    // A live derivation lease refuses it too; nothing changes.
    await pg.exec(
      "UPDATE card_embeddings SET status='running',lease_until=now()+interval '5 minutes' WHERE user_id='derived-b'",
    );
    const derivationLeased = await retained();
    const derivationLeasedBytes = await bytes();
    await expect(
      migrate(drizzle(pg), { migrationsFolder: folder }),
    ).rejects.toMatchObject({
      cause: { message: "remove_derived_requires_no_live_derivation_lease" },
    });
    expect(await retained()).toEqual(derivationLeased);
    expect(await catalog()).toEqual(leasedCatalog);
    expect(await bytes()).toEqual(derivationLeasedBytes);
    expect(
      (
        await rows(
          "SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations",
        )
      )[0]!.n,
    ).toBe(18);
    await pg.exec(
      "UPDATE card_embeddings SET status='failed',lease_until=now() WHERE user_id='derived-b'",
    );
    const kept = await retained();
    const preCatalog = await catalog();
    const preBytes = await bytes();
    const ledgers = await rows(
      "SELECT 'derivation' AS ledger,user_id,day_utc::text,reserved_micros::int FROM derivation_usage UNION ALL SELECT 'gardening',user_id,day_utc::text,reserved_micros::int FROM gardening_usage ORDER BY 1",
    );
    expect(ledgers).toHaveLength(2);

    await migrate(drizzle(pg), { migrationsFolder: folder });
    expect(await retained()).toEqual(kept);
    expect(await bytes()).toEqual({
      ...preBytes,
      "derived-a": preBytes["derived-a"]! - jobBytes,
    });
    expect((await bytes())["derived-a"]).toBe(before["derived-a"]!);
    expect(
      await rows(
        "SELECT 'derivation' AS ledger,user_id,day_utc::text,reserved_micros::int FROM derivation_usage UNION ALL SELECT 'gardening',user_id,day_utc::text,reserved_micros::int FROM gardening_usage ORDER BY 1",
      ),
    ).toEqual(ledgers);
    const postCatalog = await catalog();
    expect(postCatalog.tables).toEqual([
      "accepted_changes",
      "derivation_usage",
      "foreground_usage",
      "gardening_usage",
      "identities",
      "instruction_card_versions",
      "instruction_cards",
      "memo_cards",
      "memo_versions",
      "memos",
      "samples",
      "save_requests",
      "spend_alert_emails",
      "spend_alerts",
      "store_config",
      "tps_reports",
      "trial_accounts",
      "usage_daily",
      "users",
    ]);
    expect(postCatalog.extensions).toEqual([]);
    expect(postCatalog.functions.map((f) => f.proname as string)).not.toContain(
      "milton_gardening_guard",
    );
    expect(postCatalog.functions.map((f) => f.proname as string)).not.toContain(
      "milton_card_link_guard",
    );
    expect(
      postCatalog.columns.filter(
        (c) =>
          derivedColumns.includes(c.column_name as string) ||
          derived.includes(c.table_name as string),
      ),
    ).toEqual([]);
    expect(
      postCatalog.constraints.filter(
        (c) =>
          derived.includes(c.tbl as string) ||
          (c.conname as string).startsWith("config_derivation"),
      ),
    ).toEqual([]);

    // The rollback restores the pre-0018 shape, empty.
    const down = await Bun.file(
      new URL("../drizzle/rollback/0018_remove_derived.sql", import.meta.url),
    ).text();
    await pg.exec(down);
    expect(await catalog()).toEqual(preCatalog);
    expect(await retained()).toEqual(kept);
    for (const table of derived)
      expect(await rows(`SELECT * FROM ${table}`)).toEqual([]);
    // A 0017-era statement set runs against it.
    expect(
      await rows(
        `SELECT ${derivedColumns.join(",")} FROM store_config WHERE singleton=1`,
      ),
    ).toEqual([
      {
        derivation_account_budget_micros: null,
        derivation_global_budget_micros: null,
        derivation_budget_revision: 0,
        derivation_cursor: 0,
      },
    ]);
    const restoredBytes = await bytes();
    await pg.exec(`INSERT INTO gardening_jobs(user_id,request_id,payload_json,report_revision,source_hash)
      VALUES ('derived-a','00000000-0000-4000-8000-000000000001','{"request":{"text":"Again."},"before":[],"after":[]}',1,repeat('c',64));
      INSERT INTO retrieval_enrollments(user_id,baseline) VALUES ('derived-a','[]');
      INSERT INTO card_retrieval_embeddings(user_id,card_id,version,model,body_hash,embedding,status,attempt_id,lease_until) VALUES
      ('derived-a','a',1,'fixture-embedding',repeat('e',64),${unit},'ready','00000000-0000-4000-8000-0000000000e5',now());
      UPDATE store_config SET derivation_account_budget_micros=100,derivation_global_budget_micros=1000,derivation_budget_revision=1;`);
    const [again] = await rows(
      "SELECT payload_bytes::float8 AS n FROM gardening_jobs",
    );
    expect((await bytes())["derived-a"]).toBe(
      restoredBytes["derived-a"]! + (again!.n as number),
    );
    await expect(
      pg.exec("UPDATE gardening_jobs SET payload_json='{}'"),
    ).rejects.toThrow("gardening_job_is_immutable");
    await expect(
      pg.exec(
        `INSERT INTO card_links(user_id,from_id,from_version,to_id,to_version,source_hash,kind,from_quote,to_quote,reason) VALUES
        ('derived-a','b',1,'a',1,repeat('c',64),'possible_exception','narrative reviews','code reviews','No graph.')`,
      ),
    ).rejects.toThrow("card_link_invalid");
    // Forward again over the restored shape returns the post-0018 catalog.
    await pg.exec(
      "BEGIN;\n" + (await drizzleSql("0018_remove_derived.sql")) + "\nCOMMIT;",
    );
    expect(await catalog()).toEqual(postCatalog);
    expect(await bytes()).toEqual(restoredBytes);
  } finally {
    await pg.close();
  }
}, 30000);

test("0019 rollback refuses while disconnects or deleted identities exist and restores the pre-0019 shape when empty", async () => {
  const base = await migratedThrough(18);
  const pg = await migratedThrough(19);
  try {
    const down = await Bun.file(
      new URL(
        "../drizzle/rollback/0019_assistant_disconnects.sql",
        import.meta.url,
      ),
    ).text();
    const refused = async (seed: string, code: string) => {
      await pg.exec(seed);
      await expect(pg.exec(down)).rejects.toThrow(code);
      await pg.exec("ROLLBACK");
      expect(await publicTables(pg)).toContain("assistant_disconnects");
    };
    await pg.exec("INSERT INTO users(id) VALUES ('rollback-a')");
    await refused(
      "INSERT INTO assistant_disconnects(provider,subject,client_id) VALUES ('neon','fixture','client-a')",
      "assistant_disconnects_rollback_requires_no_disconnects",
    );
    await pg.exec("DELETE FROM assistant_disconnects");
    await refused(
      `INSERT INTO deleted_identities(identity_hash) VALUES (repeat('a',64))`,
      "deleted_identities_rollback_requires_no_deleted_identities",
    );
    await pg.exec("DELETE FROM deleted_identities");
    await pg.exec(down);
    expect(await schemaCatalog(pg)).toEqual(await schemaCatalog(base));
    expect((await pg.query("SELECT id FROM users")).rows).toEqual([
      { id: "rollback-a" },
    ]);
  } finally {
    await pg.close();
    await base.close();
  }
});

test("a failing migration changes no table, row or journal entry, empty or populated", async () => {
  const bad = await mkdtemp(join(tmpdir(), "milton-migration-"));
  const pg = new PGlite();
  const failure = "\n--> statement-breakpoint\nSELECT 1/0;\n";
  let populated: PGlite | undefined;
  try {
    await cp(new URL("../drizzle/", import.meta.url), bad, { recursive: true });
    await appendFile(join(bad, "0001_store_invariants.sql"), failure);
    await expect(
      migrate(drizzle(pg), { migrationsFolder: bad }),
    ).rejects.toMatchObject({ cause: { code: "22012" } });
    expect(
      (
        await pg.query(
          "SELECT tablename FROM pg_tables WHERE schemaname='public'",
        )
      ).rows,
    ).toEqual([]);
    expect(
      (
        await pg.query(
          "SELECT count(*)::integer AS n FROM drizzle.__drizzle_migrations",
        )
      ).rows,
    ).toEqual([{ n: 0 }]);
    // Over populated data, the newest migration failing changes nothing; the
    // fixed migration then applies.
    await cp(
      new URL("../drizzle/0001_store_invariants.sql", import.meta.url),
      join(bad, "0001_store_invariants.sql"),
    );
    const { entries } = (await Bun.file(
      join(bad, "meta/_journal.json"),
    ).json()) as { entries: { idx: number; tag: string }[] };
    const newest = entries.at(-1)!;
    populated = await migratedThrough(newest.idx - 1);
    const db = populated;
    await db.exec(`INSERT INTO users(id) VALUES ('kept-a'),('kept-b');
      INSERT INTO identities(provider,subject,user_id) VALUES ('neon','kept-a','kept-a');`);
    const state = async () => {
      const tables: Record<string, unknown> = {};
      for (const table of await publicTables(db))
        tables[table] = (
          await db.query<{ rows: unknown }>(
            `SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]') AS rows FROM ${table} t`,
          )
        ).rows[0]!.rows;
      return {
        tables,
        catalog: await schemaCatalog(db),
        journal: (
          await db.query(
            "SELECT * FROM drizzle.__drizzle_migrations ORDER BY id",
          )
        ).rows,
      };
    };
    const before = await state();
    await appendFile(join(bad, newest.tag + ".sql"), failure);
    await expect(
      migrate(drizzle(db), { migrationsFolder: bad }),
    ).rejects.toMatchObject({ cause: { code: "22012" } });
    expect(await state()).toEqual(before);
    await cp(
      new URL(`../drizzle/${newest.tag}.sql`, import.meta.url),
      join(bad, newest.tag + ".sql"),
    );
    await migrate(drizzle(db), { migrationsFolder: bad });
    expect(
      (
        await db.query(
          "SELECT count(*)::integer AS n FROM drizzle.__drizzle_migrations",
        )
      ).rows,
    ).toEqual([{ n: entries.length }]);
    expect((await db.query("SELECT id FROM users ORDER BY id")).rows).toEqual([
      { id: "kept-a" },
      { id: "kept-b" },
    ]);
  } finally {
    await pg.close();
    await populated?.close();
    await rm(bad, { recursive: true, force: true });
  }
});
