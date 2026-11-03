import { z } from "zod";
import type { StoreDatabase, StoreSession } from "./database";
import type { CardHead } from "./cards";
import type { Documents, Sample } from "./reports";
import type { MemoUpdate, UpdateReceipt } from "./memo-updates";
import type { SaveMemoInput } from "./compiled";

export const retiredSample = z.object({
  id: z.string(),
  reason: z.enum(["replaced", "removed", "evicted"]),
});
// Stored receipts may hold needs_clarification from the retired model path.
export const outcomeSchema = z.object({
  status: z.enum([
    "saved",
    "unchanged",
    "needs_clarification",
    "conflict",
    "in_progress",
    "failed",
  ]),
  request_id: z.string(),
  version: z.string().optional(),
  question: z.string().optional(),
  error: z.string().optional(),
  /** A StoreError's client-facing message; never raw internal text. */
  message: z.string().optional(),
  samples_retired: z.array(retiredSample).optional(),
});
export type SaveOutcome = z.infer<typeof outcomeSchema> & {
  memo_update?: MemoUpdate;
};
export type Report = { revision: number; body: string; source_hash: string };
export type Receipt = UpdateReceipt & {
  input_hash: string;
  source_hash: string;
  completed: boolean;
  live: boolean;
  result_json: unknown;
};
/** What `snapshot` reads inside a transaction. */
export type Snapshot = {
  heads: CardHead[];
  samples: Sample[];
  report: Report | undefined;
  fingerprint: string;
  active: CardHead[];
  documents: Documents;
  ready: boolean;
  version: string;
};
/** One save's input and the account helpers its phases share. Built once per
 * save, after the input is parsed and the assistant is known. */
export type SaveContext = {
  db: StoreDatabase;
  userId: string;
  actor: { issuer: string; clientId: string };
  appOrigin: string | undefined;
  input: SaveMemoInput;
  inputHash: string;
  result: (
    status: SaveOutcome["status"],
    rest?: Partial<SaveOutcome>,
  ) => SaveOutcome;
  lock: (tx: StoreSession) => Promise<void>;
  snapshot: (tx: StoreSession) => Promise<Snapshot>;
  receipt: (tx: StoreSession, id: string) => Promise<Receipt | undefined>;
  complete: (
    tx: StoreSession,
    result: SaveOutcome,
    changed?: boolean,
  ) => Promise<SaveOutcome>;
  assemble: (tx: StoreSession, documents: Documents) => Promise<string>;
  publish: (
    tx: StoreSession,
    current: Snapshot,
    body: string,
  ) => Promise<string>;
};
