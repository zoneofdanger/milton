import { createDecipheriv, createECDH, hkdfSync } from "node:crypto";
import { readFileSync } from "node:fs";

// Reads exactly what `dotenvx encrypt` (2.38) writes for auth's payload and
// refuses every other form, so no payload can mean something different here
// than under dotenvx. Lines are LF-separated and each is one of:
//   empty, or a `#` comment (the CLI's header block and `# .env`);
//   DOTENV_PUBLIC_KEY[_SUFFIX]="<66 hex, compressed key>", optionally followed
//     by the ` # -fk <path>` the CLI writes with an explicit keys file;
//   NAME="encrypted:<base64>", NAME being [A-Z_][A-Z0-9_]*, once each.
// Each value is ECIES over secp256k1 (eciesjs defaults, as dotenvx uses them):
// a 65-byte uncompressed ephemeral key, a 16-byte nonce, a 16-byte tag and
// AES-256-GCM ciphertext under HKDF-SHA256 of the ephemeral key and the
// uncompressed shared point. OpenSSL does the private key work; dotenvx's
// pure-JS curve took most of auth's startup. A plaintext must be UTF-8 and may
// neither start with `encrypted:` nor contain `$` (dotenvx would expand or run
// it); dotenvx changes no other double-quoted value after decrypting.
const P = 2n ** 256n - 2n ** 32n - 977n;
const HEADER =
  /^(DOTENV_PUBLIC_KEY(?:_[A-Z0-9_]+)?)="(0[23][0-9a-f]{64})"(?: # -fk .+)?$/;
const VALUE = /^([A-Z_][A-Z0-9_]*)="encrypted:([A-Za-z0-9+/]+={0,2})"$/;
function power(base: bigint, exponent: bigint) {
  let result = 1n;
  for (; exponent; exponent >>= 1n, base = (base * base) % P)
    if (exponent & 1n) result = (result * base) % P;
  return result;
}
function decrypt(base64: string, key: ReturnType<typeof createECDH>) {
  const data = Buffer.from(base64, "base64");
  if (data.length < 97 || data[0] !== 4) throw new Error();
  const ephemeral = data.subarray(0, 65);
  const nonce = data.subarray(65, 81);
  const tag = data.subarray(81, 97);
  // ECDH yields the shared x; y is one of two square roots, and only the true
  // point's key passes the GCM tag.
  const x = key.computeSecret(ephemeral);
  const n = BigInt("0x" + x.toString("hex"));
  const square = (n ** 3n + 7n) % P;
  const root = power(square, (P + 1n) / 4n);
  if ((root * root) % P !== square) throw new Error();
  for (const y of [root, P - root]) {
    const point = Buffer.concat([
      Buffer.from([4]),
      x,
      Buffer.from(y.toString(16).padStart(64, "0"), "hex"),
    ]);
    const secret = Buffer.from(
      hkdfSync("sha256", Buffer.concat([ephemeral, point]), "", "", 32),
    );
    const decipher = createDecipheriv("aes-256-gcm", secret, nonce, {
      authTagLength: 16,
    });
    decipher.setAuthTag(tag);
    try {
      const plain = Buffer.concat([
        decipher.update(data.subarray(97)),
        decipher.final(),
      ]);
      // Keep a leading BOM, as dotenvx's Buffer.toString does.
      return new TextDecoder("utf-8", {
        fatal: true,
        ignoreBOM: true,
      }).decode(plain);
    } catch {
      // The other root, or a wrong key.
    }
  }
  throw new Error();
}
export function loadEnvironment(env: NodeJS.ProcessEnv = process.env) {
  const path = env.AUTH_ENCRYPTED_ENV_FILE;
  if (!path) return env;
  try {
    const hex = env.DOTENV_PRIVATE_KEY ?? "";
    if (!/^[0-9a-f]{64}$/.test(hex)) throw new Error();
    const key = createECDH("secp256k1");
    key.setPrivateKey(Buffer.from(hex, "hex"));
    const parsed = new Map<string, string>();
    const text = readFileSync(path, "utf8");
    // LF only: a CR could hide lines inside what reads as one comment.
    if (text.includes("\r")) throw new Error();
    for (const line of text.split("\n")) {
      if (line === "" || line.startsWith("#")) continue;
      const header = HEADER.exec(line);
      const match = header ?? VALUE.exec(line);
      if (!match || parsed.has(match[1]!)) throw new Error();
      let value = match[2]!;
      if (!header) {
        if (match[1]!.startsWith("DOTENV_PUBLIC_KEY")) throw new Error();
        value = decrypt(value, key);
        if (value.startsWith("encrypted:") || value.includes("$"))
          throw new Error();
      }
      parsed.set(match[1]!, value);
    }
    const resolved: Record<string, string> = {};
    for (const [k, v] of Object.entries(env))
      if (v !== undefined) resolved[k] = v;
    // Platform variables take precedence, as with dotenvx.
    for (const [name, value] of parsed)
      if (!Object.hasOwn(resolved, name)) resolved[name] = value;
    return resolved;
  } catch {
    // A stable code for safeError's logs; no cause, value or key material.
    throw Object.assign(new Error("auth_runtime_secrets_unavailable"), {
      code: "AUTH_RUNTIME_SECRETS_UNAVAILABLE",
    });
  }
}
