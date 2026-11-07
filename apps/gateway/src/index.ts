import { connect, runMigrations } from "@gemdex/db";
import type { Mode } from "@gemdex/venues";
import { buildServer } from "./server";

// Blank counts as unset, so a placeholder waiting to be filled in keeps the default.
const mode = (process.env.GEMDEX_MODE || "paper") as Mode;
const port = Number(process.env.GATEWAY_PORT || 4010);

let draining = false;

await runMigrations();
const database = connect();
const app = await buildServer({ database, mode, corsOrigin: process.env.WEB_ORIGIN || true, draining: () => draining });
await app.listen({ port, host: process.env.GATEWAY_HOST || "127.0.0.1" });
console.log(`[gateway] listening on ${port} in ${mode} mode`);

/**
 * Stopping. In an update the new gateway is already healthy when this runs: report unhealthy, keep
 * serving for DRAIN_DELAY_MS while traffic moves over, then close the live streams (browsers reconnect
 * to the new gateway), let open requests finish, and exit. Never longer than 9 seconds, inside Docker's
 * default 10-second stop grace.
 */
async function shutdown() {
  if (draining) return;
  draining = true;
  console.log("[gateway] stopping: finishing open requests");
  setTimeout(() => process.exit(0), 9_000).unref();
  await new Promise((resolve) => setTimeout(resolve, Number(process.env.DRAIN_DELAY_MS ?? 0)));
  await app.close();
  await database.close();
  process.exit(0);
}
process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
// Lets tools/handover.ts stop it the same way on Windows, which has no signals.
process.on("message", (message) => {
  if (message === "shutdown") void shutdown();
});
