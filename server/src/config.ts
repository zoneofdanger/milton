import type { StoreBindings } from "./store";
import { StoreError } from "./store/errors";
import type { McpConfig } from "./handler";

export interface RuntimeConfig extends StoreBindings {
  issuer: string;
  resource: string;
  appOrigin: string;
  cookieSecret: string;
  /** The address pages give for support; the hosted one when unset. */
  supportEmail?: string;
  /** Stripe, for the app service only; unset means billing answers 503. */
  billing?: BillingConfig;
}
/** Stripe settings for the app service, from STRIPE_SECRET_KEY,
 * STRIPE_WEBHOOK_SECRET and STRIPE_PRICE_ID. The MCP service never reads them. */
export interface BillingConfig {
  secretKey: string;
  webhookSecret: string;
  priceId: string;
  /** Private dependency injection for tests; never populated from env. */
  fetch?: (url: string, init: RequestInit) => Promise<Response>;
}

// All unset leaves billing off: the billing routes answer 503 and the rest of the
// app runs. Any one set means all three must be valid, or startup fails: a typo
// must not silently switch off the rule that no new approval lands without a
// subscription. Values are never logged or echoed.
export function billingConfig(
  env: NodeJS.ProcessEnv,
): BillingConfig | undefined {
  const secretKey = env.STRIPE_SECRET_KEY;
  const webhookSecret = env.STRIPE_WEBHOOK_SECRET;
  const priceId = env.STRIPE_PRICE_ID;
  if (
    secretKey === undefined &&
    webhookSecret === undefined &&
    priceId === undefined
  )
    return undefined;
  if (
    !secretKey ||
    !webhookSecret ||
    !priceId ||
    !/^(sk|rk)_(test|live)_[A-Za-z0-9]{8,247}$/.test(secretKey) ||
    !/^whsec_[A-Za-z0-9+/=]{8,250}$/.test(webhookSecret) ||
    !/^price_[A-Za-z0-9]{1,250}$/.test(priceId)
  )
    throw new StoreError(
      "configuration",
      "Milton's server configuration is unavailable.",
    );
  return { secretKey, webhookSecret, priceId };
}

const HOSTED_SUPPORT_EMAIL = "support@meetmilton.com";
export const supportEmail = (config: Pick<RuntimeConfig, "supportEmail">) =>
  config.supportEmail ?? HOSTED_SUPPORT_EMAIL;
export const isLoopback = (hostname: string) =>
  ["localhost", "127.0.0.1", "[::1]"].includes(hostname);

export function mcpRuntimeConfig(
  env: NodeJS.ProcessEnv = process.env,
): McpConfig {
  try {
    const app = new URL(env.APP_ORIGIN!);
    const issuer = new URL(env.NEON_AUTH_BASE_URL!);
    const resource = new URL(env.MCP_RESOURCE!);
    const valid = (url: URL) =>
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      (url.protocol === "https:" ||
        (env.NODE_ENV !== "production" &&
          url.protocol === "http:" &&
          isLoopback(url.hostname)));
    if (
      !valid(app) ||
      !valid(issuer) ||
      !valid(resource) ||
      app.href !== app.origin + "/" ||
      resource.pathname !== "/mcp" ||
      issuer.href.endsWith("/")
    )
      throw new Error();
    return {
      issuer: issuer.href,
      resource: resource.href,
      appOrigin: app.origin,
      DATABASE_URL: env.DATABASE_URL,
    };
  } catch {
    throw new StoreError(
      "configuration",
      "Milton's server configuration is unavailable.",
    );
  }
}

export function runtimeConfig(
  env: NodeJS.ProcessEnv = process.env,
): RuntimeConfig {
  const config = mcpRuntimeConfig(env);
  if (!env.NEON_AUTH_COOKIE_SECRET || env.NEON_AUTH_COOKIE_SECRET.length < 32)
    throw new StoreError(
      "configuration",
      "Milton's server configuration is unavailable.",
    );
  const support = env.MILTON_SUPPORT_EMAIL;
  if (
    support !== undefined &&
    !/^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,253}\.[A-Za-z]{2,63}$/.test(
      support,
    )
  )
    throw new StoreError(
      "configuration",
      "Milton's server configuration is unavailable.",
    );
  const billing = billingConfig(env);
  return {
    ...config,
    cookieSecret: env.NEON_AUTH_COOKIE_SECRET,
    ...(support === undefined ? {} : { supportEmail: support }),
    ...(billing ? { billing } : {}),
  };
}
