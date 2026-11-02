import { createHash } from "node:crypto";
import { z } from "zod";
import { sql } from "drizzle-orm";
import templates from "../../generated/templates.json";
import {
  neonDatabase,
  databaseFailure,
  type StoreDatabase,
  type StoreSession,
} from "./database";
import { StoreError } from "./errors";
import { claimTrialNotice, trialStatus, type TrialNotice } from "./trials";
import {
  memoWrites,
  type CreateInput,
  type UpdateInput,
  type ArchiveInput,
} from "./writes";
import { parseVersionTag, versionTag } from "./versions";
import {
  compiledMemos,
  type CompiledReport,
  type Documents,
  type SaveMemoInput,
  type SaveOutcome,
} from "./compiled";
export { StoreError } from "./errors";

// Stable legacy storage key: preserve existing identities and opaque version tags.
export const TPS_REPORT_KEY = "vibes";

export interface StoreBindings {
  DATABASE_URL?: string;
  MEMOS_SOURCE?: string;
  // Private dependency injection for the embedded fixture; never populated from a request.
  storeDatabase?: StoreDatabase;
  appOrigin?: string;
}
export function memosSource(bindings: StoreBindings) {
  const source = bindings.MEMOS_SOURCE ?? "bundle";
  if (source !== "bundle" && source !== "store")
    throw new StoreError(
      "configuration",
      "MEMOS_SOURCE must be bundle or store.",
    );
  return source;
}
function database(bindings: StoreBindings): StoreDatabase {
  if (bindings.storeDatabase) return bindings.storeDatabase;
  if (!bindings.DATABASE_URL)
    throw new StoreError("configuration", "The memo store is unavailable.");
  return neonDatabase(bindings.DATABASE_URL);
}
const positiveLimit = z.number().int().positive();
const limitsSchema = z.object({
  memos: positiveLimit,
  body_bytes: positiveLimit,
  name_bytes: positiveLimit,
  description_bytes: positiveLimit,
  reason_bytes: positiveLimit,
  history_bytes: positiveLimit,
  report_body_bytes: positiveLimit,
  daily_calls: positiveLimit,
  daily_writes: positiveLimit,
  request_bytes: positiveLimit,
  page_size: positiveLimit.max(50),
});
export type StoreLimits = z.infer<typeof limitsSchema>;

export async function readLimits(db: StoreSession): Promise<StoreLimits> {
  let value: unknown;
  try {
    value = (
      await db.query<{ limits_json: unknown }>(
        sql`SELECT limits_json FROM store_config WHERE singleton = 1`,
      )
    )[0]?.limits_json;
  } catch (error) {
    throw databaseFailure(error);
  }
  const result = limitsSchema.safeParse(value);
  if (!result.success)
    throw new StoreError("configuration", "The memo store limits are invalid.");
  return result.data;
}
export const utf8Bytes = (value: string) =>
  new TextEncoder().encode(value).length;

export interface VerifiedIdentity {
  provider: string;
  subject: string;
  profile?: Record<string, unknown>;
}

// One-way fingerprint of a sign-in identity, stored after account deletion.
const identityHash = (provider: string, subject: string) =>
  createHash("sha256").update(`${provider}:${subject}`).digest("hex");

