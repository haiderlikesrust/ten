import { autoFires, autoRules, eq, sql, type Db } from "@gemdex/db";

export { autoFires, emit, eq, listings, machines, placeOrder, poolCards, pricePoints, pulls, sales, sql } from "@gemdex/db";

/** Enabled rules with what each has spent in the last 24 hours. */
export async function activeRulesQuery(db: Db) {
  const rows = await db
    .select({
      rule: autoRules,
      spent: sql<string>`coalesce((select sum(f.price) from auto_fires f where f.rule_id = auto_rules.id and f.at > now() - interval '24 hours'), 0)`,
    })
    .from(autoRules)
    .where(eq(autoRules.enabled, true));
  return rows.map((row) => ({ rule: row.rule, spent: Number(row.spent) }));
}
