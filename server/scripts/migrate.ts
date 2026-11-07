import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Client } from "pg";
import { readFile } from "node:fs/promises";
import { validateDatabaseUrl } from "../src/store/database";
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
  const client = new Client({
    connectionString: validateDatabaseUrl(url),
    ssl: true,
    connectionTimeoutMillis: 5000,
    statement_timeout: 20000,
  });
  try {
    await client.connect();
    const { rows } = await client.query<{ database: string; role: string }>(
      "SELECT current_database() AS database, current_user AS role",
    );
    const appAuth = process.argv.includes("--app-auth");
    if (
      rows[0]?.database !== "milton" ||
      !(
        appAuth ? ["neondb_owner", "milton_app_owner"] : ["neondb_owner"]
      ).includes(rows[0]?.role ?? "")
    )
      throw new StoreError(
        "configuration",
        "Unexpected database or owner role.",
      );
    if (appAuth) {
      if (
        !(
          await client.query(
            "SELECT EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='milton_guard' AND p.proname='security_status' AND p.proargtypes=ARRAY['text'::regtype::oid,'text'::regtype::oid,'text'::regtype::oid,'text'::regtype::oid]::oidvector) AS ready",
          )
        ).rows[0]?.ready
      )
        throw new Error("native004_required");
      await client.query(
        await readFile(
          new URL("../migrations/005-app.up.sql", import.meta.url),
          "utf8",
        ),
      );
      return;
    }
    // PgDialect migrates writing DDL and journal entries in one transaction.
    await migrate(drizzle(client), {
      migrationsFolder: new URL("../drizzle", import.meta.url).pathname,
    });
  } finally {
    await client.end();
  }
}
if (import.meta.main) {
  try {
    const url = process.argv.includes("--app-auth")
      ? process.env.MILTON_OWNER_DATABASE_URL
        ? validateDatabaseUrl(process.env.MILTON_OWNER_DATABASE_URL)
        : undefined
      : await migrationUrl();
    if (!url)
      throw new StoreError(
        "configuration",
        "db:migrate requires MILTON_OWNER_DATABASE_URL, or DATABASE_URL in server/.dev.vars.",
      );
    await migrateStore(url);
    console.log(
      process.argv.includes("--app-auth")
        ? "PASS: app-only auth migration applied after native004."
        : "PASS: milton schema and Drizzle migration journal are current.",
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
