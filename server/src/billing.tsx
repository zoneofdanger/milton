/** @jsxImportSource hono/jsx */
import { createHash } from "node:crypto";
import Stripe from "stripe";
import { z } from "zod";
import type { RuntimeConfig, StripeApiConfig } from "./config";
import {
  applyStripeEvent,
  billingForAccount,
  lookupIdentityAccount,
  StoreError,
  stripeResync,
  type StoreBindings,
  type StripeSubscriptionState,
} from "./store";
import { boundRequest, inOrder } from "./http";
import { AuthError } from "./token";
import { logUnexpected } from "./error-log";
import { navigation, page } from "./pages";
import type { PageContext } from "./auth-session";

const noStore = { "Cache-Control": "no-store" };
const unavailable = () =>
  Response.json(
    {
      error: "billing_unavailable",
      message: "Billing is not available yet.",
    },
    { status: 503, headers: noStore },
  );
const stripeFailed = () =>
  new AuthError(
    "billing_unavailable",
    "Billing is unavailable right now. Nothing was charged. Try again.",
    503,
  );

// Stripe's API version, pinned so the shapes read here never move with the
// account's default. Periods live on subscription items from 2025-03-31 on.
const STRIPE_VERSION = "2026-10-28.endive";
const STRIPE_TIMEOUT_MS = 5000;

// One call to the Stripe API with the restricted key. A failure is reported
// without Stripe's status, body or any request value.
async function stripeCall(
  billing: StripeApiConfig,
  method: "GET" | "POST" | "DELETE",
  path: string,
  params?: Record<string, string>,
  idempotencyKey?: string,
) {
  try {
    return await (billing.fetch ?? fetch)(`https://api.stripe.com/v1/${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${billing.secretKey}`,
        "Stripe-Version": STRIPE_VERSION,
        ...(params
          ? { "Content-Type": "application/x-www-form-urlencoded" }
          : {}),
        ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
      },
      ...(params ? { body: new URLSearchParams(params) } : {}),
      redirect: "error",
      signal: AbortSignal.timeout(STRIPE_TIMEOUT_MS),
    });
  } catch {
    throw stripeFailed();
  }
}

async function stripeAnswer<T>(response: Response, shape: z.ZodType<T>) {
  if (!response.ok) throw stripeFailed();
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw stripeFailed();
  }
  const parsed = shape.safeParse(body);
  if (!parsed.success) throw stripeFailed();
  return parsed.data;
}

// Stripe accepts 30 minutes to 24 hours after it creates the session; the
// extra minute keeps network delay and clock skew from undercutting the minimum.
// Each click opens a new session with no idempotency key, so nothing replays a
// stale expiry.
const CHECKOUT_LIFETIME_SECONDS = 1860;

const stripePost = async <T,>(
  billing: StripeApiConfig,
  path:
    | "customers"
    | `customers/${string}`
    | "subscriptions"
    | "checkout/sessions"
    | "billing_portal/sessions",
  params: Record<string, string>,
  shape: z.ZodType<T>,
  idempotencyKey?: string,
) =>
  stripeAnswer(
    await stripeCall(billing, "POST", path, params, idempotencyKey),
    shape,
  );

const customerId = z.string().regex(/^cus_[A-Za-z0-9]{1,251}$/);
const stripeCustomer = z.object({ id: customerId });
const epoch = z.number().int().min(1_000_000_000).max(10_000_000_000);
// Only item-level periods: the pinned API version has no other.
const stripeSubscription = z
  .object({
    id: z.string().regex(/^sub_[A-Za-z0-9]{1,251}$/),
    status: z.string().min(1).max(64),
    created: epoch,
    trial_end: epoch.nullable(),
    items: z.object({
      data: z
        .array(
          z.object({ current_period_start: epoch, current_period_end: epoch }),
        )
        .min(1),
    }),
  })
  .transform((sub) => ({
    id: sub.id,
    status: sub.status,
    created: sub.created,
    trialEnd: sub.trial_end,
    periodStart: sub.items.data[0]!.current_period_start,
    periodEnd: sub.items.data[0]!.current_period_end,
  }));
type StripeSubscription = StripeSubscriptionState & { created: number };

// Every subscription the customer has, canceled included. Any non-2xx is a failed
// read, 404 too: an unknown customer proves nothing, and a key from the wrong mode
// would otherwise mark paying people canceled.
async function listSubscriptions(billing: StripeApiConfig, customer: string) {
  return (
    await stripeAnswer(
      await stripeCall(
        billing,
        "GET",
        `subscriptions?customer=${customer}&status=all&limit=10`,
      ),
      z.object({ data: z.array(stripeSubscription) }),
    )
  ).data;
}