export async function resolveIdentityAccount(
  bindings: StoreBindings,
  identity: VerifiedIdentity,
) {
  const provider = z.string().min(1).max(64).parse(identity.provider);
  const subject = z.string().min(1).max(512).parse(identity.subject);
  return database(bindings)
    .transaction(async (tx) => {
      await readLimits(tx);
      const lookup = () =>
        tx.query<{
          id: string;
          status: string;
          templates_revision: number;
        }>(sql`
      SELECT u.id, u.status, u.templates_revision FROM identities i JOIN users u ON u.id = i.user_id
      WHERE i.provider = ${provider} AND i.subject = ${subject} FOR UPDATE OF u`);
      let account = (await lookup())[0];
      if (!account) {
        const config = (
          await tx.query<{
            signup_mode: string;
            allowed_identities_json: unknown;
          }>(sql`
        SELECT signup_mode, allowed_identities_json FROM store_config WHERE singleton = 1 FOR UPDATE`)
        )[0];
        // A separate READ COMMITTED statement sees an admission that committed while this request waited.
        account = (await lookup())[0];
        if (!account) {
          const allowed = z
            .array(z.object({ provider: z.string(), subject: z.string() }))
            .parse(config?.allowed_identities_json);
          if (
            !config ||
            !(
              config.signup_mode === "open" ||
              (config.signup_mode === "allowlist" &&
                allowed.some(
                  (item) =>
                    item.provider === provider && item.subject === subject,
                ))
            )
          )
            throw new StoreError(
              "admission_refused",
              "New Milton accounts are closed.",
              403,
            );
          const id = `m_${crypto.randomUUID()}`;
          await tx.query(sql`INSERT INTO users (id) VALUES (${id})`);
          // A sign-in identity whose account was deleted gets no second trial:
          // its trial row has already ended, so it reads as expired whenever
          // trials are enabled (now or later) and has no effect while they are off.
          await tx.query(sql`INSERT INTO trial_accounts(user_id,started_at)
            SELECT u.id,CASE WHEN d.identity_hash IS NULL THEN u.created_at
              ELSE u.created_at - interval '720 hours' END
            FROM users u CROSS JOIN store_config c
            LEFT JOIN deleted_identities d
              ON d.identity_hash=${identityHash(provider, subject)}
            WHERE u.id=${id} AND c.singleton=1
            AND (c.trials_enabled OR d.identity_hash IS NOT NULL)`);
          await tx.query(sql`INSERT INTO identities (provider,subject,user_id,profile_json)
          VALUES (${provider},${subject},${id},${JSON.stringify(identity.profile ?? {})}::jsonb)`);
          account = { id, status: "active", templates_revision: 0 };
        }
      }
      if (account.status !== "active")
        throw new StoreError(
          "account_unavailable",
          "This Milton account is unavailable.",
          403,
        );
      if (account.templates_revision === 0) {
        // Use this tenant-locked transaction; never open a nested repair transaction.
        const current = (
          await tx.query<SnapshotRow>(sql`SELECT r.id,r.name,v.description,v.body,v.version,v.archived
          FROM memos r JOIN memo_versions v ON v.user_id=r.user_id AND v.memo_id=r.id
          WHERE r.user_id=${account.id} AND r.name=${TPS_REPORT_KEY} ORDER BY v.version DESC LIMIT 1`)
        )[0];
        if (current?.archived) {
          await tx.query(sql`INSERT INTO memo_versions (user_id,memo_id,version,description,body,archived,reason,actor_json,details_json)
            VALUES (${account.id},${current.id},${current.version + 1},${current.description},${current.body},false,'Restored TPS Report','{"kind":"system"}',${JSON.stringify({ kind: "restore", source_version: current.version })})`);
        } else if (!current) {
          await tx.query(
            sql`INSERT INTO memos (user_id,name) VALUES (${account.id},${TPS_REPORT_KEY}) ON CONFLICT (user_id,name) DO NOTHING`,
          );
          const description =
            templates.find((item) => item.name === TPS_REPORT_KEY)
              ?.description ?? "How you want your assistants to work with you.";
          await tx.query(sql`INSERT INTO memo_versions (user_id,memo_id,version,description,body,reason,actor_json,details_json)
            SELECT ${account.id},id,1,${description},'','Created TPS Report','{"kind":"system"}','{"kind":"create"}'
            FROM memos WHERE user_id=${account.id} AND name=${TPS_REPORT_KEY}`);
        }
        await tx.query(
          sql`UPDATE users SET templates_revision=2 WHERE id=${account.id}`,
        );
      }
      return { miltonUserId: account.id };
    })
    .catch((error) => {
      throw databaseFailure(error);
    });
}

