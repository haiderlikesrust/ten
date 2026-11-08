import { randomUUID } from "node:crypto";
import { parseUsd, usd, type Micros, type Rarity } from "@gemdex/core";
import { and, ccPacks, eq, isNull, machines, paperChain, paperTx, poolCards, sql, type Db, type Tx } from "@gemdex/db";
import {
  AddressBlocked, AmbiguousSend, MachineDown, type BuybackQuote, type ChainOp, type ChainVenue, type FeeVenue,
  type GachaVenue, type GeneratedPack, type MarketVenue, type OpenResult, type PaidPack, type Party, type PreparedTx, type Role,
  type TxStatus, type UsdcMoved, type Venue,
} from "./types";

export type Fault =
  | "send_lost" | "send_ambiguous" | "send_failed" | "machine_down" | "machine_blocked"
  | "open_waiting" | "open_dead" | "simulate_fail";

export interface PaperOptions {
  rng?: () => number;
  /** Chance per opportunity of each fault. Empty in normal use. */
  faults?: Partial<Record<Fault, number>>;
  /** $ value of one $CARDS, for the simulated swap. */
  cardsPriceUsd?: number;
  txTtlMs?: number;
}

const ROLE_ADDRESS: Record<Role, string> = {
  drops: "PaperDrops1111111111111111111111111111111111",
  vault: "PaperVau1t111111111111111111111111111111111",
  cashback: "PaperCashback11111111111111111111111111111",
  fee: "PaperFee11111111111111111111111111111111111",
  feePayer: "PaperFeePayer111111111111111111111111111111",
};

/** Maps a party to its account, the same names the book uses. */
/** A party's wallet address, for its paper $TENR balance. */
function addressOf(party: Party): string {
  return party.kind === "role" ? ROLE_ADDRESS[party.role] : party.address;
}

export function accountOf(party: Party): string {
  if (party.kind === "role") return party.role === "vault" ? "drops" : party.role;
  if (party.kind === "user") return `user:${party.userId}`;
  return "world";
}

const CARDS_ACCOUNT = "fee_cards";
/** Stands in for pump.fun's creator vaults: fees wait here until a claim moves them to the Fee wallet, as on mainnet. */
const UNCLAIMED_CARDS = "fee_cards_unclaimed";
const tokenAccount = (wallet: string) => `token:${wallet}`;
/** Paper $TENR price: $100k market cap on 1 billion supply. */
const PAPER_TENR_PRICE_USD = 0.0001;
const tenrFor = (usdcIn: Micros) => Math.floor(usdcIn / 1e6 / PAPER_TENR_PRICE_USD);

async function credit(tx: Tx, account: string, delta: number) {
  await tx
    .insert(paperChain)
    .values({ account, micros: delta })
    .onConflictDoUpdate({ target: paperChain.account, set: { micros: sql`${paperChain.micros} + ${delta}` } });
}

async function debit(tx: Tx, account: string, amount: number): Promise<boolean> {
  const updated = await tx
    .update(paperChain)
    .set({ micros: sql`${paperChain.micros} - ${amount}` })
    .where(and(eq(paperChain.account, account), sql`${paperChain.micros} >= ${amount}`))
    .returning({ account: paperChain.account });
  return updated.length === 1;
}

/** Stand-in for the chain. Kept apart from the book so reconciliation compares two real things. */
class PaperChainVenue implements ChainVenue {
  constructor(private readonly db: Db, private readonly opts: Required<Pick<PaperOptions, "rng" | "faults" | "cardsPriceUsd" | "txTtlMs">>) {}

  private roll(fault: Fault): boolean {
    const chance = this.opts.faults[fault] ?? 0;
    return chance > 0 && this.opts.rng() < chance;
  }

  async prepare(op: ChainOp): Promise<PreparedTx> {
    const signature = `paper_${randomUUID()}`;
    const validUntil = new Date(Date.now() + this.opts.txTtlMs);
    return { signature, validUntil, raw: JSON.stringify({ signature, validUntil, op }) };
  }

