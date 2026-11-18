import { databaseOptions } from "../src/database.ts";
import * as nodeFs from "node:fs";
import { constants, type Stats } from "node:fs";
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
import { refusal, type RefusalCode } from "../src/refusal.ts";

/** The one directory the app secret may be written to: MILTON_OWNER_OUTPUT_DIR,
 * or ~/keys. An allowlist, not a list of places to avoid (milton-duo, PR #161). */
export const ownerOutputDir = (env: NodeJS.ProcessEnv) =>
  resolve(env.MILTON_OWNER_OUTPUT_DIR || join(homedir(), "keys"));

/** The file calls provision makes on its output; tests inject failures. It has
 * no way to remove or truncate a file: provision never does (milton-duo,
 * PR #161), so no cleanup can reach the wrong file. */
export type OutputFs = Pick<
  typeof nodeFs,
  | "lstatSync"
  | "realpathSync"
  | "openSync"
  | "fstatSync"
  | "writeSync"
  | "fsyncSync"
  | "closeSync"
>;

export type AllowedOutput = { path: string; dir: Stats; allowed: string };

/** Refuses, creating nothing, unless `given` is a plain file name directly
 * inside `dir`, a real directory (not a symlink) owned by `uid` with no group
 * or other permission bits, by real path (so a case alias or a symlinked
 * parent of `dir` is `dir` itself). */
export function allowOutput(
  given: string,
  dir: string,
  uid = process.getuid!(),
  fs: OutputFs = nodeFs,
): AllowedOutput {
  let checked: Stats;
  try {
    checked = fs.lstatSync(dir);
  } catch {
    throw unsafeDir();
  }
  if (
    !checked.isDirectory() ||
    checked.uid !== uid ||
    (checked.mode & 0o077) !== 0
  )
    throw unsafeDir();
  const allowed = fs.realpathSync.native(dir);
  const target = resolve(given);
  const name = basename(target);
  let parent: string | undefined;
  try {
    parent = fs.realpathSync.native(dirname(target));
  } catch {}
  if (!name || parent !== allowed)
    throw refusal("OUTPUT_PATH_NOT_ALLOWED", "owner_output_path_not_allowed");
  return { path: join(allowed, name), dir: checked, allowed };
}
const unsafeDir = () =>
  refusal(
    "OUTPUT_DIR_UNSAFE",
    "owner_output_dir_unsafe: make it a real directory you own and chmod 700 it",
  );

/** Creates the output new (O_EXCL, O_NOFOLLOW, mode 0600) and returns its
 * descriptor, or refuses with nothing created. */
export function openOutput(output: AllowedOutput, fs: OutputFs = nodeFs) {
  try {
    return fs.openSync(
      output.path,
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
}

export type Provisioned =
  | {
      ok: true;
      client: { AUTH_APP_CLIENT_ID: string; AUTH_APP_CLIENT_SECRET: string };
    }
  | {
      ok: false;
      error: unknown;
      /** OUTPUT_RESERVATION_LEFT: the app was not provisioned; the file is
       * left as it is. OUTPUT_HOLDS_SECRET: the secret is synced to the file
       * and the commit's outcome is unknown. */
      left: Extract<
        RefusalCode,
        "OUTPUT_RESERVATION_LEFT" | "OUTPUT_HOLDS_SECRET"
      >;
    };

/** Provisions the app into an output `openOutput` created. Every file call
 * after the open is inside this one handler, and the file is never removed
 * or truncated. The secret is written and synced, and the file closed,
 * inside the promotion's transaction before its COMMIT: a failure before then
 * rolls the promotion back (Better Auth's own registration row stays, an
 * unpromoted anonymous client like any public registration), and a failure at
 * COMMIT leaves the secret on disk. */
export async function provisionToOutput(
  output: AllowedOutput,
  fd: number,
  pool: pg.Pool,
  config: Config,
  fs: OutputFs = nodeFs,
): Promise<Provisioned> {
  let closed = false;
  let synced = false;
  try {
    const file = fs.fstatSync(fd);
    const now = fs.lstatSync(output.allowed);
    if (
      !file.isFile() ||
      file.nlink !== 1 ||
      (file.mode & 0o077) !== 0 ||
      file.dev !== output.dir.dev ||
      now.dev !== output.dir.dev ||
      now.ino !== output.dir.ino ||
      fs.lstatSync(output.path).ino !== file.ino
    )
      throw refusal(
        "OUTPUT_RESERVATION_CHANGED",
        "owner_output_reservation_changed",
      );
    const client = await provisionFixedApp(pool, config, (client) => {
      const bytes = Buffer.from(JSON.stringify(client) + "\n");
      for (let at = 0; at < bytes.length;) at += fs.writeSync(fd, bytes, at);
      fs.fsyncSync(fd);
      closed = true;
      fs.closeSync(fd);
      synced = true;
    });
    return { ok: true, client };
  } catch (error) {
    if (!closed)
      try {
        closed = true;
        fs.closeSync(fd);
      } catch {}
    return {
      ok: false,
      error,
      left: synced ? "OUTPUT_HOLDS_SECRET" : "OUTPUT_RESERVATION_LEFT",
    };
  }
}

// Owner-only preparation. Native anonymous registration creates/hashes a secret;
// the owner then promotes exactly this one client. No temporary human account.
// `beforeCommit` runs inside the promotion's transaction, before its COMMIT.
export async function provisionFixedApp(
  pool: pg.Pool,
  config: Config,
  beforeCommit?: (client: {
    AUTH_APP_CLIENT_ID: string;
    AUTH_APP_CLIENT_SECRET: string;
  }) => void,
) {
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
    beforeCommit?.({
      AUTH_APP_CLIENT_ID: client.client_id,
      AUTH_APP_CLIENT_SECRET: client.client_secret,
    });
    await connection.query("commit");
  } catch (error) {
    await connection.query("rollback").catch(() => {});
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
  // Every refusal prints its code through safeError (docs/accounts.md). The
  // checks that need no database or file come first; the output is created
  // only after them, and before any database work.
  let pool: pg.Pool | undefined;
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
    const output = allowOutput(process.argv[3], ownerOutputDir(process.env));
    pool = new pg.Pool({
      ...databaseOptions(process.env.AUTH_OWNER_DATABASE_URL),
      max: 1,
      statement_timeout: 10000,
    });
    const config = readConfig(process.env);
    const result = await provisionToOutput(
      output,
      openOutput(output),
      pool,
      config,
    );
    if (result.ok)
      console.log("Native fixed client written to private owner output.");
    else {
      console.error("auth_provision", safeError(result.error));
      console.error(
        "auth_provision",
        safeError(refusal(result.left, "owner_output_left")),
      );
      process.exitCode = 1;
    }
  } catch (error) {
    console.error("auth_provision", safeError(error));
    process.exitCode = 1;
  } finally {
    await pool?.end();
  }
}
