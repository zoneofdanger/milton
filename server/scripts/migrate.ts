import { drizzle } from "drizzle-orm/neon-serverless";
import { migrate } from "drizzle-orm/neon-serverless/migrator";
import { validateDatabaseUrl, withNeonClient } from "../src/store/database";
import { StoreError } from "../src/store/errors";
import { localDatabaseUrl } from "./database-config";

/** A release passes the owner connection in MILTON_OWNER_DATABASE_URL, checked
 * here; set but empty is refused, never a fall back to the local file. Otherwise it
 * comes from server/.dev.vars. An inherited DATABASE_URL is never used: it may be
 * the runtime's or another branch's. */
export async function migrationUrl(env: NodeJS.ProcessEnv = process.env) {
  const url = env.MILTON_OWNER_DATABASE_URL;
  return url === undefined ? localDatabaseUrl() : validateDatabaseUrl(url);
}

async function migrateStore(url: string) {
  await withNeonClient(url, async (client) => {
    const { rows } = await client.query<{ database: string; role: string }>(
      "SELECT current_database() AS database, current_user AS role",
    );
    if (rows[0]?.database !== "milton" || rows[0]?.role !== "neondb_owner")
      throw new StoreError(
        "configuration",
        "Unexpected database or owner role.",
      );
    // PgDialect migrates all application DDL and journal entries in one WS transaction.
    await migrate(drizzle(client), {
      migrationsFolder: new URL("../drizzle", import.meta.url).pathname,
    });
  });
}
if (import.meta.main) {
  try {
    const url = await migrationUrl();
    if (!url)
      throw new StoreError(
        "configuration",
        "db:migrate requires MILTON_OWNER_DATABASE_URL, or DATABASE_URL in server/.dev.vars.",
      );
    await migrateStore(url);
    console.log(
      "PASS: milton schema and Drizzle migration journal are current.",
    );
  } catch (error) {
    console.error(
      error instanceof StoreError
        ? error.message
        : "Migration failed; database details were not logged.",
    );
    process.exitCode = 1;
  }
}
