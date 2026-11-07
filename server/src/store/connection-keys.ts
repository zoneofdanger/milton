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
/** Expired, unrevoked keys listed as history, most recently expired first. */
export const EXPIRED_KEY_HISTORY = 20;

/** The native authority a key is bound to: the identity and the incarnation
 * and security generation of the validated fresh session that created it. */
export interface KeyBinding {
  issuer: string;
  subject: string;
  incarnation: string;
  generation: string;
}
export interface ConnectionKey {
  id: string;
  name: string;
  scope: KeyScope;
  createdAt: Date;
  expiresAt: Date | null;
  lastUsedAt: Date | null;
  expired: boolean;
  /** Bound to an earlier incarnation or generation of the viewing identity, so
   * refused for good: a recovery or security change happened after creation. */
  stopped: boolean;
}
type KeyRow = {
  id: string;
  name: string;
  scope: KeyScope;
  created_at: Date | string;
  expires_at: Date | string | null;
  last_used_at: Date | string | null;
  expired: boolean;
  stopped: boolean;
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
  stopped: row.stopped,
});
// Never secret_hash: the app runtime cannot read it.
const columns = (
  b: KeyBinding,
  at = sql`clock_timestamp()`,
) => sql`id,name,scope,created_at,expires_at,last_used_at,
  (expires_at IS NOT NULL AND expires_at<=${at}) AS expired,
  (issuer=${b.issuer} AND subject=${b.subject}
    AND (incarnation,generation)<>(${b.incarnation},${b.generation})) AS stopped`;
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

/** A key's public id and secret, if `presented` has the exact key shape in
 * canonical base64url; parsing touches no database. */
export function parseConnectionKey(
  presented: string,
): { id: string; secret: string } | undefined {
  const parts = keyFormat.exec(presented);
  if (!parts || !canonical(parts[1]!, 16) || !canonical(parts[2]!, 32))
    return undefined;
  return { id: parts[1]!, secret: parts[2]! };
}

const staleSnapshot = () =>
  new StoreError(
    "session_required",
    "Sign in again before creating a connection key.",
    403,
  );

/**
 * Creates a key bound to `binding`, the creating session's validated native
 * snapshot. Under the account lock it asks native SQL that the snapshot is
 * still current, then retires this identity's keys bound to any other
 * incarnation or generation: fences only advance, so those can never work
 * again and must not hold the cap.
 */
export async function createConnectionKey(
  db: StoreDatabase,
  userId: string,
  binding: KeyBinding,
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
  const b = binding;
  const row = await db.transaction(async (tx) => {
    // The account lock serializes creates, so the cap holds under concurrency
    // and no key bound to a newer snapshot can appear while this one is checked.
    await requireActiveAccount(tx, userId, { lock: true });
    const [live] = await tx.query<{ ok: boolean | null }>(
      sql`SELECT milton_guard.connection_key_status(${b.subject},${b.incarnation},${b.generation}) AS ok`,
    );
    if (live?.ok !== true) throw staleSnapshot();
    await tx.query(sql`UPDATE connection_keys SET revoked_at=clock_timestamp()
      WHERE user_id=${userId} AND issuer=${b.issuer} AND subject=${b.subject}
      AND (incarnation,generation)<>(${b.incarnation},${b.generation}) AND ${active}`);
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
    // Only for the identity that maps to this account.
    const [created] = await tx.query<KeyRow>(sql`INSERT INTO connection_keys
        (id,user_id,issuer,subject,incarnation,generation,secret_hash,name,scope,expires_at)
        SELECT ${id},${userId},${b.issuer},${b.subject},${b.incarnation},${b.generation},
          ${secretHash(secret).toString("hex")},${name},${input.scope},${expires}
        FROM identities WHERE provider=${b.issuer} AND subject=${b.subject} AND user_id=${userId}
        RETURNING ${columns(b)}`);
    if (!created) throw staleSnapshot();
    return created;
  });
  return { key: `mk_${id}_${secret}`, record: record(row) };
}

