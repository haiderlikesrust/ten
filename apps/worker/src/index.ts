import { DEFAULT_DROP_SETTINGS, usd } from "@gemdex/core";
import { balanceOf, connect, getSetting, loadJson, post, runMigrations, saveJson, setSetting, sql, type Database } from "@gemdex/db";
import { CcRead, createPaperVenue, type PaperVenue } from "@gemdex/venues";
import { tickBalances } from "./balances";
import { tickCashback, tickHolderSnapshots } from "./cashback";
import type { Ctx } from "./ctx";
import { announceDrop, tickDrops, tickScheduler } from "./drops";
import { tickFees } from "./fees";
import { detectSales, ingestListings, ingestMachines, ingestPool, ingestPulls, recordPricePoints } from "./ingest";
import { tickOrders } from "./orders";
import { databaseAlive, holdLeadership, serveHealth, type Leadership, type WorkerState } from "./leader";
import { tickPulse } from "./pulse";
import { reconcile } from "./reconcile";
import { slotReaderFor, tokenReaderFor } from "@gemdex/venues/holdings";
import { tickGiftDraws, tickHolderStreaks } from "./gifts";
import { tickBuyback } from "./buyback";
import { loadVenue, modeFromEnv } from "./venue";

const log = (message: string, extra?: unknown) =>
  console.log(`[worker ${new Date().toISOString().slice(11, 19)}] ${message}`, extra ?? "");

let state: WorkerState = "starting";
const timers: NodeJS.Timeout[] = [];
/** Job runs in progress, which a stopping worker lets finish before it hands over. */
const inFlight = new Set<Promise<void>>();
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Runs a job on an interval. A slow run never overlaps itself, one failure never stops the loop,
 * and a stopping worker starts no new runs.
 */
function every(ms: number, name: string, job: () => Promise<unknown>) {
  let running = false;
  const run = () => {
    if (running || state === "stopping") return;
    running = true;
    const done = (async () => {
      try {
        await job();
      } catch (error) {
        log(`${name} failed`, error instanceof Error ? error.message : error);
      } finally {
        running = false;
      }
    })();
    inFlight.add(done);
    void done.finally(() => inFlight.delete(done));
  };
  run();
  const timer = setInterval(run, ms);
  timers.push(timer);
  return timer;
}

async function seedPaperTreasury(ctx: Ctx, venue: PaperVenue) {
  const seed = async (account: string, amount: number) => {
    const fresh = await ctx.db.transaction((tx) => post(tx, `seed:paper:${account}`, "seed", [{ account: "world", delta: -amount }, { account, delta: amount }]));
    if (fresh) await venue.faucet(account, amount);
  };
  await seed("drops", usd(50_000));
  await seed("cashback", usd(1_500));
  // Paper runs on a demo budget so drops come often. Real budget comes from real fees.
  if (!(await loadJson(ctx.db, "paperDefaultsPulse"))) {
    await setSetting(ctx.db, "drops", { budgetPerDayFallback: usd(150_000), dailySpendCap: usd(150_000), ttlSec: 300, newPullSec: 60, lockedHoldSec: 600, relists: 0, intervalFloorSec: 12 });
    await saveJson(ctx.db, "paperDefaultsPulse", true);
  }
}

