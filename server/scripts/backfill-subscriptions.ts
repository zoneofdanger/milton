import { ensureSubscription } from "../src/billing";
import { runtimeConfig, type RuntimeConfig } from "../src/config";
import { loadEnvironment } from "../src/environment";
import {
  StoreError,
  subscriptionBackfill,
  type StoreBindings,
} from "../src/store";

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

/** Starts the 30-day Stripe trial for every active account still without a
 * subscription. Dry run unless apply is set. Rows with a status are skipped, so a
 * rerun is safe and canceled rows never get a trial. Sends Stripe no email, since
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
  if (!(await store.trialsEnabled())) throw refuse("trials_enabled is off.");
  const key = config.billing?.secretKey;
  if (!key) throw refuse("Billing is not configured.");
  if (!allowTestKey && !/^(sk|rk)_live_/.test(key))
    throw refuse(
      "Billing has no live key. Pass --allow-test-key only on a disposable database.",
    );
  const accounts = await store.accounts();
  const waiting = accounts.filter(({ status }) => status === null);
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
      } catch {
        // ensureSubscription has logged where, class and code; the row stays NULL.
        counts.failed++;
      }
      await pause();
    }
  const after = apply ? await store.accounts() : accounts;
  return {
    ...counts,
    still_null: after.filter(({ status }) => status === null).length,
  };
}

/** A dry run changes nothing, so its waiting rows are not a failure. */
export const backfillExitCode = (counts: BackfillCounts, apply: boolean) =>
  apply && counts.still_null > 0 ? 1 : 0;

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.some((arg) => arg !== "--apply" && arg !== "--allow-test-key")) {
    console.error(`Usage:
  bun --no-env-file scripts/backfill-subscriptions.ts [--apply] [--allow-test-key]

Uses the app's settings. Dry run unless --apply is passed. Requires trials_enabled
and a live Stripe key; --allow-test-key is for disposable databases only. Prints
counts only, and exits nonzero if --apply leaves any account with no status.`);
    process.exit(2);
  }
  const apply = args.includes("--apply");
  try {
    const counts = await backfillSubscriptions(
      runtimeConfig(loadEnvironment()),
      {
        apply,
        allowTestKey: args.includes("--allow-test-key"),
      },
    );
    console.log(JSON.stringify({ apply, ...counts }));
    process.exitCode = backfillExitCode(counts, apply);
  } catch (error) {
    console.error(
      error instanceof StoreError
        ? error.message
        : "The backfill failed; no details were logged.",
    );
    process.exitCode = 1;
  }
}
