import type { SQL } from "drizzle-orm";
import { StoreError } from "./errors";
import { logUnexpected } from "../error-log";
import { Pool, type PoolClient } from "pg";
import { PgDialect } from "drizzle-orm/pg-core";

export interface StoreSession {
  query<Row extends Record<string, unknown> = Record<string, unknown>>(
    statement: SQL,
  ): Promise<Row[]>;
}
export interface StoreDatabase extends StoreSession {
  transaction<T>(work: (tx: StoreSession) => Promise<T>): Promise<T>;
  withConnection<T>(work: (db: StoreDatabase) => Promise<T>): Promise<T>;
}

/** How long a connection may sit idle and still be handed out. The pool's idle
 * timer closes clients after this too, but Cloud Run throttles CPU between
 * requests, so that timer and a socket's close event may not have run when the
 * next request arrives; checkout compares the wall clock instead. Far below the
 * minutes after which networks and poolers drop idle TCP connections, while a
 * request's sequential operations (milliseconds apart) and bursts still share one. */
export const POOL_IDLE_MS = 30_000;
const pools = new Map<string, Pool>();
const releasedAt = new WeakMap<PoolClient, number>();

function poolFor(url: string): Pool {
  let pool = pools.get(url);
  if (!pool) {
    pool = new Pool({
      connectionString: url,
      ssl: true,
      // Bounds both a new connection and a wait for a busy pool's next client.
      connectionTimeoutMillis: 5000,
      query_timeout: 20000,
      // Applied by plain PostgreSQL only: Neon's proxy drops connect-time
      // settings, so production's limits are the app/MCP role settings in
      // migrations/007-role-timeouts.up.sql. Change both together.
      statement_timeout: 20000,
      lock_timeout: 10000,
      // Cloud Run containerConcurrency; each request holds at most one connection.
      max: 40,
      idleTimeoutMillis: POOL_IDLE_MS,
      // Scripts exit once their work is done; services close pools on SIGTERM.
      allowExitOnIdle: true,
    });
    // A dropped connection surfaces at its next use, idle or held.
    pool.on("error", () => {});
    pool.on("connect", (client) => client.on("error", () => {}));
    pools.set(url, pool);
  }
  return pool;
}

// Work no request awaits (usage records), so shutdown can wait for it.
const background = new Set<Promise<unknown>>();
/** Runs `work` without blocking the caller; its failure is the work's own to
 * handle, and closeDatabasePools waits for it before ending any pool. */
export function inBackground(work: () => Promise<unknown>): void {
  const running = work()
    .catch(() => {})
    .finally(() => background.delete(running));
  background.add(running);
}
/** Settles once no background work is running. */
export async function backgroundSettled(): Promise<void> {
  while (background.size) await Promise.allSettled([...background]);
}

/** Ends every pool once background work has finished and its borrowed
 * connections return. */
export async function closeDatabasePools(): Promise<void> {
  await backgroundSettled();
  const open = [...pools.values()];
  pools.clear();
  await Promise.allSettled(open.map((pool) => pool.end()));
}

async function checkout(pool: Pool, now: () => number): Promise<PoolClient> {
  for (;;) {
    const client = await pool.connect();
    const idle = now() - (releasedAt.get(client) ?? now());
    if (idle >= 0 && idle <= POOL_IDLE_MS) return client;
    client.release(true);
  }
}

/** Direct PostgreSQL TLS through one process-wide pool per URL: an operation
 * borrows one bounded connection and returns it, or destroys it after any
 * failure that may leave it unusable. Sessions hold no state between borrowers
 * (only SET LOCAL). No native auth SDK or credential-schema access is needed by
 * either writing runtime. `now` is for tests. */
export function postgresDatabase(
  url: string,
  { now = Date.now }: { now?: () => number } = {},
): StoreDatabase {
  validateDatabaseUrl(url);
  const dialect = new PgDialect();
  const connect = async <T>(work: (db: StoreDatabase) => Promise<T>) => {
    let client: PoolClient;
    try {
      client = await checkout(poolFor(url), now);
    } catch (error) {
      throw databaseFailure(error);
    }
    // Reused only when its last command succeeded, no BEGIN, COMMIT or ROLLBACK
    // failed (an error inside a transaction is fine after its ROLLBACK), and no
    // query or transaction is still unfinished when `work` settles.
    let lastFailed = false,
      broken = false,
      released = false,
      running = 0,
      open = 0;
    const run = async <Row extends Record<string, unknown>>(
      text: string,
      params?: unknown[],
    ) => {
      // Once released, the client may belong to another borrower.
      if (released)
        throw new StoreError(
          "store_unavailable",
          "The memo store is unavailable. Try again.",
        );
      running++;
      try {
        const result = await client.query<Row>(text, params);
        lastFailed = false;
        return result;
      } catch (error) {
        lastFailed = true;
        throw error;
      } finally {
        running--;
      }
    };
    const control = async (command: string) => {
      try {
        await run(command);
      } catch (error) {
        broken = true;
        throw error;
      }
    };
    const session: StoreDatabase = {
      async query<Row extends Record<string, unknown>>(statement: SQL) {
        const query = dialect.sqlToQuery(statement);
        try {
          return (await run<Row>(query.sql, query.params)).rows;
        } catch (error) {
          throw databaseFailure(error);
        }
      },
      async transaction(work) {
        open++;
        try {
          try {
            await control("BEGIN");
          } catch (error) {
            throw databaseFailure(error);
          }
          let callbackCompleted = false;
          try {
            const result = await work(session);
            callbackCompleted = true;
            await control("COMMIT");
            return result;
          } catch (error) {
            try {
              await control("ROLLBACK");
            } catch (rollbackError) {
              databaseFailure(rollbackError);
            }
            // Query failures are already mapped; callback rejections keep identity.
            if (!callbackCompleted) throw error;
            throw databaseFailure(error);
          }
        } finally {
          open--;
        }
      },
      withConnection: (work) => work(session),
    };
    try {
      return await work(session);
    } finally {
      released = true;
      const reusable = !lastFailed && !broken && running === 0 && open === 0;
      if (reusable) releasedAt.set(client, now());
      client.release(!reusable);
    }
  };
  return {
    query: (statement) => connect((db) => db.query(statement)),
    transaction: (work) => connect((db) => db.transaction(work)),
    withConnection: connect,
  };
}