  async simulate(raw: string): Promise<{ ok: boolean; reason?: string }> {
    if (this.roll("simulate_fail")) return { ok: false, reason: "simulated failure" };
    const { op } = JSON.parse(raw) as { op: ChainOp };
    const source = op.type === "settle" ? op.buyer : op.type === "usdc" ? op.from : op.type === "ccPack" ? op.payer : null;
    if (!source || !("amount" in op)) return { ok: true };
    const balance = await this.usdcBalance(source);
    return balance >= op.amount ? { ok: true } : { ok: false, reason: "insufficient funds on chain" };
  }

  async send(raw: string): Promise<void> {
    if (this.roll("send_lost")) throw new AmbiguousSend("send timed out, transaction was lost");
    const { signature, op, validUntil } = JSON.parse(raw) as { signature: string; op: ChainOp; validUntil: string };
    if (Date.now() > new Date(validUntil).getTime()) return;
    const fails = this.roll("send_failed");
    await this.db.transaction(async (tx) => {
      const inserted = await tx
        .insert(paperTx)
        .values({ signature, status: "pending", op })
        .onConflictDoNothing()
        .returning({ signature: paperTx.signature });
      if (inserted.length === 0) return; // Rebroadcast of identical bytes lands once, like a real chain.
      const ok = !fails && (await this.apply(tx, op));
      await tx.update(paperTx).set({ status: ok ? "confirmed" : "failed" }).where(eq(paperTx.signature, signature));
      if (!ok) throw new RollbackButKeepFailure(signature, op);
    }).catch(async (error) => {
      if (error instanceof RollbackButKeepFailure) {
        await this.db.insert(paperTx).values({ signature: error.signature, status: "failed", op: error.op }).onConflictDoNothing();
        return;
      }
      throw error;
    });
    if (this.roll("send_ambiguous")) throw new AmbiguousSend("landed, but the response was lost");
  }

  private async apply(tx: Tx, op: ChainOp): Promise<boolean> {
    const move = async (from: string, to: string, amount: number) => {
      if (!["cc", "world"].includes(from) && !(await debit(tx, from, amount))) return false;
      await credit(tx, to, amount);
      return true;
    };
    switch (op.type) {
      case "usdc":
        return move(accountOf(op.from), accountOf(op.to), op.amount);
      case "settle":
        return move(accountOf(op.buyer), "drops", op.amount);
      case "ccPack":
        return move(accountOf(op.payer), "cc", op.amount);
      case "ccBuyback":
        return move("cc", accountOf(op.recipient), op.amount);
      case "ccBuy":
        return move(accountOf(op.buyer), "world", op.amount);
      case "split": {
        if (!(await debit(tx, "fee", op.cashback + op.drops))) return false;
        await credit(tx, "cashback", op.cashback);
        await credit(tx, "drops", op.drops);
        return true;
      }
      case "swap": {
        const cards = Math.round(op.cardsIn * 1e6);
        if (!(await debit(tx, CARDS_ACCOUNT, cards))) return false;
        await credit(tx, "fee", usd(op.cardsIn * this.opts.cardsPriceUsd));
        return true;
      }
      case "buyTenr": {
        const tokens = tenrFor(op.usdcIn);
        if (tokens < op.minOut) return false;
        if (!(await debit(tx, accountOf(op.from), op.usdcIn))) return false;
        await credit(tx, tokenAccount(addressOf(op.from)), tokens);
        return true;
      }
      case "burnTenr":
        await tx.update(paperChain).set({ micros: 0 }).where(eq(paperChain.account, tokenAccount(addressOf(op.owner))));
        return true;
      case "feeCollect": {
        // Claims everything waiting. A second claim finds nothing, so a repeated send cannot count fees twice.
        const rows = await tx.select({ micros: paperChain.micros }).from(paperChain).where(eq(paperChain.account, UNCLAIMED_CARDS));
        const waiting = rows[0]?.micros ?? 0;
        if (waiting > 0 && (await debit(tx, UNCLAIMED_CARDS, waiting))) await credit(tx, CARDS_ACCOUNT, waiting);
        return true;
      }
      case "core":
      case "ccList":
        return true;
    }
  }

