import { formatUsd } from "@gemdex/core";

export const money = (micros: number | null | undefined, compact = false): string =>
  micros === null || micros === undefined ? "–" : formatUsd(micros, { compact });

const PAUSE_REASONS: Record<string, string> = {
  disabled: "turned off in Admin",
  kill_switch: "kill switch is on",
  reconcile_mismatch: "balance check found a difference",
  wallet_floor: "the Pulse pool is low",
  daily_cap: "today's spend cap is reached",
};

export const pauseReason = (reason: string | null | undefined): string => (reason ? PAUSE_REASONS[reason] ?? reason : "");

/** Large dollar figures such as a market cap: $215.4M. */
export function compactUsd(value: number): string {
  return `$${new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(value)}`;
}

export function ago(at: string | Date | null | undefined, now = Date.now()): string {
  if (!at) return "–";
  const sec = Math.max(0, Math.floor((now - new Date(at).getTime()) / 1000));
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m`;
  if (sec < 86_400) return `${Math.floor(sec / 3600)}h`;
  return `${Math.floor(sec / 86_400)}d`;
}

export function clock(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return "0:00";
  const s = Math.floor(sec);
  if (s >= 3600) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** "2017 #008 Magikarp PSA 10 Japanese Sun..." reads better without the grade repeated. */
export function cardTitle(name: string): string {
  return name.replace(/\s+(PSA|CGC|BGS|SGC)\s+[\d.]+.*$/i, "").trim() || name;
}

export function gradeShort(grader: string | null | undefined, grade: string | null | undefined): string | null {
  if (!grader && !grade) return null;
  const number = String(grade ?? "").match(/[\d.]+\s*$/)?.[0]?.trim();
  return [grader, number].filter(Boolean).join(" ") || null;
}

/** "pokemon_25" reads as "Pokemon $25". */
export function packLabel(code: string): string {
  const parts = code.split("_");
  const price = parts.at(-1);
  const hasPrice = !!price && /^\d+$/.test(price);
  const name = (hasPrice ? parts.slice(0, -1) : parts).join(" ");
  const title = name.charAt(0).toUpperCase() + name.slice(1);
  return hasPrice ? `${title} $${price}` : title;
}
