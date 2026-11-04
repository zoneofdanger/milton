/** @jsxImportSource hono/jsx */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { BillingConfig, RuntimeConfig } from "./config";
import {
  applyStripeEvent,
  billingForAccount,
  lookupIdentityAccount,
  StoreError,
  type StripeSubscriptionState,
} from "./store";
import { boundRequest } from "./http";
import { AuthError } from "./token";
import { logUnexpected } from "./error-log";
import { page } from "./pages";
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
  billing: BillingConfig,
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

const stripePost = async <T,>(
  billing: BillingConfig,
  path:
    | "customers"
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

// Every subscription the customer has, canceled included. A customer Stripe no
// longer has has none.
async function listSubscriptions(billing: BillingConfig, customer: string) {
  const response = await stripeCall(
    billing,
    "GET",
    `subscriptions?customer=${customer}&status=all&limit=10`,
  );
  if (response.status === 404) return [];
  return (
    await stripeAnswer(
      response,
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

// The key makes a repeated or concurrent first call reuse one customer. Stored
// before anything else happens with it, so a later failure leaves it findable.
async function createCustomer(
  billing: BillingConfig,
  store: ReturnType<typeof billingForAccount>,
  email?: string,
) {
  const created = await stripePost(
    billing,
    "customers",
    {
      "metadata[milton_user_id]": store.userId,
      ...(email ? { email } : {}),
    },
    stripeCustomer,
    `milton-customer-${store.userId}`,
  );
  const customer = await store.linkCustomer(created.id);
  if (!customer) throw stripeFailed();
  return customer;
}

/** Gives an enrolled account with no subscription its 30-day Stripe trial; a
 * no-op for any other account or without billing. A stored customer is listed
 * first, so a retry stores what exists rather than starting a second trial. Never
 * throws: a sign-up that hits a Stripe failure heals at the next sign-in, and the
 * gate allows the account meanwhile. Each Stripe call is bound by its timeout. */
export async function ensureSubscription(
  config: RuntimeConfig,
  userId: string,
  email?: string,
) {
  const billing = config.billing;
  if (!billing) return;
  try {
    const store = billingForAccount(config, userId);
    const account = await store.account();
    if (!account.enrolled || account.status !== null) return;
    if (account.customer) {
      const found = decidingSubscription(
        await listSubscriptions(billing, account.customer),
      );
      if (found) return await store.saveSubscription(found);
    }
    const customer =
      account.customer ?? (await createCustomer(billing, store, email));
    await store.saveSubscription(
      await stripePost(
        billing,
        "subscriptions",
        {
          customer,
          "items[0][price]": billing.priceId,
          trial_period_days: "30",
          "payment_settings[save_default_payment_method]": "on_subscription",
          "trial_settings[end_behavior][missing_payment_method]": "cancel",
        },
        stripeSubscription,
        `milton-subscription-${userId}`,
      ),
    );
  } catch (error) {
    logUnexpected("billing", error);
  }
}

/** POST /billing/checkout and POST /billing/portal: signed-in forms with the
 * page CSRF check. Checkout finds or creates the account's Stripe customer,
 * stores it on the clock row, and redirects to a subscription Checkout for the
 * one price; an account already paid goes to the portal instead. */
export async function billingRoutes(ctx: PageContext): Promise<Response> {
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
        provider: "neon",
        subject: user.id,
      })
    ).userId,
  );
  const account = await store.account();
  const home = config.appOrigin + "/";
  const portal = async (customer: string) =>
    Response.redirect(
      (
        await stripePost(
          billing,
          "billing_portal/sessions",
          { customer, return_url: home },
          redirectTo("https://billing.stripe.com"),
        )
      ).url,
      303,
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
  if (account.paid && account.customer) return portal(account.customer);
  const customer =
    account.customer ?? (await createCustomer(billing, store, user.email));
  const session = await stripePost(
    billing,
    "checkout/sessions",
    {
      mode: "subscription",
      customer,
      client_reference_id: store.userId,
      "line_items[0][price]": billing.priceId,
      "line_items[0][quantity]": "1",
      success_url: home,
      cancel_url: home,
    },
    redirectTo("https://checkout.stripe.com"),
  );
  return Response.redirect(session.url, 303);
}

/** The webhook body bound, read before the signature check. */
export const WEBHOOK_MAX_BYTES = 262144;
const SIGNATURE_TOLERANCE_SECONDS = 300;

/** Stripe's v1 scheme: HMAC-SHA256 of `${t}.${body}` with the endpoint secret,
 * any listed v1 matching in constant time, t within five minutes of now. */
export function verifyStripeSignature(
  body: Uint8Array,
  header: string | null,
  secret: string,
  nowSeconds = Date.now() / 1000,
) {
  if (!header || header.length > 4096) return false;
  let timestamp: string | undefined;
  const signatures: string[] = [];
  for (const part of header.split(",")) {
    const at = part.indexOf("=");
    if (at < 0) continue;
    const key = part.slice(0, at).trim();
    const value = part.slice(at + 1).trim();
    if (key === "t") timestamp = value;
    else if (key === "v1") signatures.push(value);
  }
  if (
    !timestamp ||
    !/^\d{1,12}$/.test(timestamp) ||
    Math.abs(nowSeconds - Number(timestamp)) > SIGNATURE_TOLERANCE_SECONDS
  )
    return false;
  const expected = createHmac("sha256", secret)
    .update(`${timestamp}.`)
    .update(body)
    .digest();
  return signatures.some(
    (signature) =>
      /^[a-f0-9]{64}$/.test(signature) &&
      timingSafeEqual(Buffer.from(signature, "hex"), expected),
  );
}

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
 * subscription that decides access, or "canceled" when Stripe no longer has the
 * stored one, or nothing when neither side has one yet. */
async function currentSubscription(
  billing: BillingConfig,
  customer: string,
  stored: string | null,
) {
  const subscriptions = await listSubscriptions(billing, customer);
  return (
    decidingSubscription(subscriptions) ?? (stored ? "canceled" : undefined)
  );
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
    if (
      !verifyStripeSignature(
        body,
        request.headers.get("Stripe-Signature"),
        billing.webhookSecret,
      )
    )
      return answer(400, { error: "signature_invalid" });
    let event: z.infer<typeof stripeEvent>;
    let customer: string | null = null;
    try {
      event = stripeEvent.parse(
        JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body)),
      );
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
