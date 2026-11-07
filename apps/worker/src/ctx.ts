import type { Database, Db, Drop } from "@gemdex/db";
import type { CcRead, Venue } from "@gemdex/venues";

export interface Ctx {
  db: Db;
  sql: Database["sql"];
  venue: Venue;
  /** Always reads live CC data, in every mode. */
  cc: CcRead;
  rng: () => number;
  log: (message: string, extra?: unknown) => void;
  /** Tells clients about a drop that changed. */
  announce: (drop: Drop) => Promise<void>;
}
