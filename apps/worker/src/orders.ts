import { BRAND } from "@gemdex/core";
import {
  activity, and, ccPacks, chainTx, closeHold, emit, eq, giftDraws, holdings, inArray, listings, machines, orders, post, sales, sql, userAccount, users,
} from "@gemdex/db";
import { MachineDown, AddressBlocked, role, trader, type OpenResult, type Party } from "@gemdex/venues";
import { PACK_REVIEW_MS, confirmedSignature, sendOnce } from "./chain-tx";
import { accrueCashback } from "./cashback";
import type { Ctx } from "./ctx";

type Order = typeof orders.$inferSelect;
type User = typeof users.$inferSelect;

/** Nothing is reserved or paid before a pack is generated, so an outage this long can end the order cleanly. */
const GENERATE_GIVE_UP_MS = 10 * 60_000;
const PACK_REVIEW = "Collector Crypt has not delivered or refunded this pack after 6 hours. It needs a manual review.";

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

/** A gift claim that didn't get its pack can be claimed again until the gift expires (docs/FLYWHEEL.md). */
async function reopenGift(ctx: Ctx, giftId: string | undefined) {
  if (giftId) await ctx.db.update(giftDraws).set({ orderId: null, state: "drawn" }).where(eq(giftDraws.id, giftId));
}

