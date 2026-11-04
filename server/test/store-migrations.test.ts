import { expect, test } from "bun:test";
import {
  drizzleSql,
  migratedThrough,
  migrationsThrough,
  storeDatabase,
} from "./local-store";
import { fixtureStore, seedUsers } from "./store-fixtures";
import { checkRuntimeRole } from "../scripts/check-runtime-role";
import { linkStripeCustomer, recordStripeEvent } from "../src/store/billing";
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
      "SELECT proname,pg_get_functiondef(oid) AS definition FROM pg_proc WHERE pronamespace='public'::regnamespace AND (proname LIKE 'milton_%' OR proname LIKE 'guard_%') ORDER BY proname",
    ),
    extensions: await rows(
      "SELECT extname FROM pg_extension WHERE extname<>'plpgsql' ORDER BY extname",
    ),
  };
};

test("0025 adds the Stripe ledger and customer column, the runtime applies an event once, and rollback refuses until both are empty", async () => {
  const base = await migratedThrough(24);
  const pg = await migratedThrough(24);
  const post = await migratedThrough(25);
  try {
    const up = await drizzleSql("0025_stripe_billing.sql");
    const down = await drizzleSql("rollback/0025_stripe_billing.sql");
    await pg.exec(`INSERT INTO users(id) VALUES ('billing');
      INSERT INTO trial_accounts(user_id,started_at) VALUES ('billing','2026-11-01T00:00:00Z')`);
    const clock = async () =>
      (
        await pg.query(
          "SELECT user_id,started_at::text,paid_through::text,notice_stage FROM trial_accounts",
        )
      ).rows;
    const kept = await clock();
    // The runtime's privileges on the new objects, through 0024's defaults.
    const grants = async () =>
      (
        await pg.query(
          `SELECT c.relname,string_agg(a.privilege_type,',' ORDER BY a.privilege_type) AS privileges
           FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) a
           WHERE a.grantee='milton_runtime'::regrole AND c.relname IN ('stripe_events','trial_accounts')
           GROUP BY 1 ORDER BY 1`,
        )
      ).rows;
    const forward = async () => {
      await pg.exec("BEGIN;" + up + "COMMIT;");
      expect(await schemaCatalog(pg)).toEqual(await schemaCatalog(post));
      expect(await grants()).toEqual([
        { relname: "stripe_events", privileges: "INSERT,SELECT,UPDATE" },
        { relname: "trial_accounts", privileges: "INSERT,SELECT,UPDATE" },
      ]);
    };
    await forward();
    expect(await clock()).toEqual(kept);
    expect(
      (await pg.query("SELECT stripe_customer_id FROM trial_accounts")).rows,
    ).toEqual([{ stripe_customer_id: null }]);

    await pg.exec(
      "CREATE ROLE milton_app_fixture LOGIN IN ROLE milton_runtime; SET ROLE milton_app_fixture",
    );
    const db = storeDatabase(pg);
    try {
      expect(await linkStripeCustomer(db, "billing", "cus_fixture")).toBe(
        "cus_fixture",
      );
      // A second customer never replaces the stored one.
      expect(await linkStripeCustomer(db, "billing", "cus_other")).toBe(
        "cus_fixture",
      );
      const paid = {
        id: "evt_fixture",
        type: "invoice.paid",
        payloadSha256: "a".repeat(64),
        action: {
          kind: "paid_through" as const,
          customer: "cus_fixture",
          periodEnd: Date.parse("2026-12-01T00:00:00Z") / 1000,
        },
      };
      expect(await recordStripeEvent(db, paid)).toEqual({
        recorded: true,
        updated: 1,
      });
      // The same event id again changes nothing, whatever it carries.
      expect(
        await recordStripeEvent(db, {
          ...paid,
          action: { kind: "clear", customer: "cus_fixture" },
        }),
      ).toEqual({ recorded: false, updated: 0 });
      for (const statement of [
        "DELETE FROM stripe_events",
        "DELETE FROM trial_accounts",
      ])
        await expect(pg.query(statement)).rejects.toThrow("permission denied");
    } finally {
      await pg.exec("RESET ROLE");
    }
    await pg.exec("DROP ROLE milton_app_fixture");
    expect(
      (
        await pg.query(
          "SELECT stripe_customer_id,paid_through=timestamptz '2026-12-04T00:00:00Z' AS grace FROM trial_accounts",
        )
      ).rows,
    ).toEqual([{ stripe_customer_id: "cus_fixture", grace: true }]);

    await expect(pg.exec(down)).rejects.toThrow(
      "stripe_billing_rollback_requires_no_customers",
    );
    await pg.exec("ROLLBACK");
    await pg.exec("UPDATE trial_accounts SET stripe_customer_id=NULL");
    await expect(pg.exec(down)).rejects.toThrow(
      "stripe_billing_rollback_requires_no_events",
    );
    await pg.exec("ROLLBACK");
    await pg.exec("DELETE FROM stripe_events");
    await pg.exec(down);
    expect(await schemaCatalog(pg)).toEqual(await schemaCatalog(base));
    await forward();
  } finally {
    await post.close();
    await pg.close();
    await base.close();
  }
}, 30000);

