import { sql } from "drizzle-orm";
import { loadEnvironment } from "../src/environment";
import { neonDatabase } from "../src/store/database";
import type { StoreDatabase } from "../src/store/database";
import { verifyDatabaseTarget } from "./database-config";

export async function configureMemoUpdatePolicy(
  db: StoreDatabase,
  options: { dailyLimit?: number | null } = {},
) {
  const limit = options.dailyLimit ?? null;
  await db.query(sql`UPDATE store_config SET
    memo_updates_daily_limit=coalesce(${limit}::int,memo_updates_daily_limit) WHERE singleton=1`);
}

const usage = `Usage:
  bun --no-env-file scripts/memo-updates.ts policy --daily-limit COUNT
  bun --no-env-file scripts/memo-updates.ts enable | disable

Uses explicit DATABASE_URL, or a dotenvx payload file in MILTON_ENCRYPTED_ENV_FILE
with DOTENV_PRIVATE_KEY. policy sets the daily memo-update limit. It does
not enable memo updates, trials or model work.
enable is a separate prospective rollout step. disable retains existing holds and charges;
drain mutating traffic/holds before compatible runtime rollback. No command
changes instructions or calls a model.`;

export async function memoUpdatesCommand(
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
) {
  if (args.length === 1 && args[0] === "--help") {
    console.log(usage);
    return;
  }
  const [operation, ...rest] = args;
  if (!operation || !["policy", "enable", "disable"].includes(operation))
    throw new Error();
  let limit: number | null = null;
  const seen = new Set<string>();
  for (let i = 0; i < rest.length; i++) {
    const key = rest[i]!;
    if (operation !== "policy" || seen.has(key)) throw new Error();
    seen.add(key);
    if (key === "--daily-limit") {
      const raw = rest[++i] ?? "";
      if (!/^[1-9]\d{0,9}$/.test(raw) || Number(raw) > 2147483647)
        throw new Error();
      limit = Number(raw);
    } else throw new Error();
  }
  if (operation === "policy" && limit === null) throw new Error();
  const resolved = loadEnvironment(env);
  if (!resolved.DATABASE_URL) throw new Error();
  const db = neonDatabase(resolved.DATABASE_URL);
  await verifyDatabaseTarget(db);
  if (operation === "policy")
    await configureMemoUpdatePolicy(db, { dailyLimit: limit });
  else
    await db.query(
      sql`UPDATE store_config SET memo_updates_enabled=${operation === "enable"} WHERE singleton=1`,
    );
  console.log(
    "Memo-update policy changed. No model request or instruction change was performed.",
  );
}
if (import.meta.main)
  memoUpdatesCommand(process.argv.slice(2)).catch(() => {
    console.error(
      "Memo-update configuration failed. Check the explicit operation, database and schema.",
    );
    process.exitCode = 1;
  });
