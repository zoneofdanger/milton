import { sql } from "drizzle-orm";
import { loadEnvironment } from "./environment";
import { neonDatabase } from "./store/database";
import { anthropicGuideProvider } from "./guides/provider";
import { runGuideWorker } from "./guides/worker";

// Separate finite job, never started by app/MCP requests. Its secret payload must
// contain only the scoped guide DB URL and provider key, never auth/signing keys.
try {
  const env = loadEnvironment();
  if (!env.GUIDE_DATABASE_URL || !env.ANTHROPIC_API_KEY)
    throw new Error("configuration");
  const db = neonDatabase(env.GUIDE_DATABASE_URL);
  const [role] = await db.query<{ allowed: boolean }>(sql`SELECT
    pg_has_role(current_user,'milton_guide_worker','USAGE')
    AND NOT pg_has_role(current_user,'milton_runtime','USAGE')
    AND NOT (rolsuper OR rolcreaterole OR rolcreatedb OR rolbypassrls OR rolreplication) AS allowed
    FROM pg_roles WHERE rolname=current_user`);
  if (!role?.allowed) throw new Error("configuration");
  const processed = await runGuideWorker(
    db,
    anthropicGuideProvider(env.ANTHROPIC_API_KEY, env.GUIDE_MODEL),
  );
  console.info(JSON.stringify({ event: "guide_worker_completed", processed }));
} catch {
  console.error(JSON.stringify({ event: "guide_worker_failed" }));
  process.exitCode = 1;
}
