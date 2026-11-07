import { BRAND } from "@gemdex/core";
import {
  activity, and, ccPacks, closeHold, emit, eq, holdings, inArray, listings, machines, orders, post, sales, sql, userAccount, users,
} from "@gemdex/db";
import { MachineDown, AddressBlocked, role, trader, type Party } from "@gemdex/venues";
import { sendOnce } from "./chain-tx";
import { accrueCashback } from "./cashback";
import type { Ctx } from "./ctx";

type Order = typeof orders.$inferSelect;
type User = typeof users.$inferSelect;

async function setStep(ctx: Ctx, order: Order, step: string, patch: Partial<typeof orders.$inferInsert> = {}) {
  await ctx.db
    .update(orders)
    .set({ ...patch, step, state: "running", nextRunAt: new Date(), leaseUntil: null, updatedAt: new Date() })
    .where(eq(orders.id, order.id));
}

async function retry(ctx: Ctx, order: Order, ms = 1_000) {
  await ctx.db.update(orders).set({ nextRunAt: new Date(Date.now() + ms), leaseUntil: null, updatedAt: new Date() }).where(eq(orders.id, order.id));
}

async function finish(ctx: Ctx, order: Order, state: "done" | "failed", result: Record<string, unknown> = {}, error?: string) {
  await ctx.db.transaction(async (tx) => {
    if (order.holdId && state === "failed") await closeHold(tx, order.holdId, "released");
    await tx.update(orders).set({ state, result, error: error ?? null, leaseUntil: null, updatedAt: new Date() }).where(eq(orders.id, order.id));
    await emit(tx, `user:${order.userId}`, { type: "order", id: order.id, kind: order.kind, state, result, error });
  });
}

async function runMarketBuy(ctx: Ctx, order: Order, user: User) {
  const { nft, price } = order.params as { nft: string; price: number };
  const buyer: Party = trader(user.id, user.tradingWallet);
  const rows = await ctx.db.select().from(listings).where(eq(listings.nft, nft));
  const listing = rows[0];
  if (!listing || !listing.active || listing.price !== price) return finish(ctx, order, "failed", {}, "This listing is gone or its price changed");

  const result = await sendOnce(ctx, "market_buy", order.id, async () => {
    const built = await ctx.venue.market.buildBuy({ buyer, nft, price });
    return { type: "ccBuy", buyer, nft, amount: price, raw: built.raw };
  });
  if (result.status === "pending") return retry(ctx, order);
  if (result.status === "failed") return finish(ctx, order, "failed", {}, "The purchase failed on-chain");

  const card = { name: listing.name, image: listing.image, grader: listing.grader, grade: listing.grade, category: listing.category, set: listing.set };
  await ctx.db.transaction(async (tx) => {
    await post(tx, `order:${order.id}`, "market_buy", [{ account: userAccount(user.id), delta: -price }, { account: "world", delta: price }]);
    if (order.holdId) await closeHold(tx, order.holdId, "captured");
    await tx.insert(holdings).values({ userId: user.id, nft, wallet: "trading", card, source: "market", cost: price, insuredValue: listing.insuredValue });
    await tx.update(listings).set({ active: false }).where(eq(listings.nft, nft));
    await tx.insert(sales).values({ nft, name: listing.name, price, insuredValue: listing.insuredValue, seller: listing.seller, buyer: user.connectedWallet, source: "gemdex" });
    await tx.insert(activity).values({ userId: user.id, kind: "buy", title: `Bought ${listing.name}`, delta: -price, ref: nft });
  });
  await finish(ctx, order, "done", { nft, price, name: listing.name, image: listing.image });
  await emit(ctx.db, "listings", { type: "sold", nft, price });
  if (user.settings.autoForward) {
    await ctx.db.insert(orders).values({ userId: user.id, kind: "send", params: { nft }, idempotencyKey: `autoforward:${order.id}` }).onConflictDoNothing();
  }
}

