import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { z } from "zod";
import { sql } from "drizzle-orm";
import { postgresDatabase, type StoreDatabase } from "../src/store/database";
import { trialFingerprints, fingerprintKeyCheck } from "../src/auth-admission";

const rowSchema = z.strictObject({
  legacySubject: z.string().min(1).max(512),
  issuer: z.url().max(64),
  subject: z.string().min(1).max(512),
  userId: z
    .string()
    .regex(/^m_[a-f0-9-]{36}$/)
    .nullable(),
  verifiedEmail: z.email().max(254),
  verifiedIdentities: z
    .array(
      z.strictObject({
        provider: z.enum(["google", "github"]),
        subject: z.string().min(1).max(512),
      }),
    )
    .max(16),
});
const source = z.array(rowSchema).max(10000);
/** Owner-supplied verified METADATA only. No directory scan, email merge,
 * credential import, legacy token acceptance or changes to the managed schema. */
export async function importIdentities(
  db: StoreDatabase,
  input: unknown,
  issuer: string,
  key: string,
  apply = false,
) {
  const records = source.parse(input);
  if (!key || key.length < 32)
    throw new Error("stable_fingerprint_key_required");
  const subjects = new Set<string>(),
    legacy = new Set<string>(),
    accounts = new Set<string>();
  for (const r of records) {
    if (
      r.issuer !== issuer ||
      subjects.has(r.subject) ||
      legacy.has(r.legacySubject) ||
      (r.userId && accounts.has(r.userId))
    )
      throw new Error("ambiguous_identity_mapping");
    subjects.add(r.subject);
    legacy.add(r.legacySubject);
    if (r.userId) accounts.add(r.userId);
  }
  return db.transaction(async (tx) => {
    const check = fingerprintKeyCheck(key);
    const policy = (
      await tx.query<{ key_check: string }>(
        sql`SELECT key_check FROM milton_app.eligibility_policy WHERE singleton FOR UPDATE`,
      )
    )[0];
    if (policy && policy.key_check !== check)
      throw new Error("stable_fingerprint_key_mismatch");
    // Full batch preflight happens before any write. Lock original ownership
    // rows; an active self-hosted subject may never be reassigned by import.
    const plans = [];
    for (const r of records) {
      const legacyHash = createHash("sha256")
        .update("neon:" + r.legacySubject)
        .digest("hex");
      const old = (
        await tx.query<{ user_id: string }>(
          sql`SELECT user_id FROM public.identities WHERE provider='neon' AND subject=${r.legacySubject} FOR UPDATE`,
        )
      )[0];
      const deleted =
        (
          await tx.query(
            sql`SELECT 1 FROM public.deleted_identities WHERE identity_hash=${legacyHash}`,
          )
        ).length > 0;
      const current = (
        await tx.query<{ user_id: string }>(
          sql`SELECT user_id FROM public.identities WHERE provider=${issuer} AND subject=${r.subject} FOR UPDATE`,
        )
      )[0];
      const imported = (
        await tx.query<{
          issuer: string;
          subject: string;
          user_id: string | null;
          deleted: boolean;
        }>(
          sql`SELECT issuer,subject,user_id,deleted FROM milton_app.legacy_mapping WHERE legacy_hash=${legacyHash}`,
        )
      )[0];
      if (
        (r.userId ? old?.user_id !== r.userId || deleted : !deleted || !!old) ||
        (current && current.user_id !== r.userId) ||
        (imported &&
          (imported.issuer !== issuer ||
            imported.subject !== r.subject ||
            imported.user_id !== r.userId ||
            imported.deleted !== (r.userId === null)))
      )
        throw new Error("source_metadata_mismatch");
      if (
        r.userId &&
        !(
          await tx.query(
            sql`SELECT 1 FROM public.users WHERE id=${r.userId} AND status='active' FOR UPDATE`,
          )
        ).length
      )
        throw new Error("source_account_unavailable");
      plans.push({ r, legacyHash });
    }
    const coverage = (
      await tx.query<{ active: number; deleted: number }>(sql`SELECT
      (SELECT count(*)::int FROM public.identities i WHERE i.provider='neon'
        AND NOT i.subject IN(SELECT jsonb_array_elements_text(${JSON.stringify(records.map((r) => r.legacySubject))}::jsonb))
        AND NOT EXISTS(SELECT 1 FROM milton_app.legacy_mapping l WHERE l.legacy_hash=encode(sha256(convert_to('neon:'||i.subject,'UTF8')),'hex'))) AS active,
      (SELECT count(*)::int FROM public.deleted_identities d
        WHERE NOT d.identity_hash IN(SELECT jsonb_array_elements_text(${JSON.stringify(plans.map((p) => p.legacyHash))}::jsonb))
        AND NOT EXISTS(SELECT 1 FROM milton_app.legacy_mapping l WHERE l.legacy_hash=d.identity_hash)) AS deleted`)
    )[0];
    if (
      !coverage ||
      (apply && (coverage.active !== 0 || coverage.deleted !== 0))
    )
      throw new Error("unmapped_legacy_metadata");
    if (apply) {
      await tx.query(
        sql`INSERT INTO milton_app.eligibility_policy(singleton,key_check) VALUES(true,${check}) ON CONFLICT DO NOTHING`,
      );
      const held = (
        await tx.query<{ key_check: string }>(
          sql`SELECT key_check FROM milton_app.eligibility_policy WHERE singleton`,
        )
      )[0];
      if (held?.key_check !== check)
        throw new Error("stable_fingerprint_key_mismatch");
    }
    if (apply)
      for (const { r, legacyHash } of plans) {
        if (r.userId)
          await tx.query(
            sql`INSERT INTO public.identities(provider,subject,user_id) VALUES(${issuer},${r.subject},${r.userId}) ON CONFLICT DO NOTHING`,
          );
        await tx.query(
          sql`INSERT INTO milton_app.legacy_mapping(legacy_hash,issuer,subject,user_id,deleted) VALUES(${legacyHash},${issuer},${r.subject},${r.userId},${r.userId === null}) ON CONFLICT DO NOTHING`,
        );
        for (const fingerprint of trialFingerprints(key, r)) {
          await tx.query(
            sql`INSERT INTO milton_app.trial_fingerprint(fingerprint,first_user_id) VALUES(${fingerprint},${r.userId ?? "deleted:" + legacyHash}) ON CONFLICT DO NOTHING`,
          );
          if (r.userId)
            await tx.query(
              sql`INSERT INTO milton_app.account_fingerprint(user_id,fingerprint) VALUES(${r.userId},${fingerprint}) ON CONFLICT DO NOTHING`,
            );
        }
      }
    return {
      checked: records.length,
      active: records.filter((r) => r.userId).length,
      deleted: records.filter((r) => !r.userId).length,
      unmappedActive: coverage.active,
      unmappedDeleted: coverage.deleted,
      keyProvisioned: !!policy,
      applied: apply,
    };
  });
}
if (import.meta.main) {
  try {
    const [mode, path] = process.argv.slice(2);
    const {
      MILTON_OWNER_DATABASE_URL: owner,
      AUTH_ISSUER: issuer,
      MILTON_TRIAL_FINGERPRINT_KEY: key,
    } = process.env;
    if (
      !["--dry-run", "--apply"].includes(mode ?? "") ||
      !path ||
      !owner ||
      !issuer ||
      !key
    )
      throw new Error("explicit_owner_metadata_input_required");
    const db = postgresDatabase(owner);
    const role = (
      await db.query<{ role: string; runtime: boolean }>(
        sql`SELECT current_user AS role,pg_has_role('milton_app_runtime','MEMBER') OR pg_has_role('milton_mcp_runtime','MEMBER') OR pg_has_role('milton_auth_runtime','MEMBER') AS runtime`,
      )
    )[0];
    if (
      !role ||
      role.runtime ||
      !["neondb_owner", "milton_app_owner"].includes(role.role)
    )
      throw new Error("migration_owner_required");
    console.log(
      JSON.stringify(
        await importIdentities(
          db,
          JSON.parse(await readFile(path, "utf8")),
          issuer,
          key,
          mode === "--apply",
        ),
      ),
    );
  } catch {
    console.error(
      "Identity metadata preflight/import refused; details were not logged.",
    );
    process.exitCode = 1;
  }
}
