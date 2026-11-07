import { usd, type Micros } from "./money";

export interface MachineWeight {
  code: string;
  weight: number;
}

export interface DropSettings {
  enabled: boolean;
  /** The lowest price any card can reach, and the balance needed to buy one. */
  minPrice: Micros;
  /** The ceiling on a sealed pack. Shown cards open at insured value, so they have none. */
  maxPrice: Micros;
  /** A sealed pack stays at least this far below the lowest card it could hold. */
  ivMargin: Micros;
  /** A crash lands at a random share of insured value in this band. */
  crashLo: number;
  crashHi: number;
  /** Share of drops that are hidden. */
  hiddenShare: number;
  /** Hidden price is a random share of the lowest card value on the machine. */
  hiddenLo: number;
  hiddenHi: number;
  intervalFloorSec: number;
  /** How long the price keeps moving. */
  ttlSec: number;
  /** Age at which a card moves from New Pulls to the middle panel. */
  newPullSec: number;
  /** How long an unsold card stays buyable at its locked price before it is sold back. */
  lockedHoldSec: number;
  relists: number;
  /** Time a wallet must wait after a win. 0 turns it off. */
  winCooldownSec: number;
  /** Drops pause when spend in the last 24h reaches this. */
  dailySpendCap: Micros;
  /** Drops pause when the Drops wallet falls under this. */
  walletFloor: Micros;
  /** Budget used for pacing while there is no fee history yet. */
  budgetPerDayFallback: Micros;
  machineMix: MachineWeight[];
}

export const DEFAULT_DROP_SETTINGS: DropSettings = {
  enabled: true,
  minPrice: usd(5),
  maxPrice: usd(100),
  ivMargin: usd(1),
  crashLo: 0.1,
  crashHi: 0.4,
  hiddenShare: 0.25,
  hiddenLo: 0.6,
  hiddenHi: 1,
  intervalFloorSec: 30,
  ttlSec: 300,
  newPullSec: 60,
  lockedHoldSec: 1800,
  relists: 0,
  winCooldownSec: 300,
  dailySpendCap: usd(2_500),
  walletFloor: usd(100),
  budgetPerDayFallback: usd(1_000),
  machineMix: [
    { code: "pokemon_25", weight: 60 },
    { code: "pokemon_50", weight: 18 },
    { code: "onepiece_50", weight: 10 },
    { code: "dragonball_50", weight: 6 },
    { code: "pokemon_100", weight: 6 },
  ],
};

export interface FeeSettings {
  cashbackBps: number;
  /** Do not swap below this much $CARDS value. */
  minSwapUsd: Micros;
  maxSlippageBps: number;
}

export const DEFAULT_FEE_SETTINGS: FeeSettings = {
  cashbackBps: 3_000,
  minSwapUsd: usd(25),
  maxSlippageBps: 150,
};

export interface HolderTier {
  name: string;
  /** Lowest token balance held across the snapshot window. */
  minBalance: number;
  rateBps: number;
}

export interface CashbackSettings {
  tiers: HolderTier[];
  dailyCapPerUser: Micros;
  /** Margin kept under the open-and-sell-back loss, so cashback can never be farmed. */
  safetyBps: number;
  maxRateBps: number;
  snapshotsPerDay: number;
}

export const DEFAULT_CASHBACK_SETTINGS: CashbackSettings = {
  tiers: [
    { name: "Rookie", minBalance: 100_000, rateBps: 100 },
    { name: "Ace", minBalance: 1_000_000, rateBps: 200 },
    { name: "Champion", minBalance: 5_000_000, rateBps: 300 },
  ],
  dailyCapPerUser: usd(50),
  safetyBps: 100,
  maxRateBps: 300,
  snapshotsPerDay: 6,
};