async function main() {
  const mode = modeFromEnv();
  let open: Database | null = null;
  let leadership: Leadership | null = null;

  // Docker's health check (the image sets WORKER_HEALTH_PORT). A standby counts as healthy: during an
  // update it is the new worker, waiting for the old one to hand over.
  const healthPort = Number(process.env.WORKER_HEALTH_PORT ?? 0);
  if (healthPort) {
    serveHealth(healthPort, process.env.WORKER_HEALTH_HOST ?? "127.0.0.1", async () => {
      if (state === "starting" || state === "standby") return { ok: true, state, mode };
      return { ok: state === "active" && open !== null && (await databaseAlive(open)), state, mode };
    });
  }

  /**
   * Stopping, for an update or otherwise: start no new job runs, give the running ones up to 8 seconds
   * (every money step also resumes from the database), then release the lock so a standby takes over.
   */
  const stop = async () => {
    if (state === "stopping") return;
    const wasActive = state === "active";
    state = "stopping";
    for (const timer of timers) clearInterval(timer);
    if (wasActive) {
      log(`stopping: letting ${inFlight.size} running job(s) finish`);
      await Promise.race([Promise.allSettled([...inFlight]), sleep(8_000)]);
      await leadership?.release().catch(() => {});
      log("released the worker lock");
    }
    await open?.close().catch(() => {});
    process.exit(0);
  };
  process.once("SIGINT", () => void stop());
  process.once("SIGTERM", () => void stop());
  // Lets tools/handover.ts stop it the same way on Windows, which has no signals.
  process.on("message", (message) => {
    if (message === "shutdown") void stop();
  });

  await runMigrations();
  const database = connect();
  open = database;
  leadership = await holdLeadership(database, {
    onStandby: () => {
      state = "standby";
      log("standby: another worker is running, taking over when it stops");
    },
    onLost: (why) => {
      log(`lost the worker lock (${why}), exiting so no job runs twice`);
      process.exit(1);
    },
  });
  if (state !== "starting" && state !== "standby") return;
  state = "active";
  log("active: this worker holds the lock");

  const venue = await loadVenue(mode, database.db);
  const tokens = tokenReaderFor(mode, process.env, venue.mode === "paper" ? (wallet) => venue.chain.tokenBalance(wallet) : undefined);
  const ctx: Ctx = { db: database.db, sql: database.sql, venue, cc: new CcRead({ mode, apiKey: process.env.CC_API_KEY }), rng: Math.random, log, announce: (drop) => announceDrop(database.db, drop), tokens };
  ctx.slots = slotReaderFor(mode, process.env);
  log(`starting in ${mode} mode`);

  if (venue.mode === "paper") await seedPaperTreasury(ctx, venue as PaperVenue);

  await ingestMachines(ctx).catch((e) => log("first machines fetch failed", e?.message));
  every(1_000, "drops", () => tickDrops(ctx));
  every(500, "orders", () => tickOrders(ctx));
  every(5_000, "scheduler", () => tickScheduler(ctx));
  every(1_000, "pulse", () => tickPulse(ctx));
  every(10_000, "cashback", () => tickCashback(ctx));
  every(60_000, "fees", () => tickFees(ctx));
  every(20_000, "machines", () => ingestMachines(ctx));
  every(8_000, "pulls", () => ingestPulls(ctx));
  every(15_000, "listings", () => ingestListings(ctx));
  every(30_000, "sales", () => detectSales(ctx));
  every(3_600_000, "price points", () => recordPricePoints(ctx));
  // Off the minute on purpose, so it never lines up with the jobs that move money.
  every(venue.mode === "paper" ? 127_000 : 307_000, "reconcile", () => reconcile(ctx));
  every(4 * 3_600_000, "holder snapshots", () => tickHolderSnapshots(ctx));
  if (venue.mode !== "paper") every(30_000, "balances", () => tickBalances(ctx));
  // The $TENR flywheel (docs/FLYWHEEL.md): gift draws every 30 minutes, and how long people have held.
  every(30_000, "gift draws", () => tickGiftDraws(ctx));
  every(600_000, "holder streaks", () => tickHolderStreaks(ctx));
  every(60_000, "buyback and burn", () => tickBuyback(ctx));
  every(3_600_000, "outbox prune", () => ctx.sql`delete from outbox where at < now() - interval '1 day'`);

  // The first backfill is slow, so it runs behind the live loops.
  void (async () => {
    const added = await ingestListings(ctx, { pages: 5, announce: false }).catch(() => 0);
    log(`backfilled ${added} listings`);
    const codes = (await getSetting(ctx.db, "drops")).machineMix.map((m) => m.code);
    if (venue.mode === "paper") {
      await ingestPool(ctx, [...new Set([...codes, ...DEFAULT_DROP_SETTINGS.machineMix.map((m) => m.code)])]);
      log("card pool ready");
    }
    await recordPricePoints(ctx).catch(() => {});
  })();

  if (venue.mode === "paper") {
    // Stands in for token trading volume, so the fee loop runs without a live token.
    const paper = venue as PaperVenue;
    every(10_000, "paper fees", async () => {
      const settings = await getSetting(ctx.db, "drops");
      const perDay = settings.budgetPerDayFallback / 0.7 / 1e6;
      await paper.accrueCards((perDay / 8640) / 0.2);
    });
  }

  const status = await balanceOf(ctx.db, "drops");
  log(`Drops wallet holds ${status / 1e6}`);
}

main().catch((error) => {
  // A worker stopped while it waited as a standby has its connection closed under it. That's expected.
  if (state === "stopping") return;
  log("failed to start", error instanceof Error ? error.message : error);
  process.exit(1);
});
void sql;
