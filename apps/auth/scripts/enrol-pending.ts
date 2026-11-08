import { admissionClient } from "../src/admission.ts";
import { admissionTarget, safeError } from "../src/config.ts";

type Fetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;
// milton-admit gives up starting another account after 5 s, and one account can
// take about 20 s more (four Stripe calls at 5 s); its own timeout is 30 s.
const SWEEP_TIMEOUT_MS = 28_000;
const counts = (value: unknown) => {
  const c = value as Record<string, unknown> | null;
  return c &&
    ["attempted", "enrolled", "failed", "remaining"].every((k) =>
      Number.isInteger(c[k]),
    )
    ? c
    : null;
};

/** The maintenance job's last step: asks milton-admit to enrol accounts left
 * without a trial (a stalled or failed background enrolment after sign-in), with
 * the same identity token and bearer as admission. Skipped, and logged, without
 * AUTH_ADMISSION_URL. Answers "failed" only when the call itself failed; the
 * caller sets the exit code after its other steps. Logs counts only. */
export async function sweepPendingEnrolments(
  env: NodeJS.ProcessEnv,
  networkFetch: Fetch,
): Promise<"done" | "skipped" | "failed"> {
  const url = env.AUTH_ADMISSION_URL;
  if (!url) {
    console.log(
      "Pending enrolment sweep skipped: AUTH_ADMISSION_URL is not configured.",
    );
    return "skipped";
  }
  const secret = env.AUTH_ADMISSION_SECRET ?? "";
  const target = admissionTarget(url);
  if (
    secret.length < 32 ||
    !target ||
    (env.NODE_ENV === "production" && target !== "cloud-run")
  ) {
    console.error("auth_enrol_pending", { code: "configuration" });
    return "failed";
  }
  try {
    const response = await admissionClient(
      { AUTH_ADMISSION_URL: url, AUTH_ADMISSION_SECRET: secret },
      networkFetch,
    ).send("/internal/billing/enrol-pending", {}, SWEEP_TIMEOUT_MS);
    if (!response) return "failed";
    if (response.status === 204) {
      console.log("Pending enrolment sweep: billing is not configured.");
      return "done";
    }
    const answer = response.ok
      ? counts(await response.json().catch(() => null))
      : null;
    if (!answer) {
      await response.body?.cancel().catch(() => {});
      console.error("auth_enrol_pending", { status: response.status });
      return "failed";
    }
    console.log("Pending enrolments:", JSON.stringify(answer));
    return "done";
  } catch (error) {
    console.error("auth_enrol_pending", safeError(error));
    return "failed";
  }
}