const verifiedStoreIdentity = Symbol("verifiedStoreIdentity");
export interface VerifiedStoreAuth {
  readonly userId: string;
  readonly [verifiedStoreIdentity]: true;
}

// An assistant is one OAuth client acting for one sign-in identity.
export interface AssistantIdentity {
  provider: string;
  subject: string;
  clientId: string;
}
const assistantIdentity = (identity: AssistantIdentity) => ({
  provider: z.string().min(1).max(64).parse(identity.provider),
  subject: z.string().min(1).max(512).parse(identity.subject),
  clientId: z.string().min(1).max(2048).parse(identity.clientId),
});

/**
 * Looks up the active account for a sign-in identity. With a clientId (the MCP
 * path), the same query also refuses an assistant the person disconnected,
 * whatever its token's remaining lifetime.
 */
export async function lookupIdentityAccount(
  bindings: StoreBindings,
  identity: Pick<VerifiedIdentity, "provider" | "subject"> & {
    clientId?: string;
  },
): Promise<VerifiedStoreAuth> {
  const provider = z.string().min(1).max(64).parse(identity.provider);
  const subject = z.string().min(1).max(512).parse(identity.subject);
  const clientId =
    identity.clientId === undefined
      ? undefined
      : z.string().min(1).max(2048).parse(identity.clientId);
  try {
    const row = (
      await database(bindings).query<{
        id: string | null;
        disconnected: boolean;
      }>(sql`
        SELECT (SELECT u.id FROM identities i JOIN users u ON u.id=i.user_id
          WHERE i.provider=${provider} AND i.subject=${subject} AND u.status='active') AS id,
        ${
          clientId === undefined
            ? sql`false`
            : sql`EXISTS(SELECT 1 FROM assistant_disconnects d
          WHERE d.provider=${provider} AND d.subject=${subject} AND d.client_id=${clientId})`
        } AS disconnected`)
    )[0];
    if (row?.disconnected)
      throw new StoreError(
        "invalid_token",
        "This assistant was disconnected from Milton. Reconnect it from your assistant.",
        401,
      );
    if (!row?.id)
      throw new StoreError(
        "account_unavailable",
        "Sign in to Milton before connecting your assistant.",
        403,
      );
    return { userId: row.id, [verifiedStoreIdentity]: true };
  } catch (error) {
    throw databaseFailure(error);
  }
}

/** Records a disconnect; Milton refuses the assistant from the next request. */
export async function recordAssistantDisconnect(
  bindings: StoreBindings,
  identity: AssistantIdentity,
) {
  const { provider, subject, clientId } = assistantIdentity(identity);
  try {
    await database(bindings).query(sql`
      INSERT INTO assistant_disconnects (provider,subject,client_id)
      VALUES (${provider},${subject},${clientId}) ON CONFLICT DO NOTHING`);
  } catch (error) {
    throw databaseFailure(error);
  }
}

/** Removes a disconnect after the person approved the assistant again. */
export async function clearAssistantDisconnect(
  bindings: StoreBindings,
  identity: AssistantIdentity,
) {
  const { provider, subject, clientId } = assistantIdentity(identity);
  try {
    await database(bindings).query(sql`
      DELETE FROM assistant_disconnects
      WHERE provider=${provider} AND subject=${subject} AND client_id=${clientId}`);
  } catch (error) {
    throw databaseFailure(error);
  }
}

/** Client ids this identity disconnected, for the connected-assistants page. */
export async function listAssistantDisconnects(
  bindings: StoreBindings,
  identity: Pick<VerifiedIdentity, "provider" | "subject">,
): Promise<Set<string>> {
  const provider = z.string().min(1).max(64).parse(identity.provider);
  const subject = z.string().min(1).max(512).parse(identity.subject);
  try {
    const rows = await database(bindings).query<{ client_id: string }>(sql`
      SELECT client_id FROM assistant_disconnects
      WHERE provider=${provider} AND subject=${subject}`);
    return new Set(rows.map((row) => row.client_id));
  } catch (error) {
    throw databaseFailure(error);
  }
}