  async status(signature: string, raw: string): Promise<TxStatus> {
    const rows = await this.db.select({ status: paperTx.status }).from(paperTx).where(eq(paperTx.signature, signature));
    const status = rows[0]?.status;
    if (status === "confirmed" || status === "failed") return status;
    const { validUntil } = JSON.parse(raw) as { validUntil: string };
    return Date.now() > new Date(validUntil).getTime() ? "dead" : "pending";
  }

  async usdcBalance(party: Party): Promise<Micros> {
    const rows = await this.db.select({ micros: paperChain.micros }).from(paperChain).where(eq(paperChain.account, accountOf(party)));
    return rows[0]?.micros ?? 0;
  }

  /** Paper money only moves through Tenner, so there is never an outside transfer to read. */
  async usdcMoved(): Promise<UsdcMoved> {
    return { status: "missing" };
  }

  async tokenBalance(wallet: string): Promise<number> {
    const rows = await this.db.select({ micros: paperChain.micros }).from(paperChain).where(eq(paperChain.account, tokenAccount(wallet)));
    return rows[0]?.micros ?? 0;
  }
}

class RollbackButKeepFailure extends Error {
  constructor(readonly signature: string, readonly op: ChainOp) {
    super("paper transaction failed");
  }
}

const TIER_ORDER: Rarity[] = ["epic", "rare", "uncommon", "common"];

/** Uses real odds and a real card pool, so paper pulls look and price like the real thing. */
class PaperGachaVenue implements GachaVenue {
  /** Machine-down state lasts a moment, like a real outage. */
  constructor(private readonly db: Db, private readonly opts: Required<Pick<PaperOptions, "rng" | "faults">>) {}

  private roll(fault: Fault): boolean {
    const chance = this.opts.faults[fault] ?? 0;
    return chance > 0 && this.opts.rng() < chance;
  }

  async generate(input: { machine: string; price: Micros; player: Party; deliverTo: string; turbo?: boolean }): Promise<GeneratedPack> {
    if (this.roll("machine_down")) throw new MachineDown("Machine is off balance");
    if (this.roll("machine_blocked")) throw new AddressBlocked("address blocked");
    const rows = await this.db.select().from(machines).where(eq(machines.code, input.machine));
    const machine = rows[0];
    if (!machine || !machine.isOpen) throw new MachineDown("Machine is off");
    const memo = `paper-${randomUUID()}`;
    return { memo, raw: JSON.stringify({ memo, machine: input.machine, deliverTo: input.deliverTo }), turbo: !!input.turbo };
  }

  async open(paid: PaidPack): Promise<OpenResult> {
    const memo = paid.memo;
    if (this.roll("open_waiting")) return { status: "waiting" };
    if (this.roll("open_dead")) return this.refund(memo);
    const packs = await this.db.select().from(ccPacks).where(eq(ccPacks.memo, memo));
    const pack = packs[0];
    if (!pack) return this.refund(memo);
    if (pack.state === "opened") {
      return { status: "opened", nft: pack.nft, rarity: pack.rarity as Rarity, insuredValue: pack.insuredValue, card: {}, roll: pack.roll, turboBuyback: pack.buybackAmount };
    }
    const machineRows = await this.db.select().from(machines).where(eq(machines.code, pack.machineCode));
    const machine = machineRows[0];
    if (!machine) return this.refund(memo);

    let point = this.opts.rng();
    let rarity: Rarity = "common";
    for (const tier of TIER_ORDER) {
      point -= machine.odds[tier] ?? 0;
      if (point < 0) {
        rarity = tier;
        break;
      }
    }
    const card = await this.pickCard(pack.machineCode, rarity);
    const value = card?.insuredValue ?? pack.price;
    const roll = Math.floor(this.opts.rng() * 1e8);

    if (pack.turbo && rarity === "common") {
      const turboBuyback = Math.floor((value * machine.buybackPct) / 100);
      await this.payOnce(`turbo:${memo}`, pack.dropId ? "drops" : `user:${pack.userId}`, turboBuyback);
      return { status: "opened", nft: null, rarity, insuredValue: value, card: {}, roll, turboBuyback };
    }
    return {
      status: "opened",
      nft: card?.nft ?? `paper-card-${randomUUID()}`,
      rarity,
      insuredValue: value,
      roll,
      turboBuyback: null,
      card: {
        name: card?.name ?? `${machine.shortName ?? machine.name} pull`,
        image: card?.image ?? machine.image,
        grader: card?.grader ?? null,
        grade: card?.grade ?? null,
        rarity,
        machine: pack.machineCode,
        memo,
      },
    };
  }

