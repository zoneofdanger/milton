import { databaseOptions } from "../src/database.ts";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import pg from "pg";
import { createProvider } from "../src/provider.ts";
import {
  readConfig,
  safeError,
  APP_ORIGIN,
  type Config,
} from "../src/config.ts";

// Owner-only preparation. Native anonymous registration creates/hashes a secret;
// the owner then promotes exactly this one client. No temporary human account.
export async function provisionFixedApp(pool: pg.Pool, config: Config) {
  const role = await pool.query<{ current_user: string }>(
    "select current_user",
  );
  if (role.rows[0]?.current_user !== "milton_auth_owner")
    throw new Error("migration_owner_required");
  const existing = await pool.query(
    "select client_id from milton_guard.first_party_policy",
  );
  if (existing.rowCount) throw new Error("fixed_app_already_provisioned");
  const auth = createProvider(config, { pool, owner: true });
  const client = await auth.provider.api.registerOAuthClient({
    body: {
      client_name: "Milton app",
      redirect_uris: [APP_ORIGIN + "/auth/callback"],
      token_endpoint_auth_method: "client_secret_post",
      scope: "openid profile email",
      grant_types: ["authorization_code"],
      response_types: ["code"],
    },
  });
  if (!client.client_id || !client.client_secret)
    throw new Error("native_client_provision_failed");
  const connection = await pool.connect();
  try {
    await connection.query("begin");
    await connection.query(
      "lock table milton_guard.first_party_policy in exclusive mode",
    );
    const check = await connection.query(
      "select client_id from milton_guard.first_party_policy",
    );
    if (check.rowCount) throw new Error("concurrent_app_provision_refused");
    await connection.query(
      `update milton_auth."oauthClient" set "userId"=null,"skipConsent"=true,"enableEndSession"=true,"requirePKCE"=true,"postLogoutRedirectUris"=$2,"dpopBoundAccessTokens"=false where "clientId"=$1`,
      [client.client_id, JSON.stringify([APP_ORIGIN + "/auth/logged-out"])],
    );
    await connection.query(
      'delete from milton_auth."oauthClientResource" where "clientId"=$1',
      [client.client_id],
    );
    await connection.query(
      "insert into milton_guard.first_party_policy(client_id) values($1)",
      [client.client_id],
    );
    await connection.query("commit");
  } catch (error) {
    await connection.query("rollback");
    throw error;
  } finally {
    connection.release();
  }
  return {
    AUTH_APP_CLIENT_ID: client.client_id,
    AUTH_APP_CLIENT_SECRET: client.client_secret,
  };
}
if (import.meta.main) {
  if (
    process.argv[2] !== "--apply" ||
    !process.argv[3] ||
    !process.env.AUTH_OWNER_DATABASE_URL
  )
    throw new Error("explicit_owner_apply_and_private_output_required");
  const output = resolve(process.argv[3]);
  if (
    output.startsWith(
      resolve(new URL("../../../", import.meta.url).pathname) + "/",
    )
  )
    throw new Error("secret_output_must_be_outside_repository");
  const pool = new pg.Pool({
    ...databaseOptions(process.env.AUTH_OWNER_DATABASE_URL),
    max: 1,
    statement_timeout: 10000,
  });
  try {
    const client = await provisionFixedApp(pool, readConfig(process.env));
    writeFileSync(output, JSON.stringify(client) + "\n", {
      mode: 0o600,
      flag: "wx",
    });
    console.log("Native fixed client written to private owner output.");
  } catch (error) {
    console.error("auth_provision", safeError(error));
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}
