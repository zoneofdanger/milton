import { databaseOptions } from "./database.ts";
import { z } from "zod";

export const AUTH_ORIGIN = "https://auth.meetmilton.com";
export const APP_ORIGIN = "https://app.meetmilton.com";
export const ISSUER = `${AUTH_ORIGIN}/api/auth`;
export const MCP_RESOURCE = "https://mcp.meetmilton.com/mcp";
export const SCOPES = [
  "openid",
  "profile",
  "email",
  "offline_access",
  "milton:read",
  "milton:write",
];
const secret = z.string().min(32).max(512);
/** Where auth sends admissions: the milton-admit service's run.app origin, which
 * gets a Google ID token, or a loopback origin for local development and tests,
 * which does not and is refused in production. Nothing else. */
export function admissionTarget(
  value: string,
): "cloud-run" | "loopback" | null {
  if (!URL.canParse(value)) return null;
  const url = new URL(value);
  if (url.origin !== value) return null;
  if (
    url.protocol === "https:" &&
    !url.port &&
    /^[a-z0-9-]+(\.[a-z0-9-]+)*\.run\.app$/.test(url.hostname)
  )
    return "cloud-run";
  if (
    url.protocol === "http:" &&
    ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
  )
    return "loopback";
  return null;
}
const schema = z.object({
  AUTH_DATABASE_URL: z.url().refine((v) => /^postgres(ql)?:/.test(v)),
  AUTH_SECRET: secret,
  AUTH_ADMISSION_SECRET: secret,
  AUTH_ADMISSION_URL: z.string().refine((v) => admissionTarget(v) !== null),
  AUTH_RATE_SECRET: secret,
  AUTH_APP_CLIENT_ID: z.string().min(1).max(256),
  AUTH_GOOGLE_CLIENT_ID: z.string().min(1),
  AUTH_GOOGLE_CLIENT_SECRET: z.string().min(1),
  AUTH_GITHUB_CLIENT_ID: z.string().min(1),
  AUTH_GITHUB_CLIENT_SECRET: z.string().min(1),
  AUTH_RESEND_API_KEY: z.string().min(1),
  AUTH_MAIL_FROM: z
    .email()
    .refine((v) => v.endsWith("@notifications.meetmilton.com")),
  PORT: z.coerce.number().int().min(1024).max(65535).default(8080),
});
export type Config = z.infer<typeof schema>;
export function readConfig(env: NodeJS.ProcessEnv): Config {
  const r = schema.safeParse(env);
  if (
    !r.success ||
    (env.NODE_ENV === "production" &&
      admissionTarget(r.data.AUTH_ADMISSION_URL) !== "cloud-run")
  )
    throw new Error("invalid_auth_configuration");
  databaseOptions(r.data.AUTH_DATABASE_URL);
  if (
    new Set([
      r.data.AUTH_SECRET,
      r.data.AUTH_ADMISSION_SECRET,
      r.data.AUTH_RATE_SECRET,
    ]).size !== 3
  )
    throw new Error("auth_secrets_must_be_distinct");
  return r.data;
}
export function safeError(error: unknown) {
  const e = error instanceof Error ? error : null;
  const code =
    e &&
    "code" in e &&
    typeof e.code === "string" &&
    /^[A-Z0-9_]{1,40}$/.test(e.code)
      ? e.code
      : "UNCLASSIFIED";
  return { class: e?.name === "TypeError" ? "TypeError" : "Error", code };
}
