import { getSetting, users, eq } from "@gemdex/db";
import { checkAccess, walletsOf } from "@gemdex/venues/holdings";
import type { Ctx } from "./ctx";

/**
 * Whether a user holds enough $TENR right now (docs/FLYWHEEL.md). Limit orders and auto-buys ask
 * before they fire. If the chain can't be read, the answer is no, and they try again later.
 */
export async function mayBuy(ctx: Ctx, userId: string): Promise<boolean> {
  if (!ctx.tokens) return true;
  const { accessBps } = await getSetting(ctx.db, "flywheel");
  if (!(accessBps > 0)) return true;
  const rows = await ctx.db.select().from(users).where(eq(users.id, userId));
  const user = rows[0];
  if (!user) return false;
  try {
    return (await checkAccess(ctx.tokens, walletsOf(user), accessBps)).ok;
  } catch (error) {
    ctx.log("could not read $TENR for the access minimum", error instanceof Error ? error.message : error);
    return false;
  }
}
