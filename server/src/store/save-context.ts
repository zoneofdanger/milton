import { z } from "zod";
import type { StoreDatabase, StoreSession } from "./database";
import type { CardHead } from "./cards";
import type { Documents, Sample } from "./reports";
import type { SaveMemoInput } from "./compiled";

export const retiredSample = z.object({
  id: z.string(),
  reason: z.enum(["replaced", "removed", "evicted"]),
});
export const outcomeSchema = z.object({
  status: z.enum(["saved", "unchanged", "conflict", "failed"]),
  request_id: z.string(),
  version: z.string().optional(),
  question: z.string().optional(),
  error: z.string().optional(),
  /** A StoreError's client-facing message; never raw internal text. */
  message: z.string().optional(),
  samples_retired: z.array(retiredSample).optional(),
});
export type SaveOutcome = z.infer<typeof outcomeSchema>;
export type Receipt = { input_hash: string; result_json: unknown };
/** What `snapshot` reads in one statement. */
export type Snapshot = {
  /** The account exists and is active. */
  open: boolean;
  heads: CardHead[];
  samples: Sample[];
  /** The source fingerprint: card heads and active sample IDs, kinds and context revisions. */
  fingerprint: string;
  active: CardHead[];
  documents: Documents;
  /** The fingerprint of the assembled documents; every save fences on it. */
  version: string;
};
/** One save's input and the account helpers its transaction uses. Built once
 * per save, after the input is parsed and the assistant is known. */
export type SaveContext = {
  db: StoreDatabase;
  userId: string;
  actor: { issuer: string; clientId: string };
  input: SaveMemoInput;
  inputHash: string;
  result: (
    status: SaveOutcome["status"],
    rest?: Partial<SaveOutcome>,
  ) => SaveOutcome;
  lock: (tx: StoreSession) => Promise<void>;
  snapshot: (tx: StoreSession) => Promise<Snapshot>;
  receipt: (tx: StoreSession, id: string) => Promise<Receipt | undefined>;
  checkSize: (tx: StoreSession, documents: Documents) => Promise<void>;
};