/** The account's keys that are not revoked: every active key (the cap bounds
 * them) newest first, and separately the most recently expired ones. Never any
 * secret or hash. `binding` is the viewing session's, to mark stopped keys. */
export async function listConnectionKeys(
  db: StoreDatabase,
  userId: string,
  binding: KeyBinding,
): Promise<{ active: ConnectionKey[]; expired: ConnectionKey[] }> {
  // One statement and one now(), so no key falls between the two parts.
  const at = sql`now()`;
  const rows = await db.query<KeyRow>(sql`SELECT * FROM (
    (SELECT ${columns(binding, at)} FROM connection_keys
      WHERE user_id=${userId} AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at>${at}))
    UNION ALL
    (SELECT ${columns(binding, at)} FROM connection_keys
      WHERE user_id=${userId} AND revoked_at IS NULL AND expires_at<=${at}
      ORDER BY expires_at DESC, id LIMIT ${EXPIRED_KEY_HISTORY})) k
    ORDER BY expired, CASE WHEN expired THEN expires_at END DESC, created_at DESC, id`);
  const keys = rows.map(record);
  return {
    active: keys.filter((key) => !key.expired),
    expired: keys.filter((key) => key.expired),
  };
}

/** One of the account's keys that is not revoked, by id, whatever the list
 * shows; undefined if it has none. */
export async function findConnectionKey(
  db: StoreDatabase,
  userId: string,
  binding: KeyBinding,
  id: string,
): Promise<ConnectionKey | undefined> {
  if (!/^[A-Za-z0-9_-]{22}$/.test(id)) return undefined;
  const [row] = await db.query<KeyRow>(sql`SELECT ${columns(binding)}
    FROM connection_keys WHERE id=${id} AND user_id=${userId} AND revoked_at IS NULL`);
  return row && record(row);
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

export type KeyCheck =
  | { ok: true; userId: string; keyId: string; scope: KeyScope }
  /** `known` is false only when no key has the id at all. */
  | { ok: false; known: boolean };

/**
 * The account and scope a parsed key grants, or a refusal: unknown id, wrong
 * secret, revoked, expired, an account that is not active, an issuer other than
 * `issuer`, or native authority that no longer matches the key's binding
 * (recovery, security change, deletion begun, unverified). Callers tell users
 * nothing about which. Records last use at most once a minute per key;
 * failing to record it never fails the call.
 */
export async function authenticateConnectionKey(
  db: StoreDatabase,
  issuer: string,
  { id, secret }: { id: string; secret: string },
): Promise<KeyCheck> {
  const row = (
    await db.query<{
      user_id: string;
      scope: KeyScope;
      secret_hash: string;
      usable: boolean;
      stale: boolean;
    }>(sql`SELECT k.user_id,k.scope,k.secret_hash,
      (k.revoked_at IS NULL AND (k.expires_at IS NULL OR k.expires_at>clock_timestamp())
        AND u.status='active' AND k.issuer=${issuer}
        AND EXISTS(SELECT 1 FROM identities i
          WHERE i.provider=k.issuer AND i.subject=k.subject AND i.user_id=k.user_id)
        AND milton_guard.connection_key_status(k.subject,k.incarnation,k.generation)) IS TRUE AS usable,
      (k.last_used_at IS NULL OR k.last_used_at<=clock_timestamp()-interval '1 minute') AS stale
      FROM connection_keys k JOIN users u ON u.id=k.user_id WHERE k.id=${id}`)
  )[0];
  // Compare in constant time, against a stand-in when no key has this id.
  const stored = Buffer.from(row?.secret_hash ?? "0".repeat(64), "hex");
  const matches = timingSafeEqual(stored, secretHash(secret)) && !!row;
  if (!row || !matches || row.usable !== true)
    return { ok: false, known: !!row };
  if (row.stale)
    await db
      .query(
        sql`UPDATE connection_keys SET last_used_at=clock_timestamp()
        WHERE id=${id} AND (last_used_at IS NULL OR last_used_at<=clock_timestamp()-interval '1 minute')`,
      )
      .catch(() => {});
  return { ok: true, userId: row.user_id, keyId: id, scope: row.scope };
}
