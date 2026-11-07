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
let file = "";
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
    file = `${name}.${direction}.sql`;
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
      const sql = readFileSync(
        new URL(`../migrations/${file}`, import.meta.url),
        "utf8",
      );
      const ownTransaction = () =>
        Object.assign(
          new Error(`${file} must not manage its own transaction`),
          {
            code: "MIGRATION_MUST_NOT_MANAGE_TRANSACTION",
          },
        );
      // Habit check before any work: a line that is only BEGIN;, COMMIT; or ROLLBACK;.
      if (/^\s*(begin|commit|rollback)\s*;\s*$/im.test(sql))
        throw ownTransaction();
      // Any COMMIT or ROLLBACK in the file (with or without AND CHAIN) ends the
      // transaction and this savepoint, so the release fails. It is caught after
      // the file ran: its work may be committed, but it gets no ledger row.
      await client.query("SAVEPOINT migration_file");
      await client.query(sql);
      await client
        .query("RELEASE SAVEPOINT migration_file")
        .catch((error: { code?: string }) => {
          throw ["25P01", "3B001"].includes(error.code ?? "")
            ? ownTransaction()
            : error;
        });
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
  console.error("auth_migration", file, safeError(error));
  process.exitCode = 1;
} finally {
  client?.release();
  await pool.end();
}