  private async pickCard(machineCode: string, rarity: string) {
    const rows = await this.db
      .select()
      .from(poolCards)
      .where(and(eq(poolCards.machineCode, machineCode), eq(poolCards.rarity, rarity), isNull(poolCards.usedAt)))
      .orderBy(sql`random()`)
      .limit(1);
    const card = rows[0];
    if (card) await this.db.update(poolCards).set({ usedAt: new Date() }).where(eq(poolCards.nft, card.nft));
    return card;
  }

  /** A pack that can never open is reported only once CC has refunded it, like the real one. */
  private async refund(memo: string): Promise<OpenResult> {
    return (await this.refunded(memo)) ? { status: "refunded" } : { status: "waiting" };
  }

  /** Paper refunds at once. Real CC takes about 2h10m. */
  async refunded(memo: string): Promise<boolean> {
    const rows = await this.db.select().from(ccPacks).where(eq(ccPacks.memo, memo));
    const pack = rows[0];
    if (!pack) return false;
    await this.payOnce(`refund:${memo}`, pack.dropId ? "drops" : `user:${pack.userId}`, pack.price);
    return true;
  }

  /** CC paying someone. Idempotent, like a chain transaction that can only land once. */
  private async payOnce(signature: string, account: string, amount: number) {
    await this.db.transaction(async (tx) => {
      const fresh = await tx
        .insert(paperTx)
        .values({ signature, status: "confirmed", op: { type: "ccPayout", account, amount } })
        .onConflictDoNothing()
        .returning({ signature: paperTx.signature });
      if (fresh.length > 0) await credit(tx, account, amount);
    });
  }

  async buybackQuote(nft: string): Promise<BuybackQuote> {
    const rows = await this.db.select().from(ccPacks).where(eq(ccPacks.nft, nft));
    const pack = rows[0];
    if (!pack?.insuredValue || !pack.openedAt) return { available: false, amount: 0, expiresAt: null };
    const machineRows = await this.db.select().from(machines).where(eq(machines.code, pack.machineCode));
    const pct = machineRows[0]?.buybackPct ?? 85;
    const expiresAt = new Date(pack.openedAt.getTime() + 72 * 3600_000);
    if (Date.now() > expiresAt.getTime()) return { available: false, amount: 0, expiresAt: null };
    return { available: true, amount: Math.floor((pack.insuredValue * pct) / 100), expiresAt };
  }

  async buildBuyback(input: { owner: Party; nft: string }): Promise<{ raw: string; amount: Micros }> {
    const quote = await this.buybackQuote(input.nft);
    if (!quote.available) throw new Error("buyback unavailable");
    return { raw: JSON.stringify({ buyback: input.nft }), amount: quote.amount };
  }
}

class PaperMarketVenue implements MarketVenue {
  async buildBuy(input: { nft: string; price: Micros }) {
    return { raw: JSON.stringify({ buy: input.nft, price: input.price }) };
  }
  async buildList(input: { nft: string; price: Micros }) {
    return { raw: JSON.stringify({ list: input.nft, price: input.price }) };
  }
}

class PaperFeeVenue implements FeeVenue {
  constructor(private readonly db: Db, private readonly priceUsd: number) {}

