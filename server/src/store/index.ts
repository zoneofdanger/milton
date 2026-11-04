import { createHash } from "node:crypto";
import { z } from "zod";
import { sql } from "drizzle-orm";
import {
  neonDatabase,
  databaseFailure,
  type StoreDatabase,
  type StoreSession,
} from "./database";
import { StoreError } from "./errors";
import { claimTrialNotice, trialStatus, type TrialNotice } from "./trials";
import {
  billingAccount,
  linkStripeCustomer,
  lockStripeCustomer,
  recordStripeEvent,
  stripeEventRecorded,
  type StripeEvent,
  type StripeSubscriptionState,
} from "./billing";
import {
  compiledMemos,
  type CompiledReport,
  type Documents,
  type SaveMemoInput,
  type SaveOutcome,
} from "./compiled";
export { StoreError } from "./errors";
export type { StripeSubscriptionState } from "./billing";

// Stable legacy storage key: preserve existing identities and opaque version tags.
export const TPS_REPORT_KEY = "vibes";

export interface StoreBindings {
  DATABASE_URL?: string;
  // Private dependency injection for the embedded fixture; never populated from a request.
  storeDatabase?: StoreDatabase;
}
function database(bindings: StoreBindings): StoreDatabase {
  if (bindings.storeDatabase) return bindings.storeDatabase;
  if (!bindings.DATABASE_URL)
    throw new StoreError("configuration", "The memo store is unavailable.");
  return neonDatabase(bindings.DATABASE_URL);
}
const positiveLimit = z.number().int().positive();
const limitsSchema = z.object({
  body_bytes: positiveLimit,
  description_bytes: positiveLimit,
  history_bytes: positiveLimit,
  report_body_bytes: positiveLimit,
  daily_calls: positiveLimit,
});
export type StoreLimits = z.infer<typeof limitsSchema>;

export async function readLimits(db: StoreSession): Promise<StoreLimits> {
  let value: unknown;
  try {
    value = (
      await db.query<{ limits_json: unknown }>(
        sql`SELECT limits_json FROM store_config WHERE singleton = 1`,
      )
    )[0]?.limits_json;
  } catch (error) {
    throw databaseFailure(error);
  }
  const result = limitsSchema.safeParse(value);
  if (!result.success)
    throw new StoreError("configuration", "The memo store limits are invalid.");
  return result.data;
}
export const utf8Bytes = (value: string) =>
  new TextEncoder().encode(value).length;

export interface VerifiedIdentity {
  provider: string;
  subject: string;
  profile?: Record<string, unknown>;
}

// One-way fingerprint of a sign-in identity, stored after account deletion.
const identityHash = (provider: string, subject: string) =>
  createHash("sha256").update(`${provider}:${subject}`).digest("hex");

