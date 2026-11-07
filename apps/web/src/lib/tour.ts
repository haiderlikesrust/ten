import type { PixelName } from "@/components/pixel";

/** Remembers, per browser, that the tour was finished or skipped. */
export const TOUR_KEY = "gemdex.tour";
/** Bump to show the tour again to everyone, for example after adding a step. */
export const TOUR_VERSION = "1";
/** Pages where the tour never opens by itself. */
export const TOUR_SKIP_ON = ["/terms", "/blocked", "/admin"];

export interface TourStep {
  id: string;
  icon: PixelName;
  kicker: string;
  title: string;
  body: string;
  /** A recording of the real app: public/tour/<id>.mp4, with <id>.jpg as its first frame. */
  clip: string | null;
  cta: { label: string; href: string } | null;
}

export const TOUR_STEPS: TourStep[] = [
  {
    id: "pulse",
    icon: "pulse",
    kicker: "Pulse",
    title: "Real cards drop live",
    body: "A real graded card drops onto Pulse with a price that moves for five minutes. The first click buys it at that second's price.",
    clip: "/tour/pulse",
    cta: { label: "Open Pulse", href: "/" },
  },
  {
    id: "timing",
    icon: "cursor",
    kicker: "Timing",
    title: "Click when it's cheap",
    body: "Every card opens at its insured value. Many run up, then crash, and some land 60 to 90% below insured. Buy when the price looks right, before anyone else does.",
    clip: "/tour/timing",
    cta: null,
  },
  {
    id: "scanner",
    icon: "scanner",
    kicker: "Scanner",
    title: "Every listing, priced against insured",
    body: "Scanner shows each Collector Crypt listing the moment it lands, next to its insured value, so the deals stand out.",
    clip: "/tour/scanner",
    cta: { label: "Open Scanner", href: "/scanner" },
  },
  {
    id: "gacha",
    icon: "pack",
    kicker: "Gacha Desk",
    title: "Rip real packs",
    body: "Open Collector Crypt packs with the odds and expected value shown first. Keep the hits.",
    clip: "/tour/gacha",
    cta: { label: "Open Gacha Desk", href: "/gacha" },
  },
  {
    id: "portfolio",
    icon: "slab",
    kicker: "Portfolio",
    title: "Every card you own, in one place",
    body: "See what you paid, what each card is insured for, and your profit over time. Share it as a PnL card.",
    clip: "/tour/portfolio",
    cta: { label: "Open Portfolio", href: "/portfolio" },
  },
];

export function tourSeen(): boolean {
  try {
    return localStorage.getItem(TOUR_KEY) === TOUR_VERSION;
  } catch {
    // No storage (a private window, or blocked): don't open it on every page load.
    return true;
  }
}

export function markTourSeen(): void {
  try {
    localStorage.setItem(TOUR_KEY, TOUR_VERSION);
  } catch {
    // Nothing to remember it in.
  }
}
