import { createHash } from "node:crypto";
import { z } from "zod";
import { sql } from "drizzle-orm";
import {
  databaseFailure,
  mappedDatabase,
  postgresDatabase,
  type StoreDatabase,
} from "./database";
import { StoreError } from "./errors";
import { accountUnavailable, requireActiveAccount } from "./accounts";
import {
  claimTrialNotice,
  trialStatus,
  type TrialNotice,
  type TrialStatus,
} from "./trials";
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
import { parseLimits, readLimits } from "./limits";
import {
  authenticateConnectionKey,
  createConnectionKey,
  findConnectionKey,
  listConnectionKeys,
  revokeConnectionKey,
  type KeyBinding,
  type KeyScope,
} from "./connection-keys";
export { StoreError } from "./errors";
export {
  EXPIRED_KEY_HISTORY,
  keyExpiries,
  keyName,
  MAX_ACTIVE_KEYS,
  parseConnectionKey,
  type ConnectionKey,
  type KeyBinding,
  type KeyExpiry,
  type KeyScope,
} from "./connection-keys";
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
/** A sign-in identity's fields, provider first, within the bounds they are
 * stored under. */
const parseIdentity = (identity: VerifiedIdentity): VerifiedIdentity => ({
  provider: z.string().min(1).max(64).parse(identity.provider),
  subject: z.string().min(1).max(512).parse(identity.subject),
});

// One-way fingerprint of a sign-in identity, stored after account deletion.
const identityHash = (provider: string, subject: string) =>
  createHash("sha256").update(`${provider}:${subject}`).digest("hex");

export async function resolveIdentityAccount(
  bindings: StoreBindings,
  identity: VerifiedIdentity,
  fingerprints: readonly string[] = [],
) {
  const { provider, subject } = parseIdentity(identity);
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
      if (account.status !== "active") throw accountUnavailable();
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

/** Looks up the active account for a sign-in identity. */
export async function lookupIdentityAccount(
  bindings: StoreBindings,
  identity: Pick<VerifiedIdentity, "provider" | "subject">,
): Promise<VerifiedStoreAuth> {
  const { provider, subject } = parseIdentity(identity);
  const row = (
    await database(bindings).query<{ id: string }>(sql`
        SELECT u.id FROM identities i JOIN users u ON u.id=i.user_id
        WHERE i.provider=${provider} AND i.subject=${subject} AND u.status='active'`)
  )[0];
  if (!row)
    throw new StoreError(
      "account_unavailable",
      "Sign in to Milton before connecting your assistant.",
      403,
    );
  return { userId: row.id, [verifiedStoreIdentity]: true };
}

/** The account a parsed connection key grants and the key's scope, or a
 * refusal alike for every reason (see authenticateConnectionKey); `known` is
 * false only when no key has the id. */
export async function connectionKeyAccount(
  bindings: StoreBindings & { issuer: string },
  key: { id: string; secret: string },
): Promise<
  | { ok: true; auth: VerifiedStoreAuth; keyId: string; scope: KeyScope }
  | { ok: false; known: boolean }
> {
  const checked = await authenticateConnectionKey(
    database(bindings),
    bindings.issuer,
    key,
  );
  if (!checked.ok) return checked;
  return {
    ok: true,
    auth: { userId: checked.userId, [verifiedStoreIdentity]: true },
    keyId: checked.keyId,
    scope: checked.scope,
  };
}

/** One signed-in account's connection keys, for the Connected assistants page.
 * `binding` is the signed-in session's validated native snapshot. */
export function connectionKeysForAccount(
  bindings: StoreBindings,
  auth: VerifiedStoreAuth,
  binding: KeyBinding,
) {
  const db = database(bindings);
  return {
    list: () => listConnectionKeys(db, auth.userId, binding),
    find: (id: string) => findConnectionKey(db, auth.userId, binding, id),
    create: (input: Parameters<typeof createConnectionKey>[3]) =>
      createConnectionKey(db, auth.userId, binding, input),
    revoke: (id: string) => revokeConnectionKey(db, auth.userId, id),
  };
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

/** An account's store, refused once the account is not active. */
export async function storeForCurrentRequest(
  bindings: StoreBindings & { appOrigin: string },
  auth: VerifiedStoreAuth,
  assistant?: { issuer: string; clientId: string },
): Promise<TenantStore> {
  await requireActiveAccount(database(bindings), auth.userId, { lock: false });
  return tenantStore(bindings, auth, assistant);
}

/** The store for an `auth` this request just looked up, which required an
 * active account; built without a query. Every tool call's charge and every
 * read and save check the account again. */
export function tenantStore(
  bindings: StoreBindings & { appOrigin: string },
  auth: VerifiedStoreAuth,
  assistant?: { issuer: string; clientId: string },
): TenantStore {
  const userId = auth.userId;
  const db = database(bindings);
  // The trial status the latest read's gate admitted, for that call's notice.
  let gated: TrialStatus | undefined;
  const compiled = compiledMemos(db, userId, assistant, (status) => {
    gated = status;
  });
  return {
    appOrigin: bindings.appOrigin,
    trialNotice: async () => {
      const status = gated;
      gated = undefined;
      // The claim's conditions are those of a due reminder, so when the
      // status this call's read just gated on has none, it would find nothing.
      if (status?.reminder_stage === 0) return undefined;
      return db.transaction(async (tx) => {
        await tx.query(
          sql`SELECT set_config('lock_timeout','250ms',true), set_config('statement_timeout','500ms',true)`,
        );
        return claimTrialNotice(tx, userId, bindings.appOrigin);
      });
    },
    readTpsReport: compiled.getTpsReport,
    readDocuments: compiled.readDocuments,
    saveMemo: compiled.saveMemo,
    /** One statement, so one implicit transaction and one round trip. It
     * takes the account row lock the deletion and every writer take, held
     * until the statement commits: a deletion that holds it first leaves no
     * active row (the charge refuses and counts nothing); one that comes
     * second waits and then sees, and cascades, the counted call. The limits
     * are read in the same statement, so a change applies to the next call. */
    async chargeToolCall() {
      const row = (
        await db.query<{
          limits: unknown;
          day: string;
          open: boolean;
          charged: boolean;
        }>(sql`WITH account AS (
            SELECT id FROM users WHERE id=${userId} AND status='active' FOR UPDATE),
          config AS (
            SELECT limits_json AS limits,
              (clock_timestamp() AT TIME ZONE 'UTC')::date AS day,
              CASE WHEN jsonb_typeof(limits_json->'daily_calls')='number'
                THEN (limits_json->>'daily_calls')::numeric END AS daily_calls
            FROM store_config WHERE singleton=1),
          charged AS (
            INSERT INTO usage_daily (user_id,day_utc,tool_calls)
            SELECT account.id, config.day, 1 FROM account, config
            WHERE config.daily_calls >= 1
            ON CONFLICT (user_id,day_utc) DO UPDATE SET tool_calls = usage_daily.tool_calls + 1
            WHERE usage_daily.tool_calls < (SELECT daily_calls FROM config)
            RETURNING tool_calls)
          SELECT config.limits, config.day::text AS day,
            EXISTS(SELECT 1 FROM account) AS open,
            EXISTS(SELECT 1 FROM charged) AS charged
          FROM config`)
      )[0];
      parseLimits(row?.limits);
      if (!row!.open) throw accountUnavailable();
      return row!.charged
        ? { allowed: true as const }
        : {
            allowed: false as const,
            limit: "day" as const,
            retry_at_ms: Date.parse(`${row!.day}T00:00:00Z`) + 86400000,
          };
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
