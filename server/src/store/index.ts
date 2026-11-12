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
import { accountUnavailable } from "./accounts";
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
  lockStripeAccount,
  enrollForBackfill,
  linkStripeCustomer,
  lockWaitingSubscription,
  recordStripeEvent,
  saveStripeSubscription,
  saveCustomerState,
  storedCustomers,
  stripeCustomerRow,
  stripeEventRecorded,
  type StripeEvent,
  type StripeSubscriptionState,
} from "./billing";
import {
  compiledMemos,
  type SaveMemoInput,
  type SaveOutcome,
} from "./compiled";
import type { ReportIntent, ReportRead } from "./memos";
import { tpsStore } from "./tps";
import { parseLimits, readLimits } from "./limits";
import { recordToolUsage, type CallUsage } from "./usage";
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
            WHERE u.id=${id} AND c.singleton=1 AND NOT u.test_account
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

/** The id of the active account a sign-in identity owns; `subject` may be a
 * column of the enclosing statement. */
const activeAccount = (provider: string, subject: string | SQL) => sql`
        SELECT u.id FROM identities i JOIN users u ON u.id=i.user_id
        WHERE i.provider=${provider} AND i.subject=${subject} AND u.status='active'`;
const noAccount = () =>
  new StoreError(
    "account_unavailable",
    "Sign in to Milton before connecting your AI.",
    403,
  );

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
  const account = activeAccount(provider, subject);
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
  if (!row?.id) throw noAccount();
  return {
    userId: row.id,
    [verifiedStoreIdentity]: true,
    ...(guard ? { limits: row.limits } : {}),
  };
}

/** A browser session read in one statement with its identity's active
 * account. `session.statement` selects at most one session row, with its
 * `subject`; `admit` turns that row into the signed-in user, or null for no
 * usable session, before any account is minted, and a failed statement is the
 * caller's `outage`. `account()` then refuses as lookupIdentityAccount does
 * when the identity has no active account. */
