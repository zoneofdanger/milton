import { neonDatabase } from "./store/database";
import type { StoreDatabase } from "./store/database";
import { runSpendAlertEmails } from "./store/spend-alert-email";
import {
  configuredAlertThresholds,
  observeSpendAlerts,
} from "./store/spend-alerts";

type Step = "spend_alerts" | "spend_alert_email";
type Tick = { status: string; step?: Step };
type Log = (event: { event: string; step: Step; error: string }) => void;
const defaultLog: Log = (event) => console.error(JSON.stringify(event));

// The worker observes spend alerts, then delivers their emails. A healthy tick
// replies "disabled", the status the scheduler has always received from a
// worker without model work. Any failed step replies "failed" (503) and names
// the first failed step, so a database outage or a failed delivery stays
// visible to the scheduler. The log carries the step and the error class only:
// never a message, address or payload.
export async function runSpendAlertTick(
  env: NodeJS.ProcessEnv,
  database?: StoreDatabase,
  log: Log = defaultLog,
): Promise<Tick> {
  if (!database && !env.DATABASE_URL)
    throw new Error("Database is not configured");
  const db = database ?? neonDatabase(env.DATABASE_URL!);
  let step: Step | undefined;
  const fail = (failed: Step, error: string) => {
    step ??= failed;
    try {
      log({ event: "spend_alert_tick_failed", step: failed, error });
    } catch {
      /* Logging cannot block work. */
    }
  };
  const errorClass = (error: unknown) =>
    error instanceof Error ? error.name : typeof error;
  try {
    await observeSpendAlerts(
      db,
      configuredAlertThresholds(env.MILTON_SPEND_ALERT_THRESHOLDS_USD),
    );
  } catch (error) {
    fail("spend_alerts", errorClass(error));
  }
  // Publication has committed (or failed) before external delivery. Drain
  // prior published events even when this observation cycle failed.
  try {
    const email = await runSpendAlertEmails(db, env);
    // The email step logs its own delivery code before reporting "failed".
    if (email.status === "failed") fail("spend_alert_email", "failed_status");
  } catch (error) {
    fail("spend_alert_email", errorClass(error));
  }
  return step ? { status: "failed", step } : { status: "disabled" };
}

export const spendAlertReply = (status: string, code = 200, step?: Step) =>
  Response.json(step ? { status, step } : { status }, {
    status: code,
    headers: { "Cache-Control": "no-store" },
  });

export async function runSpendAlertRequest(run: () => Promise<Tick>) {
  try {
    // Request input cannot steer the worker; only the database supplies work.
    const result = await run();
    return spendAlertReply(
      result.status,
      ["failed", "lost_lease"].includes(result.status) ? 503 : 200,
      result.step,
    );
  } catch {
    return spendAlertReply("unavailable", 503);
  }
}

// This adapter is deployed ONLY on the private, IAM-authenticated worker service.
// Google verifies Scheduler's OIDC token before a request reaches the container.
export function createSpendAlertHandler(
  env: NodeJS.ProcessEnv,
  run: () => Promise<Tick> = () => runSpendAlertTick(env),
) {
  return async (request: Request): Promise<Response> => {
    if (new URL(request.url).pathname !== "/api/garden")
      return spendAlertReply("not_found", 404);
    if (request.method !== "GET")
      return spendAlertReply("method_not_allowed", 405);
    return runSpendAlertRequest(run);
  };
}
