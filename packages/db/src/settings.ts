import {
  DEFAULT_CASHBACK_SETTINGS, DEFAULT_DROP_SETTINGS, DEFAULT_FEE_SETTINGS, DEFAULT_FLYWHEEL_SETTINGS,
  type CashbackSettings, type DropSettings, type FeeSettings, type FlywheelSettings,
} from "@gemdex/core";
import { eq, sql } from "drizzle-orm";
import type { DbOrTx } from "./client";
import { appSettings } from "./schema";

export interface OpsFlags {
  killSwitch: boolean;
  reconcileHold: boolean;
  /** Set only when an admin arms mainnet. Empty or expired means mainnet signs nothing. */
  armedUntil: string | null;
  /** The admin who armed it. */
  armedBy: string[];
}

export interface Settings {
  drops: DropSettings;
  fees: FeeSettings;
  cashback: CashbackSettings;
  flywheel: FlywheelSettings;
  ops: OpsFlags;
}

const DEFAULTS: Settings = {
  drops: DEFAULT_DROP_SETTINGS,
  fees: DEFAULT_FEE_SETTINGS,
  cashback: DEFAULT_CASHBACK_SETTINGS,
  flywheel: DEFAULT_FLYWHEEL_SETTINGS,
  ops: { killSwitch: false, reconcileHold: false, armedUntil: null, armedBy: [] },
};

/** The built-in values for a group of settings, before anything saved is laid over them. */
export const settingDefaults = <K extends keyof Settings>(key: K): Settings[K] => DEFAULTS[key];

function withDefaults<K extends keyof Settings>(key: K, saved: unknown): Settings[K] {
  const defaults = DEFAULTS[key] as unknown as Record<string, unknown>;
  const merged: Record<string, unknown> = { ...defaults };
  // A null saved over a real setting is not a value (a form field left unreadable once saved one): the default stands.
  for (const [name, value] of Object.entries((saved as Record<string, unknown> | null | undefined) ?? {})) {
    if (value !== null || defaults[name] === null) merged[name] = value;
  }
  return merged as unknown as Settings[K];
}

export async function getSetting<K extends keyof Settings>(db: DbOrTx, key: K): Promise<Settings[K]> {
  const rows = await db.select().from(appSettings).where(eq(appSettings.key, key));
  return withDefaults(key, rows[0]?.value);
}

/**
 * Saves the given fields and leaves the rest as they are. The merge happens inside one statement in the database,
 * so two writers at once cannot undo each other: read-then-write let a renewed arm put back a kill switch that
 * someone had just switched on.
 */
export async function setSetting<K extends keyof Settings>(db: DbOrTx, key: K, value: Partial<Settings[K]>): Promise<Settings[K]> {
  const rows = await db
    .insert(appSettings)
    .values({ key, value })
    .onConflictDoUpdate({ target: appSettings.key, set: { value: sql`${appSettings.value} || excluded.value`, updatedAt: new Date() } })
    .returning({ value: appSettings.value });
  return withDefaults(key, rows[0]?.value);
}

/**
 * Why nothing new may start right now, if anything: the kill switch, or mainnet outside an armed window.
 * One rule for the gateway's routes, limit orders and signing, so none of them can disagree.
 */
export function pausedBy(ops: OpsFlags, mode: string, now = Date.now()): "kill_switch" | "not_armed" | null {
  if (ops.killSwitch) return "kill_switch";
  if (mode !== "mainnet") return null;
  const until = ops.armedUntil ? new Date(ops.armedUntil).getTime() : 0;
  return until > now && ops.armedBy.length > 0 ? null : "not_armed";
}

/** Free-form runtime state such as scheduler status. */
export async function loadJson<T>(db: DbOrTx, key: string): Promise<T | null> {
  const rows = await db.select().from(appSettings).where(eq(appSettings.key, key));
  return (rows[0]?.value as T | undefined) ?? null;
}

export async function saveJson(db: DbOrTx, key: string, value: unknown): Promise<void> {
  await db
    .insert(appSettings)
    .values({ key, value })
    .onConflictDoUpdate({ target: appSettings.key, set: { value, updatedAt: new Date() } });
}