const STATUS_ORDER = ["active", "trialing", "past_due"];
const statusRank = ({ status }: StripeSubscription) => {
  const rank = STATUS_ORDER.indexOf(status);
  return rank < 0 ? STATUS_ORDER.length : rank;
};
/** active, then trialing, then past_due, otherwise the newest. */
const decidingSubscription = (subscriptions: StripeSubscription[]) =>
  subscriptions.toSorted(
    (a, b) => statusRank(a) - statusRank(b) || b.created - a.created,
  )[0];

const redirectTo = (origin: string) =>
  z.object({
    url: z
      .string()
      .max(4096)
      .refine((url) => url.startsWith(origin + "/")),
  });

// A key that lasts one UTC minute. Stripe replays a stored error for the same key
// for 24 hours or more, and refuses the same key with other params; under the
// rule that a failure stops the sign-in, a fixed key would lock the person out for
// a day. Double submits within a minute still dedupe, and listing under the row
// lock reconciles a later retry, with one gap: a create that timed out here and is
// still running at Stripe can be missed once the minute has turned.
const idempotencyKey = (kind: "customer" | "subscription", userId: string) =>
  `milton-${kind}-${userId}-${Math.floor(Date.now() / 60000)}`;

// Stored before anything else happens with it, so a later failure leaves it
// findable.
async function createCustomer(
  billing: StripeApiConfig,
  userId: string,
  link: (customer: string) => Promise<string | undefined>,
  email?: string,
) {
  const created = await stripePost(
    billing,
    "customers",
    {
      "metadata[milton_user_id]": userId,
      ...(email ? { email } : {}),
    },
    stripeCustomer,
    idempotencyKey("customer", userId),
  );
  const customer = await link(created.id);
  if (!customer) throw stripeFailed();
  return customer;
}

/** Gives an enrolled account with no subscription its 30-day Stripe trial; a
 * no-op for any other account or without billing. What Stripe already has is
 * stored rather than starting a second trial. A failure throws a 503 that says to
 * try again, and repeating the attempt is the retry. */
export async function ensureSubscription(
  config: StoreBindings & { billing?: StripeApiConfig },
  userId: string,
  email?: string,
) {
  const billing = config.billing;
  if (!billing) return;
  try {
    const store = billingForAccount(config, userId);
    const account = await store.account();
    // A test account never gets a trial, customer or subscription.
    if (account.test || !account.enrolled || account.status !== null) return;
    // The row stays locked across customer, list and create. Two attempts across
    // a minute boundary have different keys, so only the lock stops each making a
    // customer, or each listing nothing and starting a trial, which could charge
    // the person twice. That is at most three Stripe calls, 15 s; a waiter gives up
    // at the 10 s lock_timeout with the same 503. A reply lost after Stripe made the
    // customer can still leave an orphan once the minute turns: it is never
    // charged, may hold an email, and is removed by hand in Stripe if ever needed.
    await store.whileWaiting(async ({ customer: stored, link, save }) => {
      const customer =
        stored ?? (await createCustomer(billing, userId, link, email));
      await save(
        decidingSubscription(await listSubscriptions(billing, customer)) ??
          (await stripePost(
            billing,
            "subscriptions",
            {
              customer,
              "items[0][price]": billing.priceId,
              trial_period_days: "30",
              "payment_settings[save_default_payment_method]":
                "on_subscription",
              "trial_settings[end_behavior][missing_payment_method]": "cancel",
            },
            stripeSubscription,
            idempotencyKey("subscription", userId),
          )),
      );
    });
  } catch (error) {
    logUnexpected("billing", error);
    throw new AuthError(
      "auth_unavailable",
      "Milton could not start your subscription. Nothing was charged. Try again.",
      503,
    );
  }
}

/** Deletes the account's Stripe customer, which ends any subscription at once. A
 * failed DELETE proves nothing either way: a key from the wrong mode gets a 404 for
 * a live customer who would go on being charged, and a repeat on a deleted customer
 * may answer anything. So on any failure, only a read that reports the customer
 * deleted counts as done. The row then forgets the customer before Milton's own
 * delete, which can still fail. Throws on anything else, including a customer on
 * record with billing unconfigured. Issues no refund. */
export async function endStripeCustomer(config: RuntimeConfig, userId: string) {
  const store = billingForAccount(config, userId);
  const { customer } = await store.account();
  if (!customer) return;
  const billing = config.billing;
  if (!billing) throw stripeFailed();
  const path = `customers/${customer}`;
  const response = await stripeCall(billing, "DELETE", path);
  if (!response.ok)
    await stripeAnswer(
      await stripeCall(billing, "GET", path),
      z.object({ deleted: z.literal(true) }),
    );
  await store.clearCustomer();
}

