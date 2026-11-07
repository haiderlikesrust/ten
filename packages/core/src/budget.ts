import { ofBps, usd, type Micros } from "./money";
import { PATH_MIX } from "./pricepath";
import type { CashbackSettings, DropSettings, MachineWeight } from "./settings";

export interface MachineEcon {
  code: string;
  price: Micros;
  /** Buyback as a whole percent of insured value. */
  buybackPct: number;
  ev: Micros | null;
  commonFloor: Micros;
  open: boolean;
  stock: number;
}

/** Average loss from opening a pack and instantly selling it back. */
export function recycleCost(machine: MachineEcon): Micros {
  if (machine.ev === null) return machine.price;
  return Math.max(0, machine.price - Math.floor((machine.ev * machine.buybackPct) / 100));
}

export interface BurnEstimate {
  revealed: Micros;
  hidden: Micros;
  blended: Micros;
}

/** What a card that doesn't crash brings back, as a share of its value. Buyback sets the floor. */
const CALM_SALE = 0.85;

/** Average treasury cost per drop, used only for pacing. */
export function expectedBurn(machine: MachineEcon, s: DropSettings): BurnEstimate {
  const ev = machine.ev ?? machine.price;
  const crashSale = Math.max(s.minPrice, Math.floor((ev * (s.crashLo + s.crashHi)) / 2));
  const avgSale = Math.round(crashSale * PATH_MIX.crash + ev * CALM_SALE * (1 - PATH_MIX.crash));
  const revealed = Math.max(0, machine.price - avgSale);

  const hiddenCap = Math.min(s.maxPrice, machine.commonFloor - s.ivMargin);
  const avgHidden = Math.min(hiddenCap, Math.floor((machine.commonFloor * (s.hiddenLo + s.hiddenHi)) / 2));
  const hidden = Math.max(0, machine.price - Math.max(s.minPrice, avgHidden));

  return { revealed, hidden, blended: Math.round(revealed * (1 - s.hiddenShare) + hidden * s.hiddenShare) };
}

export function blendedBurn(mix: MachineWeight[], machines: MachineEcon[], s: DropSettings): Micros {
  let total = 0;
  let weights = 0;
  for (const entry of mix) {
    const machine = machines.find((m) => m.code === entry.code);
    if (!machine) continue;
    total += expectedBurn(machine, s).blended * entry.weight;
    weights += entry.weight;
  }
  return weights === 0 ? usd(10) : Math.round(total / weights);
}

/** Seconds between drops so spend matches budget. Infinity means there is no budget. */
export function intervalSeconds(burnPerDrop: Micros, budgetPerDay: Micros, floorSec: number): number {
  if (budgetPerDay <= 0) return Number.POSITIVE_INFINITY;
  return Math.max(floorSec, Math.ceil((burnPerDrop * 86_400) / budgetPerDay));
}

export interface PauseInput {
  enabled: boolean;
  killSwitch: boolean;
  reconcileHold: boolean;
  dropsBalance: Micros;
  spent24h: Micros;
  settings: Pick<DropSettings, "walletFloor" | "dailySpendCap">;
}

export type PauseReason = "disabled" | "kill_switch" | "reconcile_mismatch" | "wallet_floor" | "daily_cap";

export function pauseReason(input: PauseInput): PauseReason | null {
  if (input.killSwitch) return "kill_switch";
  if (input.reconcileHold) return "reconcile_mismatch";
  if (!input.enabled) return "disabled";
  if (input.dropsBalance < input.settings.walletFloor) return "wallet_floor";
  if (input.spent24h >= input.settings.dailySpendCap) return "daily_cap";
  return null;
}

/** Weighted random machine among those that can currently sell. */
export function pickMachine(mix: MachineWeight[], machines: MachineEcon[], rnd: number): MachineEcon | null {
  const usable = mix
    .map((entry) => ({ entry, machine: machines.find((m) => m.code === entry.code) }))
    .filter((x): x is { entry: MachineWeight; machine: MachineEcon } => !!x.machine && x.machine.open && x.machine.stock > 0);
  const total = usable.reduce((sum, x) => sum + x.entry.weight, 0);
  if (total === 0) return null;
  let point = rnd * total;
  for (const x of usable) {
    point -= x.entry.weight;
    if (point < 0) return x.machine;
  }
  return usable[usable.length - 1]!.machine;
}

/**
 * Highest cashback a machine can safely pay. Open-and-sell-back loses recycleCost, so a
 * rate at or above that loss turns cashback into free money. Stays below it by safetyBps.
 */
export function cashbackCapBps(machine: MachineEcon, s: Pick<CashbackSettings, "safetyBps" | "maxRateBps">): number {
  if (machine.ev === null || machine.price <= 0) return 0;
  const lossBps = Math.floor((recycleCost(machine) * 10_000) / machine.price);
  return Math.max(0, Math.min(s.maxRateBps, lossBps - s.safetyBps));
}

export interface CashbackInput {
  packPrice: Micros;
  tierBps: number;
  machineCapBps: number;
  paidToday: Micros;
  dailyCap: Micros;
  poolBalance: Micros;
}

export function cashbackAmount(input: CashbackInput): Micros {
  const rate = Math.min(input.tierBps, input.machineCapBps);
  const wanted = ofBps(input.packPrice, rate);
  const room = Math.max(0, input.dailyCap - input.paidToday);
  return Math.max(0, Math.min(wanted, room, input.poolBalance));
}
