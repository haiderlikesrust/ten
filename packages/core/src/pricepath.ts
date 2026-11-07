import { floorToCents, type Micros } from "./money";

/**
 * How a card's price behaves, and the share of cards that behave that way. Seven in ten run up
 * from their opening price and then crash or simmer. The rest go somewhere else, often higher.
 */
export const PATH_MIX = {
  crash: 0.49,
  simmer: 0.21,
  moon: 0.12,
  late_run: 0.08,
  chop: 0.06,
  fade: 0.04,
} as const;
export type PathCharacter = keyof typeof PATH_MIX;

export function pickCharacter(rnd: number): PathCharacter {
  let left = rnd;
  for (const character of Object.keys(PATH_MIX) as PathCharacter[]) {
    left -= PATH_MIX[character];
    if (left < 0) return character;
  }
  return "crash";
}

/** Share of crashes that stay down. The rest bounce back. */
const STAYS_DOWN = 0.35;

/** Where the price wants to be at each point of its life, as a multiple of the opening price. */
type Curve = (progress: number) => number;

/** Eases between points of [progress, multiple]. */
function through(points: Array<[number, number]>): Curve {
  return (progress) => {
    const next = points.findIndex(([at]) => at >= progress);
    if (next === 0) return points[0]![1];
    if (next < 0) return points[points.length - 1]![1];
    const [fromAt, from] = points[next - 1]!;
    const [toAt, to] = points[next]!;
    const t = (progress - fromAt) / (toAt - fromAt);
    return from + (to - from) * t * t * (3 - 2 * t);
  };
}

/** Rolls the price gently up and down around a curve. */
function wave(base: Curve, size: number, turns: number, phase: number): Curve {
  return (progress) => base(progress) * (1 + size * Math.sin(2 * Math.PI * (progress * turns + phase)));
}

/**
 * The way down, in legs. Every leg but the last ends in a rally that gives back part of the fall
 * and fails at a lower high, so a crash reads like a market giving way, not a straight line.
 */
function fakeBounces(from: number, to: number, start: number, end: number, between: (lo: number, hi: number) => number): Array<[number, number]> {
  const legs = Math.round(between(2.5, 4.4));
  const length = (end - start) / legs;
  const points: Array<[number, number]> = [];
  let level = from;
  for (let leg = 1; leg < legs; leg++) {
    const low = from * (to / from) ** (leg / legs);
    const high = low + (level - low) * between(0.45, 0.75);
    points.push([start + length * (leg - between(0.45, 0.6)), low], [start + length * leg, high]);
    level = high;
  }
  return points;
}

/**
 * The first moves after a card opens, so no two start alike. It can dip, sit still or tick up
 * before it gets going, and the run only takes over as it nears the top.
 */
function opening(top: number, topAt: number, between: (lo: number, hi: number) => number): Array<[number, number]> {
  const moves = Math.round(between(1.5, 4.4));
  const points: Array<[number, number]> = [];
  for (let move = 1; move < moves; move++) {
    const share = move / moves;
    const level = 1 + (top - 1) * share * between(-0.2, 0.7) + between(-0.12, 0.06) * (1 - share);
    points.push([topAt * (share + between(-0.08, 0.08)), level]);
  }
  return points;
}

