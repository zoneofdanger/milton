import { databaseOptions } from "../src/database.ts";
import pg from "pg";
import { safeError } from "../src/config.ts";
import { pruneUsage } from "./prune-usage.ts";
if (process.argv[2] !== "--apply" || !process.env.AUTH_OWNER_DATABASE_URL)
  throw new Error("explicit_owner_maintenance_required");
const pool = new pg.Pool({
  ...databaseOptions(process.env.AUTH_OWNER_DATABASE_URL),
  max: 1,
  connectionTimeoutMillis: 3000,
  statement_timeout: 10000,
});
try {
  const role = await pool.query("select current_user");
  if (role.rows[0].current_user !== "milton_auth_owner")
    throw new Error("owner_required");
  const r = await pool.query(
    "select milton_guard.cleanup_expired(16) as removed",
  );
  console.log("Bounded auth expiry rows removed:", r.rows[0].removed);
  // One checked-out connection: each prune batch is a transaction on it.
  const client = await pool.connect();
  try {
    const pruned = await pruneUsage((text, values) =>
      client.query(text, values),
    );
    console.log("Usage rows past retention removed:", pruned);
  } finally {
    client.release();
  }
} catch (error) {
  console.error("auth_maintenance", safeError(error));
  process.exitCode = 1;
} finally {
  await pool.end();
}
