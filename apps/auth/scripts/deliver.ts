import pg from "pg";
import { databaseOptions } from "../src/database.ts";
import { readConfig, safeError } from "../src/config.ts";
import { loadEnvironment } from "../src/environment.ts";
import { checkRuntimeRole } from "../src/roles.ts";
import { deliverMail } from "../src/mail.ts";
import { passLine } from "../src/mail-log.ts";

if (process.argv[2] !== "--apply" || process.argv.length !== 3) {
  console.log(
    "Dry run: no database or mail operation. Explicit --apply requires auth runtime environment.",
  );
} else {
  let pool: pg.Pool | undefined;
  try {
    const config = readConfig(loadEnvironment());
    pool = new pg.Pool({
      ...databaseOptions(config.AUTH_DATABASE_URL),
      max: 1,
      connectionTimeoutMillis: 3000,
      statement_timeout: 5000,
      query_timeout: 6000,
      idleTimeoutMillis: 1000,
    });
    await checkRuntimeRole(pool, "milton_auth_runtime");
    // One JSON line per pass (Cloud Logging's jsonPayload), after the
    // pass's own line per failed or throttled send (src/mail-log.ts).
    console.log(passLine(await deliverMail(pool, config)));
  } catch (error) {
    console.error("auth_mail_pass", safeError(error));
    process.exitCode = 1;
  } finally {
    await pool?.end();
  }
}
