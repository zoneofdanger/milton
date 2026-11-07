import { sql } from "drizzle-orm";
import { z } from "zod";
import type { RuntimeConfig } from "./config";
import { database, type StoreBindings } from "./store";
import { AuthError } from "./token";

export const unavailable = () =>
  new AuthError("auth_unavailable", "Sign-in is unavailable. Try again.", 503);
export const invalid = () =>
  new AuthError("invalid_token", "Sign in to Milton again.", 401);
const bounded = z.string().min(1).max(512);
export const authoritySchema = z.object({
  subject: bounded,
  binding: bounded,
  sid: bounded,
  incarnation: z.string().min(1).max(128),
  generation: z.string().min(1).max(128),
});
export type Authority = z.infer<typeof authoritySchema>;

/** Every call asks SQL. Missing/invalid proof refuses; a failed query is an
 * outage, never inactive and never a reason to accept a cached positive. */
export async function appActive(config: RuntimeConfig, a: Authority) {
  try {
    return (
      (
        await database(config).query<{ active: boolean }>(
          sql`SELECT milton_guard.app_status(${a.binding},${a.subject},${config.oidc.clientId},${a.sid},${a.incarnation},${a.generation}) AS active`,
        )
      )[0]?.active === true
    );
  } catch {
    throw unavailable();
  }
}
export async function bindingActive(
  config: StoreBindings & { resource: string },
  a: {
    subject: string;
    clientId: string;
    scope: string;
    binding: string;
    incarnation: string;
    generation: string;
  },
) {
  let status: unknown;
  try {
    status = (
      await database(config).query<{ status: unknown }>(
        sql`SELECT milton_guard.binding_status(${a.binding},${a.subject},${a.clientId},ARRAY(SELECT jsonb_array_elements_text(${JSON.stringify(a.scope.split(" "))}::jsonb)),ARRAY[${config.resource}]::text[]) AS status`,
      )
    )[0]?.status;
  } catch {
    throw unavailable();
  }
  const parsed = z
    .object({
      reference: bounded,
      miltonIdentityIncarnation: bounded,
      miltonSecurityGeneration: bounded,
    })
    .safeParse(status);
  if (
    !parsed.success ||
    parsed.data.reference !== a.binding ||
    parsed.data.miltonIdentityIncarnation !== a.incarnation ||
    parsed.data.miltonSecurityGeneration !== a.generation
  )
    throw invalid();
}
export async function securityStatus(
  config: RuntimeConfig,
  a: Pick<Authority, "subject" | "sid" | "incarnation" | "generation">,
): Promise<unknown> {
  try {
    return (
      await database(config).query<{ status: unknown }>(
        sql`SELECT milton_guard.security_status(${a.subject},${a.incarnation},${a.generation},${a.sid}) AS status`,
      )
    )[0]?.status;
  } catch {
    throw unavailable();
  }
}
