import type { Micros, Rarity } from "@gemdex/core";

export type Mode = "paper" | "devnet" | "mainnet";
export type Role = "drops" | "vault" | "cashback" | "fee" | "feePayer";

/** Who a transaction acts for. Business logic never handles keys, only parties. */
export type Party =
  | { kind: "role"; role: Role }
  | { kind: "user"; userId: string; address: string }
  | { kind: "address"; address: string };

export const role = (name: Role): Party => ({ kind: "role", role: name });
export const trader = (userId: string, address: string): Party => ({ kind: "user", userId, address });

/** Everything the app can ever do on-chain. Paper and Solana both implement exactly this list. */
export type ChainOp =
  | { type: "usdc"; from: Party; to: Party; amount: Micros; memo: string }
  | { type: "settle"; buyer: Party; amount: Micros; nft: string; deliverTo: string; memo: string }
  | { type: "core"; from: Party; nft: string; to: string; memo: string }
  | { type: "ccPack"; payer: Party; amount: Micros; memo: string; raw: string }
  | { type: "ccBuyback"; owner: Party; recipient: Party; nft: string; amount: Micros; raw: string }
  | { type: "ccBuy"; buyer: Party; nft: string; amount: Micros; raw: string }
  | { type: "ccList"; owner: Party; nft: string; amount: Micros; raw: string }
  | { type: "split"; cashback: Micros; drops: Micros; memo: string }
  | { type: "feeCollect" }
  | { type: "swap"; cardsIn: number; minOut: Micros };

export interface PreparedTx {
  signature: string;
  raw: string;
  /** Past this the blockhash is dead, so the bytes can never land. */
  validUntil: Date;
}

export type TxStatus = "confirmed" | "failed" | "pending" | "dead";

/** The send was attempted but its result is unknown, so it may still land. */
export class AmbiguousSend extends Error {}
/** CC says a machine cannot sell right now. Nothing has happened. */
export class MachineDown extends Error {}
/** CC froze this card, so it cannot move. Retrying can never help. */
export class CardFrozen extends Error {}
/** CC refused an address (403). Nothing has happened. */
export class AddressBlocked extends Error {}

export interface ChainVenue {
  prepare(op: ChainOp): Promise<PreparedTx>;
  simulate(raw: string): Promise<{ ok: boolean; reason?: string }>;
  send(raw: string): Promise<void>;
  status(signature: string, raw: string): Promise<TxStatus>;
  usdcBalance(party: Party): Promise<Micros>;
  tokenBalance(wallet: string): Promise<number>;
}

export interface GeneratedPack {
  memo: string;
  raw: string;
}

export type OpenResult =
  | { status: "waiting" }
  /** The pack can never open, so CC will refund it. */
  | { status: "dead" }
  | {
      status: "opened";
      nft: string | null;
      rarity: Rarity | null;
      insuredValue: Micros | null;
      card: Record<string, unknown>;
      roll: number | null;
      /** Set when Turbo sold a Common straight back for USDC. */
      turboBuyback: Micros | null;
    };

export interface BuybackQuote {
  available: boolean;
  amount: Micros;
  expiresAt: Date | null;
}

export interface GachaVenue {
  generate(input: { machine: string; price: Micros; player: Party; deliverTo: string; turbo?: boolean }): Promise<GeneratedPack>;
  open(memo: string): Promise<OpenResult>;
  refunded(memo: string): Promise<boolean>;
  buybackQuote(nft: string): Promise<BuybackQuote>;
  buildBuyback(input: { owner: Party; nft: string; recipient?: Party }): Promise<{ raw: string; amount: Micros }>;
}

export interface MarketVenue {
  buildBuy(input: { buyer: Party; nft: string; price: Micros }): Promise<{ raw: string }>;
  buildList(input: { owner: Party; nft: string; price: Micros }): Promise<{ raw: string }>;
}

export interface FeeVenue {
  /** $CARDS sitting in the Fee wallet, whoever triggered collection. */
  cardsBalance(): Promise<number>;
  cardsValue(cards: number): Promise<Micros>;
  /** Fails loudly if a pump.fun fee sharing config exists, because it breaks collection. */
  assertNoSharingConfig(): Promise<void>;
  usdcReceived(signature: string): Promise<Micros>;
}

export interface Venue {
  mode: Mode;
  chain: ChainVenue;
  gacha: GachaVenue;
  market: MarketVenue;
  fees: FeeVenue;
  /** Address of a treasury role, shown in admin and used for delivery. */
  address(role: Role): string;
}
