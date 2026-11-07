import type pg from "pg";
import { safeError } from "./config.ts";

// Network and server-availability failures only; a role or privilege refusal
// is never retried. pg reports connect timeouts and drops by message alone.
const TRANSIENT_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ENOTFOUND",
  "ETIMEDOUT",
  "57P01", // admin_shutdown
  "57P03", // cannot_connect_now
]);
const TRANSIENT_MESSAGES = new Set([
  "Connection terminated due to connection timeout",
  "Connection terminated unexpectedly",
  "timeout exceeded when trying to connect",
]);
function transient(error: unknown, depth = 0): boolean {
  if (!(error instanceof Error) || depth > 3) return false;
  const code = "code" in error ? error.code : undefined;
  if (typeof code === "string" && TRANSIENT_CODES.has(code)) return true;
  return (
    TRANSIENT_MESSAGES.has(error.message) || transient(error.cause, depth + 1)
  );
}

// Retries a startup check on transient failures with backoff of 0.5, 1, 2,
// then 4 seconds, while the next wait still ends within about 15 seconds of
// the first try; then throws the last error as a single try would.
export async function retryStartupCheck<T>(
  check: () => Promise<T>,
  {
    now = Date.now,
    sleep = (ms: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, ms)),
    log = (fields: object) => console.warn("auth_startup_retry", fields),
  }: {
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
    log?: (fields: {
      attempt: number;
      delayMs: number;
      class: string;
      code: string;
    }) => void;
  } = {},
): Promise<T> {
  const start = now();
  for (let attempt = 1; ; attempt++) {
    try {
      return await check();
    } catch (error) {
      const delayMs = Math.min(500 * 2 ** (attempt - 1), 4000);
      if (!transient(error) || now() - start + delayMs > 15000) throw error;
      log({ attempt, delayMs, ...safeError(error) });
      await sleep(delayMs);
    }
  }
}
// Audits the auth service's own runtime role. App and MCP roles are audited by
// checkProductRuntimeRole in server/scripts/check-runtime-role.ts.
export async function checkRuntimeRole(pool: pg.Pool) {
  const role = await pool.query<{
    rolname: string;
    rolsuper: boolean;
    rolcreatedb: boolean;
    rolcreaterole: boolean;
    rolinherit: boolean;
    rolbypassrls: boolean;
  }>("select * from pg_roles where rolname=current_user");
  const r = role.rows[0];
  if (
    !r ||
    r.rolname !== "milton_auth_runtime" ||
    r.rolsuper ||
    r.rolcreatedb ||
    r.rolcreaterole ||
    r.rolinherit ||
    r.rolbypassrls
  )
    throw new Error("unsafe_runtime_role");
  const memberships = await pool.query(
    "select 1 from pg_auth_members m join pg_roles r on r.oid=m.member where r.rolname=current_user",
  );
  if (memberships.rowCount) throw new Error("runtime_role_membership_refused");
  const power = await pool.query<{ unsafe: boolean }>(
    `select has_database_privilege(current_user,current_database(),'CREATE') or has_database_privilege(current_user,current_database(),'TEMP') or has_schema_privilege(current_user,'public','CREATE') as unsafe`,
  );
  if (power.rows[0]?.unsafe) throw new Error("runtime_ddl_or_temp_refused");
  const cross = await pool.query<{ n: string }>(
    `select count(*)::text as n from pg_class c join pg_namespace n on n.oid=c.relnamespace where c.relkind in ('r','v','m','p') and n.nspname not in ('pg_catalog','information_schema','milton_auth','milton_guard','milton_credential') and n.nspname not like 'pg_%' and has_schema_privilege(current_user,n.oid,'USAGE') and (has_table_privilege(current_user,c.oid,'SELECT') or has_any_column_privilege(current_user,c.oid,'SELECT'))`,
  );
  if (cross.rows[0]?.n !== "0")
    throw new Error("auth_cross_service_storage_grant");
  const mail = await pool.query<{ unsafe: boolean }>(
    `select has_table_privilege(current_user,c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') or has_any_column_privilege(current_user,c.oid,'SELECT,INSERT,UPDATE,REFERENCES') as unsafe from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='milton_guard' and c.relname in ('mail_job','mail_delivery')`,
  );
  if (mail.rows.some((r) => r.unsafe))
    throw new Error("direct_mail_storage_grant");
  // Check effective rights, including views and SECURITY DEFINER functions in
  // retained managed auth and app-only credential schemas. Run as the real auth role.
  const exposed = await pool.query<{ n: string }>(
    `select count(*)::text as n from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname in ('neon_auth','milton_app_auth','milton_app') and c.relkind in ('r','v','m','p') and has_schema_privilege(current_user,n.oid,'USAGE') and has_table_privilege(current_user,c.oid,'SELECT')`,
  );
  if (exposed.rows[0]?.n !== "0")
    throw new Error("cross_service_retained_or_app_storage");
  const functions = await pool.query<{ n: string }>(
    `select count(*)::text as n from pg_proc p join pg_namespace n on n.oid=p.pronamespace where p.prosecdef and n.nspname in ('public','neon_auth','milton_app_auth') and has_schema_privilege(current_user,n.oid,'USAGE') and has_function_privilege(current_user,p.oid,'EXECUTE')`,
  );
  if (functions.rows[0]?.n !== "0")
    throw new Error("cross_service_definer_function");
}
