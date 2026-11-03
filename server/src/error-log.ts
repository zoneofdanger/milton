// One line per unexpected error: where it surfaced, its class name and its code.
// Error messages, URLs, bodies, tokens and identifiers never reach the log.
const safe = /^[A-Za-z0-9_.$-]{1,64}$/;

export function logUnexpected(where: string, error: unknown) {
  const name: unknown =
    typeof error === "object" && error !== null
      ? error.constructor?.name
      : typeof error;
  const code: unknown =
    typeof error === "object" && error !== null && "code" in error
      ? error.code
      : undefined;
  console.error(
    JSON.stringify({
      event: "unexpected_error",
      where,
      class: typeof name === "string" && safe.test(name) ? name : "unknown",
      ...((typeof code === "string" || typeof code === "number") &&
      safe.test(String(code))
        ? { code: String(code) }
        : {}),
    }),
  );
}