export async function lookupSessionAccount<User>(
  bindings: StoreBindings,
  provider: string,
  session: {
    statement: SQL;
    admit(row: Record<string, unknown> | undefined): User | null;
    outage(): Error;
  },
): Promise<{ user: User; account(): VerifiedStoreAuth } | null> {
  let row: Record<string, unknown> | undefined;
  try {
    row = (
      await database(bindings).query(
        sql`SELECT s.*, (${activeAccount(provider, sql`s.subject`)}) AS account_id FROM (${session.statement}) s`,
      )
    )[0];
  } catch {
    throw session.outage();
  }
  const user = session.admit(row);
  if (user === null) return null;
  const id = row?.account_id;
  return {
    user,
    account() {
      if (typeof id !== "string" || !id) throw noAccount();
      return { userId: id, [verifiedStoreIdentity]: true };
    },
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

export interface TenantStore {
  /** The app's origin, for the one link served to AIs. */
  appOrigin: string;
  trialNotice?(): Promise<TrialNotice | undefined>;
  /** The report for one draft; it writes nothing. `call`, when given, is the
   * tool call this read or save serves: once admitted, its usage row is
   * appended alongside the work (see recordToolUsage). */
  readReport(intent: ReportIntent, call?: CallUsage): Promise<ReportRead>;
  saveMemo(input: SaveMemoInput, call?: CallUsage): Promise<SaveOutcome>;
  /** Whether a save receipt exists under this request id, for a
   * rollout-boundary refusal's words (docs/saves.md); never its contents. */
  requestReceipt(requestId: string): Promise<boolean>;
}

/** The store for an `auth` this request just looked up, which required an
 * active account; built without a query. Every read and save checks the
 * account again.
 *
 * A call is admitted once access, scope and limits were checked (before the
 * store was built), the SDK validated the input, and the read or save checked
 * its remaining input (a read's kind_id) and the trial gate, right before the
 * tool's own work (the read, or the save's decision under its account lock; a
 * replayed save is not admitted). Admission starts that call's usage append,
 * which runs alongside the work on its own connection; the request never
 * waits on it inside a transaction (see recordToolUsage). */
export function tenantStore(
  bindings: StoreBindings & { appOrigin: string },
  auth: AssistantAuth,
  assistant?: { issuer: string; clientId: string },
): TenantStore {
  // Invalid limits refuse every call before its work.
  parseLimits(auth.limits);
  const userId = auth.userId;
  const db = database(bindings);
  // The trial status the latest read's or save's gate admitted, for that
  // call's notice.
  let gated: TrialStatus | undefined;
  const compiled = compiledMemos(
    db,
    userId,
    assistant,
    (status) => {
      gated = status;
    },
    (call) => {
      if (!call || call.recorded) return;
      try {
        call.recorded = recordToolUsage(
          bindings.storeDatabase ?? bindings.DATABASE_URL,
          () => database(bindings),
          userId,
          call.tool,
        );
      } catch {
        /* Usage never fails a call. */
      }
    },
  );
  return {
    appOrigin: bindings.appOrigin,
    trialNotice: async () => {
      const status = gated;
      gated = undefined;
      // The claim's conditions are those of a due reminder, so when the
      // status this call's read or save just gated on has none, it would find
      // nothing.
      if (status?.reminder_stage === 0) return undefined;
      return db.transaction(async (tx) => {
        await tx.query(
          sql`SELECT set_config('lock_timeout','250ms',true), set_config('statement_timeout','500ms',true)`,
        );
        return claimTrialNotice(tx, userId, bindings.appOrigin);
      });
    },
    readReport: compiled.readReport,
    saveMemo: compiled.saveMemo,
    requestReceipt: compiled.requestReceipt,
  };
}

// The web app reads and changes memos with the person's own session: no AI,
// so no create_memo and no recorded usage. It reads no limits and makes no
// separate account check: the lookup behind `auth` required an active
// account, and every read and change refuses one that is not.
export function personStoreForCurrentRequest(
  bindings: StoreBindings,
  auth: VerifiedStoreAuth,
) {
  const db = database(bindings);
  return {
    ...tpsStore(db, auth.userId),
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
      db.transaction(async (tx) => {
        await lockStripeAccount(tx, userId);
        return linkStripeCustomer(tx, userId, customer);
      }),
    /** The stored customer, its row held for the rest of the caller's
     * transaction (account deletion's). */
    lockCustomer: async () =>
      (await lockStripeAccount(db, userId))?.customer ?? null,
    clearCustomer: () => clearStripeCustomer(db, userId),
    /** Reads Stripe with no transaction open, as the webhook does, and returns
     * what the read found, storing it if anything, only over an unchanged row (see
     * stripeConflict). An empty answer is checked too: it is what lets checkout
     * sell a subscription. */
    syncSubscription: async (
      customer: string,
      read: () => Promise<StripeSubscriptionState | undefined>,
    ) => {
      const result = await overUnchanged(
        db,
        customer,
        read,
        async (tx, state) => {
          if (state) await saveStripeSubscription(tx, userId, state);
          return state;
        },
      );
      return result ? result.written : read();
    },
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

// Checkout's live read and the webhook read Stripe with no transaction open and
// no row held. The write then runs in a short transaction that holds the
// customer's row and lands only if the row's stripe_revision is what it was
// before the read. Every write Milton's code makes of the Stripe state advances it, values unchanged
// included. So an older read cannot land after a newer one: any write that landed
// between this read's snapshot and its write moved the revision, and this one
// reads Stripe again instead. A second conflict refuses: checkout answers try
// again, and the webhook leaves the event unrecorded, so Stripe redelivers it.
// Enrolment (whileWaiting) still holds the row across its Stripe calls, so this
// short write can wait behind it up to the lock timeout, as before.
const stripeConflict = () =>
  new StoreError(
    "billing_unavailable",
    "Billing is unavailable right now. Nothing was charged. Try again.",
  );

/** Reads the customer's Stripe state with no transaction open and writes it over
 * an unchanged revision, reading again once on a conflict (see stripeConflict).
 * Nothing, without reading, when no billable row holds the customer. */
async function overUnchanged<S, T>(
  db: StoreDatabase,
  customer: string,
  read: (row: { subscription: string | null }) => Promise<S>,
  write: (tx: StoreSession, state: S) => Promise<T>,
): Promise<{ written: T } | undefined> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const before = await stripeCustomerRow(db, customer);
    if (!before) return undefined;
    const state = await read(before);
    const result = await db.transaction(async (tx) => {
      const row = await stripeCustomerRow(tx, customer, true);
      if (row?.revision !== before.revision) return undefined;
      return { written: await write(tx, state) };
    });
    if (result) return result;
  }
  throw stripeConflict();
}

/** The owner's resync (scripts/backfill-subscriptions.ts --resync): every stored
 * customer, and one customer's reconciliation without an event, through the
 * webhook's read and its compare-and-set. Answers whether a billable row held the
 * customer; a second conflict throws. */
export function stripeResync(bindings: StoreBindings) {
  const db = database(bindings);
  return {
    customers: () => storedCustomers(db),
    reconcile: async (
      customer: string,
      read: (
        customer: string,
        stored: string | null,
      ) => Promise<StripeSubscriptionState | "canceled" | undefined>,
    ) =>
      (await overUnchanged(
        db,
        customer,
        (row) => read(customer, row.subscription),
        async (tx, state) => {
          if (state) await saveCustomerState(tx, customer, state);
        },
      )) !== undefined,
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
 * holds, `read` asks Stripe for that customer's state, with no transaction open,
 * and the answer is written in the statement that records the event, over an
 * unchanged row (see stripeConflict). A `read` that throws, or a second conflict,
 * leaves nothing recorded, so Stripe redelivers.
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
  if (await stripeEventRecorded(db, event.id)) return { recorded: false };
  const result = await overUnchanged(
    db,
    customer,
    (row) => read(customer, row.subscription),
    (tx, state) =>
      recordStripeEvent(tx, event, state ? { customer, state } : undefined),
  );
  return result ? result.written : recordStripeEvent(db, event);
}
