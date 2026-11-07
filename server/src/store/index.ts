import { createHash } from "node:crypto";
import { z } from "zod";
import { sql } from "drizzle-orm";
import {
  databaseFailure,
  mappedDatabase,
  postgresDatabase,
  type StoreDatabase,
  type StoreSession,
} from "./database";
import { StoreError } from "./errors";
import { claimTrialNotice, trialStatus, type TrialNotice } from "./trials";
import {
  backfillAccounts,
  billingAccount,
  cancelReturningIdentities,
  clearStripeCustomer,
  enrollForBackfill,
  linkStripeCustomer,
  lockStripeCustomer,
  lockWaitingSubscription,
  recordStripeEvent,
  saveStripeSubscription,
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
import type { ReportIntent } from "./reports";
import { readLimits } from "./limits";
export { StoreError } from "./errors";
export type { StripeSubscriptionState } from "./billing";

export interface StoreBindings {
  DATABASE_URL?: string;
  // Private dependency injection for the embedded fixture; never populated from a request.
  storeDatabase?: StoreDatabase;
}
/** The account database, whichever adapter is configured, with every database
 * failure mapped to a StoreError (see mappedDatabase). */
export function database(bindings: StoreBindings): StoreDatabase {
  if (bindings.storeDatabase) return mappedDatabase(bindings.storeDatabase);
  if (!bindings.DATABASE_URL)
    throw new StoreError("configuration", "The memo store is unavailable.");
  return mappedDatabase(postgresDatabase(bindings.DATABASE_URL));
}
interface VerifiedIdentity {
  provider: string;
  subject: string;
}

// One-way fingerprint of a sign-in identity, stored after account deletion.
const identityHash = (provider: string, subject: string) =>
  createHash("sha256").update(`${provider}:${subject}`).digest("hex");

export async function resolveIdentityAccount(
  bindings: StoreBindings,
  identity: VerifiedIdentity,
  fingerprints: readonly string[] = [],
) {
  const provider = z.string().min(1).max(64).parse(identity.provider);
  const subject = z.string().min(1).max(512).parse(identity.subject);
  const legacyDeleted = fingerprints.length
    ? sql`EXISTS(SELECT 1 FROM milton_app.legacy_mapping l WHERE l.issuer=${provider} AND l.subject=${subject} AND l.deleted)`
    : sql`false`;
  return database(bindings)
    .transaction(async (tx) => {
      await readLimits(tx);
      const lookup = () =>
        tx.query<{
          id: string;
          status: string;
        }>(sql`
      SELECT u.id, u.status FROM identities i JOIN users u ON u.id = i.user_id
      WHERE i.provider = ${provider} AND i.subject = ${subject} FOR UPDATE OF u`);
      let account = (await lookup())[0];
      if (!account) {
        // Every sign-in creates or finds its account. The identity's primary key
        // admits one account: a sign-in that loses the race for it drops the
        // users row it made, before its trial row, and finds the winner's account
        // with a separate READ COMMITTED statement.
        const id = `m_${crypto.randomUUID()}`;
        await tx.query(sql`INSERT INTO users (id) VALUES (${id})`);
        const linked =
          await tx.query(sql`INSERT INTO identities (provider,subject,user_id)
          VALUES (${provider},${subject},${id})
          ON CONFLICT (provider,subject) DO NOTHING RETURNING user_id`);
        if (!linked.length) {
          await tx.query(sql`DELETE FROM users WHERE id=${id}`);
          account = (await lookup())[0];
          if (!account)
            throw new StoreError(
              "store_unavailable",
              "The memo store is unavailable. Try again.",
            );
        } else {
          // A sign-in identity whose account was deleted gets no second trial:
          // its row starts canceled, so it reads as expired whenever trials are
          // enabled (now or later), has no effect while they are off, and sign-up
          // creates no subscription for it.
          let returning = false;
          for (const fingerprint of [...new Set(fingerprints)].sort()) {
            await tx.query(
              sql`INSERT INTO milton_app.trial_fingerprint(fingerprint,first_user_id) VALUES(${fingerprint},${id}) ON CONFLICT DO NOTHING`,
            );
            const row = (
              await tx.query<{ first_user_id: string }>(
                sql`SELECT first_user_id FROM milton_app.trial_fingerprint WHERE fingerprint=${fingerprint}`,
              )
            )[0];
            returning ||= row?.first_user_id !== id;
            await tx.query(
              sql`INSERT INTO milton_app.account_fingerprint(user_id,fingerprint) VALUES(${id},${fingerprint}) ON CONFLICT DO NOTHING`,
            );
          }
          await tx.query(sql`INSERT INTO trial_accounts(user_id,started_at,subscription_status)
            SELECT u.id,u.created_at,
              CASE WHEN d.identity_hash IS NULL AND NOT ${returning} AND NOT ${legacyDeleted} THEN NULL ELSE 'canceled' END
            FROM users u CROSS JOIN store_config c
            LEFT JOIN deleted_identities d
              ON d.identity_hash=${identityHash(provider, subject)}
            WHERE u.id=${id} AND c.singleton=1
            AND (c.trials_enabled OR d.identity_hash IS NOT NULL OR ${returning} OR ${legacyDeleted})`);
          account = { id, status: "active" };
        }
      }
      if (account.status !== "active")
        throw new StoreError(
          "account_unavailable",
          "This Milton account is unavailable.",
          403,
        );
      // Linking records new eligibility proofs but never changes writing owner,
      // starts another trial or rewinds an existing subscription.
      for (const fingerprint of [...new Set(fingerprints)].sort()) {
        await tx.query(
          sql`INSERT INTO milton_app.trial_fingerprint(fingerprint,first_user_id) VALUES(${fingerprint},${account.id}) ON CONFLICT DO NOTHING`,
        );
        await tx.query(
          sql`INSERT INTO milton_app.account_fingerprint(user_id,fingerprint) VALUES(${account.id},${fingerprint}) ON CONFLICT DO NOTHING`,
        );
      }
      return { miltonUserId: account.id };
    })
    .catch((error) => {
      // Any failure inside, including an unexpected one, becomes a logged StoreError,
      // as before the database layer started mapping errors itself.
      throw databaseFailure(error);
    });
}

const verifiedStoreIdentity = Symbol("verifiedStoreIdentity");
export interface VerifiedStoreAuth {
  readonly userId: string;
  readonly [verifiedStoreIdentity]: true;
}

// An assistant is one OAuth client acting for one sign-in identity.
interface AssistantIdentity {
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
}

/** Records a disconnect; Milton refuses the assistant from the next request. */
export async function recordAssistantDisconnect(
  bindings: StoreBindings,
  identity: AssistantIdentity,
) {
  const { provider, subject, clientId } = assistantIdentity(identity);
  await database(bindings).query(sql`
      INSERT INTO assistant_disconnects (provider,subject,client_id)
      VALUES (${provider},${subject},${clientId}) ON CONFLICT DO NOTHING`);
}

/** Removes a disconnect after the person approved the assistant again. */
export async function clearAssistantDisconnect(
  bindings: StoreBindings,
  identity: AssistantIdentity,
) {
  const { provider, subject, clientId } = assistantIdentity(identity);
  await database(bindings).query(sql`
      DELETE FROM assistant_disconnects
      WHERE provider=${provider} AND subject=${subject} AND client_id=${clientId}`);
}

/** Client ids this identity disconnected, for the connected-assistants page. */
export async function listAssistantDisconnects(
  bindings: StoreBindings,
  identity: Pick<VerifiedIdentity, "provider" | "subject">,
): Promise<Set<string>> {
  const provider = z.string().min(1).max(64).parse(identity.provider);
  const subject = z.string().min(1).max(512).parse(identity.subject);
  const rows = await database(bindings).query<{ client_id: string }>(sql`
      SELECT client_id FROM assistant_disconnects
      WHERE provider=${provider} AND subject=${subject}`);
  return new Set(rows.map((row) => row.client_id));
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
      // Any failure inside, including an unexpected one, becomes a logged StoreError,
      // as before the database layer started mapping errors itself.
      throw databaseFailure(error);
    });
}

