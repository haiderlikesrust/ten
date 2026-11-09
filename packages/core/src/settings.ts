import { usd, type Micros } from "./money";

export interface MachineWeight {
  code: string;
  weight: number;
}

/**
 * One pack size on Pulse's ladder. A size opens once the Drops pool has enough free money for it, and the open
 * sizes are mixed by weight, so a bigger pool adds bigger packs without crowding out the small ones.
 * Admin only: users never see which sizes are off or locked.
 */
export interface PackTier {
  /** Pack price. Only machines at exactly this price are used. */
  price: Micros;
  /** Free money the Drops pool needs before this size opens. */
  unlockAt: Micros;
  /** How often this size comes up next to the other open sizes. 0 never picks it. */
  weight: number;
  /** Off means Pulse never opens this size. */
  enabled: boolean;
  /** Collector Crypt machine codes at this price. One that can sell is picked at random. */
  machines: string[];
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
  /** Money kept in the Drops pool that no pack may spend. */
  walletFloor: Micros;
  /** Budget used for pacing while there is no fee history yet. */
  budgetPerDayFallback: Micros;
  /** The pack sizes Pulse opens, smallest first. */
  ladder: PackTier[];
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
  winCooldownSec: 10,
  dailySpendCap: usd(2_500),
  walletFloor: 0,
  budgetPerDayFallback: usd(1_000),
  ladder: [
    { price: usd(25), unlockAt: usd(25), weight: 40, enabled: true, machines: ["pokemon_25"] },
    { price: usd(50), unlockAt: usd(400), weight: 25, enabled: true, machines: ["pokemon_50", "onepiece_50", "dragonball_50"] },
    { price: usd(100), unlockAt: usd(800), weight: 20, enabled: true, machines: ["pokemon_100"] },
    { price: usd(250), unlockAt: usd(2_000), weight: 10, enabled: true, machines: ["pokemon_250", "onepiece_250"] },
    { price: usd(500), unlockAt: usd(3_000), weight: 5, enabled: true, machines: ["pokemon_500"] },
  ],
};

/** Every machine the ladder can use, for loading card pools and choosing gift packs. */
export const ladderMachines = (ladder: PackTier[]): string[] => [...new Set(ladder.flatMap((tier) => tier.machines))];

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
