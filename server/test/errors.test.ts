import { expect, test } from "bun:test";
import { z } from "zod";
import { signInDiagnostic } from "../src/errors";

test("sign-in diagnostics identify the error and Zod paths without exposing sensitive values", () => {
  const credential = crypto.randomUUID();
  const diagnostic = signInDiagnostic(
    new TypeError(
      `Unsupported redirect mode: error at https://github.com/login/oauth/access_token?code=private-code ${credential} Bearer private-token {"response":"private body"}`,
    ),
    [credential],
  );
  expect(diagnostic.error).toBe("TypeError");
  expect(diagnostic.message).toContain("Unsupported redirect mode: error");
  for (const value of [
    credential,
    "https://",
    "private-code",
    "private-token",
    "private body",
  ]) {
    expect(JSON.stringify(diagnostic)).not.toContain(value);
  }
  const invalid = z.object({ verifier: z.string() }).safeParse({});
  if (invalid.success) throw new Error("Expected invalid verifier fixture");
  const schema = signInDiagnostic(invalid.error);
  expect(schema.error).toBe("ZodError");
  expect(schema.paths).toEqual([["verifier"]]);
});
