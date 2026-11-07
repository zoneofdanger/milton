import { sql } from "drizzle-orm";
import { z } from "zod";
import type { RuntimeConfig } from "./config";
import { database, lookupIdentityAccount } from "./store";
import type { SessionUser } from "./auth-session";
import { endStripeCustomer } from "./billing";
import { hash } from "./auth-oidc";
import { invalid, unavailable } from "./auth-authority";
import { AuthError } from "./token";
import { securityStatus } from "./auth-authority";
import {
  eligibilityProof,
  trialFingerprints,
  fingerprintKeyCheck,
} from "./auth-admission";

const operationSchema = z.object({
  operation_id: z.uuid(),
  issuer: z.string(),
  subject: z.string(),
  incarnation: z.string(),
  user_id: z.string(),
  client_id: z.string(),
  kind: z.enum(["delete", "disconnect"]),
  progress: z.enum([
    "pending",
    "refused",
    "stripe-ended",
    "writing-erased",
    "complete",
  ]),
  requester_hash: z.string(),
});
export type Operation = z.infer<typeof operationSchema>;
const connectionSchema = z
  .array(
    z.object({
      reference: z.string().min(1).max(512),
      client_id: z.string().min(1).max(2048),
      scopes: z.array(z.string()).max(6),
      expires_at: z.coerce.date(),
    }),
  )
  .max(64);
export async function connections(config: RuntimeConfig, user: SessionUser) {
  let value: unknown;
  try {
    value = (
      await database(config).query<{ connections: unknown }>(
        sql`SELECT milton_guard.list_connections(${user.id},${user.incarnation},64) AS connections`,
      )
    )[0]?.connections;
  } catch {
    throw unavailable();
  }
  const parsed = connectionSchema.safeParse(value);
  if (!parsed.success) throw invalid();
  const clients = new Map<string, (typeof parsed.data)[number]>();
  for (const item of parsed.data)
    if (item.client_id !== config.oidc.clientId) {
      const prior = clients.get(item.client_id);
      if (!prior || item.scopes.includes("milton:write"))
        clients.set(item.client_id, item);
    }
  return { items: [...clients.values()], full: parsed.data.length === 64 };
}
export async function pendingOperations(
  config: RuntimeConfig,
  token: string | undefined,
) {
  if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) return [];
  try {
    return z
      .array(operationSchema)
      .max(64)
      .parse(
        await database(config).query(
          sql`SELECT * FROM milton_app.lifecycle WHERE issuer=${config.issuer} AND requester_hash=${hash(token)} AND kind='disconnect' AND progress<>'complete' ORDER BY created_at LIMIT 64`,
        ),
      );
  } catch {
    throw unavailable();
  }
}
export async function findOperation(
  config: RuntimeConfig,
  token: string | undefined,
  id?: string,
  kind: "delete" | "disconnect" = "delete",
) {
  if (
    !token ||
    !/^[A-Za-z0-9_-]{43}$/.test(token) ||
    (id !== undefined && !z.uuid().safeParse(id).success)
  )
    return undefined;
  let rows: Record<string, unknown>[];
  try {
    rows = await database(config).query(
      sql`SELECT * FROM milton_app.lifecycle WHERE issuer=${config.issuer} AND requester_hash=${hash(token)} AND kind=${kind} ${id ? sql`AND operation_id=${id}::uuid` : sql``} ORDER BY created_at DESC LIMIT 1`,
    );
  } catch {
    throw unavailable();
  }
  if (!rows[0]) return undefined;
  const parsed = operationSchema.safeParse(rows[0]);
  if (!parsed.success) throw unavailable();
  return parsed.data;
}
export async function startOperation(
  config: RuntimeConfig,
  user: SessionUser,
  token: string,
  id: string,
  kind: "delete" | "disconnect",
  client = "",
) {
  if (!z.uuid().safeParse(id).success || !/^[A-Za-z0-9_-]{43}$/.test(token))
    throw invalid();
  const prior = await findOperation(config, token, id, kind);
  if (prior) return prior;
  const { userId } = await lookupIdentityAccount(config, {
    provider: config.issuer,
    subject: user.id,
  });
  try {
    const proof =
      kind === "delete"
        ? z
            .object({
              fresh: z.literal(true),
              verified: z.literal(true),
              sessionId: z.literal(user.sid),
              ...eligibilityProof.shape,
            })
            .safeParse(await securityStatus(config, user))
        : undefined;
    if (proof && !proof.success)
      throw new AuthError(
        "fresh_sign_in_required",
        "Sign in again before continuing with this account change.",
        403,
      );
    const metadata = proof?.data;
    await database(config).transaction(async (tx) => {
      if (
        !(
          await tx.query(
            sql`SELECT u.id FROM public.users u JOIN public.identities i ON i.user_id=u.id WHERE u.id=${userId} AND u.status='active' AND i.provider=${config.issuer} AND i.subject=${user.id} FOR UPDATE OF u`,
          )
        ).length
      )
        throw invalid();
      if (metadata) {
        const policy = (
          await tx.query<{ key_check: string }>(
            sql`SELECT key_check FROM milton_app.eligibility_policy WHERE singleton`,
          )
        )[0];
        if (
          policy?.key_check !== fingerprintKeyCheck(config.trialFingerprintKey)
        )
          throw unavailable();
        for (const fingerprint of trialFingerprints(
          config.trialFingerprintKey,
          metadata,
        )) {
          await tx.query(
            sql`INSERT INTO milton_app.trial_fingerprint(fingerprint,first_user_id) VALUES(${fingerprint},${userId}) ON CONFLICT DO NOTHING`,
          );
          await tx.query(
            sql`INSERT INTO milton_app.account_fingerprint(user_id,fingerprint) VALUES(${userId},${fingerprint}) ON CONFLICT DO NOTHING`,
          );
        }
      }
      await tx.query(
        sql`INSERT INTO milton_app.lifecycle(operation_id,issuer,subject,incarnation,user_id,client_id,kind,requester_hash) VALUES(${id}::uuid,${config.issuer},${user.id},${user.incarnation},${userId},${client},${kind},${hash(token)}) ON CONFLICT DO NOTHING`,
      );
    });
    const operation = await findOperation(config, token, id, kind);
    if (
      !operation ||
      operation.subject !== user.id ||
      operation.incarnation !== user.incarnation ||
      operation.client_id !== client
    )
      throw invalid();
    return operation;
  } catch (error) {
    if (error instanceof AuthError) throw error;
    throw unavailable();
  }
}
/** Every phase commits independently. A lost response cannot erase the original
 * association or rewind Stripe/writing progress; native retries keep one UUID. */
