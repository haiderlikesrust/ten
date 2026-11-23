// Sell to Tenner: Tenner buys a user's card for exactly what Collector Crypt's buyback pays, then drops it in Pulse in
// place of a pack. If nobody buys it there, it goes back to Collector Crypt for that same amount, so an unsold card
// costs the pool nothing. The card and the money change hands in one transaction, so neither side can be left short.
import {
  BRAND, BUYBACK_SAFETY_SEC, SELL_MIN_LEFT_SEC, SELL_RELEASE_BY_SEC, SOLD_TO_TENNER, formatUsd,
} from "@gemdex/core";
import { activity, and, balanceOf, drops, emit, eq, getSetting, holdings, orders, post, sql, userAccount, users } from "@gemdex/db";
import { CardFrozen, TxRefused, trader, type ChainOp, type Party } from "@gemdex/venues";
import { sendOnce } from "./chain-tx";
import type { Ctx } from "./ctx";
import { promisedToPacks, promisedToSales } from "./drops";

type Order = typeof orders.$inferSelect;
type User = typeof users.$inferSelect;

/** What the order remembers between steps. */
interface SaleState {
  amount?: number;
  expiresAt?: string;
  /** The part-signed transaction waiting for the seller's own wallet. */
  offer?: string;
  /** Its id (the fee payer's signature) and the venue's envelope, to tell whether it landed or died. */
  signature?: string;
  raw?: string;
  /** The seller's signed copy, saved by the gateway. */
  signed?: string;
  dropId?: string;
}

/** A sale whose transaction can't even be built in this long ends: nothing was signed, so ending costs nothing. */
const BUILD_GIVE_UP_MS = 2 * 60_000;

async function setStep(ctx: Ctx, order: Order, step: string, result: SaleState) {
  await ctx.db.update(orders).set({ step, result: result as Record<string, unknown>, state: "running", nextRunAt: new Date(), leaseUntil: null, updatedAt: new Date() }).where(eq(orders.id, order.id));
}

async function retry(ctx: Ctx, order: Order, ms: number) {
  await ctx.db.update(orders).set({ nextRunAt: new Date(Date.now() + ms), leaseUntil: null, updatedAt: new Date() }).where(eq(orders.id, order.id));
}

async function finish(ctx: Ctx, order: Order, state: "done" | "failed", result: SaleState, error?: string) {
  await ctx.db.transaction(async (tx) => {
    await tx.update(orders).set({ state, result: result as Record<string, unknown>, error: error ?? null, leaseUntil: null, updatedAt: new Date() }).where(eq(orders.id, order.id));
    await emit(tx, `user:${order.userId}`, { type: "order", id: order.id, kind: order.kind, state, result: { amount: result.amount, dropId: result.dropId }, error });
  });
}

/** Who signs for the card: the trading wallet through Privy, or the user's own wallet in their browser. */
function sellerOf(user: User, wallet: "trading" | "connected"): Party {
  if (wallet === "trading") return trader(user.id, user.tradingWallet);
  return { kind: "address", address: user.connectedWallet };
}

/** Paper mode signs nothing, and a trading wallet is signed for here. Only a card in the user's own wallet waits for them. */
const signsHere = (ctx: Ctx, wallet: "trading" | "connected") => ctx.venue.mode === "paper" || wallet === "trading";

