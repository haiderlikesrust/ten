// The $TENR flywheel's public page and gift claims (docs/FLYWHEEL.md).
import { giftSlot, type Access } from "@gemdex/core";
import { and, balanceOf, buybacks, desc, eq, getSetting, giftDraws, isNull, placeOrder, type Database } from "@gemdex/db";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { loadUser, requireUser, userIdFrom } from "./auth";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Account = NonNullable<Awaited<ReturnType<typeof loadUser>>>;

export interface FlywheelDeps {
  database: Database;
  /** Null when the user may act; otherwise why not. Shared with the buy routes. */
  accessRefusal: (user: Account) => Promise<{ error: string; code: string; access?: Access } | null>;
}

/** What a draw shows in public: everything needed to check it, without the full entry list. */
function publicDraw(d: typeof giftDraws.$inferSelect) {
  return {
    id: d.id, slotAt: d.slotAt, group: d.grp, state: d.state, prize: d.prize, machineCode: d.machineCode, reason: d.reason,
    entries: d.entries.length, entriesHash: d.entriesHash, targetSlot: d.targetSlot, blockhash: d.blockhash, seed: d.seed,
    winner: d.winnerWallet, drawnAt: d.drawnAt, expiresAt: d.expiresAt,
  };
}

export function flywheelRoutes(app: FastifyInstance, { database, accessRefusal }: FlywheelDeps) {
  const { db } = database;

  /** Public: where the money goes, the rules, recent draws, and buybacks. */
  app.get("/flywheel", async () => {
    const [settings, drops, cashback, gifts, giftReserved, revenue] = await Promise.all([
      getSetting(db, "flywheel"), balanceOf(db, "drops"), balanceOf(db, "cashback"), balanceOf(db, "gifts"), balanceOf(db, "gift_reserved"), balanceOf(db, "revenue"),
    ]);
    const [draws, burns] = await Promise.all([
      db.select().from(giftDraws).orderBy(desc(giftDraws.slotAt)).limit(24),
      db.select().from(buybacks).orderBy(desc(buybacks.createdAt)).limit(20),
    ]);
    const nextDrawAt = new Date(giftSlot(Date.now(), settings.giftIntervalMin) + settings.giftIntervalMin * 60_000);
    return {
      pools: { drops, cashback, gifts, giftReserved, revenue },
      rules: {
        accessBps: settings.accessBps, giftHoldBps: settings.giftHoldBps, giftBps: settings.giftBps, giftSpendBps: settings.giftSpendBps, giftIntervalMin: settings.giftIntervalMin,
        giftTiers: settings.giftTiers, activePacksPerHour: settings.activePacksPerHour, topBlasters: settings.topBlasters, blasterDays: settings.blasterDays,
        claimHours: settings.claimHours, platformFeeBps: settings.platformFeeBps, giftsEnabled: settings.giftsEnabled, buybackEnabled: settings.buybackEnabled,
      },
      nextDrawAt,
      draws: draws.map(publicDraw),
      buybacks: burns.map((b) => ({ id: b.id, stage: b.stage, usdcIn: b.usdcIn, tenrOut: b.tenrOut, swapSig: b.swapSig, burnSig: b.burnSig, at: b.createdAt })),
      totals: {
        usdcSpent: burns.filter((b) => b.stage === "DONE").reduce((sum, b) => sum + b.usdcIn, 0),
        tenrBurned: burns.filter((b) => b.stage === "DONE").reduce((sum, b) => sum + (b.tenrOut ?? 0), 0),
      },
    };
  });

  /** Public: one draw's full entries, so anyone can recompute its winner. */
  app.get("/flywheel/draws/:id", async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    if (!UUID.test(id)) return reply.code(404).send({ error: "No such draw" });
    const rows = await db.select().from(giftDraws).where(eq(giftDraws.id, id));
    if (!rows[0]) return reply.code(404).send({ error: "No such draw" });
    return { ...publicDraw(rows[0]), list: rows[0].entries.map((e) => ({ userId: e.userId, wallet: e.wallet, weight: e.weight })) };
  });

  /** The signed-in user's gifts: waiting to be claimed, or claimed. */
  app.get("/gifts/mine", async (request, reply) => {
    const userId = await userIdFrom(request);
    if (!requireUser(request, reply, userId)) return;
    const rows = await db.select().from(giftDraws).where(eq(giftDraws.winnerUserId, userId)).orderBy(desc(giftDraws.drawnAt)).limit(20);
    return { gifts: rows.map((d) => ({ ...publicDraw(d), orderId: d.orderId, claimable: d.state === "drawn" && !d.orderId && !!d.expiresAt && d.expiresAt.getTime() > Date.now() })) };
  });

  /**
   * Claims a gift: opens the pack through the normal Gacha flow, paid from the gift's reserved prize, with the
   * card delivered to the winner. The access minimum applies here too.
   */
  app.post("/gifts/:id/claim", async (request, reply) => {
    const userId = await userIdFrom(request);
    if (!requireUser(request, reply, userId)) return;
    const { id } = request.params as { id: string };
    if (!UUID.test(id)) return reply.code(404).send({ error: "No such gift" });
    const user = await loadUser(db, userId);
    if (!user) return reply.code(401).send({ error: "Session expired" });
    const refused = await accessRefusal(user);
    if (refused) return reply.code(refused.code === "access" ? 403 : 503).send(refused);
    const result = await db.transaction(async (tx) => {
      const rows = await tx.select().from(giftDraws).where(eq(giftDraws.id, id)).for("update");
      const draw = rows[0];
      if (!draw || draw.winnerUserId !== userId) return { code: 404, body: { error: "No such gift" } };
      if (draw.orderId) return { code: 200, body: { orderId: draw.orderId } };
      if (draw.state !== "drawn" || !draw.expiresAt || draw.expiresAt.getTime() <= Date.now() || !draw.machineCode) return { code: 410, body: { error: "This gift has expired" } };
      const placed = await placeOrder(tx, { userId, kind: "gacha_open", params: { machine: draw.machineCode, turbo: false, gift: draw.id }, holdAmount: 0, idempotencyKey: `gift:${draw.id}` });
      if (!placed.ok) return { code: 409, body: { error: "Could not start the claim" } };
      await tx.update(giftDraws).set({ orderId: placed.orderId, state: "claimed" }).where(and(eq(giftDraws.id, draw.id), isNull(giftDraws.orderId)));
      return { code: 200, body: { orderId: placed.orderId } };
    });
    return reply.code(result.code).send(result.body);
  });
}
