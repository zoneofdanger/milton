import { databaseOptions } from "../src/database.ts";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import pg from "pg";
import { safeError } from "../src/config.ts";
import { AUTH_MIGRATIONS } from "./migrations.ts";
// One fixed key: one migrator at a time, held only inside each transaction.
const lock = "select pg_advisory_xact_lock(7311470001)";
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
  for (const name of AUTH_MIGRATIONS) {
    file = `${name}.up.sql`;
    // The file's work and its ledger row commit together or not at all.
    await client.query("BEGIN");
    try {
      await client.query(lock);
      const found = await client.query(
        "select name from milton_credential.migration_ledger where name=$1",
        [name],
      );
      if (found.rowCount) {
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
      // Deliberately conservative check before any work: a line that is only
      // BEGIN;, COMMIT; or ROLLBACK;. Its one false positive is a comment or
      // string holding exactly such a line, a loud and safe refusal.
      if (/^\s*(begin|commit|rollback)\s*;\s*$/im.test(sql))
        throw ownTransaction();
      // After the fact (only a SQL parser could tell before): any COMMIT, END
      // or ROLLBACK in the file ends this transaction (a different xact id) or
      // this savepoint, whose unguessable name the file cannot rewind to or
      // recreate (a failed release). Either way there is no ledger row.
      const savepoint = `migration_${randomBytes(16).toString("hex")}`;
      const xact = async () =>
        (await client!.query("select pg_current_xact_id()::text as id")).rows[0]
          .id as string;
      const before = await xact();
      await client.query(`SAVEPOINT ${savepoint}`);
      await client.query(sql);
      if ((await xact()) !== before) throw ownTransaction();
      await client
        .query(`RELEASE SAVEPOINT ${savepoint}`)
        .catch((error: { code?: string }) => {
          throw ["25P01", "3B001"].includes(error.code ?? "")
            ? ownTransaction()
            : error;
        });
      await client.query(
        "insert into milton_credential.migration_ledger values($1)",
        [name],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    }
    console.log(`${name} up complete`);
  }
} catch (error) {
  console.error("auth_migration", file, safeError(error));
  process.exitCode = 1;
} finally {
  client?.release();
  await pool.end();
}