type CallAllowance =
  { allowed: true } | { allowed: false; retry_at_ms: number; limit: "day" };
export interface TenantStore {
  /** The app's origin, for the one link served to assistants. */
  appOrigin: string;
  trialNotice?(): Promise<TrialNotice | undefined>;
  readTpsReport(): Promise<CompiledReport>;
  /** The cover sheet and the five reports at one version, assembled on read;
   * with an intent, that report serves the eight samples ranked for it. */
  readDocuments(
    intent?: ReportIntent,
  ): Promise<Documents & { version: string }>;
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
  bindings: StoreBindings & { appOrigin: string },
  auth: VerifiedStoreAuth,
  assistant?: { issuer: string; clientId: string },
): Promise<TenantStore> {
  const userId = auth.userId;
  const db = database(bindings);
  const limits = await readLimits(db);
  await resolveActiveUser(db, userId);
  const compiled = compiledMemos(db, userId, assistant);
  return {
    appOrigin: bindings.appOrigin,
    trialNotice: () =>
      db.transaction(async (tx) => {
        await tx.query(sql`SET LOCAL lock_timeout='250ms'`);
        await tx.query(sql`SET LOCAL statement_timeout='500ms'`);
        return claimTrialNotice(tx, userId, bindings.appOrigin);
      }),
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
  bindings: StoreBindings & { appOrigin: string },
  auth: VerifiedStoreAuth,
) {
  const store = await storeForCurrentRequest(bindings, auth);
  const db = database(bindings);
  return {
    ...store,
    exportTpsReport: compiledMemos(db, auth.userId).exportTpsReport,
    trialStatus: () => trialStatus(db, auth.userId),
  };
}
/** The account's billing status, for the menu on pages with no person store. */
export const accountTrialStatus = (bindings: StoreBindings, userId: string) =>
  trialStatus(database(bindings), userId);
export type PersonStore = Awaited<
  ReturnType<typeof personStoreForCurrentRequest>
>;

/** One account's billing state, for sign-in and the checkout and portal routes. */
export function billingForAccount(bindings: StoreBindings, userId: string) {
  const db = database(bindings);
  return {
    userId,
    account: () => billingAccount(db, userId),
    linkCustomer: (customer: string) =>
      linkStripeCustomer(db, userId, customer),
    clearCustomer: () => clearStripeCustomer(db, userId),
    /** Reads Stripe holding the customer's row, as the webhook does, and stores
     * what the read returns, if anything. */
    syncSubscription: (
      customer: string,
      read: () => Promise<StripeSubscriptionState | undefined>,
    ) =>
      db.transaction(async (tx) => {
        await lockStripeCustomer(tx, customer);
        const state = await read();
        if (state) await saveStripeSubscription(tx, userId, state);
        return state;
      }),
    /** Runs `work` holding the row, only while it has no subscription. What it
     * stored before failing still commits: a customer must stay findable when the
     * subscription call after it fails. */
    whileWaiting: async (
      work: (row: {
        customer: string | null;
        link: (customer: string) => Promise<string | undefined>;
        save: (state: StripeSubscriptionState) => Promise<void>;
      }) => Promise<void>,
    ) => {
      let failed: { error: unknown } | undefined;
      await db.transaction(async (tx) => {
        const row = await lockWaitingSubscription(tx, userId);
        if (!row) return;
        try {
          await work({
            customer: row.customer,
            link: (customer) => linkStripeCustomer(tx, userId, customer),
            save: (state) => saveStripeSubscription(tx, userId, state),
          });
        } catch (error) {
          failed = { error };
        }
      });
      if (failed) throw failed.error;
    },
  };
}

/** What server/scripts/backfill-subscriptions.ts reads and writes. */
export function subscriptionBackfill(bindings: StoreBindings) {
  const db = database(bindings);
  return {
    trialsEnabled: async () =>
      (
        await db.query<{ enabled: boolean }>(
          sql`SELECT trials_enabled AS enabled FROM store_config WHERE singleton=1`,
        )
      )[0]?.enabled === true,
    accounts: () => backfillAccounts(db),
    cancelReturning: () => cancelReturningIdentities(db),
    enroll: (userId: string) => enrollForBackfill(db, userId),
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