  async cardsBalance(): Promise<number> {
    const rows = await this.db.select({ micros: paperChain.micros }).from(paperChain).where(eq(paperChain.account, CARDS_ACCOUNT));
    return (rows[0]?.micros ?? 0) / 1e6;
  }

  async cardsUnclaimed(): Promise<number> {
    const rows = await this.db.select({ micros: paperChain.micros }).from(paperChain).where(eq(paperChain.account, UNCLAIMED_CARDS));
    return (rows[0]?.micros ?? 0) / 1e6;
  }

  async cardsValue(cards: number): Promise<Micros> {
    return usd(cards * this.priceUsd);
  }

  async assertNoSharingConfig(): Promise<void> {}

  async usdcReceived(signature: string): Promise<Micros> {
    const rows = await this.db.select({ op: paperTx.op }).from(paperTx).where(eq(paperTx.signature, signature));
    const op = rows[0]?.op as Extract<ChainOp, { type: "swap" }> | undefined;
    return op ? usd(op.cardsIn * this.priceUsd) : 0;
  }

  async tenrQuote(usdcIn: Micros): Promise<number> {
    return tenrFor(usdcIn);
  }

  async tenrReceived(signature: string): Promise<number> {
    const rows = await this.db.select({ op: paperTx.op }).from(paperTx).where(eq(paperTx.signature, signature));
    const op = rows[0]?.op as Extract<ChainOp, { type: "buyTenr" }> | undefined;
    return op?.type === "buyTenr" ? tenrFor(op.usdcIn) : 0;
  }

  async tenrHeld(): Promise<number> {
    const rows = await this.db.select({ micros: paperChain.micros }).from(paperChain).where(eq(paperChain.account, tokenAccount(ROLE_ADDRESS.drops)));
    return rows[0]?.micros ?? 0;
  }
}

export interface PaperVenue extends Venue {
  mode: "paper";
  /** Test money for a paper wallet. Only exists in paper mode. */
  faucet(account: string, amount: Micros): Promise<void>;
  /** Creator fees earned. They wait unclaimed, as on mainnet, unless `claimed` says someone already claimed them by hand. */
  accrueCards(cards: number, where?: "unclaimed" | "claimed"): Promise<void>;
  setTokenBalance(wallet: string, tokens: number): Promise<void>;
  /** Moves paper chain funds behind the book, like a user draining their exported key. */
  drain(account: string, amount: Micros): Promise<void>;
  chainBalance(account: string): Promise<Micros>;
}

export function createPaperVenue(db: Db, options: PaperOptions = {}): PaperVenue {
  const opts = { rng: options.rng ?? Math.random, faults: options.faults ?? {}, cardsPriceUsd: options.cardsPriceUsd ?? 0.2, txTtlMs: options.txTtlMs ?? 60_000 };
  const chain = new PaperChainVenue(db, opts);
  const addRow = async (account: string, delta: number) =>
    db.transaction((tx) => credit(tx, account, delta));
  return {
    mode: "paper",
    chain,
    gacha: new PaperGachaVenue(db, opts),
    market: new PaperMarketVenue(),
    fees: new PaperFeeVenue(db, opts.cardsPriceUsd),
    address: (name) => ROLE_ADDRESS[name],
    faucet: (account, amount) => addRow(account, amount),
    accrueCards: (cards, where = "unclaimed") => addRow(where === "claimed" ? CARDS_ACCOUNT : UNCLAIMED_CARDS, Math.round(cards * 1e6)),
    setTokenBalance: async (wallet, tokens) => {
      await db
        .insert(paperChain)
        .values({ account: tokenAccount(wallet), micros: tokens })
        .onConflictDoUpdate({ target: paperChain.account, set: { micros: tokens } });
    },
    drain: (account, amount) => addRow(account, -amount),
    chainBalance: async (account) => {
      const rows = await db.select({ micros: paperChain.micros }).from(paperChain).where(eq(paperChain.account, account));
      return rows[0]?.micros ?? 0;
    },
  };
}

export { parseUsd };
