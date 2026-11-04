import type { PGlite } from "@electric-sql/pglite";
import { compiledMemos } from "../src/store/compiled";
import type { StoreDatabase, StoreSession } from "../src/store/database";

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

// The JSON payload of an MCP tool result.
export const read = (result: { content: [{ text: string }] }) =>
  JSON.parse(result.content[0].text);

// Bare accounts: one users row per id.
export const seedUsers = (pg: PGlite, ...ids: string[]) =>
  pg.query(
    `INSERT INTO users(id) VALUES ${ids.map((_, i) => `($${i + 1})`).join(",")}`,
    ids,
  );

// A user's store as a fixture assistant sees it.
export const fixtureStore = (
  db: StoreDatabase,
  userId: string,
  clientId = "fixture",
) => compiledMemos(db, userId, { issuer: "fixture", clientId });