test("0024 runtime role saves through its grants, cannot change the schema or bypass a trigger, and rolls back", async () => {
  const base = await migratedThrough(23);
  const pg = await migratedThrough(23);
  const post = await migratedThrough(24);
  try {
    const up = await drizzleSql("0024_runtime_role.sql");
    const down = await drizzleSql("rollback/0024_runtime_role.sql");
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
    // only where the runtime deletes; store_config is locked FOR UPDATE, which
    // needs one updatable column.
    const used: Record<string, string> = {
      accepted_changes: "INSERT",
      assistant_disconnects: "DELETE,INSERT,SELECT",
      deleted_identities: "INSERT,SELECT",
      identities: "INSERT,SELECT",
      instruction_card_versions: "INSERT,SELECT",
      instruction_cards: "INSERT,SELECT",
      memo_cards: "INSERT,SELECT",
      memo_versions: "INSERT,SELECT",
      memos: "INSERT,SELECT",
      sample_kinds: "INSERT,SELECT",
      samples: "INSERT,SELECT,UPDATE",
      save_requests: "INSERT,SELECT,UPDATE",
      store_config: "SELECT",
      tps_reports: "INSERT,SELECT,UPDATE",
      trial_accounts: "INSERT,SELECT,UPDATE",
      usage_daily: "INSERT,SELECT,UPDATE",
      users: "DELETE,INSERT,SELECT,UPDATE",
    };
    const forward = async () => {
      await pg.exec("BEGIN;" + up + "COMMIT;");
      expect(await schemaCatalog(pg)).toEqual(await schemaCatalog(post));
      expect(await roles(pg)).toEqual(await roles(post));
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
      expect(granted).toEqual(await grants(post));
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
      expect(granted.columns).toEqual([
        { relname: "store_config", attname: "singleton", privileges: "UPDATE" },
      ]);
      expect(granted.schemas).toEqual([
        { nspname: "drizzle", usage: false, create: false },
        { nspname: "public", usage: true, create: false },
      ]);
      expect(granted.connect).toEqual([{ connect: true }]);
      expect(granted.defaults).toEqual([
        { kind: "S", privileges: "USAGE" },
        { kind: "r", privileges: "INSERT,SELECT,UPDATE" },
      ]);
    };
    await forward();
    // Re-running the forward script by hand is a no-op.
    await pg.exec("BEGIN;" + up + "COMMIT;");
    expect(await grants(pg)).toEqual(await grants(post));

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
        "DROP FUNCTION milton_sample_guard() CASCADE",
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
        "UPDATE store_config SET memo_updates_enabled=true",
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

    // Rollback refuses while a login role is still in the group.
    await expect(pg.exec(down)).rejects.toThrow(
      "milton_runtime_has_login_members",
    );
    await pg.exec("ROLLBACK");
    expect(await grants(pg)).toEqual(await grants(post));
    await pg.exec("DROP ROLE milton_app_fixture");
    await pg.exec(down);
    expect(await schemaCatalog(pg)).toEqual(await schemaCatalog(base));
    expect(await roles(pg)).toEqual([]);
    expect(
      (await pg.query("SELECT count(*)::int AS n FROM pg_default_acl")).rows,
    ).toEqual([{ n: 0 }]);
    expect(
      (await pg.query("SELECT body FROM samples WHERE user_id='runtime'")).rows,
    ).toEqual([{ body: "Runtime sample body." }]);
    await forward();
  } finally {
    await post.close();
    await pg.close();
    await base.close();
  }
}, 30000);