export async function runSellToTenner(ctx: Ctx, order: Order, user: User) {
  const { holdingId } = order.params as { holdingId: string };
  const state = (order.result ?? {}) as SaleState;
  const rows = await ctx.db.select().from(holdings).where(and(eq(holdings.id, holdingId), eq(holdings.userId, user.id)));
  const holding = rows[0];
  if (!holding) return finish(ctx, order, "failed", state, "You no longer hold this card");

  if (order.step === "start") {
    if (holding.status !== "held") return finish(ctx, order, "failed", state, "You no longer hold this card");
    const settings = await getSetting(ctx.db, "drops");
    if (!settings.sellEnabled) return finish(ctx, order, "failed", state, "Sell to Tenner is switched off right now");
    const quote = await ctx.venue.gacha.buybackQuote(holding.nft);
    if (!quote.available) return finish(ctx, order, "failed", state, "This card's Collector Crypt buyback window has closed");
    if (!quote.expiresAt || quote.expiresAt.getTime() - Date.now() < SELL_MIN_LEFT_SEC * 1000) {
      return finish(ctx, order, "failed", state, "Too little time is left on this card's buyback window for Tenner to take it. You can still sell it back to Collector Crypt.");
    }
    if (quote.amount > settings.sellMax) return finish(ctx, order, "failed", state, `Tenner takes cards worth up to ${formatUsd(settings.sellMax)} back`);
    // The check and the reservation happen under one lock, so two sales at once can't both count the same dollars.
    const packs = await promisedToPacks(ctx);
    const reserved = await ctx.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext('sell_tenner'))`);
      const free = (await balanceOf(tx, "drops")) - settings.walletFloor - packs - (await promisedToSales(tx, order.id));
      if (free < quote.amount) return false;
      await tx.update(orders).set({ result: { amount: quote.amount, expiresAt: quote.expiresAt!.toISOString() }, step: "offer", nextRunAt: new Date(), leaseUntil: null, updatedAt: new Date() }).where(eq(orders.id, order.id));
      return true;
    });
    if (!reserved) return finish(ctx, order, "failed", state, "Tenner's Pulse pool can't take a card right now. You can still sell it back to Collector Crypt.");
    return;
  }

  const amount = state.amount!;
  const seller = sellerOf(user, holding.wallet);
  const sale = (extra: Partial<Extract<ChainOp, { type: "cardSale" }>> = {}): ChainOp => ({
    type: "cardSale", seller, nft: holding.nft, amount, payTo: trader(user.id, user.tradingWallet), memo: `${BRAND.memoPrefix}:sell:${order.id}`, ...extra,
  });
  const refused = (error: unknown) => (error instanceof TxRefused || error instanceof CardFrozen ? error.message : null);

  if (order.step === "offer") {
    if (signsHere(ctx, holding.wallet)) return setStep(ctx, order, "send", state);
    let prepared;
    try {
      prepared = await ctx.venue.chain.prepare(sale());
    } catch (error) {
      const reason = refused(error);
      if (reason) return finish(ctx, order, "failed", state, `This card can't be sold right now: ${reason}`);
      if (Date.now() - order.createdAt.getTime() > BUILD_GIVE_UP_MS) return finish(ctx, order, "failed", state, "This sale could not be prepared. Nothing moved.");
      throw error;
    }
    if (!prepared.toSign) return finish(ctx, order, "failed", state, "This sale could not be prepared. Nothing moved.");
    const next = { ...state, offer: prepared.toSign, signature: prepared.signature, raw: prepared.raw };
    await setStep(ctx, order, "sign", next);
    // The site opens the user's wallet on this.
    await emit(ctx.db, `user:${order.userId}`, { type: "sellOffer", id: order.id, transaction: prepared.toSign, amount });
    return;
  }

  if (order.step === "sign") {
    if (state.signed) return setStep(ctx, order, "send", state);
    // The user may send the signed transaction themselves, so the chain is asked too.
    const status = await ctx.venue.chain.status(state.signature!, state.raw!);
    if (status === "confirmed") return book(ctx, order, user, holding, state);
    if (status === "dead" || status === "failed") return finish(ctx, order, "failed", state, "The sale was not signed in time. Nothing moved.");
    return retry(ctx, order, 2_000);
  }

  if (order.step === "send") {
    const outside = !signsHere(ctx, holding.wallet);
    const result = await sendOnce(ctx, "sell_tenner", order.id, async () => (outside ? sale({ offer: state.offer, signed: state.signed }) : sale()), {
      // Bytes the user signed can't be rebuilt, so one try. A sale signed here can be rebuilt while it is fresh.
      ...(outside ? { maxAttempts: 1 } : { deadlineAt: new Date(order.createdAt.getTime() + BUILD_GIVE_UP_MS) }),
    });
    if (result.status === "pending") return retry(ctx, order, 1_000);
    if (result.status === "failed") return finish(ctx, order, "failed", state, result.reason ? `The sale did not go through: ${result.reason}. Nothing moved.` : "The sale failed on-chain. Nothing moved.");
    return book(ctx, order, user, holding, state);
  }
}

/** The card is Tenner's and the user is paid: book both, and queue the card for Pulse. */
async function book(ctx: Ctx, order: Order, user: User, holding: typeof holdings.$inferSelect, state: SaleState) {
  const amount = state.amount!;
  const expiresAt = new Date(state.expiresAt!);
  const deadline = new Date(expiresAt.getTime() - BUYBACK_SAFETY_SEC * 1000);
  const name = String(holding.card.name ?? "a card");
  const dropId = await ctx.db.transaction(async (tx) => {
    const moved = await tx.update(holdings).set({ status: "sold", exitPrice: amount, exitedAt: new Date() }).where(and(eq(holdings.id, holding.id), eq(holdings.status, "held"))).returning({ id: holdings.id });
    if (moved.length === 0) return state.dropId ?? null;
    await post(tx, `sell_tenner:${order.id}`, "sell_tenner", [{ account: "drops", delta: -amount }, { account: userAccount(user.id), delta: amount }]);
    await tx.insert(activity).values({ userId: user.id, kind: "sell", title: `Sold ${name} to Tenner`, delta: amount, ref: holding.nft });
    // It waits for a Pulse slot like a pack would, and goes live by itself well before its sell-back deadline.
    const created = await tx.insert(drops).values({
      kind: "revealed", origin: "user", state: "IN_VAULT", machineCode: SOLD_TO_TENNER, packPrice: amount, commonFloor: 0,
      nft: holding.nft, card: holding.card, insuredValue: holding.insuredValue, rarity: typeof holding.card.rarity === "string" ? holding.card.rarity : null,
      buybackDeadline: deadline, nextRunAt: new Date(deadline.getTime() - SELL_RELEASE_BY_SEC * 1000),
    }).returning({ id: drops.id });
    return created[0]!.id;
  });
  await finish(ctx, order, "done", { amount, expiresAt: state.expiresAt, dropId: dropId ?? undefined });
}
