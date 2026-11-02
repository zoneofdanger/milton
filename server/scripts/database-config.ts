import { sql } from "drizzle-orm";
import type { StoreSession } from "../src/store/database";
import { readFile } from "node:fs/promises";
import { parseEnv } from "node:util";
import { StoreError } from "../src/store/errors";
import { validateDatabaseUrl } from "../src/store/database";

export async function localDatabaseUrl() {
  let content: string;
  try {
    content = await readFile(new URL("../.dev.vars", import.meta.url), "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return undefined;
    throw new StoreError("configuration", "Cannot read server/.dev.vars.");
  }
  const url = parseEnv(content).DATABASE_URL;
  return url ? validateDatabaseUrl(url) : undefined;
}

export async function verifyDatabaseTarget(db: StoreSession) {
  const target = (
    await db.query<{ database: string; role: string }>(
      sql`SELECT current_database() AS database, current_user AS role`,
    )
  )[0];
  if (target?.database !== "milton" || target.role !== "neondb_owner")
    throw new StoreError("configuration", "Unexpected database or owner role.");
}
