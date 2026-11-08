import {
  DEFAULT_CASHBACK_SETTINGS, DEFAULT_DROP_SETTINGS, DEFAULT_FEE_SETTINGS, DEFAULT_FLYWHEEL_SETTINGS,
  type CashbackSettings, type DropSettings, type FeeSettings, type FlywheelSettings,
} from "@gemdex/core";
import { eq } from "drizzle-orm";
import type { DbOrTx } from "./client";
import { appSettings } from "./schema";

export interface OpsFlags {
  killSwitch: boolean;
  reconcileHold: boolean;
  /** Set only by the two-admin arm. Empty means mainnet stays off. */
  armedUntil: string | null;
  armedBy: string[];
  /** First admin must be joined by a second within minutes, or the request lapses. */
  armRequestedAt: string | null;
  /** The admin whose arm request is waiting for a second admin. */
  armRequestBy: string | null;
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
  ops: { killSwitch: false, reconcileHold: false, armedUntil: null, armedBy: [], armRequestedAt: null, armRequestBy: null },
};

export async function getSetting<K extends keyof Settings>(db: DbOrTx, key: K): Promise<Settings[K]> {
  const rows = await db.select().from(appSettings).where(eq(appSettings.key, key));
  return { ...DEFAULTS[key], ...((rows[0]?.value as object | undefined) ?? {}) } as Settings[K];
}

export async function setSetting<K extends keyof Settings>(db: DbOrTx, key: K, value: Partial<Settings[K]>): Promise<Settings[K]> {
  const merged = { ...(await getSetting(db, key)), ...value } as Settings[K];
  await db
    .insert(appSettings)
    .values({ key, value: merged })
    .onConflictDoUpdate({ target: appSettings.key, set: { value: merged, updatedAt: new Date() } });
  return merged;
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
