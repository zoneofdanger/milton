import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { sql } from "drizzle-orm";
import type { StoreDatabase } from "./database";
import { StoreError } from "./errors";
import { requireActiveAccount } from "./accounts";

/**
 * Connection keys: bearer secrets a person creates for agents with no browser.
 * A key is `mk_<id>_<secret>`: a 22-character public id and a 43-character
 * secret, both canonical base64url (16 and 32 random bytes). Only the secret's
 * SHA-256 is stored; the full key exists once, in createConnectionKey's result.
 */
export type KeyScope = "read" | "read_write";
/** The expiries a person can choose, in days; null never expires. */
export const keyExpiries = [30, 90, 365, null] as const;
export type KeyExpiry = (typeof keyExpiries)[number];
/** Keys that are neither revoked nor expired, per account. */
export const MAX_ACTIVE_KEYS = 20;

export interface ConnectionKey {
  id: string;
  name: string;
  scope: KeyScope;
  createdAt: Date;
  expiresAt: Date | null;
  lastUsedAt: Date | null;
  expired: boolean;
}
type KeyRow = {
  id: string;
  name: string;
  scope: KeyScope;
  created_at: Date | string;
  expires_at: Date | string | null;
  last_used_at: Date | string | null;
  expired: boolean;
};
const date = (value: Date | string | null) =>
  value === null ? null : new Date(value);
const record = (row: KeyRow): ConnectionKey => ({
  id: row.id,
  name: row.name,
  scope: row.scope,
  createdAt: new Date(row.created_at),
  expiresAt: date(row.expires_at),
  lastUsedAt: date(row.last_used_at),
  expired: row.expired,
});
// Never secret_hash: the app runtime cannot read it.
const columns = sql`id,name,scope,created_at,expires_at,last_used_at,
  (expires_at IS NOT NULL AND expires_at<=clock_timestamp()) AS expired`;
const active = sql`revoked_at IS NULL AND (expires_at IS NULL OR expires_at>clock_timestamp())`;

const secretHash = (secret: string) =>
  createHash("sha256").update(secret).digest();
const canonical = (value: string, bytes: number) =>
  Buffer.from(value, "base64url").length === bytes &&
  Buffer.from(value, "base64url").toString("base64url") === value;
const keyFormat = /^mk_([A-Za-z0-9_-]{22})_([A-Za-z0-9_-]{43})$/;

/** A name of 1–60 characters on one line, trimmed; undefined if none fits. */
export function keyName(raw: string): string | undefined {
  const name = raw.trim();
  const length = [...name].length;
  if (length < 1 || length > 60 || /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(name))
    return undefined;
  return name;
}

export async function createConnectionKey(
  db: StoreDatabase,
  userId: string,
  input: { name: string; scope: KeyScope; expiry: KeyExpiry },
): Promise<{ key: string; record: ConnectionKey }> {
  const name = keyName(input.name);
  if (
    name === undefined ||
    !["read", "read_write"].includes(input.scope) ||
    !keyExpiries.includes(input.expiry)
  )
    throw new StoreError(
      "invalid_input",
      "Name the key in 1 to 60 characters on one line, and choose its access and expiry.",
      400,
    );
  const id = randomBytes(16).toString("base64url");
  const secret = randomBytes(32).toString("base64url");
  const row = await db.transaction(async (tx) => {
    // The account lock serializes creates, so the cap holds under concurrency.
    await requireActiveAccount(tx, userId, { lock: true });
    const [count] = await tx.query<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM connection_keys WHERE user_id=${userId} AND ${active}`,
    );
    if ((count?.n ?? 0) >= MAX_ACTIVE_KEYS)
      throw new StoreError(
        "connection_key_limit",
        `An account can have ${MAX_ACTIVE_KEYS} active connection keys. Revoke one before creating another.`,
        409,
      );
    const expires =
      input.expiry === null
        ? sql`NULL`
        : sql`now()+make_interval(days=>${input.expiry})`;
    return (
      await tx.query<KeyRow>(sql`INSERT INTO connection_keys
        (id,user_id,secret_hash,name,scope,expires_at)
        VALUES (${id},${userId},${secretHash(secret).toString("hex")},${name},${input.scope},${expires})
        RETURNING ${columns}`)
    )[0]!;
  });
  return { key: `mk_${id}_${secret}`, record: record(row) };
}

/** The account's keys that are not revoked, newest first, expired ones
 * included and marked. Bounded; never any secret or hash. */
export async function listConnectionKeys(
  db: StoreDatabase,
  userId: string,
): Promise<ConnectionKey[]> {
  const rows = await db.query<KeyRow>(sql`SELECT ${columns} FROM connection_keys
    WHERE user_id=${userId} AND revoked_at IS NULL
    ORDER BY created_at DESC, id LIMIT 100`);
  return rows.map(record);
}

/** Revokes one of the account's keys; false if it has none by that id that is
 * not already revoked. The next call with the key is refused. */
export async function revokeConnectionKey(
  db: StoreDatabase,
  userId: string,
  id: string,
): Promise<boolean> {
  if (!/^[A-Za-z0-9_-]{22}$/.test(id)) return false;
  const rows = await db.query(sql`UPDATE connection_keys
    SET revoked_at=clock_timestamp()
    WHERE id=${id} AND user_id=${userId} AND revoked_at IS NULL RETURNING id`);
  return rows.length > 0;
}

/**
 * The account and scope a presented key grants, or undefined for any refusal:
 * malformed, unknown, wrong secret, revoked, expired or an account that is not
 * active. Callers learn nothing about which. Records last use at most once a
 * minute per key; failing to record it never fails the call.
 */
export async function authenticateConnectionKey(
  db: StoreDatabase,
  presented: string,
): Promise<{ userId: string; keyId: string; scope: KeyScope } | undefined> {
  const parts = keyFormat.exec(presented);
  if (!parts || !canonical(parts[1]!, 16) || !canonical(parts[2]!, 32))
    return undefined;
  const [, id, secret] = parts as unknown as [string, string, string];
  const row = (
    await db.query<{
      user_id: string;
      scope: KeyScope;
      secret_hash: string;
      usable: boolean;
      stale: boolean;
    }>(sql`SELECT k.user_id,k.scope,k.secret_hash,
      (k.revoked_at IS NULL AND (k.expires_at IS NULL OR k.expires_at>clock_timestamp())
        AND u.status='active') AS usable,
      (k.last_used_at IS NULL OR k.last_used_at<=clock_timestamp()-interval '1 minute') AS stale
      FROM connection_keys k JOIN users u ON u.id=k.user_id WHERE k.id=${id}`)
  )[0];
  // Compare in constant time, against a stand-in when no key has this id.
  const stored = Buffer.from(row?.secret_hash ?? "0".repeat(64), "hex");
  const matches = timingSafeEqual(stored, secretHash(secret)) && !!row;
  if (!row || !matches || !row.usable) return undefined;
  if (row.stale)
    await db
      .query(
        sql`UPDATE connection_keys SET last_used_at=clock_timestamp()
        WHERE id=${id} AND (last_used_at IS NULL OR last_used_at<=clock_timestamp()-interval '1 minute')`,
      )
      .catch(() => {});
  return { userId: row.user_id, keyId: id, scope: row.scope };
}