async function runGachaOpen(ctx: Ctx, order: Order, user: User) {
  const { machine: code, turbo } = order.params as { machine: string; turbo?: boolean };
  const machineRows = await ctx.db.select().from(machines).where(eq(machines.code, code));
  const machine = machineRows[0];
  if (!machine) return finish(ctx, order, "failed", {}, "Unknown machine");
  const payer = trader(user.id, user.tradingWallet);

  if (order.step === "start") {
    try {
      const pack = await ctx.venue.gacha.generate({ machine: code, price: machine.price, player: payer, deliverTo: user.connectedWallet, turbo: !!turbo });
      await ctx.db.insert(ccPacks).values({ memo: pack.memo, userId: user.id, machineCode: code, price: machine.price, deliverTo: user.connectedWallet, turbo: !!turbo, raw: pack.raw });
      return setStep(ctx, order, "pay", { memo: pack.memo });
    } catch (error) {
      if (error instanceof MachineDown || error instanceof AddressBlocked) return finish(ctx, order, "failed", {}, error.message);
      throw error;
    }
  }

  const memo = order.memo!;
  if (order.step === "pay") {
    const packRows = await ctx.db.select().from(ccPacks).where(eq(ccPacks.memo, memo));
    const pack = packRows[0]!;
    const result = await sendOnce(ctx, "pack", memo, async () => ({ type: "ccPack", payer, amount: pack.price, memo, raw: pack.raw }));
    if (result.status === "pending") return retry(ctx, order);
    if (result.status === "failed") return finish(ctx, order, "failed", {}, "Pack payment failed");
    await ctx.db.transaction(async (tx) => {
      await post(tx, `pack:${memo}`, "pack", [{ account: userAccount(user.id), delta: -pack.price }, { account: "cc", delta: pack.price }]);
      await tx.update(ccPacks).set({ state: "paid" }).where(eq(ccPacks.memo, memo));
      if (order.holdId) await closeHold(tx, order.holdId, "captured");
    });
    return setStep(ctx, order, "open");
  }

  if (order.step === "open") {
    const opened = await ctx.venue.gacha.open(memo);
    if (opened.status === "waiting") return retry(ctx, order);
    if (opened.status === "dead") return setStep(ctx, order, "refund");
    await ctx.db
      .update(ccPacks)
      .set({ state: "opened", nft: opened.nft, rarity: opened.rarity, insuredValue: opened.insuredValue, roll: opened.roll, buybackAmount: opened.turboBuyback, openedAt: new Date() })
      .where(and(eq(ccPacks.memo, memo), inArray(ccPacks.state, ["reserved", "paid"])));
    const quote = opened.nft ? await ctx.venue.gacha.buybackQuote(opened.nft).catch(() => null) : null;
    const card = opened.card;
    await ctx.db.transaction(async (tx) => {
      if (opened.turboBuyback) {
        const buyback = opened.turboBuyback;
        await post(tx, `turbo:${memo}`, "turbo_buyback", [{ account: "cc", delta: -buyback }, { account: userAccount(user.id), delta: buyback }]);
      }
      if (opened.nft) {
        await tx.insert(holdings).values({
          userId: user.id, nft: opened.nft, wallet: "connected", card, source: "gacha", cost: machine.price, insuredValue: opened.insuredValue,
          buybackUntil: quote?.expiresAt ?? null, buybackAmount: quote?.amount ?? null,
        });
      }
      await tx.insert(activity).values({ userId: user.id, kind: "pull", title: `Opened ${machine.shortName ?? machine.name}: ${String(card.name ?? "Common sold back")}`, delta: -machine.price + (opened.turboBuyback ?? 0), ref: memo });
    });
    await accrueCashback(ctx, user, memo, machine);
    return finish(ctx, order, "done", { memo, nft: opened.nft, rarity: opened.rarity, insuredValue: opened.insuredValue, card, turboBuyback: opened.turboBuyback, roll: opened.roll });
  }

  if (order.step === "refund") {
    if (!(await ctx.venue.gacha.refunded(memo))) return retry(ctx, order, 60_000);
    await ctx.db.transaction((tx) => post(tx, `refund:${memo}`, "pack_refund", [{ account: "cc", delta: -machine.price }, { account: userAccount(user.id), delta: machine.price }]));
    return finish(ctx, order, "failed", {}, "The pack could not open, so it was refunded");
  }
}

async function ownedHolding(ctx: Ctx, order: Order) {
  const { holdingId } = order.params as { holdingId: string };
  const rows = await ctx.db.select().from(holdings).where(and(eq(holdings.id, holdingId), eq(holdings.userId, order.userId)));
  return rows[0];
}