test("0023 drops the spend subsystem, keeps memo-update accounting, and rolls back to the empty 0022 shape", async () => {
  const base = await migratedThrough(22);
  const pg = await migratedThrough(22);
  const post = await migratedThrough(23);
  try {
    const up = await drizzleSql("0023_no_spend.sql");
    const down = await drizzleSql("rollback/0023_no_spend.sql");
    const spend = [
      "derivation_usage",
      "foreground_usage",
      "gardening_usage",
      "spend_alert_emails",
      "spend_alerts",
    ];
    const day = "(clock_timestamp() AT TIME ZONE 'UTC')::date";
    // Production's shape: memo updates on, one charged and one held update
    // today, every spend table populated and a feed key installed.
    await pg.exec(`UPDATE store_config SET memo_updates_enabled=true,memo_updates_daily_limit=80,spend_feed_key_hash=repeat('a',64);
      INSERT INTO users(id) VALUES ('spend');
      INSERT INTO save_requests(user_id,request_id,input_hash,source_hash,reserved_micros,deadline,completed,result_json,memo_update_day,memo_update_state) VALUES
      ('spend','00000000-0000-4000-8000-000000000023',repeat('a',64),repeat('c',64),100,now(),true,'{"status":"saved"}',${day},'charged'),
      ('spend','00000000-0000-4000-8000-000000000024',repeat('b',64),repeat('c',64),0,now()+interval '1 minute',false,'{}',${day},'held');
      INSERT INTO gardening_usage(user_id,day_utc,reserved_micros) VALUES ('spend','2026-11-01',90);
      INSERT INTO derivation_usage(user_id,day_utc,reserved_micros) VALUES ('spend','2026-11-01',110);
      INSERT INTO spend_alerts(id,day_utc,metric,threshold_micros,filing_micros,review_micros,derived_micros,status,published_at) VALUES
      ('00000000-0000-4000-8000-000000000001','2026-11-01','model_reservations',100,100,0,0,'published',now());
      INSERT INTO spend_alert_emails(alert_id,envelope) VALUES ('00000000-0000-4000-8000-000000000001','{}');`);
    expect(
      (
        await pg.query(
          "SELECT reserved_micros::int AS micros FROM foreground_usage",
        )
      ).rows,
    ).toEqual([{ micros: 100 }]);
    const accounting = async () => ({
      settings: (
        await pg.query(
          "SELECT memo_updates_enabled AS enabled,memo_updates_daily_limit AS lim FROM store_config",
        )
      ).rows,
      updates: (
        await pg.query(
          "SELECT request_id,memo_update_day::text,memo_update_state,completed FROM save_requests ORDER BY request_id",
        )
      ).rows,
    });
    const kept = await accounting();
    expect(kept.updates).toHaveLength(2);
    const forward = async () => {
      await pg.exec("BEGIN;" + up + "COMMIT;");
      expect(await schemaCatalog(pg)).toEqual(await schemaCatalog(post));
      const catalog = await schemaCatalog(pg);
      expect(catalog.tables.filter((t) => spend.includes(t))).toEqual([]);
      expect(
        catalog.columns.filter((c) => c.column_name === "spend_feed_key_hash"),
      ).toEqual([]);
      expect(catalog.triggers.map((t) => t.tgname)).not.toContain(
        "save_foreground_reservation",
      );
      expect(await accounting()).toEqual(kept);
    };
    await forward();
    // A receipt that reserves spend no longer feeds a ledger.
    await pg.exec(`INSERT INTO save_requests(user_id,request_id,input_hash,source_hash,reserved_micros,deadline,completed,result_json) VALUES
      ('spend','00000000-0000-4000-8000-000000000025',repeat('d',64),repeat('c',64),100,now(),true,'{"status":"saved"}')`);
    await pg.exec(
      "DELETE FROM save_requests WHERE request_id='00000000-0000-4000-8000-000000000025'",
    );
    await pg.exec(down);
    expect(await schemaCatalog(pg)).toEqual(await schemaCatalog(base));
    for (const table of spend)
      expect(
        (await pg.query(`SELECT count(*)::int AS n FROM ${table}`)).rows,
      ).toEqual([{ n: 0 }]);
    expect(
      (await pg.query("SELECT spend_feed_key_hash AS hash FROM store_config"))
        .rows,
    ).toEqual([{ hash: null }]);
    expect(await accounting()).toEqual(kept);
    await forward();
  } finally {
    await post.close();
    await pg.close();
    await base.close();
  }
}, 30000);

