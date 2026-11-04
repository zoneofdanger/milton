/** @jsxImportSource hono/jsx */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { BillingConfig, RuntimeConfig } from "./config";
import {
  applyStripeEvent,
  billingForAccount,
  lookupIdentityAccount,
  StoreError,
  type StripeEventAction,
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

// One form-encoded POST to the Stripe API with the restricted key. A failure
// is reported without Stripe's status, body or any request value.
async function stripePost<T>(
  billing: BillingConfig,
  path: "customers" | "checkout/sessions" | "billing_portal/sessions",
  params: Record<string, string>,
  shape: z.ZodType<T>,
  idempotencyKey?: string,
): Promise<T> {
  let body: unknown;
  try {
    const response = await (billing.fetch ?? fetch)(
      `https://api.stripe.com/v1/${path}`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${billing.secretKey}`,
          "Content-Type": "application/x-www-form-urlencoded",
          ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
        },
        body: new URLSearchParams(params),
        redirect: "error",
        signal: AbortSignal.timeout(10000),
      },
    );
    if (!response.ok) throw stripeFailed();
    body = await response.json();
  } catch {
    throw stripeFailed();
  }
  const parsed = shape.safeParse(body);
  if (!parsed.success) throw stripeFailed();
  return parsed.data;
}

const customerId = z.string().regex(/^cus_[A-Za-z0-9]{1,251}$/);
const stripeCustomer = z.object({ id: customerId });
const redirectTo = (origin: string) =>
  z.object({
    url: z
      .string()
      .max(4096)
      .refine((url) => url.startsWith(origin + "/")),
  });

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
    await lookupIdentityAccount(config, { provider: "neon", subject: user.id }),
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
  let customer = account.customer;
  if (!customer) {
    // The key makes a repeated or concurrent first checkout reuse one customer.
    const created = await stripePost(
      billing,
      "customers",
      { "metadata[milton_user_id]": store.userId },
      stripeCustomer,
      `milton-customer-${store.userId}`,
    );
    customer = (await store.linkCustomer(created.id)) ?? null;
    if (!customer) throw stripeFailed();
  }
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

const epoch = z.number().int().min(1_000_000_000).max(10_000_000_000);
const stripeEvent = z.object({
  id: z.string().regex(/^evt_[A-Za-z0-9]{1,251}$/),
  type: z.string().min(1).max(128),
  data: z.object({ object: z.unknown() }),
});
const checkoutSession = z.object({
  mode: z.string(),
  customer: customerId.nullable(),
  client_reference_id: z.string().nullable().optional(),
});
const paidInvoice = z.object({
  customer: customerId,
  lines: z.object({
    data: z.array(z.object({ period: z.object({ end: epoch }) })).min(1),
  }),
});
// Before API version 2025-03-31 the period end is on the subscription; from it
// on, on each subscription item. Either is read.
const subscription = z.object({
  customer: customerId,
  status: z.string(),
  current_period_end: epoch.optional(),
  items: z
    .object({
      data: z.array(z.object({ current_period_end: epoch.optional() })),
    })
    .optional(),
});
const latest = (ends: (number | undefined)[]) => {
  const known = ends.filter((end) => end !== undefined);
  return known.length ? Math.max(...known) : undefined;
};

// What a verified event does; undefined when a handled type is unreadable.
function eventAction(
  type: string,
  object: unknown,
): StripeEventAction | undefined {
  if (type === "checkout.session.completed") {
    const session = checkoutSession.safeParse(object);
    if (!session.success) return;
    const { mode, customer, client_reference_id: userId } = session.data;
    return mode === "subscription" &&
      customer &&
      userId &&
      /^m_[0-9a-f-]{36}$/.test(userId)
      ? { kind: "link", customer, userId }
      : { kind: "none" };
  }
  if (type === "invoice.paid") {
    const invoice = paidInvoice.safeParse(object);
    if (!invoice.success) return;
    return {
      kind: "paid_through",
      customer: invoice.data.customer,
      periodEnd: latest(
        invoice.data.lines.data.map((line) => line.period.end),
      )!,
    };
  }
  if (type === "customer.subscription.updated") {
    const sub = subscription.safeParse(object);
    if (!sub.success) return;
    // Only an active subscription extends access; past_due and later states
    // keep the paid_through already earned and let it run out.
    if (!["active", "trialing"].includes(sub.data.status))
      return { kind: "none" };
    const end =
      sub.data.current_period_end ??
      latest(sub.data.items?.data.map((item) => item.current_period_end) ?? []);
    return end === undefined
      ? undefined
      : { kind: "paid_through", customer: sub.data.customer, periodEnd: end };
  }
  if (type === "customer.subscription.deleted") {
    const sub = z.object({ customer: customerId }).safeParse(object);
    return sub.success
      ? { kind: "clear", customer: sub.data.customer }
      : undefined;
  }
  return { kind: "none" };
}

/** POST /billing/webhook. Unauthenticated: the Stripe signature is the only
 * credential. It is routed ahead of the browser pages, so no session, cookie or
 * CSRF check runs; it answers JSON only. Bounds: POST, Content-Type
 * application/json, at most WEBHOOK_MAX_BYTES read before the signature check.
 * A verified event is recorded once by id and applied in the same statement;
 * unknown types are recorded and ignored. */
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
    let action: StripeEventAction | undefined;
    try {
      event = stripeEvent.parse(
        JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body)),
      );
      action = eventAction(event.type, event.data.object);
    } catch {
      return answer(400, { error: "event_invalid" });
    }
    // A handled type Milton cannot read is refused unrecorded, so Stripe
    // retries it and shows the failure, rather than access silently not moving.
    if (!action) return answer(400, { error: "event_invalid" });
    try {
      const result = await applyStripeEvent(config, {
        id: event.id,
        type: event.type,
        payloadSha256: createHash("sha256").update(body).digest("hex"),
        action,
      });
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
