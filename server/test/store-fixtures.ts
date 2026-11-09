import type { PGlite } from "@electric-sql/pglite";
import { sql } from "drizzle-orm";
import { compiledMemos } from "../src/store/compiled";
import type { StoreDatabase } from "../src/store/database";
import type { MemoInput, SaveMemoInput } from "../src/mcp-tools";
import { requireActiveAccount } from "../src/store/accounts";
import { readLimits } from "../src/store/limits";
import {
  database,
  tenantStore,
  type StoreBindings,
  type TenantStore,
  type VerifiedStoreAuth,
} from "../src/store";

// Runs `inside` at the start of every transaction, while it is open. A request
// started meanwhile waits for it, as on the account lock.
export const insideTransactions = (
  db: StoreDatabase,
  inside: () => Promise<unknown>,
): StoreDatabase => ({
  ...db,
  transaction: (work) =>
    db.transaction(async (tx) => {
      await inside();
      return work(tx);
    }),
});

// The erasure step of account deletion (auth-lifecycle.ts) for a sign-in
// identity: the row lock every writer takes, then the delete that every tenant
// table cascades from. Trial-eligibility fingerprints outlive it.
export const eraseAccount = (
  db: StoreDatabase,
  identity: { provider: string; subject: string },
) =>
  db.transaction(async (tx) => {
    const [account] = await tx.query<{ id: string }>(sql`
      SELECT u.id FROM identities i JOIN users u ON u.id=i.user_id
      WHERE i.provider=${identity.provider} AND i.subject=${identity.subject}
        AND u.status='active' FOR UPDATE OF u`);
    await tx.query(sql`DELETE FROM users WHERE id=${account!.id}`);
  });

// The JSON payload of an MCP tool result.
export const read = (result: { content: [{ text: string }] }) =>
  JSON.parse(result.content[0].text);

// Bare accounts: one users row per id.
export const seedUsers = (pg: PGlite, ...ids: string[]) =>
  pg.query(
    `INSERT INTO users(id) VALUES ${ids.map((_, i) => `($${i + 1})`).join(",")}`,
    ids,
  );

// A user's store as a fixture AI sees it.
export const fixtureStore = (
  db: StoreDatabase,
  userId: string,
  clientId = "fixture",
) => compiledMemos(db, userId, { issuer: "fixture", clientId });

// A memo as an AI saves it: fictional words and context, a fresh request id.
export const memoSave = (
  memo: Partial<MemoInput> = {},
  rest: Partial<SaveMemoInput> = {},
): SaveMemoInput => ({
  request_id: crypto.randomUUID(),
  memo: {
    final: "Thanks for thinking of us. We'll pass this quarter.\n\n–P",
    context: {
      summary: "decline a vendor's meeting request",
      medium: "email",
      audience: "a vendor",
      purpose: "decline",
    },
    ...memo,
  },
  ...rest,
});
// An intent for get_report, fictional.
export const vendorIntent = {
  situation: "declining a vendor's meeting request",
  medium: "email" as const,
  audience: "a vendor",
  purpose: "decline",
};

// An account's store, refused once the account is not active: the limits and
// account checks a request makes before building it with tenantStore.
export async function storeForCurrentRequest(
  bindings: StoreBindings & { appOrigin: string },
  auth: VerifiedStoreAuth,
  assistant?: { issuer: string; clientId: string },
): Promise<TenantStore> {
  const db = database(bindings);
  const limits = await readLimits(db);
  await requireActiveAccount(db, auth.userId, { lock: false });
  return tenantStore(bindings, { ...auth, limits }, assistant);
}
