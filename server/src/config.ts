import type { StoreBindings } from "./store";
import { StoreError } from "./store/errors";
import type { McpConfig } from "./handler";
import type { customFetch, Configuration } from "openid-client";

export interface RuntimeConfig extends StoreBindings {
  issuer: string;
  resource: string;
  appOrigin: string;
  oidc: { clientId: string; clientSecret: string };
  trialFingerprintKey: string;
  /** Private protocol transport injection; never populated from env/requests. */
  authFetch?: Configuration[typeof customFetch];
  /** The address pages give for support; the hosted one when unset. */
  supportEmail?: string;
  /** Stripe, for the app service only; unset means billing answers 503. */
  billing?: BillingConfig;
}
/** The admission service's settings (MILTON_SERVICE=admit): the database, the
 * issuer whose accounts it admits, the bearer auth sends, the trial-eligibility
 * key and Stripe. No browser, OIDC client or MCP setting. */
export interface AdmitConfig extends StoreBindings {
  issuer: string;
  admissionSecret: string;
  trialFingerprintKey: string;
  /** Stripe without the webhook secret: admission only starts trials. */
  billing?: StripeApiConfig;
}
/** Stripe API settings, from STRIPE_SECRET_KEY and STRIPE_PRICE_ID. */
export interface StripeApiConfig {
  secretKey: string;
  priceId: string;
  /** Private dependency injection for tests; never populated from env. */
  fetch?: (url: string, init: RequestInit) => Promise<Response>;
}
/** Stripe settings for the app service: the API settings and
 * STRIPE_WEBHOOK_SECRET. The MCP service never reads them. */
export interface BillingConfig extends StripeApiConfig {
  webhookSecret: string;
}

// Both unset leaves Stripe off; either set means both must be valid, or startup
// fails. Values are never logged or echoed.
export function stripeApiConfig(
  env: NodeJS.ProcessEnv,
): StripeApiConfig | undefined {
  const secretKey = env.STRIPE_SECRET_KEY;
  const priceId = env.STRIPE_PRICE_ID;
  if (secretKey === undefined && priceId === undefined) return undefined;
  if (
    !secretKey ||
    !priceId ||
    !/^(sk|rk)_(test|live)_[A-Za-z0-9]{8,247}$/.test(secretKey) ||
    !/^price_[A-Za-z0-9]{1,250}$/.test(priceId)
  )
    throw new StoreError(
      "configuration",
      "Milton's server configuration is unavailable.",
    );
  return { secretKey, priceId };
}

// All unset leaves billing off: the billing routes answer 503 and the rest of the
// app runs. Any one set means all three must be valid, or startup fails: a typo
// must not silently switch off the rule that no new approval lands without a
// subscription. Values are never logged or echoed.
export function billingConfig(
  env: NodeJS.ProcessEnv,
): BillingConfig | undefined {
  const webhookSecret = env.STRIPE_WEBHOOK_SECRET;
  const api = stripeApiConfig(env);
  if (!api && webhookSecret === undefined) return undefined;
  if (
    !api ||
    !webhookSecret ||
    !/^whsec_[A-Za-z0-9+/=]{8,250}$/.test(webhookSecret)
  )
    throw new StoreError(
      "configuration",
      "Milton's server configuration is unavailable.",
    );
  return { ...api, webhookSecret };
}

const HOSTED_SUPPORT_EMAIL = "support@meetmilton.com";
export const supportEmail = (config: Pick<RuntimeConfig, "supportEmail">) =>
  config.supportEmail ?? HOSTED_SUPPORT_EMAIL;
export const isLoopback = (hostname: string) =>
  ["localhost", "127.0.0.1", "[::1]"].includes(hostname);

const validUrl = (env: NodeJS.ProcessEnv, url: URL) =>
  !url.username &&
  !url.password &&
  !url.search &&
  !url.hash &&
  (url.protocol === "https:" ||
    (env.NODE_ENV !== "production" &&
      url.protocol === "http:" &&
      isLoopback(url.hostname)));

export function mcpRuntimeConfig(
  env: NodeJS.ProcessEnv = process.env,
): McpConfig {
  try {
    const app = new URL(env.APP_ORIGIN!);
    const issuer = new URL(env.AUTH_ISSUER!);
    const resource = new URL(env.MCP_RESOURCE!);
    const valid = (url: URL) => validUrl(env, url);
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
  if (
    !env.AUTH_APP_CLIENT_ID ||
    env.AUTH_APP_CLIENT_ID.length > 2048 ||
    !env.AUTH_APP_CLIENT_SECRET ||
    env.AUTH_APP_CLIENT_SECRET.length < 32 ||
    !env.MILTON_TRIAL_FINGERPRINT_KEY ||
    env.MILTON_TRIAL_FINGERPRINT_KEY.length < 32
  )
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
    oidc: {
      clientId: env.AUTH_APP_CLIENT_ID,
      clientSecret: env.AUTH_APP_CLIENT_SECRET,
    },
    trialFingerprintKey: env.MILTON_TRIAL_FINGERPRINT_KEY,
    ...(support === undefined ? {} : { supportEmail: support }),
    ...(billing ? { billing } : {}),
  };
}

export function admitRuntimeConfig(
  env: NodeJS.ProcessEnv = process.env,
): AdmitConfig {
  const issuer = URL.canParse(env.AUTH_ISSUER ?? "")
    ? new URL(env.AUTH_ISSUER!)
    : undefined;
  if (
    !issuer ||
    !validUrl(env, issuer) ||
    issuer.href.endsWith("/") ||
    !env.AUTH_ADMISSION_SECRET ||
    env.AUTH_ADMISSION_SECRET.length < 32 ||
    !env.MILTON_TRIAL_FINGERPRINT_KEY ||
    env.MILTON_TRIAL_FINGERPRINT_KEY.length < 32
  )
    throw new StoreError(
      "configuration",
      "Milton's server configuration is unavailable.",
    );
  // Admission starts trials but never verifies webhooks: no webhook secret.
  const billing = stripeApiConfig(env);
  return {
    issuer: issuer.href,
    admissionSecret: env.AUTH_ADMISSION_SECRET,
    trialFingerprintKey: env.MILTON_TRIAL_FINGERPRINT_KEY,
    DATABASE_URL: env.DATABASE_URL,
    ...(billing ? { billing } : {}),
  };
}
