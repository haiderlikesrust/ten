import type { Db } from "@gemdex/db";
import { createPaperVenue, type Mode, type Venue } from "@gemdex/venues";

export function modeFromEnv(): Mode {
  const mode = process.env.GEMDEX_MODE || "paper";
  if (mode !== "paper" && mode !== "devnet" && mode !== "mainnet") throw new Error(`unknown GEMDEX_MODE ${mode}`);
  return mode;
}

/** The Solana adapter is only loaded on request, so paper builds never touch signing code. */
export async function loadVenue(mode: Mode, db: Db): Promise<Venue> {
  if (mode === "paper") return createPaperVenue(db);
  const { createSolanaVenue } = await import("@gemdex/venues/solana");
  return createSolanaVenue(mode, db);
}
