import { expect, test } from "bun:test";
import { loadEnvironment } from "../src/environment";

test("an inline encrypted payload without a file is refused, not ignored", () => {
  // Fictional values: the inline variable is retired, so its presence fails
  // closed with the existing configuration error instead of loading or being
  // silently dropped.
  expect(() =>
    loadEnvironment({
      MILTON_ENCRYPTED_ENV: "MILTON_FIXTURE=loaded",
      DOTENV_PRIVATE_KEY: "fixture",
    }),
  ).toThrow("Milton runtime secrets are unavailable.");
  // Without any payload the environment is used as it is (local development).
  const plain = { DATABASE_URL: "postgres://fixture" };
  expect(loadEnvironment(plain)).toBe(plain);
});
