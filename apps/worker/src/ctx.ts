import type { Database, Db, Drop } from "@gemdex/db";
import type { CcRead, Venue } from "@gemdex/venues";
import type { SlotReader, TokenReader } from "@gemdex/venues/holdings";

export interface Ctx {
  db: Db;
  sql: Database["sql"];
  venue: Venue;
  /** Always reads live CC data, in every mode. */
  cc: CcRead;
  rng: () => number;
  /** Reads $TENR for the access minimum. Null or missing when there's no $TENR to check. */
  tokens?: TokenReader | null;
  /** Seeds gift draws from a future blockhash. Null in paper mode. */
  slots?: SlotReader | null;
  log: (message: string, extra?: unknown) => void;
  /** Tells clients about a drop that changed. */
  announce: (drop: Drop) => Promise<void>;
}
