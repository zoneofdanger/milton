import { z } from "zod";
import { sql, type SQL } from "drizzle-orm";
import {
  databaseFailure,
  mappedDatabase,
  postgresDatabase,
  type StoreDatabase,
  type StoreSession,
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
import { invalidKind } from "./snapshot";
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

/** Records trial-eligibility fingerprints for an account; each keeps its first
 * claimant. */
export async function saveFingerprints(
  tx: StoreSession,
  userId: string,
  fingerprints: readonly string[],
) {
  for (const fingerprint of [...new Set(fingerprints)].sort()) {
    await tx.query(
      sql`INSERT INTO milton_app.trial_fingerprint(fingerprint,first_user_id) VALUES(${fingerprint},${userId}) ON CONFLICT DO NOTHING`,
    );
    await tx.query(
      sql`INSERT INTO milton_app.account_fingerprint(user_id,fingerprint) VALUES(${userId},${fingerprint}) ON CONFLICT DO NOTHING`,
    );
  }
}
/** Locks the active account a sign-in identity owns (only that account when
 * `id` is given) and returns its id. */
export async function lockActiveAccount(
  tx: StoreSession,
  provider: string,
  subject: string,
  id?: string,
) {
  return (
    await tx.query<{ id: string }>(
      sql`SELECT u.id FROM public.users u JOIN public.identities i ON i.user_id=u.id WHERE ${id === undefined ? sql`` : sql`u.id=${id} AND `}u.status='active' AND i.provider=${provider} AND i.subject=${subject} FOR UPDATE OF u`,
    )
  )[0]?.id;
}

export async function resolveIdentityAccount(
  bindings: StoreBindings,
  identity: VerifiedIdentity,
  fingerprints: readonly string[] = [],
) {
  const { provider, subject } = parseIdentity(identity);
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
          // A new account sharing a trial-eligibility fingerprint with an
          // earlier one (kept after deletion) gets no second trial: its row
          // starts canceled, so it reads as expired whenever trials are enabled
          // (now or later), has no effect while they are off, and sign-up
          // creates no subscription for it.
          await saveFingerprints(tx, id, fingerprints);
          let returning = false;
          for (const fingerprint of [...new Set(fingerprints)].sort()) {
            const row = (
              await tx.query<{ first_user_id: string }>(
                sql`SELECT first_user_id FROM milton_app.trial_fingerprint WHERE fingerprint=${fingerprint}`,
              )
            )[0];
            returning ||= row?.first_user_id !== id;
          }
          await tx.query(sql`INSERT INTO trial_accounts(user_id,started_at,subscription_status)
            SELECT u.id,u.created_at,
              CASE WHEN ${returning} THEN 'canceled' END
            FROM users u CROSS JOIN store_config c
            WHERE u.id=${id} AND c.singleton=1
            AND (c.trials_enabled OR ${returning})`);
          account = { id, status: "active" };
        }
      }
      if (account.status !== "active") throw accountUnavailable();
      // Linking records new eligibility proofs but never changes writing owner,
      // starts another trial or rewinds an existing subscription.
      await saveFingerprints(tx, account.id, fingerprints);
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

/** A check read in the identity lookup's own statement: `admit` sees its
 * value and throws the caller's refusal before the account is checked, and a
 * failed statement is the caller's `outage`. */
export interface IdentityGuard {
  value: SQL;
  admit(value: unknown): void;
  outage(): Error;
}

/** An assistant's account, with the store limits read in its access
 * statement, for tenantStore to validate. */
export interface AssistantAuth extends VerifiedStoreAuth {
  readonly limits: unknown;
}
const storeLimits = sql`(SELECT limits_json FROM store_config WHERE singleton=1)`;

/** Looks up the active account for a sign-in identity; with a guard, also
 * reads the store limits in the same statement. */
export async function lookupIdentityAccount(
  bindings: StoreBindings,
  identity: Pick<VerifiedIdentity, "provider" | "subject">,
): Promise<VerifiedStoreAuth>;
export async function lookupIdentityAccount(
  bindings: StoreBindings,
  identity: Pick<VerifiedIdentity, "provider" | "subject">,
  guard: IdentityGuard,
): Promise<AssistantAuth>;
export async function lookupIdentityAccount(
  bindings: StoreBindings,
  identity: Pick<VerifiedIdentity, "provider" | "subject">,
  guard?: IdentityGuard,
): Promise<VerifiedStoreAuth | AssistantAuth> {
  const { provider, subject } = parseIdentity(identity);
  const account = sql`
        SELECT u.id FROM identities i JOIN users u ON u.id=i.user_id
        WHERE i.provider=${provider} AND i.subject=${subject} AND u.status='active'`;
  let row: { id: string | null; limits?: unknown } | undefined;
  if (!guard)
    row = (await database(bindings).query<{ id: string }>(account))[0];
  else {
    let guarded:
      { guard: unknown; id: string | null; limits: unknown } | undefined;
    try {
      guarded = (
        await database(bindings).query<{
          guard: unknown;
          id: string | null;
          limits: unknown;
        }>(
          sql`SELECT ${guard.value} AS guard, (${account}) AS id, ${storeLimits} AS limits`,
        )
      )[0];
    } catch {
      throw guard.outage();
    }
    guard.admit(guarded?.guard);
    row = guarded;
  }
  if (!row?.id)
    throw new StoreError(
      "account_unavailable",
      "Sign in to Milton before connecting your assistant.",
      403,
    );
  return {
    userId: row.id,
    [verifiedStoreIdentity]: true,
    ...(guard ? { limits: row.limits } : {}),
  };
}