export const triggerRefusals = new Map<
  string,
  { message: string; status: number }
>([
  [
    "card_version_conflict",
    {
      message: "The instruction card changed. Read the current report.",
      status: 409,
    },
  ],
  [
    "card_version_is_immutable",
    { message: "Instruction card versions cannot be changed.", status: 409 },
  ],
  [
    "card_identity_is_immutable",
    { message: "Instruction card identity cannot be changed.", status: 409 },
  ],
  [
    "memo_body_limit",
    { message: "The memo body exceeds its size limit.", status: 422 },
  ],
  [
    "memo_description_limit",
    { message: "The memo description exceeds its size limit.", status: 422 },
  ],
  [
    "memo_reason_limit",
    { message: "The memo reason exceeds its size limit.", status: 422 },
  ],
  [
    "account_unavailable",
    { message: "This Milton account is unavailable.", status: 403 },
  ],
  [
    "user_id_is_immutable",
    { message: "The Milton user id cannot be changed.", status: 409 },
  ],
  [
    "sample_identity_is_immutable",
    { message: "Sample identities cannot be changed.", status: 409 },
  ],
  [
    "sample_version_is_immutable",
    { message: "Sample revisions cannot be changed.", status: 409 },
  ],
  [
    "sample_version_conflict",
    {
      message: "Append the next complete revision of an active sample.",
      status: 409,
    },
  ],
  [
    "sample_kind_is_immutable",
    { message: "Sample kinds cannot be changed.", status: 409 },
  ],
  [
    "save_receipt_is_immutable",
    { message: "A completed save receipt cannot be changed.", status: 409 },
  ],
]);

export function databaseFailure(error: unknown): StoreError {
  if (error instanceof StoreError) return error;
  // Logged when unrecognized: the innermost error that carries a code.
  let logged = error;
  const seen = new Set<object>();
  while (typeof error === "object" && error !== null && !seen.has(error)) {
    seen.add(error);
    if ("code" in error) {
      logged = error;
      if (error.code === "23505")
        return new StoreError(
          "unique_violation",
          "A record with these identifiers already exists.",
          409,
        );
      if (error.code === "23514")
        return new StoreError(
          "check_violation",
          "The record does not meet the store requirements.",
          422,
        );
      if (
        error.code === "P0001" &&
        "message" in error &&
        typeof error.message === "string"
      ) {
        const refusal = triggerRefusals.get(error.message);
        if (refusal)
          return new StoreError(error.message, refusal.message, refusal.status);
      }
    }
    error = "cause" in error ? error.cause : undefined;
  }
  logUnexpected("store", logged);
  return new StoreError(
    "store_unavailable",
    "The memo store is unavailable. Try again.",
  );
}

/** `db`, whatever its adapter, with every database failure mapped through
 * databaseFailure: its own queries, its transactions' and connections' queries,
 * and their begin, commit and connect. A rejection from the caller's own
 * callback keeps its identity. The production adapters already map (scripts
 * use them directly); a StoreError passes through unchanged, so each failure
 * is mapped and logged once. */
export function mappedDatabase(db: StoreDatabase): StoreDatabase {
  return {
    ...mappedSession(db),
    transaction: (work) =>
      keepingCallbackFailures(
        (inner) => db.transaction((tx) => inner(mappedSession(tx))),
        work,
      ),
    withConnection: (work) =>
      keepingCallbackFailures(
        (inner) =>
          db.withConnection((connection) => inner(mappedDatabase(connection))),
        work,
      ),
  };
}

function mappedSession(session: StoreSession): StoreSession {
  return {
    async query<Row extends Record<string, unknown>>(statement: SQL) {
      try {
        return await session.query<Row>(statement);
      } catch (error) {
        throw databaseFailure(error);
      }
    },
  };
}

// `run` calls `work` back; whatever `work` rejects with is the caller's own.
async function keepingCallbackFailures<S, T>(
  run: (inner: (session: S) => Promise<T>) => Promise<T>,
  work: (session: S) => Promise<T>,
): Promise<T> {
  let callbackFailure: { error: unknown } | undefined;
  try {
    return await run(async (session) => {
      try {
        return await work(session);
      } catch (error) {
        callbackFailure = { error };
        throw error;
      }
    });
  } catch (error) {
    if (callbackFailure && error === callbackFailure.error) throw error;
    throw databaseFailure(error);
  }
}

export function validateDatabaseUrl(value: string): string {
  try {
    const url = new URL(value);
    if (
      /[\r\n\0]/.test(value) ||
      !["postgres:", "postgresql:"].includes(url.protocol) ||
      !url.hostname ||
      url.searchParams.has("ssl") ||
      url.searchParams.has("uselibpqcompat") ||
      url.searchParams.getAll("sslmode").length > 1 ||
      decodeURIComponent(url.pathname) !== "/milton" ||
      !["require", "verify-full", "verify-ca"].includes(
        url.searchParams.get("sslmode") ?? "require",
      )
    )
      throw new Error();
    return value;
  } catch {
    throw new StoreError(
      "configuration",
      "DATABASE_URL must select the milton Postgres database with TLS.",
    );
  }
}