async function runBuyback(ctx: Ctx, order: Order, user: User) {
  const holding = await ownedHolding(ctx, order);
  if (!holding || holding.status !== "held") return finish(ctx, order, "failed", {}, "You no longer hold this card");
  const seller = trader(user.id, user.tradingWallet);
  if (!order.result?.amount) {
    const quote = await ctx.venue.gacha.buybackQuote(holding.nft);
    if (!quote.available) return finish(ctx, order, "failed", {}, "The buyback window has closed");
  }
  const result = await sendOnce(ctx, "buyback", order.id, async () => {
    const built = await ctx.venue.gacha.buildBuyback({ owner: seller, nft: holding.nft, recipient: seller });
    await ctx.db.update(orders).set({ result: { amount: built.amount } }).where(eq(orders.id, order.id));
    return { type: "ccBuyback", owner: seller, recipient: seller, nft: holding.nft, amount: built.amount, raw: built.raw };
  });
  if (result.status === "pending") return retry(ctx, order);
  if (result.status === "failed") return finish(ctx, order, "failed", {}, "Buyback failed on-chain");
  const saved = await ctx.db.select({ result: orders.result }).from(orders).where(eq(orders.id, order.id));
  const amount = Number(saved[0]?.result?.amount ?? 0);
  await ctx.db.transaction(async (tx) => {
    await post(tx, `order:${order.id}`, "buyback", [{ account: "cc", delta: -amount }, { account: userAccount(user.id), delta: amount }]);
    await tx.update(holdings).set({ status: "bought_back", exitPrice: amount, exitedAt: new Date() }).where(eq(holdings.id, holding.id));
    await tx.insert(activity).values({ userId: user.id, kind: "sell", title: `Sold back ${String(holding.card.name ?? "a card")}`, delta: amount, ref: holding.nft });
  });
  await finish(ctx, order, "done", { amount });
}

async function runList(ctx: Ctx, order: Order, user: User) {
  const holding = await ownedHolding(ctx, order);
  const { price } = order.params as { price: number };
  if (!holding || holding.status !== "held") return finish(ctx, order, "failed", {}, "You no longer hold this card");
  const owner = trader(user.id, user.tradingWallet);
  const result = await sendOnce(ctx, "list", order.id, async () => {
    const built = await ctx.venue.market.buildList({ owner, nft: holding.nft, price });
    return { type: "ccList", owner, nft: holding.nft, amount: price, raw: built.raw };
  });
  if (result.status === "pending") return retry(ctx, order);
  if (result.status === "failed") return finish(ctx, order, "failed", {}, "Listing failed");
  await ctx.db.update(holdings).set({ status: "listed", listPrice: price }).where(eq(holdings.id, holding.id));
  await finish(ctx, order, "done", { price });
}

async function runSend(ctx: Ctx, order: Order, user: User) {
  const { nft } = order.params as { nft: string };
  const from = trader(user.id, user.tradingWallet);
  const result = await sendOnce(ctx, "send", order.id, async () => ({ type: "core", from, nft, to: user.connectedWallet, memo: `${BRAND.memoPrefix}:send:${order.id}` }));
  if (result.status === "pending") return retry(ctx, order);
  if (result.status === "failed") return finish(ctx, order, "failed", {}, "Transfer failed");
  await ctx.db.update(holdings).set({ wallet: "connected" }).where(and(eq(holdings.userId, user.id), eq(holdings.nft, nft)));
  await finish(ctx, order, "done", { nft });
}

async function leaseOrders(ctx: Ctx, limit: number): Promise<Order[]> {
  const leased = await ctx.sql<{ id: string }[]>`
    update orders set lease_until = now() + interval '15 seconds', state = 'running'
    where id in (
      select id from orders
      where state in ('queued', 'running') and next_run_at <= now()
        and (lease_until is null or lease_until < now())
      order by next_run_at limit ${limit}
      for update skip locked
    )
    returning id`;
  if (leased.length === 0) return [];
  return ctx.db.select().from(orders).where(inArray(orders.id, leased.map((row) => row.id)));
}

export async function tickOrders(ctx: Ctx): Promise<number> {
  const due = await leaseOrders(ctx, 30);
  await Promise.all(
    due.map(async (order) => {
      try {
        const rows = await ctx.db.select().from(users).where(eq(users.id, order.userId));
        const user = rows[0]!;
        if (order.kind === "market_buy") await runMarketBuy(ctx, order, user);
        else if (order.kind === "gacha_open") await runGachaOpen(ctx, order, user);
        else if (order.kind === "buyback") await runBuyback(ctx, order, user);
        else if (order.kind === "list") await runList(ctx, order, user);
        else if (order.kind === "send") await runSend(ctx, order, user);
      } catch (error) {
        ctx.log(`order ${order.id} ${order.kind}/${order.step} failed`, error instanceof Error ? error.message : error);
        await retry(ctx, order, 2_000);
      }
    }),
  );
  return due.length;
}

export { role, sql };