export async function resolveIdentityAccount(
  bindings: StoreBindings,
  identity: VerifiedIdentity,
) {
  const provider = z.string().min(1).max(64).parse(identity.provider);
  const subject = z.string().min(1).max(512).parse(identity.subject);
  return database(bindings)
    .transaction(async (tx) => {
      await readLimits(tx);
      const lookup = () =>
        tx.query<{
          id: string;
          status: string;
          templates_revision: number;
        }>(sql`
      SELECT u.id, u.status, u.templates_revision FROM identities i JOIN users u ON u.id = i.user_id
      WHERE i.provider = ${provider} AND i.subject = ${subject} FOR UPDATE OF u`);
      let account = (await lookup())[0];
      if (!account) {
        const config = (
          await tx.query<{
            signup_mode: string;
            allowed_identities_json: unknown;
          }>(sql`
        SELECT signup_mode, allowed_identities_json FROM store_config WHERE singleton = 1 FOR UPDATE`)
        )[0];
        // A separate READ COMMITTED statement sees an admission that committed while this request waited.
        account = (await lookup())[0];
        if (!account) {
          const allowed = z
            .array(z.object({ provider: z.string(), subject: z.string() }))
            .parse(config?.allowed_identities_json);
          if (
            !config ||
            !(
              config.signup_mode === "open" ||
              (config.signup_mode === "allowlist" &&
                allowed.some(
                  (item) =>
                    item.provider === provider && item.subject === subject,
                ))
            )
          )
            throw new StoreError(
              "admission_refused",
              "New Milton accounts are closed.",
              403,
            );
          const id = `m_${crypto.randomUUID()}`;
          await tx.query(sql`INSERT INTO users (id) VALUES (${id})`);
          // A sign-in identity whose account was deleted gets no second trial:
          // its row starts canceled, so it reads as expired whenever trials are
          // enabled (now or later), has no effect while they are off, and sign-up
          // creates no subscription for it. started_at still marks it for code
          // before 0025.
          await tx.query(sql`INSERT INTO trial_accounts(user_id,started_at,subscription_status)
            SELECT u.id,CASE WHEN d.identity_hash IS NULL THEN u.created_at
              ELSE u.created_at - interval '720 hours' END,
              CASE WHEN d.identity_hash IS NULL THEN NULL ELSE 'canceled' END
            FROM users u CROSS JOIN store_config c
            LEFT JOIN deleted_identities d
              ON d.identity_hash=${identityHash(provider, subject)}
            WHERE u.id=${id} AND c.singleton=1
            AND (c.trials_enabled OR d.identity_hash IS NOT NULL)`);
          await tx.query(sql`INSERT INTO identities (provider,subject,user_id,profile_json)
          VALUES (${provider},${subject},${id},${JSON.stringify(identity.profile ?? {})}::jsonb)`);
          account = { id, status: "active", templates_revision: 0 };
        }
      }
      if (account.status !== "active")
        throw new StoreError(
          "account_unavailable",
          "This Milton account is unavailable.",
          403,
        );
      if (account.templates_revision === 0) {
        // Use this tenant-locked transaction; never open a nested repair transaction.
        const current = (
          await tx.query<{
            id: string;
            description: string;
            body: string;
            version: number;
            archived: boolean;
          }>(sql`SELECT r.id,r.name,v.description,v.body,v.version,v.archived
          FROM memos r JOIN memo_versions v ON v.user_id=r.user_id AND v.memo_id=r.id
          WHERE r.user_id=${account.id} AND r.name=${TPS_REPORT_KEY} ORDER BY v.version DESC LIMIT 1`)
        )[0];
        if (current?.archived) {
          await tx.query(sql`INSERT INTO memo_versions (user_id,memo_id,version,description,body,archived,reason,actor_json,details_json)
            VALUES (${account.id},${current.id},${current.version + 1},${current.description},${current.body},false,'Restored TPS Report','{"kind":"system"}',${JSON.stringify({ kind: "restore", source_version: current.version })})`);
        } else if (!current) {
          await tx.query(
            sql`INSERT INTO memos (user_id,name) VALUES (${account.id},${TPS_REPORT_KEY}) ON CONFLICT (user_id,name) DO NOTHING`,
          );
          const description = "How you want your assistants to work with you.";
          await tx.query(sql`INSERT INTO memo_versions (user_id,memo_id,version,description,body,reason,actor_json,details_json)
            SELECT ${account.id},id,1,${description},'','Created TPS Report','{"kind":"system"}','{"kind":"create"}'
            FROM memos WHERE user_id=${account.id} AND name=${TPS_REPORT_KEY}`);
        }
        await tx.query(
          sql`UPDATE users SET templates_revision=2 WHERE id=${account.id}`,
        );
      }
      return { miltonUserId: account.id };
    })
    .catch((error) => {
      throw databaseFailure(error);
    });
}

const verifiedStoreIdentity = Symbol("verifiedStoreIdentity");
export interface VerifiedStoreAuth {
  readonly userId: string;
  readonly [verifiedStoreIdentity]: true;
}

// An assistant is one OAuth client acting for one sign-in identity.
export interface AssistantIdentity {
  provider: string;
  subject: string;
  clientId: string;
}
const assistantIdentity = (identity: AssistantIdentity) => ({
  provider: z.string().min(1).max(64).parse(identity.provider),
  subject: z.string().min(1).max(512).parse(identity.subject),
  clientId: z.string().min(1).max(2048).parse(identity.clientId),
});

/**
 * Looks up the active account for a sign-in identity. With a clientId (the MCP
 * path), the same query also refuses an assistant the person disconnected,
 * whatever its token's remaining lifetime.
 */
export async function lookupIdentityAccount(
  bindings: StoreBindings,
  identity: Pick<VerifiedIdentity, "provider" | "subject"> & {
    clientId?: string;
  },
): Promise<VerifiedStoreAuth> {
  const provider = z.string().min(1).max(64).parse(identity.provider);
  const subject = z.string().min(1).max(512).parse(identity.subject);
  const clientId =
    identity.clientId === undefined
      ? undefined
      : z.string().min(1).max(2048).parse(identity.clientId);
  try {
    const row = (
      await database(bindings).query<{
        id: string | null;
        disconnected: boolean;
      }>(sql`
        SELECT (SELECT u.id FROM identities i JOIN users u ON u.id=i.user_id
          WHERE i.provider=${provider} AND i.subject=${subject} AND u.status='active') AS id,
        ${
          clientId === undefined
            ? sql`false`
            : sql`EXISTS(SELECT 1 FROM assistant_disconnects d
          WHERE d.provider=${provider} AND d.subject=${subject} AND d.client_id=${clientId})`
        } AS disconnected`)
    )[0];
    if (row?.disconnected)
      throw new StoreError(
        "invalid_token",
        "This assistant was disconnected from Milton. Reconnect it from your assistant.",
        401,
      );
    if (!row?.id)
      throw new StoreError(
        "account_unavailable",
        "Sign in to Milton before connecting your assistant.",
        403,
      );
    return { userId: row.id, [verifiedStoreIdentity]: true };
  } catch (error) {
    throw databaseFailure(error);
  }
}

