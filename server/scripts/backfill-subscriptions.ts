import { ensureSubscription, resyncCustomer } from "../src/billing";
import { runtimeConfig, type RuntimeConfig } from "../src/config";
import { loadEnvironment } from "../src/environment";
import {
  StoreError,
  subscriptionBackfill,
  type StoreBindings,
} from "../src/store";
import { AuthError } from "../src/token";

// About 5 accounts a second: each one fires webhooks, and each webhook reads Stripe.
const PACE_MS = 200;

export type BackfillCounts = {
  total: number;
  created: number;
  skipped: number;
  failed: number;
  still_null: number;
};

const refuse = (message: string) => new StoreError("configuration", message);

/** Both modes refuse without trials_enabled and a live key. */
async function guarded(
  config: StoreBindings & Pick<RuntimeConfig, "billing">,
  allowTestKey: boolean,
) {
  if (!(await subscriptionBackfill(config).trialsEnabled()))
    throw refuse("trials_enabled is off.");
  const billing = config.billing;
  if (!billing?.secretKey) throw refuse("Billing is not configured.");
  if (!allowTestKey && !/^(sk|rk)_live_/.test(billing.secretKey))
    throw refuse(
      "Billing has no live key. Pass --allow-test-key only on a disposable database.",
    );
  return billing;
}

/** Starts the 30-day Stripe trial for every active account still without a
 * subscription. Dry run unless apply is set. Rows with a status are skipped, so a
 * rerun is safe and canceled rows never get a trial, and a returning deleted
 * identity an older image left with no status is canceled and counted as skipped,
 * as is an account whose deletion has begun. Sends Stripe no email, since
 * Milton holds none. created counts accounts that now hold a subscription, whether
 * started here or found at Stripe. */
export async function backfillSubscriptions(
  config: StoreBindings & Pick<RuntimeConfig, "billing">,
  {
    apply = false,
    allowTestKey = false,
  }: { apply?: boolean; allowTestKey?: boolean } = {},
  pause: () => Promise<unknown> = () => Bun.sleep(PACE_MS),
): Promise<BackfillCounts> {
  const store = subscriptionBackfill(config);
  await guarded(config, allowTestKey);
  if (apply) await store.cancelReturning();
  const accounts = await store.accounts();
  const waiting = accounts.filter(
    ({ status, returning }) => status === null && !returning,
  );
  const counts = {
    total: accounts.length,
    created: 0,
    skipped: accounts.length - waiting.length,
    failed: 0,
  };
  if (apply)
    for (const { id } of waiting) {
      try {
        await store.enroll(id);
        await ensureSubscription(config, id);
        counts.created++;
      } catch (error) {
        // An account whose deletion has begun is skipped, never enrolled.
        if (error instanceof AuthError && error.code === "account_deleting")
          counts.skipped++;
        // ensureSubscription has logged where, class and code; the row stays NULL.
        else counts.failed++;
      }
      await pause();
    }
  return {
    ...counts,
    still_null: apply
      ? (await store.accounts()).filter(({ status }) => status === null).length
      : waiting.length,
  };
}

/** A dry run changes nothing, so its waiting rows are not a failure. */
export const backfillExitCode = (counts: BackfillCounts, apply: boolean) =>
  apply && counts.still_null > 0 ? 1 : 0;

export type ResyncCounts = {
  total: number;
  reconciled: number;
  failed: number;
};

/** Re-reads every stored Stripe customer of a non-test account from Stripe, as a
 * webhook does, and writes what it finds through the webhook's compare-and-set,
 * with no event. Run once after a release whose old and new revisions overlapped:
 * a write from the old code does not advance stripe_revision, so a new read could
 * have landed over it, and checkout does not read Stripe for a status it already
 * manages. Dry run unless apply is set; the dry run calls Stripe for nothing. A
 * failed read or a second conflict counts as failed: rerun it. */
export async function resyncSubscriptions(
  config: StoreBindings & Pick<RuntimeConfig, "billing">,
  {
    apply = false,
    allowTestKey = false,
  }: { apply?: boolean; allowTestKey?: boolean } = {},
  pause: () => Promise<unknown> = () => Bun.sleep(PACE_MS),
): Promise<ResyncCounts> {
  const resync = resyncCustomer(await guarded(config, allowTestKey), config);
  const customers = await resync.customers();
  const counts = { total: customers.length, reconciled: 0, failed: 0 };
  if (apply)
    for (const customer of customers) {
      try {
        if (await resync.reconcile(customer)) counts.reconciled++;
      } catch {
        counts.failed++;
      }
      await pause();
    }
  return counts;
}

export const resyncExitCode = (counts: ResyncCounts, apply: boolean) =>
  apply && counts.failed > 0 ? 1 : 0;

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (
    args.some(
      (arg) => !["--apply", "--allow-test-key", "--resync"].includes(arg),
    )
  ) {
    console.error(`Usage:
  bun --no-env-file scripts/backfill-subscriptions.ts [--resync] [--apply] [--allow-test-key]

Run from a checkout, not the image. Uses the app's settings: explicit environment
variables, or a dotenvx payload file in MILTON_ENCRYPTED_ENV_FILE with
DOTENV_PRIVATE_KEY. Dry run unless --apply is passed. Requires trials_enabled and a
live Stripe key; --allow-test-key is for disposable databases only. Prints counts
only. Without --resync it starts missing trials and exits nonzero if --apply leaves
any account with no status. With --resync it re-reads every stored customer from
Stripe and writes what it finds, and exits nonzero if --apply failed any.`);
    process.exit(2);
  }
  const apply = args.includes("--apply");
  const options = { apply, allowTestKey: args.includes("--allow-test-key") };
  try {
    const config = runtimeConfig(loadEnvironment());
    if (args.includes("--resync")) {
      const counts = await resyncSubscriptions(config, options);
      console.log(JSON.stringify({ resync: true, apply, ...counts }));
      process.exitCode = resyncExitCode(counts, apply);
    } else {
      const counts = await backfillSubscriptions(config, options);
      console.log(JSON.stringify({ apply, ...counts }));
      process.exitCode = backfillExitCode(counts, apply);
    }
  } catch (error) {
    console.error(
      error instanceof StoreError
        ? error.message
        : "The backfill failed; no details were logged.",
    );
    process.exitCode = 1;
  }
}
