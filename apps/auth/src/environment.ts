import { createDecipheriv, createECDH, hkdfSync } from "node:crypto";
import { readFileSync } from "node:fs";

// Reads the payload `dotenvx encrypt` writes: DOTENV_PUBLIC_KEY lines and
// `KEY="encrypted:..."` lines, in dotenv's line form (quotes, `export`,
// comments, CRLF or CR). Each value is ECIES over secp256k1 (eciesjs
// defaults, as dotenvx uses them): a 65-byte uncompressed ephemeral key, a
// 16-byte nonce, a 16-byte tag and AES-256-GCM ciphertext under HKDF-SHA256 of
// the ephemeral key and the uncompressed shared point. OpenSSL does the private
// key work; dotenvx's pure-JS curve took most of auth's startup.
// After decrypting, dotenvx expands `$NAME`/`${...}`, runs `$(...)` and turns
// `\$` into `$`, except in single-quoted values; nothing else changes a value.
// So a `$` outside single quotes and any plaintext value except a public key
// are refused, and every accepted payload means exactly what dotenvx makes of it.
const P = 2n ** 256n - 2n ** 32n - 977n;
const LINE =
  /^\s*(?:export\s+)?([\w.-]+)\s*=\s*(?:"([^"\\$]*)"|'([^'\\$]*)'|`([^`\\$]*)`|([^\s"'`\\$#]*))\s*(?:#.*)?$/;
const ENCRYPTED = /^encrypted:([A-Za-z0-9+/]+={0,2})$/;
function power(base: bigint, exponent: bigint) {
  let result = 1n;
  for (; exponent; exponent >>= 1n, base = (base * base) % P)
    if (exponent & 1n) result = (result * base) % P;
  return result;
}
function decrypt(value: string, keys: ReturnType<typeof createECDH>[]) {
  const data = Buffer.from(ENCRYPTED.exec(value)![1]!, "base64");
  if (data.length < 97 || data[0] !== 4) throw new Error();
  const ephemeral = data.subarray(0, 65);
  const nonce = data.subarray(65, 81);
  const tag = data.subarray(81, 97);
  for (const key of keys) {
    // ECDH yields the shared x; y is one of two square roots, and only the
    // true point's key passes the GCM tag.
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
        return new TextDecoder("utf-8", {
          fatal: true,
          ignoreBOM: true,
        }).decode(plain);
      } catch {
        // Wrong root or wrong key: try the next.
      }
    }
  }
  throw new Error();
}
export function loadEnvironment(env: NodeJS.ProcessEnv = process.env) {
  const path = env.AUTH_ENCRYPTED_ENV_FILE;
  if (!path) return env;
  try {
    const keys = (env.DOTENV_PRIVATE_KEY ?? "").split(",").map((hex) => {
      if (!/^[0-9a-fA-F]{64}$/.test(hex)) throw new Error();
      const key = createECDH("secp256k1");
      key.setPrivateKey(Buffer.from(hex, "hex"));
      return key;
    });
    const resolved: Record<string, string> = {};
    for (const [k, v] of Object.entries(env))
      if (v !== undefined) resolved[k] = v;
    // A later assignment wins, as with dotenvx; every one must decrypt.
    const parsed = new Map<string, string>();
    for (const line of readFileSync(path, "utf8").split(/\r\n?|\n/)) {
      if (/^\s*(#.*)?$/.test(line)) continue;
      const match = LINE.exec(line);
      if (!match || match[1] === "__proto__") throw new Error();
      const name = match[1]!;
      const raw = match[2] ?? match[3] ?? match[4] ?? match[5]!;
      let value = raw;
      if (ENCRYPTED.test(raw)) value = decrypt(raw, keys);
      else if (!name.startsWith("DOTENV_PUBLIC_KEY")) throw new Error();
      if (match[3] === undefined && value.includes("$")) throw new Error();
      parsed.set(name, value);
    }
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