// Copies the sign-in email to a stored customer, so Stripe's receipts and reminders
// reach this person. A backfilled customer has none until now, and everyone who can
// add a card or pay comes through here signed in. Never stops them paying. No
// idempotency key: repeating it is harmless, and a key would refuse a changed email.
async function copyEmail(
  billing: StripeApiConfig,
  customer: string,
  email?: string,
) {
  if (!email) return;
  try {
    await stripePost(
      billing,
      `customers/${customer}`,
      { email },
      stripeCustomer,
    );
  } catch (error) {
    logUnexpected("billing", error);
  }
}

// A subscription its person manages in the portal: a second Checkout would
// double-bill them. Stripe counts active, past_due, unpaid and paused as an
// existing subscription (Limit customers to one subscription); a trial is one too.
const MANAGED = new Set(["trialing", "active", "past_due", "unpaid", "paused"]);

/** POST /billing/checkout and POST /billing/portal: signed-in forms with the
 * page CSRF check. Checkout sends an existing subscription to the portal, stored
 * or found at Stripe, and anything else to a subscription Checkout for the one
 * price, card required, no trial. An account still waiting on its trial takes it
 * first: paying now would lose the 30 days. */
export async function billingRoutes(ctx: PageContext): Promise<Response> {
  try {
    return await billingRoute(ctx);
  } catch (error) {
    // The page logs only what it does not recognize, so a wrong key permission or
    // an archived price would otherwise show a 503 and leave no trace.
    if (error instanceof AuthError && error.code === "billing_unavailable")
      logUnexpected("billing", error);
    throw error;
  }
}

async function billingRoute(ctx: PageContext): Promise<Response> {
  const { config, request, url, readForm, signedIn } = ctx;
  const billing = config.billing;
  if (!billing) return unavailable();
  if (request.method !== "POST")
    return page(
      "Method not allowed",
      <p>Use the page's controls to continue.</p>,
      405,
    );
  await readForm();
  const user = await signedIn();
  const store = billingForAccount(
    config,
    (
      await lookupIdentityAccount(config, {
        provider: config.issuer,
        subject: user.id,
      })
    ).userId,
  );
  let account = await store.account();
  const home = config.appOrigin + "/";
  // navigation, not a redirect: form-action 'self' blocks an external Location
  // after a form, and a person could then neither pay nor add a card.
  // The portal session needs no email, so the copy runs alongside it; both
  // finish before the person leaves, and a failed copy is still only logged.
  const portal = async (customer: string) => {
    const [, session] = await inOrder(
      copyEmail(billing, customer, user.email),
      stripePost(
        billing,
        "billing_portal/sessions",
        { customer, return_url: home },
        redirectTo("https://billing.stripe.com"),
      ),
    );
    return navigation(session.url);
  };
  if (account.test)
    throw new AuthError(
      "test_account",
      "This test account has no subscription.",
      409,
    );
  if (url.pathname === "/billing/portal") {
    if (!account.customer)
      throw new AuthError(
        "subscription_not_found",
        "There is no Milton subscription to manage yet.",
        409,
      );
    return portal(account.customer);
  }
  if (!account.enrolled)
    throw new AuthError(
      "trial_not_started",
      "Subscriptions open when your Milton trial starts.",
      409,
    );
  if (account.status === null) {
    await ensureSubscription(config, store.userId, user.email);
    account = await store.account();
    if (account.status === null) throw stripeFailed();
  }
  if (account.customer && MANAGED.has(account.status))
    return portal(account.customer);
  // The stored status can lag a payment by hours, when a webhook is retrying, so
  // ask Stripe before selling a second subscription. Two sessions opened before
  // either is paid stay possible, but each expires after 31 minutes instead of
  // Stripe's default 24 hours, so an abandoned tab cannot pay a day later.
  if (account.customer) {
    const { customer } = account;
    const live = await store.syncSubscription(customer, async () =>
      decidingSubscription(
        (await listSubscriptions(billing, customer)).filter(({ status }) =>
          MANAGED.has(status),
        ),
      ),
    );
    if (live) return portal(customer);
    await copyEmail(billing, customer, user.email);
  }
  const session = await stripePost(
    billing,
    "checkout/sessions",
    {
      mode: "subscription",
      customer:
        account.customer ??
        (await createCustomer(
          billing,
          store.userId,
          store.linkCustomer,
          user.email,
        )),
      payment_method_collection: "always",
      "line_items[0][price]": billing.priceId,
      "line_items[0][quantity]": "1",
      success_url: home,
      cancel_url: home,
      expires_at: String(
        Math.floor(Date.now() / 1000) + CHECKOUT_LIFETIME_SECONDS,
      ),
    },
    redirectTo("https://checkout.stripe.com"),
  );
  return navigation(session.url);
}

/** The webhook body bound, read before the signature check. */
export const WEBHOOK_MAX_BYTES = 262144;
// Checked by Stripe's own SDK: the v1 HMAC-SHA256 of `${t}.${body}` with the
// endpoint secret, compared in constant time, t at most five minutes old.
const SIGNATURE_TOLERANCE_SECONDS = 300;

