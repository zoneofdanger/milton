import { AsyncLocalStorage } from "node:async_hooks";
import { Kysely, PostgresDialect, sql } from "kysely";
import { kyselyAdapter } from "@better-auth/kysely-adapter";
import type { BetterAuthOptions } from "@better-auth/core";
import type { DBAdapter, Where } from "@better-auth/core/db/adapter";
import type pg from "pg";

const I = "miltonIdentityIncarnation",
  G = "miltonSecurityGeneration",
  R = "miltonCredentialRevision";
type Snapshot = Readonly<{
  id: string;
  email?: string;
  [I]: string;
  [G]: string;
}>;
type Credential = Readonly<{ id: string; userId: string; [R]: string }>;
type OriginalToken = {
  id: string;
  referenceId: string;
  userId: string;
  clientId: string;
};
export type RequestState = {
  mail?: import("./mail.ts").NativeMail;
  mailFault?: boolean;
  mailExpected?: boolean;
  resetMailProof?: { identifier: string; expiresAt: number };
  path: string;
  cleanupPath: boolean;
  revokePath: boolean;
  clientId?: string;
  users: Map<string, Snapshot>;
  credentials: Map<string, Credential>;
  /** This request's admitted and bound OAuth flows, by correlate's inputs. */
  flows: Map<string, Promise<string>>;
  subject?: string;
  noCredentialObserved?: string;
  originalRefresh?: OriginalToken;
  originalAccess?: OriginalToken;
  linkedSubject?: string;
  linkedIdentity?: { provider: string; subject: string };
  securitySession?: { id: string; createdAt: Date };
};
export const transport = new AsyncLocalStorage<RequestState>();
type NativeRow = Record<string, unknown>;
type Args = {
  model: string;
  where?: Where[];
  data?: NativeRow;
  update?: NativeRow;
  join?: unknown;
};
const row = (value: unknown): NativeRow | null =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as NativeRow)
    : null;
const text = (value: unknown): string => {
  if (typeof value !== "string" || !value)
    throw new Error("missing_native_provenance");
  return value;
};
const snapshot = (r: NativeRow): Snapshot => ({
  id: text(r.id),
  email: typeof r.email === "string" ? r.email : undefined,
  [I]: text(r[I]),
  [G]: text(r[G]),
});
const methods = new Set([
  "create",
  "findOne",
  "findMany",
  "update",
  "updateMany",
  "delete",
  "deleteMany",
  "consumeOne",
  "incrementOne",
]);
function state() {
  const s = transport.getStore();
  if (!s) throw new Error("missing_native_request_context");
  return s;
}
async function invoke(
  adapter: DBAdapter,
  method: string,
  args: Args,
): Promise<unknown> {
  const fn: unknown = Reflect.get(adapter, method);
  if (typeof fn !== "function")
    throw new Error("unsupported_native_adapter_method");
  return Reflect.apply(fn, adapter, [args]) as Promise<unknown>;
}

