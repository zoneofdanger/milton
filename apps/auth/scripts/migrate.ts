import { databaseOptions } from "../src/database.ts";
import { readFileSync } from "node:fs";
import pg from "pg";
import { safeError } from "../src/config.ts";
const names = [
  "001-native",
  "002-credential",
  "003-mechanism",
  "004-product",
  "005-recovery",
  "006-mail",
  "007-connection-key-status",
];
// One fixed key: one migrator at a time, held only inside each transaction.
const lock = "select pg_advisory_xact_lock(7311470001)";
const direction = process.argv[2];
if (
  !["up", "down"].includes(direction ?? "") ||
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
let client: pg.PoolClient | undefined;
try {
  client = await pool.connect();
  const r = await client.query<{ current_user: string }>("select current_user");
  if (r.rows[0]?.current_user !== "milton_auth_owner")
    throw new Error("migration_owner_required");
  await client.query(
    `BEGIN; ${lock}; CREATE SCHEMA IF NOT EXISTS milton_credential AUTHORIZATION milton_auth_owner; CREATE TABLE IF NOT EXISTS milton_credential.migration_ledger(name text primary key); REVOKE ALL ON ALL TABLES IN SCHEMA milton_credential FROM PUBLIC,milton_auth_runtime,milton_app_runtime,milton_mcp_runtime; COMMIT;`,
  );
  for (const name of direction === "up"
    ? names
    : [...names].reverse().filter((n) => n !== "001-native")) {
    const sql = readFileSync(
      new URL(`../migrations/${name}.${direction}.sql`, import.meta.url),
      "utf8",
    );
    // The runner owns the transaction; a file that ends it early would commit
    // its work apart from the ledger row.
    if (
      /^\s*(begin|commit|rollback|end|abort|start\s+transaction)\s*(work|transaction)?\s*;/im.test(
        sql,
      )
    )
      throw new Error("migration_transaction_control_refused");
    // The file's work and its ledger row commit together or not at all.
    await client.query("BEGIN");
    try {
      await client.query(lock);
      const found = await client.query(
        "select name from milton_credential.migration_ledger where name=$1",
        [name],
      );
      if (
        (direction === "up" && found.rowCount) ||
        (direction === "down" && !found.rowCount)
      ) {
        await client.query("ROLLBACK");
        continue;
      }
      await client.query(sql);
      if (direction === "up")
        await client.query(
          "insert into milton_credential.migration_ledger values($1)",
          [name],
        );
      else
        await client.query(
          "delete from milton_credential.migration_ledger where name=$1",
          [name],
        );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    }
    console.log(`${name} ${direction} complete`);
  }
} catch (error) {
  console.error("auth_migration", safeError(error));
  process.exitCode = 1;
} finally {
  client?.release();
  await pool.end();
}
