import { readFileSync } from "node:fs";
import { config } from "@dotenvx/dotenvx";

// The encrypted payload is a mounted secret file (Cloud Run); its private key
// is a separate platform secret.
export function loadEnvironment(env: NodeJS.ProcessEnv = process.env) {
  const path = env.MILTON_ENCRYPTED_ENV_FILE;
  if (!path) return env; // Local development and staged rollout.
  try {
    const value = readFileSync(path, "utf8");
    const resolved: Record<string, string> = {};
    for (const [key, value] of Object.entries(env))
      if (value !== undefined) resolved[key] = value;
    config({
      envs: [{ type: "env", value, privateKeyName: "DOTENV_PRIVATE_KEY" }],
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
    throw new Error("Milton runtime secrets are unavailable.");
  }
}
