import { afterAll, expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { readdirSync, readFileSync } from "node:fs";
import { AUTH_MIGRATIONS } from "../../apps/auth/scripts/migrations";

const INVENTORY = "docs/deletion-inventory.txt";
const CLASSES = ["deleted", "hidden", "retained", "not-personal"];
const root = new URL("../../", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root), "utf8");

/** A fresh schema from all three tracks, applied as a fresh install applies them:
 * Drizzle, then native auth, then the owner files. */
async function freshSchema() {
  const pg = new PGlite();
  await migrate(drizzle(pg), {
    migrationsFolder: new URL("server/drizzle/", root).pathname,
  });
  // The native preparation's audited inventory: this cluster has no other logins.
  await pg.query("SELECT set_config('milton.retained_logins','[]',false)");
  await pg.exec(read("apps/auth/migrations/000-owner-prerequisites.sql"));
  for (const name of AUTH_MIGRATIONS)
    await pg.exec(read(`apps/auth/migrations/${name}.up.sql`));
  // 007-role-timeouts sets role options in the database named milton.
  await pg.exec("CREATE DATABASE milton");
  for (const file of readdirSync(new URL("server/migrations/", root)).sort())
    await pg.exec(read(`server/migrations/${file}`));
  return pg;
}
const schema = freshSchema();
afterAll(async () => (await schema).close());

/** Every column of a table or materialized view the migrations create whose type
 * can hold text: string types (text, varchar, char, name), JSON, bytea, tsvector,
 * XML and enums, and arrays, domains and composites of them, resolved recursively. */
async function textColumns(pg: PGlite) {
  type Type = {
    oid: number;
    typtype: string;
    typcategory: string;
    typname: string;
    typbasetype: number;
    typelem: number;
    typrelid: number;
  };
  const types = new Map(
    (
      await pg.query<Type>(
        "SELECT oid::int,typtype,typcategory,typname,typbasetype::int,typelem::int,typrelid::int FROM pg_type",
      )
    ).rows.map((t) => [t.oid, t]),
  );
  const attributes = (
    await pg.query<{
      relid: number;
      typid: number;
      relkind: string;
      schema: string;
      table: string;
      column: string;
      type: string;
    }>(
      `SELECT a.attrelid::int AS relid, a.atttypid::int AS typid, c.relkind, n.nspname AS schema,
         n.nspname||'.'||c.relname AS table, a.attname AS column, format_type(a.atttypid,a.atttypmod) AS type
       FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace
       WHERE a.attnum>0 AND NOT a.attisdropped ORDER BY 5,6`,
    )
  ).rows;
  const fields = Map.groupBy(attributes, (a) => a.relid);
  const known = new Map<number, boolean>();
  const bearing = (oid: number): boolean => {
    const t = types.get(oid);
    if (!t || known.has(oid)) return known.get(oid) ?? false;
    known.set(oid, false); // a type cannot contain itself
    const result =
      t.typtype === "d"
        ? bearing(t.typbasetype)
        : t.typcategory === "A"
          ? bearing(t.typelem)
          : t.typtype === "c"
            ? (fields.get(t.typrelid) ?? []).some((a) => bearing(a.typid))
            : t.typtype === "e" ||
              t.typcategory === "S" ||
              ["json", "jsonb", "bytea", "tsvector", "xml"].includes(t.typname);
    known.set(oid, result);
    return result;
  };
  return attributes.filter(
    (a) =>
      ["r", "p", "m"].includes(a.relkind) &&
      !["pg_catalog", "information_schema", "drizzle"].includes(a.schema) &&
      !a.schema.startsWith("pg_") &&
      bearing(a.typid),
  );
}

/** Every column missing from, or listed in but absent from, the inventory. */
function unclassified(
  columns: { table: string; column: string; type: string }[],
  inventory: string,
) {
  const failures: string[] = [];
  const listed = new Set<string>();
  for (const [n, line] of inventory.split("\n").entries()) {
    if (!line.trim() || line.startsWith("#")) continue;
    const [table, kind, names, reason, extra] = line
      .split("|")
      .map((s) => s.trim());
    if (
      !table ||
      !CLASSES.includes(kind ?? "") ||
      !names ||
      !reason ||
      extra !== undefined
    ) {
      failures.push(
        `${INVENTORY}:${n + 1}: expected "schema.table | ${CLASSES.join(" or ")} | columns | reason"`,
      );
      continue;
    }
    for (const column of names.split(/\s+/)) {
      const key = `${table}.${column}`;
      if (listed.has(key))
        failures.push(`${INVENTORY}:${n + 1}: ${key} is listed twice`);
      listed.add(key);
    }
  }
  for (const { table, column, type } of columns)
    if (!listed.delete(`${table}.${column}`))
      failures.push(
        `${table}.${column} (${type}) is not in ${INVENTORY}: add it to a ${table} line as ${CLASSES.join(", ")}, with the reason`,
      );
  for (const key of listed)
    failures.push(
      `${INVENTORY} lists ${key}, which a fresh schema does not have; remove it`,
    );
  return failures;
}

test(`every text-bearing column in a fresh schema is classified in ${INVENTORY}`, async () => {
  expect(
    unclassified(await textColumns(await schema), read(INVENTORY)),
  ).toEqual([]);
});

test("anonymous client registrations' free-text fields are classed retained, not not-personal", () => {
  const line = read(INVENTORY)
    .split("\n")
    .find((l) => l.startsWith("milton_auth.oauthClient | retained |"));
  expect(line?.split("|")[2]?.trim().split(/\s+/)).toEqual(
    expect.arrayContaining([
      "name",
      "contacts",
      "uri",
      "icon",
      "tos",
      "policy",
    ]),
  );
});

test("a domain, enum or composite over text, and a materialized view, count as text-bearing", async () => {
  const pg = await schema;
  await pg.exec(`BEGIN;
    CREATE DOMAIN public.memo_payload AS jsonb;
    CREATE DOMAIN public.memo_label AS public.memo_payload;
    CREATE TYPE public.mood AS ENUM ('plain');
    CREATE TYPE public.pair AS (label text, n integer);
    CREATE TYPE public.nest AS (inner_pair public.pair);
    CREATE TABLE public.fictional(id integer, payload public.memo_payload, label public.memo_label, mood public.mood, pair public.nest[]);
    CREATE MATERIALIZED VIEW public.fictional_view AS SELECT 'x'::text AS note;`);
  try {
    expect(unclassified(await textColumns(pg), read(INVENTORY))).toEqual([
      "public.fictional.label (memo_label) is not in docs/deletion-inventory.txt: add it to a public.fictional line as deleted, hidden, retained, not-personal, with the reason",
      "public.fictional.mood (mood) is not in docs/deletion-inventory.txt: add it to a public.fictional line as deleted, hidden, retained, not-personal, with the reason",
      "public.fictional.pair (nest[]) is not in docs/deletion-inventory.txt: add it to a public.fictional line as deleted, hidden, retained, not-personal, with the reason",
      "public.fictional.payload (memo_payload) is not in docs/deletion-inventory.txt: add it to a public.fictional line as deleted, hidden, retained, not-personal, with the reason",
      "public.fictional_view.note (text) is not in docs/deletion-inventory.txt: add it to a public.fictional_view line as deleted, hidden, retained, not-personal, with the reason",
    ]);
  } finally {
    await pg.exec("ROLLBACK");
  }
});
