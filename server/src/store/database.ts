import type { SQL } from "drizzle-orm";
import { StoreError } from "./errors";
import { logUnexpected } from "../error-log";
import { Client as PgClient } from "pg";
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

/** Direct PostgreSQL, with one bounded connection per operation. No native auth
 * SDK or credential-schema access is needed by either writing runtime. */
export function postgresDatabase(url: string): StoreDatabase {
  validateDatabaseUrl(url);
  const dialect = new PgDialect();
  const connect = async <T>(work: (db: StoreDatabase) => Promise<T>) => {
    const client = new PgClient({
      connectionString: url,
      ssl: true,
      connectionTimeoutMillis: 5000,
      query_timeout: 20000,
      statement_timeout: 20000,
      lock_timeout: 10000,
    });
    client.on("error", () => {});
    let failed = false;
    try {
      try {
        await client.connect();
      } catch (error) {
        throw databaseFailure(error);
      }
      const session: StoreDatabase = {
        async query<Row extends Record<string, unknown>>(statement: SQL) {
          const query = dialect.sqlToQuery(statement);
          try {
            return (await client.query<Row>(query.sql, query.params)).rows;
          } catch (error) {
            throw databaseFailure(error);
          }
        },
        async transaction(work) {
          try {
            await client.query("BEGIN");
          } catch (error) {
            throw databaseFailure(error);
          }
          let callbackCompleted = false;
          try {
            const result = await work(session);
            callbackCompleted = true;
            await client.query("COMMIT");
            return result;
          } catch (error) {
            try {
              await client.query("ROLLBACK");
            } catch (rollbackError) {
              databaseFailure(rollbackError);
            }
            // Query failures are already mapped; callback rejections keep identity.
            if (!callbackCompleted) throw error;
            throw databaseFailure(error);
          }
        },
        withConnection: (work) => work(session),
      };
      return await work(session);
    } catch (error) {
      failed = true;
      throw error;
    } finally {
      try {
        await client.end();
      } catch (error) {
        const failure = databaseFailure(error);
        if (!failed) throw failure;
      }
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
