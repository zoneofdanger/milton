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

export const read = (result: { content: [{ text: string }] }) =>
  JSON.parse(result.content[0].text);
