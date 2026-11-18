import { databaseOptions } from "../src/database.ts";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  realpathSync,
  unlinkSync,
  writeSync,
  type Stats,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import pg from "pg";
import { createProvider } from "../src/provider.ts";
import {
  readConfig,
  safeError,
  APP_ORIGIN,
  type Config,
} from "../src/config.ts";
import { refusal } from "../src/refusal.ts";

/** The one directory the app secret may be written to: MILTON_OWNER_OUTPUT_DIR,
 * or ~/keys. An allowlist, not a list of places to avoid (milton-duo, PR #161). */
export const ownerOutputDir = (env: NodeJS.ProcessEnv) =>
  resolve(env.MILTON_OWNER_OUTPUT_DIR || join(homedir(), "keys"));

export type Reservation = { fd: number; path: string; ino: number };

/** Creates the empty output file before any database work, or refuses. The
 * output must be a plain file name directly inside `dir`, which must be a real
 * directory (not a symlink) owned by `uid` with no group or other permission
 * bits. The file is created new (O_EXCL, O_NOFOLLOW, mode 0600) at the
 * directory's real path, then checked through its descriptor: a regular file
 * with one link, on the directory's device, still the entry at that path. */
export function reserveOutput(
  given: string,
  dir: string,
  uid = process.getuid!(),
): Reservation {
  let checked: Stats;
  try {
    checked = lstatSync(dir);
  } catch {
    throw unsafeDir();
  }
  if (
    !checked.isDirectory() ||
    checked.uid !== uid ||
    (checked.mode & 0o077) !== 0
  )
    throw unsafeDir();
  const allowed = realpathSync.native(dir);
  const target = resolve(given);
  const name = basename(target);
  let parent: string | undefined;
  try {
    parent = realpathSync.native(dirname(target));
  } catch {}
  if (!name || parent !== allowed)
    throw refusal("OUTPUT_PATH_NOT_ALLOWED", "owner_output_path_not_allowed");
  const path = join(allowed, name);
  let fd: number;
  try {
    fd = openSync(
      path,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
  } catch (error) {
    if (["EEXIST", "ELOOP"].includes((error as { code?: string }).code ?? ""))
      throw refusal("OUTPUT_EXISTS", "owner_output_exists");
    throw error;
  }
  const file = fstatSync(fd);
  const reservation = { fd, path, ino: file.ino };
  const now = lstatSync(allowed);
  if (
    !file.isFile() ||
    file.nlink !== 1 ||
    (file.mode & 0o077) !== 0 ||
    file.dev !== checked.dev ||
    now.dev !== checked.dev ||
    now.ino !== checked.ino ||
    lstatSync(path).ino !== file.ino
  ) {
    releaseOutput(reservation);
    throw refusal(
      "OUTPUT_RESERVATION_CHANGED",
      "owner_output_reservation_changed",
    );
  }
  return reservation;
}
const unsafeDir = () =>
  refusal(
    "OUTPUT_DIR_UNSAFE",
    "owner_output_dir_unsafe: make it a real directory you own and chmod 700 it",
  );

/** Closes the reservation and removes it if it is still the file created. */
export function releaseOutput(reservation: Reservation) {
  try {
    closeSync(reservation.fd);
  } catch {}
  try {
    if (lstatSync(reservation.path).ino === reservation.ino)
      unlinkSync(reservation.path);
  } catch {}
}

// Owner-only preparation. Native anonymous registration creates/hashes a secret;
// the owner then promotes exactly this one client. No temporary human account.
export async function provisionFixedApp(pool: pg.Pool, config: Config) {
  const role = await pool.query<{ current_user: string }>(
    "select current_user",
  );
  if (role.rows[0]?.current_user !== "milton_auth_owner")
    throw refusal("OWNER_ROLE_REQUIRED", "migration_owner_required");
  const existing = await pool.query(
    "select client_id from milton_guard.first_party_policy",
  );
  if (existing.rowCount)
    throw refusal("APP_ALREADY_PROVISIONED", "fixed_app_already_provisioned");
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
    throw refusal("APP_CLIENT_NOT_ISSUED", "native_client_provision_failed");
  const connection = await pool.connect();
  try {
    await connection.query("begin");
    await connection.query(
      "lock table milton_guard.first_party_policy in exclusive mode",
    );
    const check = await connection.query(
      "select client_id from milton_guard.first_party_policy",
    );
    if (check.rowCount)
      throw refusal(
        "APP_PROVISION_CONCURRENT",
        "concurrent_app_provision_refused",
      );
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
  // Every refusal prints its code through safeError (docs/accounts.md).
  let pool: pg.Pool | undefined;
  let output: Reservation | undefined;
  let writing = false;
  try {
    if (
      process.argv[2] !== "--apply" ||
      !process.argv[3] ||
      !process.env.AUTH_OWNER_DATABASE_URL
    )
      throw refusal(
        "APPLY_ARGS_REQUIRED",
        "explicit_owner_apply_and_private_output_required",
      );
    // Reserved before any database work, so a refusal here costs no client
    // and a client is never created without somewhere to put its secret.
    output = reserveOutput(process.argv[3], ownerOutputDir(process.env));
    pool = new pg.Pool({
      ...databaseOptions(process.env.AUTH_OWNER_DATABASE_URL),
      max: 1,
      statement_timeout: 10000,
    });
    const client = await provisionFixedApp(pool, readConfig(process.env));
    // From here the client exists: keep the file whatever happens.
    writing = true;
    const bytes = Buffer.from(JSON.stringify(client) + "\n");
    for (let at = 0; at < bytes.length;) at += writeSync(output.fd, bytes, at);
    fsyncSync(output.fd);
    closeSync(output.fd);
    output = undefined;
    console.log("Native fixed client written to private owner output.");
  } catch (error) {
    if (output && !writing) releaseOutput(output);
    else if (output)
      try {
        closeSync(output.fd);
      } catch {}
    console.error("auth_provision", safeError(error));
    process.exitCode = 1;
  } finally {
    await pool?.end();
  }
}