/**
 * Deletes the identity's active account and everything it owns, in one
 * transaction. First records a disconnect for every given assistant (so their
 * unexpired tokens cannot reach a later account for this identity) and the
 * identity fingerprint (so that account gets no second trial). Every tenant
 * table cascades from users; global spend counters have no account link.
 */
export async function deleteAccount(
  bindings: StoreBindings,
  identity: Pick<VerifiedIdentity, "provider" | "subject">,
  clientIds: string[],
): Promise<void> {
  const provider = z.string().min(1).max(64).parse(identity.provider);
  const subject = z.string().min(1).max(512).parse(identity.subject);
  const clients = [
    ...new Set(clientIds.map((id) => z.string().min(1).max(2048).parse(id))),
  ];
  await database(bindings)
    .transaction(async (tx) => {
      // The same row lock every writer takes, so in-flight saves finish first
      // and later ones find no active account.
      const account = (
        await tx.query<{ id: string }>(sql`
        SELECT u.id FROM identities i JOIN users u ON u.id=i.user_id
        WHERE i.provider=${provider} AND i.subject=${subject} AND u.status='active'
        FOR UPDATE OF u`)
      )[0];
      if (!account)
        throw new StoreError(
          "account_unavailable",
          "This Milton account is unavailable.",
          403,
        );
      for (const clientId of clients)
        await tx.query(sql`
          INSERT INTO assistant_disconnects (provider,subject,client_id)
          VALUES (${provider},${subject},${clientId}) ON CONFLICT DO NOTHING`);
      await tx.query(sql`
        INSERT INTO deleted_identities (identity_hash)
        VALUES (${identityHash(provider, subject)}) ON CONFLICT DO NOTHING`);
      await tx.query(sql`DELETE FROM users WHERE id=${account.id}`);
    })
    .catch((error) => {
      throw databaseFailure(error);
    });
}

export type MemoSummary = {
  name: string;
  description: string;
  version: string;
};
export interface MemoSnapshot extends MemoSummary {
  text: string;
  archived: boolean;
}
type SummaryRow = {
  name: string;
  description: string;
  version: number;
  id: string;
};
type SnapshotRow = SummaryRow & {
  body: string;
  archived: boolean;
};
export interface StorePage<T> {
  items: T[];
  next_cursor: string | null;
}
export type TpsReportSnapshot = Omit<MemoSnapshot, "name"> & {
  title: "TPS Report";
};
export const tpsReportSnapshot = ({
  name: _name,
  ...memo
}: MemoSnapshot): TpsReportSnapshot => ({ title: "TPS Report", ...memo });
export type SearchHit =
  | (MemoSummary & { kind: "memo"; snippets: string[] })
  | {
      kind: "tps_report";
      title: "TPS Report";
      description: string;
      version: string;
      snippets: string[];
    };
export type CallAllowance =
  { allowed: true } | { allowed: false; retry_at_ms: number; limit: "day" };
export interface TenantStore {
  appOrigin?: string;
  trialNotice?(): Promise<TrialNotice | undefined>;
  memoUpdates?(): Promise<import("./memo-updates").MemoUpdates | undefined>;
  readTpsReport(): Promise<CompiledReport>;
  /** The cover sheet and the five reports at one version; rebuilds a stale snapshot. */
  readDocuments(): Promise<Documents & { version: string }>;
  saveMemo(input: SaveMemoInput): Promise<SaveOutcome>;
  createMemo(input: CreateInput): Promise<MemoSnapshot>;
  updateMemo(input: UpdateInput): Promise<MemoSnapshot>;
  archiveMemo(input: ArchiveInput): Promise<MemoSnapshot>;
  updateTpsReport(input: Omit<UpdateInput, "name">): Promise<MemoSnapshot>;
  listMemos(
    cursor?: string,
    archived?: boolean,
    excludeTpsReport?: boolean,
  ): Promise<StorePage<MemoSummary>>;
  getMemo(name: string): Promise<MemoSnapshot | null>;
  getTpsReport(): Promise<MemoSnapshot>;
  search(words: string, cursor?: string): Promise<StorePage<SearchHit>>;
  chargeToolCall(): Promise<CallAllowance>;
}

