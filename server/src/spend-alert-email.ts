/** Only aggregate alert data enters email. Never include the capability-feed URL. */
export type AlertEmail = {
  from: string;
  to: string[];
  subject: string;
  text: string;
};

export function emailConfiguration(env: NodeJS.ProcessEnv) {
  const key = env.RESEND_API_KEY;
  const from = env.MILTON_SPEND_ALERT_EMAIL_FROM;
  const to = env.MILTON_SPEND_ALERT_EMAIL_TO;
  if (!key && !from && !to) return undefined;
  // Bare addresses only: prevent header injection and accidental recipient lists.
  const address = /^[^\s<>@,;]+@[^\s<>@,;]+\.[^\s<>@,;]+$/;
  if (
    !key ||
    /[\r\n]/.test(key) ||
    !from ||
    !to ||
    from.length > 254 ||
    to.length > 254 ||
    !address.test(from) ||
    !address.test(to)
  )
    throw new Error("email_configuration");
  return { key, from, to };
}

const dollars = (micros: string) => {
  const n = BigInt(micros);
  const fraction = (n % 1_000_000n)
    .toString()
    .padStart(6, "0")
    .replace(/0+$/, "");
  return `$${n / 1_000_000n}${fraction ? `.${fraction}` : ""}`;
};

export function alertEmail(
  config: { from: string; to: string },
  alert: { id: string; total: string; threshold: string; timestamp: string },
): AlertEmail {
  const amount = dollars(alert.total);
  const threshold = dollars(alert.threshold);
  return {
    from: config.from,
    to: [config.to],
    subject: `[Milton spend alert] Daily reserved spend: ${amount} of ${threshold} threshold`,
    text: [
      "Type: model_reservations",
      "Severity: warning",
      `Reserved amount: ${amount} USD`,
      `Alert threshold: ${threshold} USD`,
      "Account scope: Milton — all accounts",
      `Timestamp: ${alert.timestamp}`,
      `Alert ID: ${alert.id}`,
      "These are conservative model reservations, not invoices. Thresholds do not stop service.",
      "Operator dashboard: https://console.cloud.google.com/home/dashboard?project=milton-510506",
    ].join("\n"),
  };
}

export type EmailResult =
  | { status: "sent"; providerId: string }
  | { status: "retry" | "failed"; code: string };

export async function sendAlertEmail(
  key: string,
  alertId: string,
  envelope: AlertEmail,
  signal: AbortSignal,
  request: typeof fetch = fetch,
): Promise<EmailResult> {
  try {
    signal.throwIfAborted();
    const response = await request("https://api.resend.com/emails", {
      method: "POST",
      redirect: "error",
      signal,
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        "Idempotency-Key": `milton-spend-alert/${alertId}`,
      },
      body: JSON.stringify(envelope),
    });
    if (response.ok) {
      const result: unknown = await response.json();
      if (
        result &&
        typeof result === "object" &&
        "id" in result &&
        typeof result.id === "string" &&
        /^[a-zA-Z0-9_-]{1,128}$/.test(result.id)
      )
        return { status: "sent", providerId: result.id };
      return { status: "retry", code: "invalid_response" };
    }
    // 409 can mean an in-flight identical request. A mismatched envelope also
    // cannot send; retries use the immutable original and the same key.
    return {
      status:
        response.status === 429 ||
        response.status === 409 ||
        response.status >= 500
          ? "retry"
          : "failed",
      code: `http_${response.status}`,
    };
  } catch {
    // Do not log provider bodies, fetch errors, addresses, or credentials.
    return { status: "retry", code: "transport_failure" };
  }
}
