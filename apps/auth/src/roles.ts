import type pg from "pg";
export async function checkRuntimeRole(
  pool: pg.Pool,
  expected: "milton_auth_runtime" | "milton_app_runtime" | "milton_mcp_runtime",
) {
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
    r.rolname !== expected ||
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
  if (expected === "milton_auth_runtime") {
    const cross = await pool.query<{ n: string }>(
      `select count(*)::text as n from pg_class c join pg_namespace n on n.oid=c.relnamespace where c.relkind in ('r','v','m','p') and n.nspname not in ('pg_catalog','information_schema','milton_auth','milton_guard','milton_credential') and n.nspname not like 'pg_%' and has_schema_privilege(current_user,n.oid,'USAGE') and (has_table_privilege(current_user,c.oid,'SELECT') or has_any_column_privilege(current_user,c.oid,'SELECT'))`,
    );
    if (cross.rows[0]?.n !== "0")
      throw new Error("auth_cross_service_storage_grant");
  }
  if (expected !== "milton_auth_runtime") {
    for (const table of [
      "user",
      "account",
      "session",
      "verification",
      "jwks",
      "oauthClient",
      "oauthRefreshToken",
      "oauthAccessToken",
    ]) {
      const access = await pool.query<{ unsafe: boolean }>(
        `select has_table_privilege(current_user,c.oid,'SELECT') or has_any_column_privilege(current_user,c.oid,'SELECT') as unsafe from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='milton_auth' and c.relname=$1`,
        [table],
      );
      if (access.rows[0]?.unsafe)
        throw new Error("cross_service_native_storage_grant");
    }
  }
  const mail = await pool.query<{ unsafe: boolean }>(
    `select has_table_privilege(current_user,c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') or has_any_column_privilege(current_user,c.oid,'SELECT,INSERT,UPDATE,REFERENCES') as unsafe from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='milton_guard' and c.relname in ('mail_job','mail_delivery')`,
  );
  if (mail.rows.some((r) => r.unsafe))
    throw new Error("direct_mail_storage_grant");
  // Check effective rights, including views and SECURITY DEFINER functions in
  // retained managed auth and app-only credential schemas. Run as each real role.
  const exposed = await pool.query<{ n: string }>(
    `select count(*)::text as n from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname in ('neon_auth','milton_app_auth','milton_app') and c.relkind in ('r','v','m','p') and has_schema_privilege(current_user,n.oid,'USAGE') and has_table_privilege(current_user,c.oid,'SELECT') and ($1<>'milton_app_runtime' or n.nspname not in ('milton_app_auth','milton_app'))`,
    [expected],
  );
  if (exposed.rows[0]?.n !== "0")
    throw new Error("cross_service_retained_or_app_storage");
  const functions = await pool.query<{ n: string }>(
    `select count(*)::text as n from pg_proc p join pg_namespace n on n.oid=p.pronamespace where p.prosecdef and n.nspname in ('public','neon_auth','milton_app_auth') and has_schema_privilege(current_user,n.oid,'USAGE') and has_function_privilege(current_user,p.oid,'EXECUTE') and ($1<>'milton_app_runtime' or n.nspname not in ('milton_app_auth','milton_app'))`,
    [expected],
  );
  if (functions.rows[0]?.n !== "0")
    throw new Error("cross_service_definer_function");
}
