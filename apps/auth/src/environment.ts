import { readFileSync } from "node:fs";
import { config } from "@dotenvx/dotenvx";
export function loadEnvironment(env: NodeJS.ProcessEnv = process.env) {
  const path = env.AUTH_ENCRYPTED_ENV_FILE;
  if (!path) return env;
  try {
    const resolved: Record<string, string> = {};
    for (const [k, v] of Object.entries(env))
      if (v !== undefined) resolved[k] = v;
    config({
      envs: [
        {
          type: "env",
          value: readFileSync(path, "utf8"),
          privateKeyName: "DOTENV_PRIVATE_KEY",
        },
      ],
      processEnv: resolved,
      strict: true,
      quiet: true,
      noArmor: true,
      noNative: true,
      no1Password: true,
      noBitwarden: true,
    });
    return resolved;
  } catch {
    throw new Error("auth_runtime_secrets_unavailable");
  }
}
