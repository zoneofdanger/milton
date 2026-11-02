import { ZodError } from "zod";

export function signInDiagnostic(
  error: unknown,
  sensitive: readonly (string | undefined)[] = [],
) {
  function redact(value: string) {
    let message = value;
    for (const secret of sensitive) {
      if (secret) message = message.replaceAll(secret, "[redacted]");
    }
    return message
      .replace(/\b[a-z][a-z\d+.-]*:\/\/[^\s"'<>]+/gi, "[url]")
      .replace(/\bBearer\s+\S+/gi, "Bearer [redacted]")
      .replace(
        /\b(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+)\b/g,
        "[token]",
      )
      .replace(/\{[\s\S]*\}|\[[\s\S]*\]|<[\s\S]*/g, "[data]")
      .replace(/(["'])(.*?)\1/gs, (quoted, _quote: string, text: string) =>
        ["error", "manual", "follow"].includes(text) ? quoted : "[quoted]",
      )
      .slice(0, 500);
  }
  return {
    error:
      error instanceof Error
        ? error.constructor.name.replace(/[^a-z\d_]/gi, "").slice(0, 60)
        : typeof error,
    message: redact(
      error instanceof ZodError
        ? error.issues.map((issue) => issue.message).join("; ")
        : error instanceof Error
          ? error.message
          : "Non-Error value thrown",
    ),
    ...(error instanceof ZodError
      ? {
          paths: error.issues.map((issue) =>
            issue.path.map((part) =>
              typeof part === "number" ? part : redact(String(part)),
            ),
          ),
        }
      : {}),
  };
}
