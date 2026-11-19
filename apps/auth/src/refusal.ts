/** Every refusal of the auth owner scripts (provision, maintain, migrate), of
 * the configuration and TLS checks they run, and of test-user's
 * createVerifiedUser. safeError prints the code and never the message, so a
 * message stays a fixed string; docs/accounts.md says what each code means. */
export const REFUSAL_CODES = [
  "APPLY_ARGS_REQUIRED",
  "OUTPUT_DIR_UNSAFE",
  "OUTPUT_PATH_NOT_ALLOWED",
  "OUTPUT_EXISTS",
  "OUTPUT_RESERVATION_CHANGED",
  "OUTPUT_RESERVATION_LEFT",
  "OUTPUT_HOLDS_SECRET",
  "DATABASE_TLS_REQUIRED",
  "AUTH_CONFIG_INVALID",
  "AUTH_SECRETS_NOT_DISTINCT",
  "OWNER_ROLE_REQUIRED",
  "APP_ALREADY_PROVISIONED",
  "APP_CLIENT_NOT_ISSUED",
  "APP_PROVISION_CONCURRENT",
  "PRUNE_TIMEOUTS_UNSET",
  "MIGRATION_MUST_NOT_MANAGE_TRANSACTION",
  "TEST_EMAIL_NOT_INVALID",
  "TEST_PASSWORD_POLICY",
  "TEST_USER_ID_INVALID",
  "TEST_EMAIL_EXISTS",
] as const;
export type RefusalCode = (typeof REFUSAL_CODES)[number];

export function refusal(code: RefusalCode, message: string) {
  return Object.assign(new Error(message), { code });
}

/** The code of an error refusal() built, or undefined for any other error, so a
 * caller can print the code without printing an arbitrary error's code. */
export function refusalCode(error: unknown): RefusalCode | undefined {
  const code =
    error instanceof Error && "code" in error ? error.code : undefined;
  return REFUSAL_CODES.find((known) => known === code);
}
