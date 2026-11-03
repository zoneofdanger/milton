import type { PGlite } from "@electric-sql/pglite";
import { compiledMemos } from "../src/store/compiled";
import type { StoreDatabase, StoreSession } from "../src/store/database";

// Runs `between` after a save's claim commits and before its write phase, the
// window in which another request or an account change can land.
export const betweenPhases = (
  db: StoreDatabase,
  between: () => Promise<unknown>,
): StoreDatabase => ({
  ...db,
  async transaction<T>(work: (tx: StoreSession) => Promise<T>) {
    const result = await db.transaction(work);
    if (typeof result === "object" && result !== null && "current" in result)
      await between();
    return result;
  },
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