export async function advanceOperation(
  config: RuntimeConfig,
  original: Operation,
) {
  const read = async () =>
    operationSchema.parse(
      (
        await database(config).query(
          sql`SELECT * FROM milton_app.lifecycle WHERE operation_id=${original.operation_id}::uuid AND requester_hash=${original.requester_hash}`,
        )
      )[0],
    );
  let op = await read();
  if (op.progress === "complete") return op;
  if (op.progress === "pending") {
    await database(config).query(
      sql`SELECT milton_guard.begin_operation(${op.operation_id},${op.subject},${op.incarnation},${op.kind === "disconnect" ? op.client_id : null},${op.kind})`,
    );
    await database(config).query(
      sql`UPDATE milton_app.lifecycle SET progress='refused' WHERE operation_id=${op.operation_id}::uuid AND progress='pending'`,
    );
    op = await read();
  }
  if (op.kind === "delete") {
    await database(config).withConnection((connection) =>
      connection.transaction(async (tx) => {
        const current = operationSchema.parse(
          (
            await tx.query(
              sql`SELECT * FROM milton_app.lifecycle WHERE operation_id=${op.operation_id}::uuid FOR UPDATE`,
            )
          )[0],
        );
        if (current.progress !== "refused") return;
        const scoped = {
          ...config,
          storeDatabase: {
            ...connection,
            query: tx.query.bind(tx),
            transaction: async <T>(work: (s: typeof tx) => Promise<T>) =>
              work(tx),
          },
        };
        await endStripeCustomer(scoped, current.user_id);
        await tx.query(
          sql`UPDATE milton_app.lifecycle SET progress='stripe-ended' WHERE operation_id=${op.operation_id}::uuid`,
        );
      }),
    );
    await database(config).transaction(async (tx) => {
      const current = operationSchema.parse(
        (
          await tx.query(
            sql`SELECT * FROM milton_app.lifecycle WHERE operation_id=${op.operation_id}::uuid FOR UPDATE`,
          )
        )[0],
      );
      if (current.progress !== "stripe-ended") return;
      await tx.query(
        sql`SELECT id FROM users WHERE id=${current.user_id} FOR UPDATE`,
      );
      await tx.query(
        sql`INSERT INTO deleted_identities(identity_hash) VALUES(${hash(current.issuer + ":" + current.subject)}) ON CONFLICT DO NOTHING`,
      );
      await tx.query(sql`DELETE FROM users WHERE id=${current.user_id}`);
      await tx.query(
        sql`DELETE FROM milton_app.session WHERE issuer=${current.issuer} AND subject=${current.subject} AND incarnation=${current.incarnation}`,
      );
      await tx.query(
        sql`UPDATE milton_app.lifecycle SET progress='writing-erased' WHERE operation_id=${op.operation_id}::uuid`,
      );
    });
    op = await read();
    if (op.progress !== "writing-erased" && op.progress !== "complete")
      throw unavailable();
  }
  if (op.progress !== "complete") {
    for (let attempt = 0; attempt < 4; attempt++) {
      const result = (
        await database(config).query<{ progress: string }>(
          sql`SELECT milton_guard.cleanup_operation(${op.operation_id},16) AS progress`,
        )
      )[0]?.progress;
      if (result === "complete") {
        await database(config).query(
          sql`UPDATE milton_app.lifecycle SET progress='complete' WHERE operation_id=${op.operation_id}::uuid`,
        );
        break;
      }
      if (!["refused", "tokens-cleaned"].includes(result ?? ""))
        throw unavailable();
    }
  }
  return read();
}
