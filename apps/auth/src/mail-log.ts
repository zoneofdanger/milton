/** The delivery job's log lines, one JSON object each, which Cloud Logging
 * stores as jsonPayload. Counts and outcomes only: no recipient, link or
 * message. No imports, so the monitoring test reads the same shapes. */
export type PassCounts = {
  claimed: number;
  sent: number;
  retry: number;
  failed: number;
  throttled: number;
};

/** One line per delivery pass. */
export const passLine = (counts: PassCounts) =>
  JSON.stringify({ message: "auth_mail_pass", ...counts });

/** One line per send that ended failed or throttled; the log metric
 * milton-auth-mail-problems counts these for the milton-auth-mail page. */
export const problemLine = (outcome: "failed" | "throttled") =>
  JSON.stringify({ message: "auth_mail_send", outcome });