/** The account a parsed connection key grants and the key's scope, or a
 * refusal alike for every reason (see authenticateConnectionKey). */
export async function connectionKeyAccount(
  bindings: StoreBindings & { issuer: string },
  key: { id: string; secret: string },
): Promise<
  | { ok: true; auth: AssistantAuth; keyId: string; scope: KeyScope }
  | { ok: false }
> {
  const checked = await authenticateConnectionKey(
    database(bindings),
    bindings.issuer,
    key,
    storeLimits,
  );
  if (!checked.ok) return checked;
  return {
    ok: true,
    auth: {
      userId: checked.userId,
      [verifiedStoreIdentity]: true,
      limits: checked.alongside,
    },
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
  /** Counts one admitted call, on `session` (a save's own transaction) or
   * alone; with an intent naming a kind, only when that kind is the account's. */
  chargeToolCall(
    session?: StoreSession,
    intent?: ReportIntent,
  ): Promise<CallAllowance>;
}

/** An account's store, refused once the account is not active. */
export async function storeForCurrentRequest(
  bindings: StoreBindings & { appOrigin: string },
  auth: VerifiedStoreAuth,
  assistant?: { issuer: string; clientId: string },
): Promise<TenantStore> {
  const db = database(bindings);
  const limits = await readLimits(db);
  await requireActiveAccount(db, auth.userId, { lock: false });
  return tenantStore(bindings, { ...auth, limits }, assistant);
}

/** The store for an `auth` this request just looked up, which required an
 * active account; built without a query. Every tool call's charge and every
 * read and save check the account again.
 *
 * A call is charged only once it is admitted: access, scope and limits were
 * checked before the store was built and the SDK validated the input before
 * the tool ran; each read and save then checks the trial gate, and the charge
 * comes next, right before the tool's own work (the snapshot read, or the
 * save's decision under its account lock). Any refusal before it counts
 * nothing. */
export function tenantStore(
  bindings: StoreBindings & { appOrigin: string },
  auth: AssistantAuth,
  assistant?: { issuer: string; clientId: string },
): TenantStore {
  // Refused before any write, so invalid limits never count a call.
  const limits = parseLimits(auth.limits);
  const userId = auth.userId;
  const db = database(bindings);
  // The trial status the latest read's gate admitted, for that call's notice.
  let gated: TrialStatus | undefined;
  // Through the returned store, so a fixture can stand in for the charge.
  const admit = async (session: StoreSession, intent?: ReportIntent) => {
    const allowance = await store.chargeToolCall(session, intent);
    if (!allowance.allowed)
      throw new StoreError(
        "rate_limited",
        "The daily tool-call allowance is used.",
        429,
        { limit: allowance.limit, retry_at_ms: allowance.retry_at_ms },
      );
  };
  const compiled = compiledMemos(
    db,
    userId,
    assistant,
    (status) => {
      gated = status;
    },
    admit,
  );
  const store: TenantStore = {
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
    /** One statement, so one round trip, in its own implicit transaction or
     * the save's. It takes the account row lock the deletion and every writer
     * take, held until that transaction commits: a deletion that holds it
     * first leaves no active row (the charge refuses and counts nothing); one
     * that comes second waits and then sees, and cascades, the counted call.
     * The conditional increment is one row update, so concurrent charges
     * never both take the last unit. The limit is the one this request's
     * access statement read and validated. An unknown kind_id counts nothing
     * and is refused as the read would refuse it. */
    async chargeToolCall(session = db, intent) {
      const row = (
        await session.query<{
          day: string;
          open: boolean;
          kind_valid: boolean;
          charged: boolean;
        }>(
          sql`WITH account AS (
            SELECT id FROM users WHERE id=${userId} AND status='active' FOR UPDATE),
          today AS (SELECT (clock_timestamp() AT TIME ZONE 'UTC')::date AS day),
          kind AS (SELECT ${intent?.kind_id ? sql`EXISTS(SELECT 1 FROM sample_kinds WHERE user_id=${userId} AND id=${intent.kind_id} AND report=${intent.report})` : sql`true`} AS valid),
          charged AS (
            INSERT INTO usage_daily (user_id,day_utc,tool_calls)
            SELECT account.id, today.day, 1 FROM account, today, kind WHERE kind.valid
            ON CONFLICT (user_id,day_utc) DO UPDATE SET tool_calls = usage_daily.tool_calls + 1
            WHERE usage_daily.tool_calls < ${limits.daily_calls}
            RETURNING tool_calls)
          SELECT today.day::text AS day,
            EXISTS(SELECT 1 FROM account) AS open,
            (SELECT valid FROM kind) AS kind_valid,
            EXISTS(SELECT 1 FROM charged) AS charged
          FROM today`,
        )
      )[0]!;
      if (!row.open) throw accountUnavailable();
      if (!row.kind_valid) throw invalidKind();
      return row.charged
        ? { allowed: true as const }
        : {
            allowed: false as const,
            limit: "day" as const,
            retry_at_ms: Date.parse(`${row.day}T00:00:00Z`) + 86400000,
          };
    },
  };
  return store;
}

// The web app reads with the person's own session: no assistant, so no saves and
// no charged calls. It reads no limits (they bound only saves and charges) and
// makes no separate account check: the lookup behind `auth` required an active
// account, and every read's snapshot statement refuses one that is not.
export function personStoreForCurrentRequest(
  bindings: StoreBindings,
  auth: VerifiedStoreAuth,
) {
  const db = database(bindings);
  const compiled = compiledMemos(db, auth.userId);
  return {
    readTpsReport: compiled.getTpsReport,
    readDocuments: compiled.readDocuments,
    exportTpsReport: compiled.exportTpsReport,
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