/** Records a disconnect; Milton refuses the assistant from the next request. */
export async function recordAssistantDisconnect(
  bindings: StoreBindings,
  identity: AssistantIdentity,
) {
  const { provider, subject, clientId } = assistantIdentity(identity);
  try {
    await database(bindings).query(sql`
      INSERT INTO assistant_disconnects (provider,subject,client_id)
      VALUES (${provider},${subject},${clientId}) ON CONFLICT DO NOTHING`);
  } catch (error) {
    throw databaseFailure(error);
  }
}

/** Removes a disconnect after the person approved the assistant again. */
export async function clearAssistantDisconnect(
  bindings: StoreBindings,
  identity: AssistantIdentity,
) {
  const { provider, subject, clientId } = assistantIdentity(identity);
  try {
    await database(bindings).query(sql`
      DELETE FROM assistant_disconnects
      WHERE provider=${provider} AND subject=${subject} AND client_id=${clientId}`);
  } catch (error) {
    throw databaseFailure(error);
  }
}

/** Client ids this identity disconnected, for the connected-assistants page. */
export async function listAssistantDisconnects(
  bindings: StoreBindings,
  identity: Pick<VerifiedIdentity, "provider" | "subject">,
): Promise<Set<string>> {
  const provider = z.string().min(1).max(64).parse(identity.provider);
  const subject = z.string().min(1).max(512).parse(identity.subject);
  try {
    const rows = await database(bindings).query<{ client_id: string }>(sql`
      SELECT client_id FROM assistant_disconnects
      WHERE provider=${provider} AND subject=${subject}`);
    return new Set(rows.map((row) => row.client_id));
  } catch (error) {
    throw databaseFailure(error);
  }
}

/**
 * Deletes the identity's active account and everything it owns, in one
 * transaction. First records a disconnect for every given assistant (so their
 * unexpired tokens cannot reach a later account for this identity) and the
 * identity fingerprint (so that account gets no second trial). Every tenant
 * table cascades from users.
 */
export async function deleteAccount(
  bindings: StoreBindings,
  identity: Pick<VerifiedIdentity, "provider" | "subject">,
  clientIds: string[],
): Promise<void> {
  const provider = z.string().min(1).max(64).parse(identity.provider);
  const subject = z.string().min(1).max(512).parse(identity.subject);
  const clients = [
    ...new Set(clientIds.map((id) => z.string().min(1).max(2048).parse(id))),
  ];
  await database(bindings)
    .transaction(async (tx) => {
      // The same row lock every writer takes, so in-flight saves finish first
      // and later ones find no active account.
      const account = (
        await tx.query<{ id: string }>(sql`
        SELECT u.id FROM identities i JOIN users u ON u.id=i.user_id
        WHERE i.provider=${provider} AND i.subject=${subject} AND u.status='active'
        FOR UPDATE OF u`)
      )[0];
      if (!account)
        throw new StoreError(
          "account_unavailable",
          "This Milton account is unavailable.",
          403,
        );
      for (const clientId of clients)
        await tx.query(sql`
          INSERT INTO assistant_disconnects (provider,subject,client_id)
          VALUES (${provider},${subject},${clientId}) ON CONFLICT DO NOTHING`);
      await tx.query(sql`
        INSERT INTO deleted_identities (identity_hash)
        VALUES (${identityHash(provider, subject)}) ON CONFLICT DO NOTHING`);
      await tx.query(sql`DELETE FROM users WHERE id=${account.id}`);
    })
    .catch((error) => {
      throw databaseFailure(error);
    });
}

export type CallAllowance =
  { allowed: true } | { allowed: false; retry_at_ms: number; limit: "day" };
export interface TenantStore {
  trialNotice?(): Promise<TrialNotice | undefined>;
  memoUpdates?(): Promise<import("./memo-updates").MemoUpdates | undefined>;
  readTpsReport(): Promise<CompiledReport>;
  /** The cover sheet and the five reports at one version; rebuilds a stale snapshot. */
  readDocuments(): Promise<Documents & { version: string }>;
  saveMemo(input: SaveMemoInput): Promise<SaveOutcome>;
  chargeToolCall(): Promise<CallAllowance>;
}

