// Direct-TLS role audit. The selected CLI requires MILTON_SERVICE=app|mcp,
// its own DATABASE_URL, distinct NOINHERIT roles and explicit authority grants.
// Only ok/fail is printed; no credentials or database errors reach the log.
import { sql } from "drizzle-orm";
import { postgresDatabase, type StoreDatabase } from "../src/store/database";

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
      const [config] = await tx.query<{ singleton: number }>(
        sql`SELECT singleton FROM store_config WHERE singleton = 1`,
      );
      const [inside] = await tx.query<Session>(session);
      return config?.singleton === 1 && passes(inside);
    });
  } catch {
    return false;
  }
}

if (import.meta.main) {
  const url = process.env.DATABASE_URL;
  let ok = false;
  try {
    ok =
      url && ["app", "mcp"].includes(process.env.MILTON_SERVICE ?? "")
        ? await checkProductRuntimeRole(
            postgresDatabase(url),
            process.env.MILTON_SERVICE as "app" | "mcp",
          )
        : false;
  } catch {
    ok = false;
  }
  console.log(ok ? "ok" : "fail");
  process.exitCode = ok ? 0 : 1;
}

/** Selected three-service cutover audit. Historical baseline helper above is
 * retained for the old schema's rollback tests, never selected by this CLI. */
export async function checkProductRuntimeRole(
  db: StoreDatabase,
  service: "app" | "mcp",
) {
  try {
    const row = (
      await db.query<{ plain: boolean; scoped: boolean }>(sql`SELECT
      r.rolname=${"milton_" + service + "_runtime"} AND NOT(r.rolsuper OR r.rolinherit OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication OR r.rolbypassrls)
      AND NOT EXISTS(SELECT 1 FROM pg_auth_members m WHERE m.member=r.oid)
      AND NOT EXISTS(SELECT 1 FROM pg_class c WHERE c.relowner=r.oid)
      AND NOT EXISTS(SELECT 1 FROM pg_namespace n WHERE n.nspowner=r.oid)
      AND NOT has_database_privilege(current_database(),'TEMP')
      AND NOT has_database_privilege(current_database(),'CREATE')
      AND NOT has_schema_privilege('public','CREATE') AS plain,
      NOT has_table_privilege((SELECT c.oid FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='milton_auth' AND c.relname='account'),'SELECT')
      AND NOT has_table_privilege((SELECT c.oid FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='milton_auth' AND c.relname='jwks'),'SELECT')
      AND NOT has_table_privilege((SELECT c.oid FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='milton_auth' AND c.relname='verification'),'SELECT')
      AND NOT has_table_privilege('milton_guard.authorization_binding','SELECT')
      AND has_function_privilege('milton_guard.binding_status(text,text,text,text[],text[])','EXECUTE')
      AND has_table_privilege((SELECT c.oid FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='milton_app' AND c.relname='session'),'SELECT')=${service === "app"}
      AND has_function_privilege('milton_guard.app_status(text,text,text,text,text,text)','EXECUTE')=${service === "app"}
      AND has_function_privilege('milton_guard.begin_operation(text,text,text,text,text)','EXECUTE')=${service === "app"}
      AS scoped FROM pg_roles r WHERE r.rolname=current_user`)
    )[0];
    return row?.plain === true && row.scoped === true;
  } catch {
    return false;
  }
}
