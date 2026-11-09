import { randomUUID } from "node:crypto";
import {
  makeSignature,
  symmetricEncrypt,
  symmetricDecrypt,
} from "better-auth/crypto";
import { decodeJwt } from "jose";
import type pg from "pg";
import { AUTH_ORIGIN, type Config } from "./config.ts";
import type { RequestState } from "./adapter.ts";
import { reservedRecipient } from "./recipient.ts";
import { addressDomain, domainDigest, type MailDomain } from "./mail-domain.ts";

// Native getCryptoKey (used by makeSignature) imports an HMAC signing key.
// Symmetric utilities instead accept a versioned SecretConfig. No bare-hex fallback.
async function key(secret: string) {
  return {
    currentVersion: 1,
    keys: new Map([[1, await makeSignature("milton auth mail v1", secret)]]),
  };
}
export type NativeMail = {
  kind: "verify" | "reset";
  to: string;
  url: string;
  user: string;
  incarnation: string;
  generation: string;
  proofExpiresAt: string;
};
export function stashMail(
  s: RequestState,
  input: {
    user: { id: string; email: string };
    url: string;
    token: string;
    kind: NativeMail["kind"];
  },
) {
  try {
    if (s.mail || s.mailFault) throw new Error("duplicate_mail_callback");
    const original = s.users.get(input.user.id);
    const url = new URL(input.url);
    const expiry =
      input.kind === "verify"
        ? Number(decodeJwt(input.token).exp) * 1000
        : s.resetMailProof?.identifier === `reset-password:${input.token}`
          ? s.resetMailProof.expiresAt
          : NaN;
    if (
      !original ||
      original.email !== input.user.email ||
      !input.user.email ||
      input.user.email.length > 320 ||
      url.origin !== AUTH_ORIGIN ||
      url.href.length > 8192 ||
      !Number.isFinite(expiry) ||
      expiry <= Date.now() ||
      expiry > Date.now() + 3601000 ||
      (input.kind === "verify"
        ? url.pathname !== "/api/auth/verify-email" ||
          url.searchParams.get("token") !== input.token
        : url.pathname !== `/api/auth/reset-password/${input.token}`)
    )
      throw new Error("invalid_native_mail");
    s.mail = {
      kind: input.kind,
      to: input.user.email,
      url: input.url,
      user: original.id,
      incarnation: original.miltonIdentityIncarnation,
      generation: original.miltonSecurityGeneration,
      proofExpiresAt: new Date(expiry).toISOString(),
    };
  } catch {
    // Native catches callback rejections; the outer handler must observe this flag.
    s.mailFault = true;
  }
}
function body(config: Pick<Config, "AUTH_MAIL_FROM">, m: NativeMail) {
  return {
    from: `Milton <${config.AUTH_MAIL_FROM}>`,
    to: [m.to],
    subject:
      m.kind === "verify"
        ? "Verify your Milton email"
        : "Reset your Milton password",
    text: `${m.kind === "verify" ? "Verify your email" : "Set a new password"}: ${m.url}\n\nIf you did not request this, ignore this message.`,
  };
}
export type MailChecks = {
  /** mailDomain in production; tests inject an answer. */
  domain: (domain: string) => Promise<MailDomain>;
  /** The request's own `email`, looked up when no message was captured. */
  requested?: string;
};
export async function acceptMail(
  pool: pg.Pool,
  config: Config,
  s: RequestState,
  checks: MailChecks,
) {
  if (s.mailFault || (s.mailExpected && !s.mail))
    throw new Error("native_mail_capture_failed");
  // A reserved recipient's message, or one to a domain DNS says takes no mail
  // (null MX, NXDOMAIN, or no MX, A or AAAA), commits the same no-op receipt
  // an unknown address does, so the public answer is the same and nothing is
  // queued. The domain is looked up whether or not a message was captured, so
  // an unknown address's answer waits for the same lookup; DNS failing sends.
  const address = s.mail?.to ?? checks.requested;
  const domain =
    address && !reservedRecipient(address) ? addressDomain(address) : "";
  const reachable =
    !domain || (await checks.domain(domain)) !== "undeliverable";
  let m = s.mail && !reservedRecipient(s.mail.to) ? s.mail : undefined;
  if (m && !reachable) {
    console.log(
      JSON.stringify({
        message: "auth_mail_skipped",
        reason: "undeliverable_domain",
        kind: m.kind,
        domain: domainDigest(domain),
      }),
    );
    m = undefined;
  }
  const id = randomUUID();
  const payload = m
    ? await symmetricEncrypt({
        key: await key(config.AUTH_SECRET),
        data: JSON.stringify({ version: 1, id, ...m, body: body(config, m) }),
      })
    : null;
  // Autocommit must resolve before returning a generic public receipt. Native proof
  // writes may have committed separately; failure does not claim to undo them.
  await pool.query("select milton_guard.accept_mail($1,$2,$3,$4,$5,$6,$7)", [
    id,
    m?.kind ?? null,
    m?.user ?? null,
    m?.incarnation ?? null,
    m?.generation ?? null,
    m?.proofExpiresAt ?? null,
    payload,
  ]);
}
export type MailJob = {
  state: string;
  id: string;
  lease: string;
  kind: NativeMail["kind"];
  origin_user: string;
  incarnation: string;
  generation: string;
  proof_expires_at: Date;
  expires_at: Date;
  payload: string;
};
export async function openMail(secret: string, job: MailJob) {
  const raw: unknown = JSON.parse(
    await symmetricDecrypt({ key: await key(secret), data: job.payload }),
  );
  if (!raw || typeof raw !== "object") throw new Error("invalid_mail_payload");
  const m = raw as NativeMail & {
    version: number;
    id: string;
    body: ReturnType<typeof body>;
  };
  if (
    m.version !== 1 ||
    m.id !== job.id ||
    m.kind !== job.kind ||
    m.user !== job.origin_user ||
    m.incarnation !== job.incarnation ||
    m.generation !== job.generation ||
    m.proofExpiresAt !== new Date(job.proof_expires_at).toISOString() ||
    typeof m.to !== "string" ||
    typeof m.url !== "string" ||
    new URL(m.url).origin !== AUTH_ORIGIN ||
    !m.body ||
    typeof m.body.from !== "string" ||
    m.body.from.length > 400 ||
    JSON.stringify(m.body) !==
      JSON.stringify(body({ AUTH_MAIL_FROM: m.body.from.slice(8, -1) }, m))
  )
    throw new Error("invalid_mail_binding");
  return m.body;
}
export async function deliverMail(
  pool: pg.Pool,
  config: Pick<Config, "AUTH_SECRET" | "AUTH_RESEND_API_KEY">,
  networkFetch: (
    input: string | URL | Request,
    init?: RequestInit,
  ) => Promise<Response> = fetch,
) {
  const deadline = Date.now() + 90000;
  const counts = { claimed: 0, sent: 0, retry: 0, failed: 0, throttled: 0 };
  // One candidate per claim avoids reserving/burning work after a vendor throttle.
  for (let n = 0; n < 16 && Date.now() + 23000 < deadline; n++) {
    const claimed = await pool.query<MailJob>(
      "select * from milton_guard.claim_mail(1)",
    );
    const job = claimed.rows[0];
    // An empty claim can have cleared one stale candidate. Keep the fixed
    // pass budget so an overdue backlog does not stall behind its first row.
    if (!job) continue;
    counts.claimed++;
    let outcome: "sent" | "retry" | "failed" | "throttled" = "failed",
      defer = 0;
    try {
      const message = await openMail(config.AUTH_SECRET, job);
      if (Date.now() + 5000 >= new Date(job.expires_at).getTime())
        throw new Error("mail_deadline");
      try {
        const r = await networkFetch("https://api.resend.com/emails", {
          method: "POST",
          redirect: "error",
          signal: AbortSignal.timeout(5000),
          headers: {
            authorization: `Bearer ${config.AUTH_RESEND_API_KEY}`,
            "content-type": "application/json",
            "idempotency-key": job.id,
          },
          body: JSON.stringify(message),
        });
        if (r.status === 429) {
          outcome = "throttled";
          const h = r.headers.get("retry-after");
          const seconds =
            h && /^\d+$/.test(h)
              ? Number(h)
              : h
                ? (Date.parse(h) - Date.now()) / 1000
                : 60;
          defer = Number.isFinite(seconds)
            ? Math.max(60, Math.min(86400, Math.ceil(seconds)))
            : 60;
        } else
          outcome = r.ok
            ? "sent"
            : r.status >= 500 || r.status === 409
              ? "retry"
              : "failed";
        // Do not read or log vendor response bodies (which can reflect addresses).
        try {
          await r.body?.cancel();
        } catch {
          /* Header outcome is already known, including a throttle. */
        }
      } catch {
        outcome = "retry";
      }
    } catch {
      outcome = "failed";
    }
    const finished = await pool.query<{ done: boolean }>(
      "select milton_guard.finish_mail($1,$2,$3,$4) as done",
      [job.id, job.lease, outcome, defer],
    );
    if (!finished.rows[0]?.done) throw new Error("mail_lease_lost");
    counts[outcome]++;
    if (outcome === "throttled") break;
  }
  return counts;
}
