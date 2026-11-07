import { loadEnvironment } from "./environment";
import { postgresDatabase } from "./store/database";
import { guideWorkerRoleAllowed } from "./guides/store";
import { anthropicGuideProvider } from "./guides/provider";
import { runGuideWorker } from "./guides/worker";

// Separate finite job, never started by app/MCP requests. Its secret payload must
// contain only the scoped guide DB URL and provider key, never auth/signing keys.
try {
  const env = loadEnvironment();
  if (!env.GUIDE_DATABASE_URL || !env.ANTHROPIC_API_KEY)
    throw new Error("configuration");
  // Same direct verified-TLS adapter and error mapping as the app/MCP runtimes.
  const db = postgresDatabase(env.GUIDE_DATABASE_URL);
  if (!(await guideWorkerRoleAllowed(db))) throw new Error("configuration");
  const processed = await runGuideWorker(
    db,
    anthropicGuideProvider(env.ANTHROPIC_API_KEY, env.GUIDE_MODEL),
  );
  console.info(JSON.stringify({ event: "guide_worker_completed", processed }));
} catch {
  console.error(JSON.stringify({ event: "guide_worker_failed" }));
  process.exitCode = 1;
}
