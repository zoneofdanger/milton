// Checks a runtime connection string before a service uses it, through the
// services' own driver: one HTTP query and one WebSocket transaction (which
// takes the store_config lock a sign-in takes). Passes only when the session is
// the expected login role, inherits milton_runtime and holds no elevated
// attribute. Reads DATABASE_URL from the environment and prints only ok or
// fail; a driver failure adds the usual one-line error log (class and code,
// never the URL) on stderr.
// Usage: DATABASE_URL=... bun --no-env-file scripts/check-runtime-role.ts
import { sql } from "drizzle-orm";
import { neonDatabase, type StoreDatabase } from "../src/store/database";

type Session = { role: string; runtime: boolean; plain: boolean };
const session = sql`SELECT current_user AS role,
  pg_has_role('milton_runtime','USAGE') AS runtime,
  NOT (r.rolsuper OR r.rolcreaterole OR r.rolcreatedb OR r.rolbypassrls OR r.rolreplication) AS plain
  FROM pg_roles r WHERE r.rolname = current_user`;

export async function checkRuntimeRole(
  db: StoreDatabase,
  expectedRole = "milton_app",
): Promise<boolean> {
  const passes = (row: Session | undefined) =>
    row?.role === expectedRole && row.runtime === true && row.plain === true;
  try {
    const [read] = await db.query<Session>(session);
    if (!passes(read)) return false;
    return await db.transaction(async (tx) => {
      const [locked] = await tx.query<{ singleton: number }>(
        sql`SELECT singleton FROM store_config WHERE singleton = 1 FOR UPDATE`,
      );
      const [inside] = await tx.query<Session>(session);
      return locked?.singleton === 1 && passes(inside);
    });
  } catch {
    return false;
  }
}

if (import.meta.main) {
  const url = process.env.DATABASE_URL;
  let ok = false;
  try {
    ok = url ? await checkRuntimeRole(neonDatabase(url)) : false;
  } catch {
    ok = false;
  }
  console.log(ok ? "ok" : "fail");
  process.exitCode = ok ? 0 : 1;
}