test("0022 drops the model-era spend fields, keeps the memo-update settings, and rolls back to the 0021 shape", async () => {
  const base = await migratedThrough(21);
  const pg = await migratedThrough(21);
  const post = await migratedThrough(22);
  try {
    const up = await drizzleSql("0022_no_model_gate.sql");
    const down = await drizzleSql("rollback/0022_no_model_gate.sql");
    const settings =
      "SELECT memo_updates_enabled AS enabled,memo_updates_daily_limit AS lim FROM store_config";
    // Production's shape: alerts_only, ready, memo updates on.
    await pg.exec(`UPDATE store_config SET global_spend_policy='alerts_only',foreground_accounting_ready=true,
      memo_updates_enabled=true,memo_updates_daily_limit=80`);
    const forward = async () => {
      await pg.exec("BEGIN;" + up + "COMMIT;");
      expect(await schemaCatalog(pg)).toEqual(await schemaCatalog(post));
      expect((await pg.query(settings)).rows).toEqual([
        { enabled: true, lim: 80 },
      ]);
    };
    await forward();
    // Memo updates switch on and off without the readiness flag.
    await pg.exec("UPDATE store_config SET memo_updates_enabled=false");
    await pg.exec("UPDATE store_config SET memo_updates_enabled=true");
    await expect(
      pg.exec("UPDATE store_config SET memo_updates_daily_limit=0"),
    ).rejects.toThrow("config_memo_updates");
    await pg.exec(down);
    expect(await schemaCatalog(pg)).toEqual(await schemaCatalog(base));
    expect(
      (
        await pg.query(
          "SELECT global_spend_policy AS policy,foreground_accounting_ready AS ready,memo_updates_enabled AS enabled,memo_updates_daily_limit AS lim FROM store_config",
        )
      ).rows,
    ).toEqual([{ policy: "alerts_only", ready: true, enabled: true, lim: 80 }]);
    await forward();
  } finally {
    await post.close();
    await pg.close();
    await base.close();
  }
}, 30000);

test("0021 removes the card and memo count limits, keeps every other guard, and rolls back to the 0020 guards", async () => {
  const base = await migratedThrough(20);
  const pg = await migratedThrough(20);
  try {
    const up = await drizzleSql("0021_no_card_count.sql");
    const down = await drizzleSql("rollback/0021_no_card_count.sql");
    await pg.exec(`UPDATE store_config SET limits_json=limits_json || '{"memos":1}'::jsonb;
      INSERT INTO users(id) VALUES ('count');
      INSERT INTO users(id,status) VALUES ('leaving','deleting');
      INSERT INTO instruction_cards(user_id,id) VALUES ('count','c1');`);
    const card = (id: string, user = "count") =>
      pg.query("INSERT INTO instruction_cards(user_id,id) VALUES ($1,$2)", [
        user,
        id,
      ]);
    const memo = (id: string, name = id) =>
      pg.query("INSERT INTO memos(user_id,id,name) VALUES ('count',$1,$2)", [
        id,
        name,
      ]);
    await memo("m1");
    await expect(card("c2")).rejects.toThrow("memo_count_limit");
    await expect(memo("m2")).rejects.toThrow("memo_count_limit");
    const forward = async () => {
      await pg.exec("BEGIN;" + up + "COMMIT;");
      expect(await schemaCatalog(pg)).toEqual(await schemaCatalog(post));
    };
    const post = await migratedThrough(21);
    try {
      await forward();
      await card("c2");
      await card("c3");
      await memo("m2");
      // The other checks still hold.
      await expect(
        pg.query("UPDATE instruction_cards SET id='c9' WHERE id='c1'"),
      ).rejects.toThrow("card_identity_is_immutable");
      await expect(card("c4", "leaving")).rejects.toThrow(
        "account_unavailable",
      );
      await expect(memo("m3", "a".repeat(65))).rejects.toThrow(
        "memo_name_limit",
      );
      await pg.exec(down);
      expect(await schemaCatalog(pg)).toEqual(await schemaCatalog(base));
      expect(
        (await pg.query("SELECT id FROM instruction_cards ORDER BY id")).rows,
      ).toEqual([{ id: "c1" }, { id: "c2" }, { id: "c3" }]);
      await expect(card("c4")).rejects.toThrow("memo_count_limit");
      await expect(memo("m3")).rejects.toThrow("memo_count_limit");
      await forward();
      await card("c4");
    } finally {
      await post.close();
    }
  } finally {
    await pg.close();
    await base.close();
  }
}, 30000);

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