function shape(character: PathCharacter, bottom: number, rng: () => number): Curve {
  const between = (lo: number, hi: number) => lo + rng() * (hi - lo);
  const peakAt = between(0.1, 0.32);
  // Most runs are modest, and a few go a long way.
  const peak = 1.2 + 1.3 * rng() ** 2;
  const start = (top: number, topAt: number): Array<[number, number]> => [[0, 1], ...opening(top, topAt, between), [topAt, top]];
  switch (character) {
    case "crash": {
      // Any time after the run up, so nobody can plan around it.
      const dropAt = between(0.14, 0.68);
      const before = 1 + (peak - 1) * between(0.2, 0.8);
      const landsAt = dropAt + between(0.16, 0.28);
      const leavesAt = landsAt + between(0.05, 0.12);
      // Most crashes are a window that closes again, so waiting for the end doesn't pay.
      // The ones that stay down still try once, then give up.
      const tail: Array<[number, number]> = rng() < STAYS_DOWN
        ? [[leavesAt + between(0.03, 0.06), bottom * between(1.3, 1.6)], [leavesAt + between(0.08, 0.12), bottom * between(1, 1.15)]]
        : [[leavesAt + between(0.06, 0.15), between(0.6, 1.3)]];
      // Overshoots the bottom a little, so the low really gets there.
      const floor = bottom * 0.93;
      const line = through([...start(peak, Math.min(peakAt, dropAt * 0.7)), [dropAt, before], ...fakeBounces(before, floor, dropAt, landsAt, between), [landsAt, floor], [leavesAt, bottom], ...tail]);
      const rolling = wave(line, 0.05, between(3, 6), rng());
      return (progress) => (progress >= dropAt && progress <= leavesAt ? line(progress) : rolling(progress));
    }
    case "simmer":
      return wave(through([...start(peak, peakAt), [between(0.35, 0.5), between(1, 1.25)], [1, between(0.85, 1.3)]]), 0.09, between(3, 5), rng());
    case "moon":
      return wave(through([...start(between(1.5, 2), between(0.2, 0.35)), [between(0.55, 0.7), between(1.4, 1.9)], [1, between(2, 3.5)]]), 0.05, 3, rng());
    case "late_run":
      return wave(through([...start(1 + (peak - 1) * 0.4, peakAt), [between(0.5, 0.65), between(0.6, 0.8)], [1, between(1.4, 2.6)]]), 0.04, 3, rng());
    case "chop":
      return wave(() => 1, between(0.25, 0.4), between(3, 5), rng());
    case "fade":
      return wave(through([[0, 1], [1, between(0.5, 0.75)]]), 0.04, 4, rng());
  }
}

/** Where a crash lands, as a share of the opening price. The minimum price can stop it short. */
function crashBottom(open: Micros, min: Micros, [lo, hi]: readonly [number, number], rnd: number): number {
  const deepest = Math.max(lo, min / open);
  return deepest + rnd * (Math.max(hi, deepest) - deepest);
}

function gaussian(rng: () => number): number {
  const u = Math.max(1e-9, rng());
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng());
}

/** How quickly the price closes on its curve each second. Noise and jumps are what's left. */
const PULL = 0.16;
const NOISE = 0.016;

export interface PathInput {
  /** The price it opens at. For a shown card this is its insured value. */
  value: Micros;
  min: Micros;
  /** Only sealed packs have a ceiling. */
  max?: Micros;
  /** A crash lands between these shares of the opening price, and nothing goes below the first. */
  crash: readonly [number, number];
  seconds: number;
  rng: () => number;
  /** Drawn from the mix unless a test sets it. */
  character?: PathCharacter;
}

/**
 * The price of a card for every second of its life, drawn once when it goes live and kept
 * on the server. Clients only ever receive the part that has already happened, so nobody
 * can see where the price is going.
 */
export function generatePath({ value, min, max = Number.POSITIVE_INFINITY, crash, seconds, rng, character = pickCharacter(rng()) }: PathInput): Micros[] {
  const open = Math.max(min, Math.min(max, floorToCents(value)));
  const curve = shape(character, crashBottom(open, min, crash, rng()), rng);
  const floor = Math.max(min, open * crash[0]);
  const points: Micros[] = [];
  let price = open;
  let drift = 0;
  for (let second = 0; second < seconds; second++) {
    points.push(Math.max(min, Math.min(max, floorToCents(Math.round(price)))));
    drift += 0.006 * gaussian(rng) - 0.02 * drift;
    const wanted = Math.min(max, open * curve(second / seconds) * Math.exp(drift));
    const jump = rng() < 0.012 ? (rng() < 0.5 ? -1 : 1) * (0.03 + rng() * 0.09) : 0;
    price *= Math.exp(PULL * Math.log(wanted / price) + NOISE * gaussian(rng) + jump);
    // Bounces off the limits, so it never sits flat against them.
    if (price < floor) price = floor * (1 + rng() * 0.04);
    if (price > max) price = max * (1 - rng() * 0.04);
  }
  return points;
}

export function pathIndex(opensAtMs: number, atMs: number, length: number): number {
  return Math.max(0, Math.min(length - 1, Math.floor((atMs - opensAtMs) / 1000)));
}

export function priceAt(path: readonly Micros[], opensAtMs: number, atMs: number): Micros {
  return path[pathIndex(opensAtMs, atMs, path.length)]!;
}

/** Seconds between the points of a small chart. */
export const SERIES_STEP = 5;

/** One price every few seconds, so each point keeps a fixed place on a small chart's time axis. */
export function sampleSeries(points: readonly number[], step = SERIES_STEP): number[] {
  return points.filter((_, i) => i % step === 0);
}