const summary = (row: SummaryRow): MemoSummary => ({
  name: row.name,
  description: row.description,
  version: versionTag(row.name, row.version, row.id),
});
const snapshot = (row: SnapshotRow): MemoSnapshot => ({
  ...summary(row),
  text: row.body,
  archived: row.archived,
});
const cursorSchema = z.object({
  tool: z.enum(["list", "search"]),
  after: z
    .string()
    .max(64)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  query: z.string().max(256),
});

function readCursor(
  value: string | undefined,
  tool: "list" | "search",
  query = "",
) {
  if (!value) return "";
  try {
    if (value.length > 2048) throw new Error();
    const decoded: unknown = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(
        Uint8Array.from(atob(value), (char) => char.charCodeAt(0)),
      ),
    );
    const cursor = cursorSchema.parse(decoded);
    if (cursor.tool !== tool || cursor.query !== query) throw new Error();
    return cursor.after;
  } catch {
    throw new StoreError(
      "invalid_cursor",
      "Start this list or search again with no cursor.",
      400,
    );
  }
}

function nextCursor(tool: "list" | "search", after: string, query = "") {
  return btoa(
    String.fromCharCode(
      ...new TextEncoder().encode(JSON.stringify({ tool, after, query })),
    ),
  );
}

function snippetsFor(text: string, query: string) {
  const folded = text.toLowerCase();
  const snippets: string[] = [];
  let offset = 0;
  while (snippets.length < 3) {
    const index = folded.indexOf(query, offset);
    if (index === -1) break;
    const start = Math.max(0, index - 60);
    const end = Math.min(text.length, index + query.length + 60);
    snippets.push(
      `${start ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}`,
    );
    offset = index + query.length;
  }
  return snippets;
}

async function resolveActiveUser(db: StoreSession, userId: string) {
  const account = (
    await db.query<{ id: string }>(
      sql`SELECT id FROM users WHERE id = ${userId} AND status = 'active'`,
    )
  )[0];
  if (!account)
    throw new StoreError(
      "account_unavailable",
      "This Milton account is unavailable.",
      403,
    );
  return account.id;
}

