import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import type { StoreDatabase } from "./database";
import {
  alertEmail,
  emailConfiguration,
  sendAlertEmail,
  type AlertEmail,
} from "../spend-alert-email";

type Claim = { alert_id: string; envelope: AlertEmail; token: string };
type Log = (event: { event: string; alert_id?: string; code: string }) => void;
const defaultLog: Log = (event) => console.error(JSON.stringify(event));

/** One bounded delivery per scheduled cycle, independent of alert publication. */
export async function runSpendAlertEmails(
  db: StoreDatabase,
  env: NodeJS.ProcessEnv,
  request: typeof fetch = fetch,
  log: Log = defaultLog,
): Promise<{ status: string }> {
  let claim: Claim | undefined;
  const report: Log = (event) => {
    try {
      log(event);
    } catch {
      /* Logging cannot block work. */
    }
  };
  try {
    const config = emailConfiguration(env);
    if (!config) return { status: "disabled" };
    claim = await db.transaction(async (tx) => {
      await tx.query(
        sql`SELECT set_config('lock_timeout','250ms',true),set_config('statement_timeout','1000ms',true)`,
      );
      // Reconcile from durable published events after publication commits. An
      // email outage never rolls back or suppresses the original alert.
      const alerts = await tx.query<{
        id: string;
        total: string;
        threshold: string;
        timestamp: string;
      }>(sql`
        SELECT a.id,(a.filing_micros::numeric+a.review_micros+a.derived_micros)::text AS total,
          a.threshold_micros::text AS threshold,
          to_char(a.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS timestamp
        FROM spend_alerts a LEFT JOIN spend_alert_emails e ON e.alert_id=a.id
        WHERE a.status='published' AND e.alert_id IS NULL
          AND a.day_utc BETWEEN (clock_timestamp() AT TIME ZONE 'UTC')::date-30 AND (clock_timestamp() AT TIME ZONE 'UTC')::date
        ORDER BY a.published_at,a.id LIMIT 16`);
      for (const alert of alerts) {
        const envelope = alertEmail(config, alert);
        await tx.query(sql`INSERT INTO spend_alert_emails(alert_id,envelope)
          VALUES (${alert.id},${JSON.stringify(envelope)}::jsonb) ON CONFLICT(alert_id) DO NOTHING`);
      }
      // Resend retains keys for 24h. Stop conservatively at 23h, including
      // ambiguous successes. Keep the ledger forever; never mint a replacement key.
      const expired = await tx.query<{
        alert_id: string;
      }>(sql`UPDATE spend_alert_emails
        SET status='unknown',last_error='retry_window_expired',token=NULL,lease_until=NULL
        WHERE status='pending' AND first_attempt_at<=clock_timestamp()-interval '23 hours'
        AND (lease_until IS NULL OR lease_until<clock_timestamp()) RETURNING alert_id`);
      for (const row of expired)
        report({
          event: "spend_alert_email_failed",
          alert_id: row.alert_id,
          code: "retry_window_expired",
        });
      const rows = await tx.query<{
        alert_id: string;
        envelope: AlertEmail;
      }>(sql`
        SELECT alert_id,envelope FROM spend_alert_emails
        WHERE status='pending' AND next_attempt_at<=clock_timestamp()
          AND (lease_until IS NULL OR lease_until<clock_timestamp())
          AND (first_attempt_at IS NULL OR first_attempt_at>clock_timestamp()-interval '23 hours')
        ORDER BY next_attempt_at,alert_id LIMIT 1 FOR UPDATE SKIP LOCKED`);
      const row = rows[0];
      if (!row) return undefined;
      const token = randomUUID();
      await tx.query(sql`UPDATE spend_alert_emails SET token=${token},
        lease_until=clock_timestamp()+interval '60 seconds',
        first_attempt_at=coalesce(first_attempt_at,clock_timestamp()),attempts=attempts+1
        WHERE alert_id=${row.alert_id}`);
      return { ...row, token };
    });
    if (!claim) return { status: "idle" };
    // Confirm the committed claim immediately before dispatch. No network lock;
    // reserve a 10s margin inside both the lease and the provider retry window.
    const eligible = await db.query(sql`SELECT alert_id FROM spend_alert_emails
      WHERE alert_id=${claim.alert_id} AND token=${claim.token} AND status='pending'
      AND lease_until>clock_timestamp()+interval '10 seconds'
      AND first_attempt_at>clock_timestamp()-interval '23 hours'+interval '10 seconds'`);
    if (!eligible.length) return { status: "deferred" };
    const result = await sendAlertEmail(
      config.key,
      claim.alert_id,
      claim.envelope,
      AbortSignal.timeout(5000),
      request,
    );
    const status = result.status === "retry" ? "pending" : result.status;
    const code = result.status === "sent" ? null : result.code;
    const completed =
      await db.query(sql`UPDATE spend_alert_emails SET status=${status},
      provider_id=${result.status === "sent" ? result.providerId : null},last_error=${code},
      sent_at=${result.status === "sent" ? sql`clock_timestamp()` : sql`NULL`},
      token=NULL,lease_until=NULL,next_attempt_at=clock_timestamp()+interval '5 minutes'
      WHERE alert_id=${claim.alert_id} AND token=${claim.token} AND status='pending' RETURNING alert_id`);
    if (!completed.length) return { status: "deferred" };
    if (code)
      report({
        event: "spend_alert_email_failed",
        alert_id: claim.alert_id,
        code,
      });
    return { status: result.status };
  } catch {
    report({
      event: "spend_alert_email_failed",
      ...(claim ? { alert_id: claim.alert_id } : {}),
      code: "delivery_unavailable",
    });
    return { status: "failed" };
  }
}
