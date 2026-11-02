import { randomBytes, createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, realpath, stat } from "node:fs/promises";
import { isAbsolute, dirname, basename, join } from "node:path";
import { sql } from "drizzle-orm";
import type { StoreDatabase } from "../src/store/database";
import { neonDatabase } from "../src/store/database";
import { loadEnvironment } from "../src/environment";
import { spendAlertsPrefix } from "../src/operator-alerts";
import { verifyDatabaseTarget } from "./database-config";

export async function rotateSpendFeed(
  db: StoreDatabase,
  origin: string,
  output: string,
) {
  const app = new URL(origin);
  if (
    !isAbsolute(output) ||
    app.origin !== origin ||
    app.username ||
    app.password ||
    (app.protocol !== "https:" &&
      !(
        app.protocol === "http:" &&
        ["127.0.0.1", "localhost", "[::1]"].includes(app.hostname)
      ))
  )
    throw new Error("Invalid protected output or origin.");
  const parent = await realpath(dirname(output));
  const directory = await stat(parent);
  if (
    !directory.isDirectory() ||
    directory.uid !== process.getuid?.() ||
    (directory.mode & 0o077) !== 0
  )
    throw new Error("Output directory must be owned and private.");
  const token = randomBytes(32).toString("base64url");
  const hash = createHash("sha256").update(token, "ascii").digest("hex");
  const file = await open(
    join(parent, basename(output)),
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await file.chmod(0o600);
    await file.writeFile(
      origin + spendAlertsPrefix + token + ".json\n",
      "utf8",
    );
    await file.sync();
  } finally {
    await file.close();
  }
  // The protected file exists before activation. Keep it even if the commit
  // acknowledgment is lost: deleting it could discard the only active key copy.
  await db.transaction(async (tx) => {
    await tx.query(
      sql`SELECT singleton FROM store_config WHERE singleton=1 FOR UPDATE`,
    );
    await tx.query(
      sql`UPDATE store_config SET spend_feed_key_hash=${hash} WHERE singleton=1`,
    );
  });
}
export async function revokeSpendFeed(db: StoreDatabase) {
  await db.transaction(async (tx) => {
    await tx.query(
      sql`SELECT singleton FROM store_config WHERE singleton=1 FOR UPDATE`,
    );
    await tx.query(
      sql`UPDATE store_config SET spend_feed_key_hash=NULL WHERE singleton=1`,
    );
  });
}
const usage = `Usage:
  bun --no-env-file scripts/spend-feed.ts rotate --logging-verified --output ABSOLUTE_PRIVATE_FILE
  bun --no-env-file scripts/spend-feed.ts revoke

Operator CLI only: uses explicit protected DATABASE_URL/dotenvx and verifies the
milton owner connection. No public write route or key argument. rotate requires
Lead's completed all-platform request-log protection before --logging-verified;
this flag is an attestation, not automatic proof. It writes a new 0600 URL file in
an owned private directory, never overwriting a file or printing the credential.
APP_ORIGIN must be the canonical HTTPS app origin (loopback HTTP is for local
fictional tests only). A failed/unknown rotation leaves the protected file for
recovery. Revoke clears the current hash immediately for subsequent admissions.
No memo, model, trial, account or alert publication change is performed.`;
export async function spendFeedCommand(
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
) {
  if (args.length === 1 && args[0] === "--help") {
    console.log(usage);
    return;
  }
  const [operation, ...rest] = args;
  let output: string | undefined;
  if (operation === "rotate") {
    if (
      rest.length !== 3 ||
      rest[0] !== "--logging-verified" ||
      rest[1] !== "--output" ||
      !rest[2]
    )
      throw new Error();
    output = rest[2];
  } else if (operation !== "revoke" || rest.length) throw new Error();
  const resolved = loadEnvironment(env);
  if (
    !resolved.DATABASE_URL ||
    (operation === "rotate" && !resolved.APP_ORIGIN)
  )
    throw new Error();
  const db = neonDatabase(resolved.DATABASE_URL);
  await verifyDatabaseTarget(db);
  if (operation === "rotate")
    await rotateSpendFeed(db, resolved.APP_ORIGIN!, output!);
  else await revokeSpendFeed(db);
  console.log(
    operation === "rotate"
      ? "Feed key rotation confirmed; credential is in the protected output file."
      : "Feed key revoked.",
  );
}
if (import.meta.main)
  spendFeedCommand(process.argv.slice(2)).catch(() => {
    console.error(
      "Feed configuration not confirmed. Preserve any protected output file for recovery; database and credential details were not logged.",
    );
    process.exitCode = 1;
  });