export async function storeForCurrentRequest(
  bindings: StoreBindings,
  auth: VerifiedStoreAuth,
  assistant?: { issuer: string; clientId: string },
): Promise<TenantStore> {
  const userId = auth.userId;
  const db = database(bindings);
  const limits = await readLimits(db);
  await resolveActiveUser(db, userId);
  const currentSnapshot = sql`FROM memos r JOIN memo_versions v ON v.user_id = r.user_id AND v.memo_id = r.id
    WHERE r.user_id = ${userId} AND v.version = (SELECT max(current.version) FROM memo_versions current
      WHERE current.user_id = r.user_id AND current.memo_id = r.id)
    AND EXISTS (SELECT 1 FROM users u WHERE u.id = ${userId} AND u.status = 'active')`;
  async function getMemo(name: string, session: StoreSession = db) {
    if (
      !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) ||
      utf8Bytes(name) > limits.name_bytes
    )
      throw new StoreError(
        "invalid_name",
        "Enter a valid memo name within its byte limit.",
        400,
      );
    const row = (
      await session.query<SnapshotRow>(
        sql`SELECT r.id, r.name, v.description, v.body, v.version, v.archived ${currentSnapshot} AND r.name = ${name}`,
      )
    )[0];
    return row ? snapshot(row) : null;
  }
  const { createMemo, updateMemo, updateTpsReport, archiveMemo } = memoWrites(
    db,
    userId,
    assistant
      ? {
          kind: "assistant",
          issuer: assistant.issuer,
          client_id: assistant.clientId,
        }
      : undefined,
  );
  const compiled = compiledMemos(db, userId, assistant, bindings.appOrigin);
  return {
    appOrigin: bindings.appOrigin,
    trialNotice: () =>
      db.transaction(async (tx) => {
        await tx.query(sql`SET LOCAL lock_timeout='250ms'`);
        await tx.query(sql`SET LOCAL statement_timeout='500ms'`);
        return claimTrialNotice(tx, userId, bindings.appOrigin);
      }),
    memoUpdates: compiled.memoUpdates,
    readTpsReport: compiled.getTpsReport,
    readDocuments: compiled.readDocuments,
    saveMemo: compiled.saveMemo,
    createMemo,
    updateMemo,
    updateTpsReport,
    archiveMemo,
    async listMemos(cursor, archived = false, excludeTpsReport = true) {
      const query = excludeTpsReport ? `${archived}:memos` : String(archived);
      const after = readCursor(cursor, "list", query);
      const rows =
        await db.query<SummaryRow>(sql`SELECT r.id, r.name, v.description, v.version ${currentSnapshot}
        AND v.archived = ${archived} AND (${!excludeTpsReport} OR r.name <> ${TPS_REPORT_KEY}) AND r.name > ${after} ORDER BY r.name LIMIT ${limits.page_size + 1}`);
      const items = rows.slice(0, limits.page_size).map(summary);
      return {
        items,
        next_cursor:
          rows.length > limits.page_size
            ? nextCursor("list", items.at(-1)!.name, query)
            : null,
      };
    },
    getMemo,
    async getTpsReport() {
      const memo = await getMemo(TPS_REPORT_KEY);
      if (memo && !memo.archived) return memo;
      return db
        .transaction(async (tx) => {
          if (
            !(
              await tx.query(
                sql`SELECT id FROM users WHERE id=${userId} AND status='active' FOR UPDATE`,
              )
            ).length
          )
            throw new StoreError(
              "account_unavailable",
              "This Milton account is unavailable.",
              403,
            );
          // Serialize repairs with ordinary writes, then recheck under the tenant lock.
          const current = await getMemo(TPS_REPORT_KEY, tx);
          if (current && !current.archived) return current;
          if (current) {
            const tag = parseVersionTag(current.version)!;
            await tx.query(sql`INSERT INTO memo_versions (user_id,memo_id,version,description,body,archived,reason,actor_json,details_json)
            VALUES (${userId},${tag.id},${tag.number + 1},${current.description},${current.text},false,'Restored TPS Report','{"kind":"system"}',${JSON.stringify({ kind: "restore", source_version: tag.number })})`);
            return (await getMemo(TPS_REPORT_KEY, tx))!;
          }
          await tx.query(
            sql`INSERT INTO memos (user_id,name) VALUES (${userId},${TPS_REPORT_KEY}) ON CONFLICT (user_id,name) DO NOTHING`,
          );
          const description =
            templates.find((item) => item.name === TPS_REPORT_KEY)
              ?.description ?? "How you want your assistants to work with you.";
          await tx.query(sql`INSERT INTO memo_versions (user_id,memo_id,version,description,body,reason,actor_json,details_json)
          SELECT ${userId},id,1,${description},'','Created TPS Report','{"kind":"system"}','{"kind":"create"}'
          FROM memos WHERE user_id=${userId} AND name=${TPS_REPORT_KEY}`);
          return (await getMemo(TPS_REPORT_KEY, tx))!;
        })
        .catch((error) => {
          throw databaseFailure(error);
        });
    },
    async search(words, cursor) {
      const query = words.trim().toLowerCase();
      if (!query || query.length > 256)
        throw new StoreError(
          "invalid_search",
          "Enter between 1 and 256 characters to search.",
          400,
        );
      const after = readCursor(cursor, "search", query);
      const rows =
        await db.query<SnapshotRow>(sql`SELECT r.id, r.name, v.description, v.body, v.version, v.archived ${currentSnapshot}
        AND NOT v.archived AND r.name > ${after} ORDER BY r.name`);
      const matches: { key: string; hit: SearchHit }[] = [];
      for (const row of rows) {
        const snippets = snippetsFor(
          `${row.name === TPS_REPORT_KEY ? "TPS Report" : row.name}\n${row.description}\n${row.body}`,
          query,
        );
        if (snippets.length)
          matches.push({
            key: row.name,
            hit:
              row.name === TPS_REPORT_KEY
                ? {
                    kind: "tps_report",
                    title: "TPS Report",
                    description: row.description,
                    version: summary(row).version,
                    snippets,
                  }
                : { kind: "memo", ...summary(row), snippets },
          });
        if (matches.length > limits.page_size) break;
      }
      const page = matches.slice(0, limits.page_size);
      const items = page.map(({ hit }) => hit);
      return {
        items,
        next_cursor:
          matches.length > limits.page_size
            ? nextCursor("search", page.at(-1)!.key, query)
            : null,
      };
    },
    async chargeToolCall() {
      return db.transaction(async (tx) => {
        if (
          !(
            await tx.query(
              sql`SELECT id FROM users WHERE id = ${userId} AND status = 'active' FOR UPDATE`,
            )
          ).length
        )
          throw new StoreError(
            "account_unavailable",
            "This Milton account is unavailable.",
            403,
          );
        const { day } = (
          await tx.query<{ day: string }>(
            sql`SELECT (clock_timestamp() AT TIME ZONE 'UTC')::date::text AS day`,
          )
        )[0]!;
        const charged =
          await tx.query(sql`INSERT INTO usage_daily (user_id,day_utc,tool_calls) VALUES (${userId},${day}::date,1)
          ON CONFLICT (user_id,day_utc) DO UPDATE SET tool_calls = usage_daily.tool_calls + 1
          WHERE usage_daily.tool_calls < ${limits.daily_calls} RETURNING tool_calls`);
        return charged.length
          ? { allowed: true as const }
          : {
              allowed: false as const,
              limit: "day" as const,
              retry_at_ms: Date.parse(`${day}T00:00:00Z`) + 86400000,
            };
      });
    },
  };
}

