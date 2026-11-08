import { usd, type Micros } from "./money";

/** pump.fun mints 1 billion. Paper mode uses this as $TENR's supply. */
export const PAPER_TENR_SUPPLY = 1_000_000_000;

/** The $TENR flywheel: who may act on Tenner, the gift draws, and buyback and burn. See docs/FLYWHEEL.md. */
export interface FlywheelSettings {
  /** Share of $TENR's current supply a user must hold to buy, open or claim, in basis points. 10 is 0.1%. 0 turns it off. */
  accessBps: number;
  /** Share a long holder or top blaster needs to be in a gift draw. 200 is 2%. */
  giftHoldBps: number;
  /** Share of trading fees (after the swap to USDC) that goes to the gift pool, taken from the drops share. */
  giftBps: number;
  /** Most of the gift pool a single draw may spend. 833 is about a twelfth. */
  giftSpendBps: number;
  giftIntervalMin: number;
  /** Prices a gift pack can be, highest first. They match Collector Crypt machine prices. */
  giftTiers: Micros[];
  /** Packs opened or sniped in the hour before a draw to count as active. */
  activePacksPerHour: number;
  /** How many of the biggest spenders are top blasters. */
  topBlasters: number;
  /** Days of spend that rank top blasters. */
  blasterDays: number;
  /** Hours a winner has to claim. Unclaimed gifts go back to the pool. */
  claimHours: number;
  /** Hours before a winner can win again. */
  winCooldownHours: number;
  /** Share of every Pulse sale that buys and burns $TENR. The rest goes back into the drops pool. 5000 is half. */
  saleBuybackBps: number;
  /** Unused. Buyback and burn is funded by Pulse sales, not a fee. Kept so saved settings still load. */
  platformFeeBps: number;
  buybackMinUsd: Micros;
  buybackMaxSlippageBps: number;
  buybackEveryMin: number;
  /** Team and other wallets that can never win a gift. */
  excludedWallets: string[];
  giftsEnabled: boolean;
  buybackEnabled: boolean;
}

export const DEFAULT_FLYWHEEL_SETTINGS: FlywheelSettings = {
  accessBps: 10,
  giftHoldBps: 200,
  giftBps: 2_000,
  giftSpendBps: 833,
  giftIntervalMin: 30,
  giftTiers: [usd(500), usd(250), usd(100), usd(50)],
  activePacksPerHour: 10,
  topBlasters: 10,
  blasterDays: 7,
  claimHours: 24,
  winCooldownHours: 24,
  saleBuybackBps: 5_000,
  platformFeeBps: 0,
  buybackMinUsd: usd(25),
  buybackMaxSlippageBps: 150,
  buybackEveryMin: 15,
  excludedWallets: [],
  giftsEnabled: true,
  buybackEnabled: true,
};

/** How a Pulse sale divides: part buys and burns $TENR, the rest refills the drops pool. Dust goes to drops. */
export function splitSale(price: Micros, saleBuybackBps: number): { buyback: Micros; drops: Micros } {
  const buyback = Math.min(price, Math.max(0, Math.floor((price * saleBuybackBps) / 10_000)));
  return { buyback, drops: price - buyback };
}

/** Whether a user holds enough $TENR to act on Tenner. */
export interface Access {
  /** False when there's nothing to check: no $TENR mint yet, or the minimum is turned off. */
  enforced: boolean;
  ok: boolean;
  /** $TENR held across the user's wallets, in whole tokens. */
  held: number;
  /** $TENR needed, in whole tokens. */
  needed: number;
  supply: number;
  bps: number;
}

export function accessFrom(held: number, supply: number, bps: number): Access {
  if (!(bps > 0) || !(supply > 0)) return { enforced: false, ok: true, held, needed: 0, supply, bps };
  const needed = (supply * bps) / 10_000;
  return { enforced: true, ok: held >= needed, held, needed, supply, bps };
}

export const NO_ACCESS_CHECK: Access = { enforced: false, ok: true, held: 0, needed: 0, supply: 0, bps: 0 };

/** 10 bps reads "0.1%". */
export const shareOfSupply = (bps: number): string => `${Number((bps / 100).toFixed(2))}%`;

/** The refusal people see when they're short. */
export const accessMessage = (access: Pick<Access, "bps">): string => `Hold ${shareOfSupply(access.bps)} of $TENR to use Tenner`;