async function runGachaOpen(ctx: Ctx, order: Order, user: User) {
  const { machine: code, turbo, gift } = order.params as { machine: string; turbo?: boolean; gift?: string };
  const machineRows = await ctx.db.select().from(machines).where(eq(machines.code, code));
  const machine = machineRows[0];
  if (!machine) {
    await reopenGift(ctx, gift);
    return finish(ctx, order, "failed", {}, "Unknown machine");
  }
  // A gift pack is paid from its reserved prize, out of the Drops wallet where the gift pool lives.
  const payer = gift ? role("drops") : trader(user.id, user.tradingWallet);
  const funds = gift ? "gift_reserved" : userAccount(user.id);

  if (order.step === "start") {
    if (gift) {
      const draw = (await ctx.db.select().from(giftDraws).where(eq(giftDraws.id, gift)))[0];
      if (!draw || draw.winnerUserId !== user.id || !draw.prize || machine.price > draw.prize) {
        await reopenGift(ctx, gift);
        return finish(ctx, order, "failed", {}, "This gift pack's price changed. Try again later.");
      }
    }
    let pack;
    try {
      pack = await ctx.venue.gacha.generate({ machine: code, price: machine.price, player: payer, deliverTo: user.connectedWallet, turbo: !!turbo && !gift });
    } catch (error) {
      if (error instanceof MachineDown || error instanceof AddressBlocked) {
        await reopenGift(ctx, gift);
        return finish(ctx, order, "failed", {}, error.message);
      }
      if (Date.now() - order.createdAt.getTime() > GENERATE_GIVE_UP_MS) {
        await reopenGift(ctx, gift);
        return finish(ctx, order, "failed", {}, "Collector Crypt is not answering. Nothing was charged.");
      }
      throw error;
    }
    await ctx.db.insert(ccPacks).values({ memo: pack.memo, userId: user.id, machineCode: code, price: machine.price, deliverTo: user.connectedWallet, turbo: pack.turbo, raw: pack.raw });
    // Only the first run past "start" may name the pack. A slow, overlapping run's pack is never paid.
    await ctx.db
      .update(orders)
      .set({ memo: pack.memo, step: "pay", state: "running", nextRunAt: new Date(), leaseUntil: null, updatedAt: new Date() })
      .where(and(eq(orders.id, order.id), eq(orders.step, "start")));
    return;
  }

  const memo = order.memo!;
  const pack = (await ctx.db.select().from(ccPacks).where(eq(ccPacks.memo, memo)))[0]!;
  if (order.step === "pay") {
    const result = await sendOnce(ctx, "pack", memo, async () => ({ type: "ccPack", payer, amount: pack.price, memo, raw: pack.raw }));
    if (result.status === "pending") return retry(ctx, order);
    // Nothing was paid, so the hold is released. CC's bytes are never signed again once dead.
    if (result.status === "failed") {
      await reopenGift(ctx, gift);
      return finish(ctx, order, "failed", {}, "Pack payment failed. Nothing was charged.");
    }
    await ctx.db.transaction(async (tx) => {
      await post(tx, `pack:${memo}`, "pack", [{ account: funds, delta: -pack.price }, { account: "cc", delta: pack.price }]);
      await tx.update(ccPacks).set({ state: "paid" }).where(eq(ccPacks.memo, memo));
      if (order.holdId) await closeHold(tx, order.holdId, "captured");
    });
    return setStep(ctx, order, "open");
  }

  // The user has paid. Past the review deadline the order ends failed with the memo kept, so a person can
  // finish it: a later CC refund reaches the trading wallet and is booked by deposit sync.
  const overdue = Date.now() - pack.createdAt.getTime() > PACK_REVIEW_MS;

  if (order.step === "open") {
    let opened: OpenResult;
    try {
      const signature = await confirmedSignature(ctx, "pack", memo);
      opened = await ctx.venue.gacha.open({ memo, machine: pack.machineCode, payer, deliverTo: pack.deliverTo, turbo: pack.turbo, signature });
    } catch (error) {
      if (overdue) return finish(ctx, order, "failed", { memo }, `${PACK_REVIEW} ${error instanceof Error ? error.message : ""}`.trim());
      throw error;
    }
    if (opened.status === "waiting") return overdue ? finish(ctx, order, "failed", { memo }, PACK_REVIEW) : retry(ctx, order);
    if (opened.status === "refunded") return setStep(ctx, order, "refund");
    await ctx.db
      .update(ccPacks)
      .set({ state: "opened", nft: opened.nft, rarity: opened.rarity, insuredValue: opened.insuredValue, roll: opened.roll, buybackAmount: opened.turboBuyback, openedAt: new Date() })
      .where(and(eq(ccPacks.memo, memo), inArray(ccPacks.state, ["reserved", "paid"])));
    const quote = opened.nft ? await ctx.venue.gacha.buybackQuote(opened.nft).catch(() => null) : null;
    const card = opened.card;
    await ctx.db.transaction(async (tx) => {
      // If the worker stops after this is saved but before the order is marked done, this step runs again.
      // The pull is recorded once: without this check each rerun added the same card to the portfolio again.
      const recorded = await tx.select({ id: activity.id }).from(activity).where(and(eq(activity.userId, user.id), eq(activity.kind, "pull"), eq(activity.ref, memo))).limit(1);
      if (recorded[0]) return;
      if (opened.turboBuyback) {
        const buyback = opened.turboBuyback;
        await post(tx, `turbo:${memo}`, "turbo_buyback", [{ account: "cc", delta: -buyback }, { account: userAccount(user.id), delta: buyback }]);
      }
      if (opened.nft) {
        await tx.insert(holdings).values({
          userId: user.id, nft: opened.nft, wallet: "connected", card, source: "gacha", cost: gift ? 0 : pack.price, insuredValue: opened.insuredValue,
          buybackUntil: quote?.expiresAt ?? null, buybackAmount: quote?.amount ?? null,
        });
      }
      await tx.insert(activity).values({
        userId: user.id, kind: "pull", title: `${gift ? "Gift pack" : "Opened"} ${machine.shortName ?? machine.name}: ${String(card.name ?? "Common sold back")}`,
        delta: gift ? 0 : -pack.price + (opened.turboBuyback ?? 0), ref: memo,
      });
      // Whatever the prize held beyond this pack's price goes back to the gift pool.
      if (gift) {
        const draw = (await tx.select().from(giftDraws).where(eq(giftDraws.id, gift)))[0];
        // What the pack actually cost when it was paid; the machine's price may have moved since.
        const left = (draw?.prize ?? 0) - pack.price;
        if (left > 0) await post(tx, `gift:${gift}:change`, "gift_change", [{ account: "gift_reserved", delta: -left }, { account: "gifts", delta: left }]);
      }
    });
    // Cashback is for packs people pay for. A gift is already free.
    if (!gift) await accrueCashback(ctx, user, memo, machine);
    return finish(ctx, order, "done", { memo, nft: opened.nft, rarity: opened.rarity, insuredValue: opened.insuredValue, card, turboBuyback: opened.turboBuyback, roll: opened.roll });
  }

  if (order.step === "refund") {
    if (!(await ctx.venue.gacha.refunded(memo))) return overdue ? finish(ctx, order, "failed", { memo }, PACK_REVIEW) : retry(ctx, order, 60_000);
    await ctx.db.transaction((tx) => post(tx, `refund:${memo}`, "pack_refund", [{ account: "cc", delta: -pack.price }, { account: funds, delta: pack.price }]));
    await reopenGift(ctx, gift);
    return finish(ctx, order, "failed", {}, gift ? "The gift pack could not open. You can claim it again." : "The pack could not open, so it was refunded");
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
  // Only the trading wallet can be signed for here. A card in the connected wallet is sold from the user's own wallet.
  if (holding.wallet !== "trading") return finish(ctx, order, "failed", {}, "This card is in your connected wallet. Sell it back from there.");
  const seller = trader(user.id, user.tradingWallet);
  if (!order.result?.amount) {
    const quote = await ctx.venue.gacha.buybackQuote(holding.nft);
    if (!quote.available) return finish(ctx, order, "failed", {}, "The buyback window has closed");
  }
  const result = await sendOnce(ctx, "buyback", order.id, async () => {
    const built = await ctx.venue.gacha.buildBuyback({ owner: seller, nft: holding.nft, recipient: seller });
    await ctx.db.update(orders).set({ result: { amount: built.amount } }).where(eq(orders.id, order.id));
    return { type: "ccBuyback", owner: seller, recipient: seller, nft: holding.nft, amount: built.amount, raw: built.raw };
  }, { maxAttempts: 3 });
  if (result.status === "pending") return retry(ctx, order);
  if (result.status === "failed") return finish(ctx, order, "failed", {}, result.reason ? `Buyback refused: ${result.reason}` : "Buyback failed on-chain");
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
  // Tenner pays the network fee for a send, so it only sends a card this user holds in their trading wallet.
  // Checked until a transfer has been signed: after that it has to finish, and the holding moves at the end.
  const started = await ctx.db.select({ id: chainTx.id }).from(chainTx).where(and(eq(chainTx.purpose, "send"), eq(chainTx.ref, order.id))).limit(1);
  if (!started[0]) {
    const held = await ctx.db.select({ id: holdings.id }).from(holdings).where(and(eq(holdings.userId, user.id), eq(holdings.nft, nft), eq(holdings.wallet, "trading"), eq(holdings.status, "held"))).limit(1);
    if (!held[0]) return finish(ctx, order, "failed", {}, "That card is not in your trading wallet");
  }
  // A transfer that can't even be built ends after ten minutes, never retried for ever in front of other orders.
  const deadlineAt = new Date(order.createdAt.getTime() + 10 * 60_000);
  const result = await sendOnce(ctx, "send", order.id, async () => ({ type: "core", from, nft, to: user.connectedWallet, memo: `${BRAND.memoPrefix}:send:${order.id}` }), { deadlineAt });
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