const stripeEvent = z.object({
  id: z.string().regex(/^evt_[A-Za-z0-9]{1,251}$/),
  type: z.string().min(1).max(128),
  data: z.object({ object: z.unknown() }),
});
// Every handled type carries its customer at this one field, and that is all
// Milton reads from an event: Stripe does not guarantee event order, so what an
// event says is never state, only a reason to ask Stripe for the current state.
const HANDLED_EVENTS = new Set([
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "invoice.paid",
  "invoice.payment_failed",
  "checkout.session.completed",
]);
const eventObject = z.object({ customer: customerId.nullable() });

/** The state Stripe holds now for a customer Milton has stored: the one
 * subscription that decides access, or "canceled" when a successful read lists
 * none for a stored one, or nothing when neither side has one yet. */
async function currentSubscription(
  billing: StripeApiConfig,
  customer: string,
  stored: string | null,
) {
  const subscriptions = await listSubscriptions(billing, customer);
  return (
    decidingSubscription(subscriptions) ?? (stored ? "canceled" : undefined)
  );
}

/** The owner's resync of one stored customer (scripts/backfill-subscriptions.ts
 * --resync): the webhook's read and compare-and-set, with no event. Answers whether
 * a billable row held the customer; a failed read or a second conflict throws. */
export function resyncCustomer(billing: StripeApiConfig, store: StoreBindings) {
  const resync = stripeResync(store);
  return {
    customers: resync.customers,
    reconcile: (customer: string) =>
      resync.reconcile(customer, (found, stored) =>
        currentSubscription(billing, found, stored),
      ),
  };
}

/** POST /billing/webhook. Unauthenticated: the Stripe signature is the only
 * credential. It is routed ahead of the browser pages, so no session, cookie or
 * CSRF check runs; it answers JSON only. Bounds: POST, Content-Type
 * application/json, at most WEBHOOK_MAX_BYTES read before the signature check.
 * One rule: a verified event of a handled type names a customer; if Milton holds
 * that customer, Stripe's current state is read and written in the statement that
 * records the event. Anything else is recorded and ignored. A failed read answers
 * 503 unrecorded, so Stripe redelivers. */
export function stripeWebhook(config: RuntimeConfig) {
  const answer = (status: number, body: Record<string, unknown>) =>
    Response.json(body, { status, headers: noStore });
  return async (request: Request): Promise<Response> => {
    if (request.method !== "POST")
      return Response.json(
        { error: "method_not_allowed" },
        { status: 405, headers: { ...noStore, Allow: "POST" } },
      );
    const billing = config.billing;
    if (!billing) return unavailable();
    if (
      !(request.headers.get("Content-Type") ?? "")
        .toLowerCase()
        .startsWith("application/json")
    )
      return answer(415, { error: "unsupported_media_type" });
    const bounded = await boundRequest(request, WEBHOOK_MAX_BYTES);
    if (bounded instanceof Response) return bounded;
    const body = new Uint8Array(await bounded.arrayBuffer());
    let verified: unknown;
    try {
      // The async variant: under Bun the SDK resolves to its web build, whose
      // crypto is async only. A signed body that is not JSON is event_invalid.
      verified = await Stripe.webhooks.constructEventAsync(
        body,
        request.headers.get("Stripe-Signature") ?? "",
        billing.webhookSecret,
        SIGNATURE_TOLERANCE_SECONDS,
      );
    } catch (error) {
      // Only a signed body that is not JSON is event_invalid; every other
      // failure, including the SDK's own argument errors on a malformed
      // header, is a bad signature.
      return answer(400, {
        error:
          error instanceof SyntaxError ? "event_invalid" : "signature_invalid",
      });
    }
    let event: z.infer<typeof stripeEvent>;
    let customer: string | null = null;
    try {
      event = stripeEvent.parse(verified);
      // A handled type Milton cannot read is refused unrecorded, so Stripe
      // retries it and shows the failure, rather than access silently not moving.
      if (HANDLED_EVENTS.has(event.type))
        customer = eventObject.parse(event.data.object).customer;
    } catch {
      return answer(400, { error: "event_invalid" });
    }
    try {
      const result = await applyStripeEvent(
        config,
        {
          id: event.id,
          type: event.type,
          payloadSha256: createHash("sha256").update(body).digest("hex"),
        },
        customer,
        (found, stored) => currentSubscription(billing, found, stored),
      );
      return answer(200, {
        received: true,
        ...(result.recorded ? {} : { duplicate: true }),
      });
    } catch (error) {
      if (!(error instanceof StoreError)) logUnexpected("billing", error);
      return answer(503, { error: "server_unavailable" });
    }
  };
}
