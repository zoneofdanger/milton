import { expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { readdirSync, readFileSync } from "node:fs";
import { AUTH_MIGRATIONS } from "../../apps/auth/scripts/migrations";

const INVENTORY = "docs/deletion-inventory.txt";
const CLASSES = ["deleted", "hidden", "not-personal"];
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

test(`every text-bearing column in a fresh schema is classified in ${INVENTORY}`, async () => {
  const pg = await freshSchema();
  try {
    // Text, character, JSON, bytea, tsvector and XML columns, arrays of them and
    // domains over them, in every table the migrations create.
    const { rows } = await pg.query<{
      table: string;
      column: string;
      type: string;
    }>(
      `SELECT n.nspname||'.'||c.relname AS table, a.attname AS column, format_type(a.atttypid,a.atttypmod) AS type
       FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace
       JOIN pg_type t ON t.oid=a.atttypid LEFT JOIN pg_type e ON e.oid=t.typelem AND t.typcategory='A'
       WHERE c.relkind IN ('r','p') AND a.attnum>0 AND NOT a.attisdropped
         AND n.nspname NOT IN ('pg_catalog','information_schema','pg_toast','drizzle')
         AND (coalesce(e.typcategory,t.typcategory)='S' OR coalesce(e.typname,t.typname) IN ('json','jsonb','bytea','tsvector','xml'))
       ORDER BY 1,2`,
    );
    const failures: string[] = [];
    const listed = new Set<string>();
    for (const [n, line] of read(INVENTORY).split("\n").entries()) {
      if (!line.trim() || line.startsWith("#")) continue;
      const [table, kind, columns, reason, extra] = line
        .split("|")
        .map((s) => s.trim());
      if (
        !table ||
        !CLASSES.includes(kind ?? "") ||
        !columns ||
        !reason ||
        extra !== undefined
      ) {
        failures.push(
          `${INVENTORY}:${n + 1}: expected "schema.table | ${CLASSES.join(" or ")} | columns | reason"`,
        );
        continue;
      }
      for (const column of columns.split(/\s+/)) {
        const key = `${table}.${column}`;
        if (listed.has(key))
          failures.push(`${INVENTORY}:${n + 1}: ${key} is listed twice`);
        listed.add(key);
      }
    }
    for (const { table, column, type } of rows)
      if (!listed.delete(`${table}.${column}`))
        failures.push(
          `${table}.${column} (${type}) is not in ${INVENTORY}: add it to a ${table} line as deleted, hidden or not-personal, with the reason`,
        );
    for (const key of listed)
      failures.push(
        `${INVENTORY} lists ${key}, which a fresh schema does not have; remove it`,
      );
    expect(failures).toEqual([]);
  } finally {
    await pg.close();
  }
});