// Proxy the public adapter. Native owns hashing, protocol, hooks, one-use consumption
// and commit callbacks. Both credential and grant decorators are reconstructed on
// the exact same transaction executor, including a nested transaction callback.
export function credentialAdapter(pool: pg.Pool) {
  const db = new Kysely<Record<string, never>>({
    dialect: new PostgresDialect({ pool }),
  }).withSchema("milton_auth");
  return (options: BetterAuthOptions): DBAdapter => {
    function capture(model: string, result: unknown, s: RequestState): void {
      if (Array.isArray(result)) {
        for (const r of result) capture(model, r, s);
        return;
      }
      const r = row(result);
      if (!r) return;
      if (model === "oauthClient" && s.cleanupPath && r.clientId) {
        const clientId = text(r.clientId);
        if (s.clientId && s.clientId !== clientId)
          throw new Error("changed_native_caller");
        s.clientId ??= clientId;
      }
      if (model === "user") {
        if (s.path === "/send-verification-email" && r.emailVerified === false)
          s.mailExpected = true;
        if (r[I] && r[G] && !s.users.has(text(r.id)))
          s.users.set(text(r.id), snapshot(r));
        if (r.account) capture("account", r.account, s);
      }
      if (model === "account") {
        if (r.providerId === "credential" && !s.credentials.has(text(r.userId)))
          s.credentials.set(text(r.userId), {
            id: text(r.id),
            userId: text(r.userId),
            [R]: text(r[R]),
          });
        if (r.user) capture("user", r.user, s);
      }
      if (model === "session") {
        const u = row(r.user);
        if (u) {
          if (!r[I] || !r[G] || r[I] !== u[I] || r[G] !== u[G])
            throw new Error("stale_native_session");
          capture("user", u, s);
          s.subject ??= text(r.userId);
          s.securitySession ??= {
            id: text(r.id),
            createdAt: new Date(String(r.createdAt)),
          };
        }
      }
      if (model === "verification" && typeof r.value === "string") {
        if (s.path === "/reset-password") s.subject ??= r.value;
        if (s.path === "/oauth2/token") {
          let v: unknown;
          try {
            v = JSON.parse(r.value);
          } catch {
            return;
          }
          const c = row(v);
          if (c?.type === "authorization_code") s.subject ??= text(c.userId);
        }
      }
    }
    type Executor = typeof db;
    type TxState = { subject?: string; mutation?: Snapshot };
    async function lock(executor: Executor, subject: string): Promise<void> {
      const r = await sql<{
        incarnation: string;
        generation: string;
      }>`select * from milton_credential.lock_user(${subject})`.execute(
        executor,
      );
      if (!r.rows[0]) throw new Error("missing_native_parent");
    }
    function decorate(
      raw: DBAdapter,
      tx?: { db: Executor; state: TxState },
    ): DBAdapter {
      let composed: DBAdapter;
      async function transaction<T>(
        callback: (adapter: DBAdapter) => Promise<T>,
      ): Promise<T> {
        if (tx) return callback(composed);
        const s = state();
        return db
          .transaction()
          .setIsolationLevel("read committed")
          .execute(async (executor) => {
            const txState: TxState = {};
            await sql`select pg_catalog.set_config('milton.native_path',${s.path},true)`.execute(
              executor,
            );
            // Captured native token/reset subject reaches this point before child writes.
            if (s.subject) {
              await lock(executor, s.subject);
              txState.subject = s.subject;
            }
            const native = kyselyAdapter(executor, {
              type: "postgres",
              transaction: false,
            })(options);
            return callback(decorate(native, { db: executor, state: txState }));
          });
      }
      const credentials = new Proxy(raw, {
        get(target, key, receiver) {
          if (key === "transaction") return transaction;
          if (typeof key !== "string" || !methods.has(key))
            return Reflect.get(target, key, receiver);
          return async (args: Args): Promise<unknown> => {
            const s = state();
            const write = key !== "findOne" && key !== "findMany";
            if (write && !tx) return transaction((a) => invoke(a, key, args));
            const passwordWrite =
              args.model === "account" &&
              ((key === "create" && args.data?.providerId === "credential") ||
                (["update", "updateMany"].includes(key) &&
                  Object.hasOwn(args.update ?? {}, "password")));
            const sessionInsert = args.model === "session" && key === "create";
            if (write && args.model === "session") {
              const create =
                sessionInsert &&
                ([
                  "/sign-up/email",
                  "/sign-in/email",
                  "/sign-in/social",
                  "/change-password",
                ].includes(s.path) ||
                  /^\/callback\/(google|github)$/.test(s.path));
              const remove =
                ["delete", "deleteMany"].includes(key) &&
                [
                  "/sign-out",
                  "/change-password",
                  "/reset-password",
                  "/revoke-session",
                  "/revoke-sessions",
                  "/revoke-other-sessions",
                  "/oauth2/end-session/confirm",
                ].includes(s.path);
              const update =
                ["update", "updateMany"].includes(key) &&
                ["/get-session"].includes(s.path) &&
                Object.keys(args.update ?? {}).every((k) =>
                  ["expiresAt", "updatedAt", "ipAddress", "userAgent"].includes(
                    k,
                  ),
                );
              if (!create && !remove && !update)
                throw new Error("uncovered_session_mutation");
            }
            if (write && args.model === "user" && key !== "create") {
              if (
                key !== "update" ||
                Object.keys(args.update ?? {}).some(
                  (k) =>
                    !["name", "image", "emailVerified", "updatedAt"].includes(
                      k,
                    ),
                )
              )
                throw new Error("uncovered_user_mutation");
            }
            if (write && args.model === "account" && !passwordWrite) {
              const unlink = key === "delete" && s.path === "/unlink-account";
              if (!unlink && !["create", "update", "updateMany"].includes(key))
                throw new Error("uncovered_account_mutation");
              if (
                key !== "create" &&
                Object.keys(args.update ?? {}).some((k) =>
                  [I, G, R, "userId", "accountId"].includes(k),
                )
              )
                throw new Error("protected_account_mutation");
            }
            if (
              write &&
              args.model === "verification" &&
              s.path === "/reset-password" &&
              !s.subject &&
              !(
                key === "deleteMany" &&
                args.where?.some(
                  (w) => w.field === "expiresAt" && w.operator === "lt",
                )
              )
            )
              throw new Error("missing_original_reset_identity");
            let subject = s.subject;
            let verificationProof: Snapshot | undefined;
            if (write && args.model === "user" && s.path === "/verify-email") {
              const email = args.where?.find(
                (w) => w.field === "email" && !w.operator,
              )?.value;
              const candidates = [...s.users.values()].filter(
                (u) => u.email === email,
              );
              if (candidates.length !== 1)
                throw new Error("missing_original_verification_identity");
              verificationProof = candidates[0]!;
              if (subject && subject !== verificationProof.id)
                throw new Error("changed_verification_subject");
              subject = verificationProof.id;
            }
            const resetIssue =
              write &&
              args.model === "verification" &&
              key === "create" &&
              typeof args.data?.identifier === "string" &&
              args.data.identifier.startsWith("reset-password:");
            let issuance: Snapshot | undefined;
            if (resetIssue) {
              subject = text(args.data?.value);
              issuance = s.users.get(subject);
              if (!issuance || s.path !== "/request-password-reset")
                throw new Error("missing_original_reset_issuance");
            }
            if (
              write &&
              [
                "oauthConsent",
                "oauthRefreshToken",
                "oauthAccessToken",
              ].includes(args.model)
            ) {
              subject ??= args.data?.userId as string | undefined;
              if (!subject) throw new Error("missing_original_token_subject");
            }
            if (
              write &&
              args.model === "verification" &&
              key === "create" &&
              typeof args.data?.value === "string"
            ) {
              let v: unknown;
              try {
                v = JSON.parse(args.data.value);
              } catch {
                v = null;
              }
              const c = row(v);
              if (c?.type === "authorization_code") subject ??= text(c.userId);
            }
            if (write && args.model === "user" && key !== "create")
              subject ??= args.where?.find(
                (w) => w.field === "id" && !w.operator,
              )?.value as string | undefined;
            if (
              write &&
              args.model === "account" &&
              key !== "create" &&
              !subject
            )
              subject = row(
                await invoke(raw, "findOne", {
                  model: "account",
                  where: args.where,
                }),
              )?.userId as string | undefined;
            if (sessionInsert || (args.model === "account" && key === "create"))
              subject = text(args.data?.userId);
            if (passwordWrite && key !== "create")
              subject ??= [...s.credentials.keys()][0];
            if (write && args.model === "session" && !subject) {
              const found = await raw.findMany<NativeRow>({
                model: "session",
                where: args.where,
              });
              subject = found[0]?.userId as string | undefined;
              if (found.some((r) => r.userId !== subject))
                throw new Error("multi_parent_operation_refused");
            }
            if (write && subject && tx) {
              if (tx.state.subject && tx.state.subject !== subject)
                throw new Error("multi_parent_transaction_refused");
              if (tx.state.subject !== subject) {
                await lock(tx.db, subject);
                tx.state.subject = subject;
              }
            }
            if (issuance) {
              const current = await raw.findOne<NativeRow>({
                model: "user",
                where: [{ field: "id", value: issuance.id }],
              });
              if (
                !current ||
                current[I] !== issuance[I] ||
                current[G] !== issuance[G]
              )
                throw new Error("stale_reset_issuance");
            }
            let input = args;
            if (verificationProof)
              input = {
                ...args,
                where: [
                  ...(args.where ?? []),
                  { field: "id", value: verificationProof.id },
                  { field: I, value: verificationProof[I] },
                  { field: G, value: verificationProof[G] },
                ],
              };
            if (
              write &&
              args.model === "account" &&
              !passwordWrite &&
              subject
            ) {
              if (args.update && Object.hasOwn(args.update, "providerId")) {
                const existing = await raw.findOne<NativeRow>({
                  model: "account",
                  where: args.where ?? [],
                });
                if (!existing || args.update.providerId !== existing.providerId)
                  throw new Error("immutable_provider");
                const { providerId: _provider, ...update } = args.update;
                input = { ...args, update };
              }
              if (s.securitySession) {
                const current = await raw.findOne<NativeRow>({
                  model: "user",
                  where: [{ field: "id", value: subject }],
                });
                const original = s.users.get(subject);
                const session = await raw.findOne<NativeRow>({
                  model: "session",
                  where: [
                    { field: "id", value: s.securitySession.id },
                    { field: "userId", value: subject },
                  ],
                });
                if (
                  !original ||
                  !current ||
                  !session ||
                  current[I] !== original[I] ||
                  current[G] !== original[G] ||
                  new Date(String(session.expiresAt)).getTime() <= Date.now() ||
                  Date.now() - s.securitySession.createdAt.getTime() > 300000
                )
                  throw new Error("stale_method_proof");
              }
            }
            if (passwordWrite) {
              if (
                ![
                  "/change-password",
                  "/reset-password",
                  "/sign-up/email",
                ].includes(s.path) ||
                !subject ||
                !tx
              )
                throw new Error("uncovered_password_mutation");
              const proof = s.credentials.get(subject);
              const current = await raw.findOne<NativeRow>({
                model: "account",
                where: [
                  { field: "userId", value: subject },
                  { field: "providerId", value: "credential" },
                ],
              });
              if (key === "create") {
                if (
                  current ||
                  (s.path !== "/sign-up/email" &&
                    s.noCredentialObserved !== subject)
                )
                  throw new Error("missing_exact_credential_absence");
              } else {
                if (
                  !proof ||
                  !current ||
                  proof.id !== current.id ||
                  proof[R] !== current[R]
                )
                  throw new Error("stale_native_credential_proof");
                input = {
                  ...args,
                  where: [...(args.where ?? []), { field: R, value: proof[R] }],
                  update: {
                    ...args.update,
                    miltonExpectedCredentialRevision: proof[R],
                  },
                };
              }
            }
            if (sessionInsert) {
              if (!subject) throw new Error("missing_session_subject");
              let snap = s.users.get(subject);
              if (s.path === "/change-password") snap = tx?.state.mutation;
              if (s.path === "/sign-in/email") {
                const proof = s.credentials.get(subject);
                if (!snap || !proof)
                  throw new Error("missing_original_signin_proof");
                const current = await raw.findOne<NativeRow>({
                  model: "account",
                  where: [
                    { field: "id", value: proof.id },
                    { field: "providerId", value: "credential" },
                  ],
                });
                if (!current || current[R] !== proof[R])
                  throw new Error("stale_native_signin_proof");
              }
              if (!snap) throw new Error("missing_original_session_snapshot");
              input = {
                ...args,
                data: { ...args.data, [I]: snap[I], [G]: snap[G] },
              };
            }
            const result = await invoke(raw, key, input);
            if (resetIssue && result) {
              const proof = row(result);
              s.mailExpected = true;
              s.resetMailProof = {
                identifier: text(proof?.identifier),
                expiresAt: new Date(
                  proof?.expiresAt as string | Date,
                ).getTime(),
              };
            }
            if (
              write &&
              args.model === "user" &&
              key === "create" &&
              row(result)?.emailVerified === false &&
              (s.path === "/sign-up/email" ||
                /^\/callback\/(google|github)$/.test(s.path))
            )
              s.mailExpected = true;
            if (verificationProof && !result)
              throw new Error("verification_cas_zero_rows");
            if (
              write &&
              args.model === "account" &&
              !passwordWrite &&
              key !== "delete" &&
              s.securitySession &&
              subject &&
              /^\/callback\/(google|github)$/.test(s.path)
            ) {
              s.linkedSubject = subject;
              const linked = row(result);
              if (linked)
                s.linkedIdentity = {
                  provider: text(linked.providerId),
                  subject: text(linked.accountId),
                };
            }
            if (passwordWrite) {
              if (
                (key === "updateMany" && result !== 1) ||
                (key !== "updateMany" && !result)
              )
                throw new Error("credential_cas_zero_rows");
              const u = await raw.findOne<NativeRow>({
                model: "user",
                where: [{ field: "id", value: text(subject) }],
              });
              if (!u || !tx) throw new Error("missing_mutated_parent");
              tx.state.mutation = snapshot(u);
            }
            if (!write) {
              capture(args.model, result, s);
              if (
                args.model === "account" &&
                !result &&
                s.path === "/reset-password"
              )
                s.noCredentialObserved = s.subject;
            }
            if (write && args.model === "user" && key === "create")
              capture("user", result, s);
            if (
              !write &&
              args.model === "user" &&
              s.path === "/change-password" &&
              row(result)
            )
              s.subject ??= text(row(result)?.id);
            return result;
          };
        },
      });
      // Original-reference decorator is outermost at every reconstruction. Capture
      // before native transaction entry; scope replay/revoke cleanup to that reference.
      composed = new Proxy(credentials, {
        get(target, key, receiver) {
          if (key === "transaction") return transaction;
          if (typeof key !== "string" || !methods.has(key))
            return Reflect.get(target, key, receiver);
          return async (args: Args): Promise<unknown> => {
            const s = state();
            const token = ["oauthAccessToken", "oauthRefreshToken"].includes(
              args.model,
            );
            if (
              s.cleanupPath &&
              token &&
              [
                "findMany",
                "update",
                "updateMany",
                "delete",
                "deleteMany",
                "consumeOne",
                "incrementOne",
              ].includes(key)
            ) {
              const original = s.originalRefresh ?? s.originalAccess;
              if (
                !original ||
                original.clientId !== s.clientId ||
                args.where?.some((w) => w.connector === "OR")
              )
                throw new Error("invalid_original_token_reference");
              if (
                (key === "findMany" && args.model === "oauthRefreshToken") ||
                (s.revokePath &&
                  args.model === "oauthRefreshToken" &&
                  key !== "findOne")
              )
                await sql`select milton_guard.retire_family(${original.referenceId},${original.userId},${original.clientId})`.execute(
                  tx?.db ?? db,
                );
              args = {
                ...args,
                where: [
                  ...(args.where ?? []),
                  { field: "referenceId", value: original.referenceId },
                ],
              };
            }
            if (
              s.cleanupPath &&
              token &&
              key === "create" &&
              (!s.originalRefresh ||
                args.data?.referenceId !== s.originalRefresh.referenceId)
            )
              throw new Error("invalid_rotated_reference");
            const result = await invoke(target, key, args);
            const r = row(result);
            if (
              s.cleanupPath &&
              token &&
              key === "findOne" &&
              args.where?.some((w) => w.field === "token") &&
              r
            ) {
              const original = {
                id: text(r.id),
                referenceId: text(r.referenceId),
                userId: text(r.userId),
                clientId: text(r.clientId),
              };
              const field =
                args.model === "oauthRefreshToken"
                  ? "originalRefresh"
                  : "originalAccess";
              if (
                s[field] &&
                JSON.stringify(s[field]) !== JSON.stringify(original)
              )
                throw new Error("changed_original_token");
              s[field] ??= Object.freeze(original);
              if (s.subject && s.subject !== original.userId)
                throw new Error("changed_original_subject");
              s.subject ??= original.userId;
            }
            return result;
          };
        },
      });
      return composed;
    }
    return decorate(
      kyselyAdapter(db, { type: "postgres", transaction: true })(options),
    );
  };
}
