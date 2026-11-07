import { createHash } from "node:crypto";
import hashes from "./common-passwords.json" with { type: "json" };
const blocked = new Set(hashes);

// Better Auth 1.7.18 performs NFKC normalization in its native scrypt implementation.
// Validate both representations, preserve whitespace, never truncate or replace hashing.
const common = new Set([
  "passwordpassword",
  "password123456789",
  "123456789012345",
  "qwertyuiopasdfgh",
  "letmeinletmein123",
  "correct horse battery staple",
]);
export function validPassword(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 512) return false;
  const normalized = value.normalize("NFKC");
  const sizes = [Array.from(value).length, Array.from(normalized).length];
  return (
    sizes.every((n) => n >= 15 && n <= 128) &&
    !common.has(normalized.toLowerCase()) &&
    !blocked.has(
      createHash("sha256").update(normalized.toLowerCase()).digest("hex"),
    ) &&
    !/^(.)\1+$/u.test(normalized)
  );
}
