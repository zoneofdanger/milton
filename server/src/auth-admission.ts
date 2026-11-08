import { createHmac, timingSafeEqual } from "node:crypto";
import { sql } from "drizzle-orm";
import { z } from "zod";
import type { AdmitConfig } from "./config";
import {
  database,
  lockActiveAccount,
  resolveIdentityAccount,
  saveFingerprints,
  StoreError,
} from "./store";
import type { StoreSession } from "./store/database";
import { ensureSubscription } from "./billing";
import { AuthError } from "./token";
import { boundRequest } from "./http";
import {
  authoritySchema,
  securityStatus,
  invalid,
  unavailable,
} from "./auth-authority";

export const eligibilityProof = z.object({
  verifiedEmail: z.email().max(254),
  verifiedIdentities: z
    .array(
      z.strictObject({
        provider: z.enum(["google", "github"]),
        subject: z
          .string()
          .min(1)
          .max(512)
          .refine((s) => s.trim() === s && !/[\u0000-\u001f\u007f]/.test(s)),
      }),
    )
    .max(16),
});
const admission = z.strictObject({
  issuer: z.string().min(1).max(64),
  subject: z.string().min(1).max(512),
  continuation: z.string().regex(/^[a-f0-9]{64}$/),
  ...eligibilityProof.shape,
});
export type Admission = z.infer<typeof admission>;
export function trialFingerprints(
  key: string,
  proof: Pick<Admission, "verifiedEmail" | "verifiedIdentities">,
) {
  const values = [
    JSON.stringify(["email", proof.verifiedEmail.trim().toLowerCase()]),
    ...proof.verifiedIdentities.map((i) =>
      JSON.stringify([i.provider, i.subject]),
    ),
  ];
  return [
    ...new Set(
      values.map((value) =>
        createHmac("sha256", key).update(value).digest("hex"),
      ),
    ),
  ].sort();
}
export const fingerprintKeyCheck = (key: string) =>
  createHmac("sha256", key).update("milton trial eligibility v1").digest("hex");
/** Saves an account's trial-eligibility fingerprints, refusing while the stored
 * key check does not match the configured fingerprint key. */
export async function saveEligibility(
  tx: StoreSession,
  config: Pick<AdmitConfig, "trialFingerprintKey">,
  userId: string,
  proof: Pick<Admission, "verifiedEmail" | "verifiedIdentities">,
) {
  const policy = (
    await tx.query<{ key_check: string }>(
      sql`SELECT key_check FROM milton_app.eligibility_policy WHERE singleton`,
    )
  )[0];
  if (policy?.key_check !== fingerprintKeyCheck(config.trialFingerprintKey))
    throw unavailable();
  await saveFingerprints(
    tx,
    userId,
    trialFingerprints(config.trialFingerprintKey, proof),
  );
}
export const ADMISSION_PATHS = [
  "/internal/auth/admit",
  "/internal/auth/preserve-eligibility",
];
export function authAdmission(config: AdmitConfig) {
  return async (request: Request): Promise<Response> => {
    const headers = { "Cache-Control": "no-store" };
    if (request.method !== "POST")
      return new Response(null, { status: 405, headers });
    const received = Buffer.from(request.headers.get("Authorization") ?? "");
    const expected = Buffer.from("Bearer " + config.admissionSecret);
    if (
      received.length !== expected.length ||
      !timingSafeEqual(received, expected)
    )
      return new Response(null, { status: 401, headers });
    if (
      request.headers.get("Content-Type")?.split(";")[0] !== "application/json"
    )
      return new Response(null, { status: 400, headers });
    const bounded = await boundRequest(request);
    if (bounded instanceof Response) return bounded;
    const body: unknown = await bounded.json().catch(() => null);
    if (
      new URL(request.url).pathname === "/internal/auth/preserve-eligibility"
    ) {
      const proof = authoritySchema
        .omit({ binding: true })
        .extend({ issuer: z.literal(config.issuer) })
        .strict()
        .safeParse(body);
      if (!proof.success) return new Response(null, { status: 400, headers });
      try {
        const p = proof.data;
        const metadata = eligibilityProof
          .extend({
            fresh: z.literal(true),
            verified: z.literal(true),
            sessionId: z.literal(p.sid),
          })
          .safeParse(await securityStatus(config, p));
        if (!metadata.success) throw invalid();
        await database(config).transaction(async (tx) => {
          const account = await lockActiveAccount(tx, p.issuer, p.subject);
          // Security removal must never admit a native-only user or touch billing.
          if (!account) return;
          await saveEligibility(tx, config, account, metadata.data);
        });
        return new Response(null, { status: 204, headers });
      } catch (error) {
        return new Response(null, {
          status: error instanceof AuthError ? error.status : 503,
          headers,
        });
      }
    }
    const proof = admission.safeParse(body);
    if (!proof.success || proof.data.issuer !== config.issuer)
      return new Response(null, { status: 400, headers });
    try {
      const p = proof.data;
      const policy = (
        await database(config).query<{ key_check: string }>(
          sql`SELECT key_check FROM milton_app.eligibility_policy WHERE singleton`,
        )
      )[0];
      if (policy?.key_check !== fingerprintKeyCheck(config.trialFingerprintKey))
        return new Response(null, { status: 503, headers });
      // Every authenticated continuation is keyed independently, while issuer /
      // subject's unique identity row and billing row arbitrate concurrent calls.
      const { miltonUserId } = await resolveIdentityAccount(
        config,
        { provider: p.issuer, subject: p.subject },
        trialFingerprints(config.trialFingerprintKey, p),
      );
      await ensureSubscription(config, miltonUserId, p.verifiedEmail);
      // Correlation receipts carry no ongoing authority and need not become
      // permanent identity history. Native login flows expire after ten minutes.
      await database(config).query(
        sql`DELETE FROM milton_app.admission WHERE (issuer,subject,continuation) IN(SELECT issuer,subject,continuation FROM milton_app.admission WHERE created_at<clock_timestamp()-interval '1 day' ORDER BY created_at LIMIT 16)`,
      );
      await database(config).query(
        sql`INSERT INTO milton_app.admission(issuer,subject,continuation,user_id) VALUES(${p.issuer},${p.subject},${p.continuation},${miltonUserId}) ON CONFLICT DO NOTHING`,
      );
      return new Response(null, { status: 204, headers });
    } catch (error) {
      return new Response(null, {
        status:
          error instanceof AuthError || error instanceof StoreError
            ? error.status
            : 503,
        headers,
      });
    }
  };
}
