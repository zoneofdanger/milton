import { admissionTarget, safeError, type Config } from "./config.ts";

type Fetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;
export type AdmissionPath =
  | "/internal/auth/admit"
  | "/internal/auth/preserve-eligibility"
  | "/internal/billing/enrol-pending";
const IDENTITY =
  "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity";
// Google's ID tokens last about an hour; refresh five minutes before expiry.
const REFRESH_MS = 5 * 60_000;

/** Seconds since the epoch at which a JWT expires, or null if it is not one. */
function expiry(token: string) {
  const parts = token.split(".");
  if (parts.length !== 3 || parts.some((p) => !/^[A-Za-z0-9_-]+$/.test(p)))
    return null;
  try {
    const exp: unknown = JSON.parse(
      Buffer.from(parts[1]!, "base64url").toString("utf8"),
    ).exp;
    return typeof exp === "number" && Number.isFinite(exp) ? exp : null;
  } catch {
    return null;
  }
}

/** Auth's calls to the milton-admit service: its two admission calls, each within
 * the existing 5 s, and the maintenance job's pending-enrolment sweep (`send`,
 * with its own timeout). Only these URLs are ever fetched: the metadata server's
 * identity endpoint and the configured admission origin plus one of the paths.
 *
 * For a run.app origin (production) each call carries a Google-signed ID token
 * for that origin, fetched from the metadata server and cached until shortly
 * before it expires, in X-Serverless-Authorization. Cloud Run checks it against
 * the service's invoker policy before the request reaches the container; the
 * bearer secret in Authorization stays the service's own second check. A
 * loopback origin (local development and tests; refused in production) gets no
 * token. Answers whether the service accepted; a failed token fetch answers
 * false without calling it, exactly as a refusal does. */
export function admissionClient(
  config: Pick<Config, "AUTH_ADMISSION_URL" | "AUTH_ADMISSION_SECRET">,
  networkFetch: Fetch,
  now = Date.now,
) {
  const origin = config.AUTH_ADMISSION_URL;
  const google = admissionTarget(origin) === "cloud-run";
  let cached: { token: string; refreshAt: number } | undefined;
  async function idToken(signal: AbortSignal) {
    if (cached && now() < cached.refreshAt) return cached.token;
    const response = await networkFetch(
      `${IDENTITY}?audience=${encodeURIComponent(origin)}`,
      { headers: { "metadata-flavor": "Google" }, redirect: "error", signal },
    );
    const token = response.ok ? (await response.text()).trim() : "";
    if (!response.ok) await response.body?.cancel();
    const exp = expiry(token);
    if (exp === null || exp * 1000 <= now())
      throw new Error("admission_identity_unavailable");
    cached = { token, refreshAt: exp * 1000 - REFRESH_MS };
    return token;
  }
  /** POSTs `body` to `path` and returns the answer, or null without an
   * identity token (logged). */
  async function send(
    path: AdmissionPath,
    body: unknown,
    timeoutMs = 5000,
  ): Promise<Response | null> {
    const signal = AbortSignal.timeout(timeoutMs);
    const headers: Record<string, string> = {
      authorization: `Bearer ${config.AUTH_ADMISSION_SECRET}`,
      "content-type": "application/json",
    };
    if (google)
      try {
        headers["x-serverless-authorization"] =
          `Bearer ${await idToken(signal)}`;
      } catch (error) {
        console.error("auth_admission_identity", safeError(error));
        return null;
      }
    return networkFetch(origin + path, {
      method: "POST",
      redirect: "error",
      signal,
      headers,
      body: JSON.stringify(body),
    });
  }
  const admit = async (
    path: AdmissionPath,
    body: unknown,
  ): Promise<boolean> => {
    const response = await send(path, body);
    if (!response) return false;
    await response.body?.cancel();
    return response.ok;
  };
  return Object.assign(admit, { send });
}
