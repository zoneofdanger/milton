import { randomBytes } from "node:crypto";
import type { Config } from "../src/config.ts";

const secret = () => randomBytes(32).toString("hex");

/** A fictional auth configuration with fresh secrets. No provider or mail
 * credential in it is real, and the database URL is unused unless overridden. */
export const fixtureConfig = (overrides: Partial<Config> = {}): Config => ({
  AUTH_DATABASE_URL: "postgresql://unused.invalid/fixture",
  AUTH_SECRET: secret(),
  AUTH_ADMISSION_SECRET: secret(),
  // Loopback: no Google ID token. Tests intercept every fetch.
  AUTH_ADMISSION_URL: "http://127.0.0.1:19913",
  AUTH_RATE_SECRET: secret(),
  AUTH_APP_CLIENT_ID: "fixed-app-fixture",
  AUTH_GOOGLE_CLIENT_ID: "fictional-google",
  AUTH_GOOGLE_CLIENT_SECRET: secret(),
  AUTH_GITHUB_CLIENT_ID: "fictional-github",
  AUTH_GITHUB_CLIENT_SECRET: secret(),
  AUTH_RESEND_API_KEY: "fictional-not-sent",
  AUTH_MAIL_FROM: "auth@notifications.meetmilton.com",
  PORT: 19911,
  ...overrides,
});
