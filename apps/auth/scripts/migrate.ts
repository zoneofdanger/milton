import { databaseOptions } from "../src/database.ts";
import { readFileSync } from "node:fs";
import pg from "pg";
import { safeError } from "../src/config.ts";
import { AUTH_MIGRATIONS } from "./migrations.ts";
if (
  process.argv[2] !== "up" ||
  process.argv[3] !== "--apply" ||
  !process.env.AUTH_OWNER_DATABASE_URL
)
  throw new Error("explicit_owner_migration_required");
const pool = new pg.Pool({
  ...databaseOptions(process.env.AUTH_OWNER_DATABASE_URL),
  max: 1,
  connectionTimeoutMillis: 3000,
  statement_timeout: 10000,
});
try {
  const r = await pool.query<{ current_user: string }>("select current_user");
  if (r.rows[0]?.current_user !== "milton_auth_owner")
    throw new Error("migration_owner_required");
  await pool.query(
    "CREATE SCHEMA IF NOT EXISTS milton_credential AUTHORIZATION milton_auth_owner; CREATE TABLE IF NOT EXISTS milton_credential.migration_ledger(name text primary key); REVOKE ALL ON ALL TABLES IN SCHEMA milton_credential FROM PUBLIC,milton_auth_runtime,milton_app_runtime,milton_mcp_runtime;",
  );
  for (const name of AUTH_MIGRATIONS) {
    const found = await pool.query(
      "select name from milton_credential.migration_ledger where name=$1",
      [name],
    );
    if (found.rowCount) continue;
    await pool.query(
      readFileSync(
        new URL(`../migrations/${name}.up.sql`, import.meta.url),
        "utf8",
      ),
    );
    await pool.query(
      "insert into milton_credential.migration_ledger values($1)",
      [name],
    );
    console.log(`${name} up complete`);
  }
} catch (error) {
  console.error("auth_migration", safeError(error));
  process.exitCode = 1;
} finally {
  await pool.end();
}