export interface VersionMetadata {
  version: number;
  reason: string;
  actor: Record<string, unknown>;
  created_at: string;
}

export async function personStoreForCurrentRequest(
  bindings: StoreBindings,
  auth: VerifiedStoreAuth,
) {
  const {
    createMemo: _create,
    updateMemo: _update,
    updateTpsReport: _updateTps,
    archiveMemo: _archive,
    ...reads
  } = await storeForCurrentRequest(bindings, auth);
  const db = database(bindings);
  const userId = auth.userId;
  const limits = await readLimits(db);
  const active = sql`EXISTS (SELECT 1 FROM users WHERE id=${userId} AND status='active')`;
  const metadata = (row: {
    version: number;
    reason: string;
    actor_json: string;
    created_at: string;
  }): VersionMetadata => ({
    version: row.version,
    reason: row.reason,
    actor: JSON.parse(row.actor_json) as Record<string, unknown>,
    created_at: row.created_at,
  });
  const { archiveMemo, restoreMemo, revertMemo } = memoWrites(db, userId, {
    kind: "person",
  });
  const { readDocuments } = compiledMemos(
    db,
    userId,
    undefined,
    bindings.appOrigin,
  );
  return {
    ...reads,
    trialStatus: () => trialStatus(db, userId),
    readDocuments,
    archiveMemo,
    restoreMemo,
    revertMemo,
    async history(
      name: string,
      cursor?: string,
    ): Promise<StorePage<VersionMetadata>> {
      if (cursor && !/^[1-9][0-9]{0,9}$/.test(cursor))
        throw new StoreError(
          "invalid_cursor",
          "Start this history again with no cursor.",
          400,
        );
      const before = cursor ? Number(cursor) : 2147483648;
      const rows = await db.query<{
        version: number;
        reason: string;
        actor_json: string;
        created_at: string;
      }>(sql`
        SELECT v.version,v.reason,v.actor_json,to_char(v.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') AS created_at
        FROM memos r JOIN memo_versions v ON v.user_id=r.user_id AND v.memo_id=r.id
        WHERE r.user_id=${userId} AND r.name=${name} AND v.version < ${before}::bigint AND ${active}
        ORDER BY v.version DESC LIMIT ${limits.page_size + 1}`);
      const items = rows.slice(0, limits.page_size).map(metadata);
      return {
        items,
        next_cursor:
          rows.length > limits.page_size ? String(items.at(-1)!.version) : null,
      };
    },
    async getVersion(
      name: string,
      number: number,
    ): Promise<(MemoSnapshot & { metadata: VersionMetadata }) | null> {
      const row = (
        await db.query<
          SnapshotRow & {
            reason: string;
            actor_json: string;
            created_at: string;
          }
        >(sql`
        SELECT r.id,r.name,v.description,v.body,v.archived,v.version,v.reason,v.actor_json,
          to_char(v.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') AS created_at
        FROM memos r JOIN memo_versions v ON v.user_id=r.user_id AND v.memo_id=r.id
        WHERE r.user_id=${userId} AND r.name=${name} AND v.version=${number} AND ${active}`)
      )[0];
      return row ? { ...snapshot(row), metadata: metadata(row) } : null;
    },
    async downloadMemos(): Promise<MemoSnapshot[]> {
      const rows =
        await db.query<SnapshotRow>(sql`SELECT r.id,r.name,v.description,v.body,v.version,v.archived
        FROM memos r JOIN memo_versions v ON v.user_id=r.user_id AND v.memo_id=r.id
        WHERE r.user_id=${userId} AND ${active} AND NOT v.archived
        AND v.version=(SELECT max(h.version) FROM memo_versions h WHERE h.user_id=r.user_id AND h.memo_id=r.id) ORDER BY r.name`);
      return rows.map(snapshot);
    },
    async usage() {
      const row = (
        await db.query<{
          retained_bytes: number;
          memos: number;
          tool_calls: number;
          writes: number;
        }>(sql`
        SELECT u.retained_bytes,(SELECT count(*)::integer FROM memos r WHERE r.user_id=u.id AND r.name <> ${TPS_REPORT_KEY}) AS memos,
        coalesce(d.tool_calls,0)::integer AS tool_calls,coalesce(d.writes,0)::integer AS writes
        FROM users u LEFT JOIN usage_daily d ON d.user_id=u.id AND d.day_utc=(clock_timestamp() AT TIME ZONE 'UTC')::date
        WHERE u.id=${userId} AND u.status='active'`)
      )[0];
      if (!row)
        throw new StoreError(
          "account_unavailable",
          "This Milton account is unavailable.",
          403,
        );
      return { ...row, limits };
    },
  };
}
export type PersonStore = Awaited<
  ReturnType<typeof personStoreForCurrentRequest>
>;

export async function guardStoreRequest(
  request: Request,
  bindings: StoreBindings,
): Promise<Request | Response> {
  if (memosSource(bindings) === "bundle") return request;
  const db = database(bindings);
  const limits = await readLimits(db);
  let bounded = request;
  if (request.body) {
    const reader = request.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limits.request_bytes) {
        await reader.cancel();
        return Response.json({ error: "request_too_large" }, { status: 413 });
      }
      chunks.push(value);
    }
    const body = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      body.set(chunk, offset);
      offset += chunk.byteLength;
    }
    bounded = new Request(request, { body: body.buffer });
  }

  return bounded;
}