async function resolveActiveUser(db: StoreSession, userId: string) {
  const account = (
    await db.query<{ id: string }>(
      sql`SELECT id FROM users WHERE id = ${userId} AND status = 'active'`,
    )
  )[0];
  if (!account)
    throw new StoreError(
      "account_unavailable",
      "This Milton account is unavailable.",
      403,
    );
  return account.id;
}

export async function storeForCurrentRequest(
  bindings: StoreBindings,
  auth: VerifiedStoreAuth,
  assistant?: { issuer: string; clientId: string },
): Promise<TenantStore> {
  const userId = auth.userId;
  const db = database(bindings);
  const limits = await readLimits(db);
  await resolveActiveUser(db, userId);
  const compiled = compiledMemos(db, userId, assistant);
  return {
    trialNotice: () =>
      db.transaction(async (tx) => {
        await tx.query(sql`SET LOCAL lock_timeout='250ms'`);
        await tx.query(sql`SET LOCAL statement_timeout='500ms'`);
        return claimTrialNotice(tx, userId);
      }),
    memoUpdates: compiled.memoUpdates,
    readTpsReport: compiled.getTpsReport,
    readDocuments: compiled.readDocuments,
    saveMemo: compiled.saveMemo,
    async chargeToolCall() {
      return db.transaction(async (tx) => {
        if (
          !(
            await tx.query(
              sql`SELECT id FROM users WHERE id = ${userId} AND status = 'active' FOR UPDATE`,
            )
          ).length
        )
          throw new StoreError(
            "account_unavailable",
            "This Milton account is unavailable.",
            403,
          );
        const { day } = (
          await tx.query<{ day: string }>(
            sql`SELECT (clock_timestamp() AT TIME ZONE 'UTC')::date::text AS day`,
          )
        )[0]!;
        const charged =
          await tx.query(sql`INSERT INTO usage_daily (user_id,day_utc,tool_calls) VALUES (${userId},${day}::date,1)
          ON CONFLICT (user_id,day_utc) DO UPDATE SET tool_calls = usage_daily.tool_calls + 1
          WHERE usage_daily.tool_calls < ${limits.daily_calls} RETURNING tool_calls`);
        return charged.length
          ? { allowed: true as const }
          : {
              allowed: false as const,
              limit: "day" as const,
              retry_at_ms: Date.parse(`${day}T00:00:00Z`) + 86400000,
            };
      });
    },
  };
}

// The web app reads with the person's own session: no assistant, so no saves.
export async function personStoreForCurrentRequest(
  bindings: StoreBindings,
  auth: VerifiedStoreAuth,
) {
  const store = await storeForCurrentRequest(bindings, auth);
  const db = database(bindings);
  return { ...store, trialStatus: () => trialStatus(db, auth.userId) };
}
export type PersonStore = Awaited<
  ReturnType<typeof personStoreForCurrentRequest>
>;

/** The signed-in account's billing state, for the checkout and portal routes. */
export function billingForAccount(
  bindings: StoreBindings,
  auth: VerifiedStoreAuth,
) {
  const db = database(bindings);
  const wrap = async <T>(work: Promise<T>) => {
    try {
      return await work;
    } catch (error) {
      throw databaseFailure(error);
    }
  };
  return {
    userId: auth.userId,
    account: () => wrap(billingAccount(db, auth.userId)),
    linkCustomer: (customer: string) =>
      wrap(linkStripeCustomer(db, auth.userId, customer)),
  };
}

/**
 * Records a verified Stripe event, once per id. When it names a customer Milton
 * holds, `read` asks Stripe for that customer's state and the answer is written
 * in the statement that records the event. The row stays locked across the read;
 * a `read` that throws leaves nothing recorded, so Stripe redelivers.
 */
export async function applyStripeEvent(
  bindings: StoreBindings,
  event: StripeEvent,
  customer: string | null,
  read: (
    customer: string,
    stored: string | null,
  ) => Promise<StripeSubscriptionState | "canceled" | undefined>,
) {
  const db = database(bindings);
  if (!customer) return recordStripeEvent(db, event);
  return db.transaction(async (tx) => {
    const row = await lockStripeCustomer(tx, customer);
    if (!row) return recordStripeEvent(tx, event);
    if (await stripeEventRecorded(tx, event.id))
      return { recorded: false, updated: 0 };
    const state = await read(customer, row.subscription);
    return recordStripeEvent(
      tx,
      event,
      state ? { customer, state } : undefined,
    );
  });
}
