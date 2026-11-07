"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { baseChartOptions, chartColors, formatPrice, withAlpha } from "@/lib/chart";
import { onPriceTick, type PulseCard } from "@/lib/pulse";
import { useUi } from "@/lib/ui";
import { Segmented } from "./bits";

interface Bar {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

const FRAMES = [1, 5, 15, 30];
/** A price change eases in over this long. Shorter than a tick, so it never falls behind. */
const GLIDE_MS = 650;

function toBars(points: Map<number, number>, frame: number): Bar[] {
  const bars: Bar[] = [];
  let last: number | null = null;
  for (const [second, price] of [...points.entries()].sort((a, b) => a[0] - b[0])) {
    const time = Math.floor(second / frame) * frame;
    const bar = bars[bars.length - 1];
    if (bar && bar.time === time) {
      bar.high = Math.max(bar.high, price);
      bar.low = Math.min(bar.low, price);
      bar.close = price;
    } else {
      const open = last ?? price;
      bars.push({ time, open, high: Math.max(open, price), low: Math.min(open, price), close: price });
    }
    last = price;
  }
  return bars;
}

/**
 * Keeps the price axis still. It opens with room around the first price and widens in a few big
 * steps when a price reaches the edge, so a crash doesn't rescale the candles on every new low.
 */
function createBand(open: number) {
  let target: { min: number; max: number } | null = null;
  let shown: { min: number; max: number } | null = null;
  return {
    fit(low: number, high: number) {
      if (!target) {
        target = { min: Math.min(low, open * 0.75), max: Math.max(high, open * 1.5) };
        shown = { ...target };
      }
      const span = target.max - target.min;
      if (low < target.min + span * 0.03) target = { ...target, min: Math.max(0, low - span * 0.4) };
      if (high > target.max - span * 0.03) target = { ...target, max: high + span * 0.4 };
    },
    step(): boolean {
      if (!target || !shown) return false;
      const gap = Math.abs(target.min - shown.min) + Math.abs(target.max - shown.max);
      if (gap < 0.005) {
        shown = { ...target };
        return false;
      }
      shown = { min: shown.min + (target.min - shown.min) * 0.14, max: shown.max + (target.max - shown.max) * 0.14 };
      return true;
    },
    range: () => shown,
  };
}

function Legend({ bar, first }: { bar: Bar | null; first: number }) {
  if (!bar) return null;
  const color = bar.close >= bar.open ? "text-teal" : "text-loss";
  const change = first > 0 ? (bar.close / first - 1) * 100 : 0;
  const item = (label: string, value: string) => (
    <span className="whitespace-nowrap"><span className="text-faint">{label}</span> <span className={color}>{value}</span></span>
  );
  return (
    <div className="num pointer-events-none absolute left-3 top-1.5 z-10 flex max-w-[calc(100%-72px)] flex-wrap items-center gap-x-2.5 gap-y-0.5 text-[12px] font-medium">
      {item("O", formatPrice(bar.open))}
      {item("H", formatPrice(bar.high))}
      {item("L", formatPrice(bar.low))}
      {item("C", formatPrice(bar.close))}
      <span className={`whitespace-nowrap ${change >= 0 ? "text-teal" : "text-loss"}`}>{change >= 0 ? "+" : ""}{change.toFixed(1)}%</span>
    </div>
  );
}

interface Handle {
  merge: (rows: Array<[number, number]>) => void;
  setLimit: (price: number | null) => void;
}

export function MarketChart({ card, prices, limit, moveSec, status }: { card: PulseCard; prices: number[]; limit: number | null; moveSec: number; status?: ReactNode }) {
  const box = useRef<HTMLDivElement>(null);
  const zone = useRef<HTMLDivElement>(null);
  const lockLine = useRef<HTMLDivElement>(null);
  const handle = useRef<Handle | null>(null);
  const [frame, setFrame] = useState(5);
  const [hovered, setHovered] = useState<Bar | null>(null);
  const [latest, setLatest] = useState<Bar | null>(null);
  const theme = useUi((s) => s.theme);
  const opens = new Date(card.opensAt).getTime();
  const start = Math.floor(opens / 1000);
  const stopped = !!card.stoppedAt;
  const boughtPrice = card.boughtBy ? card.price : null;
  // Every price seen so far, kept across timeframe and theme changes.
  const known = useRef(new Map<number, number>());

  const toPoints = (rows: number[]): Array<[number, number]> => rows.map((micros, i) => [start + i, micros / 1e6]);
  const seed = useRef({ prices, limit });
  seed.current = { prices, limit };

  useEffect(() => {
    if (!box.current) return;
    let removed = false;
    let cleanup = () => {};

    void import("lightweight-charts").then(({ createChart, CrosshairMode, LineStyle }) => {
      if (removed || !box.current) return;
      const colors = chartColors();
      const base = baseChartOptions(colors, true);
      const calm = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      // The axis already covers the card's whole life, so there is nothing to pan or zoom to.
      const chart = createChart(box.current, {
        ...base,
        handleScroll: false,
        handleScale: false,
        grid: { vertLines: { visible: false }, horzLines: { color: withAlpha(colors.line, 0.5) } },
        rightPriceScale: { borderVisible: false, scaleMargins: { top: 0.06, bottom: 0.04 } },
        crosshair: { ...base.crosshair, mode: CrosshairMode.Normal },
        timeScale: { ...base.timeScale, borderVisible: false, shiftVisibleRangeOnNewBar: false, lockVisibleTimeRangeOnResize: true },
      } as never);

      const band = createBand(card.openPrice / 1e6);
      const candles = chart.addCandlestickSeries({
        upColor: colors.up, downColor: colors.down, wickUpColor: colors.up, wickDownColor: colors.down, borderVisible: false,
        priceFormat: { type: "custom", formatter: formatPrice, minMove: 0.01 },
        autoscaleInfoProvider: (original: () => unknown) => {
          const range = band.range();
          return range ? { priceRange: { minValue: range.min, maxValue: range.max } } : original();
        },
      } as never);

      if (card.insuredValue) candles.createPriceLine({ price: card.insuredValue / 1e6, color: colors.gold, lineStyle: LineStyle.Dashed, lineWidth: 1, axisLabelVisible: true, title: "Insured" });
      if (boughtPrice) {
        candles.applyOptions({ lastValueVisible: false, priceLineVisible: false });
        candles.createPriceLine({ price: boughtPrice / 1e6, color: colors.bone, lineStyle: LineStyle.Solid, lineWidth: 1, axisLabelVisible: true, title: "Bought" });
      }

      const points = known.current;
      let bars: Bar[] = [];
      let byTime = new Map<number, Bar>();
      let glide: { from: number; to: number; start: number } | null = null;
      let raf = 0;

      const settle = (bar: Bar, price: number) => {
        bar.close = price;
        bar.high = Math.max(bar.high, price);
        bar.low = Math.min(bar.low, price);
      };

      const lockAxis = () => {
        // A running chart spans the card's full time, and candles fill it from left to right.
        const whole = Math.ceil(moveSec / frame) + 2;
        chart.timeScale().setVisibleLogicalRange({ from: -0.5, to: stopped ? Math.max(bars.length + 1.5, 24) : whole });
      };

      // The rest of the card's life: a hatched stretch from now to the lock, and the lock itself.
      // An empty right side then reads as time left, not as a broken chart.
      const place = () => {
        const shade = zone.current;
        const line = lockLine.current;
        const first = bars[0];
        if (!shade || !line) return;
        if (stopped || !first) {
          shade.style.display = "none";
          line.style.display = "none";
          return;
        }
        const scale = chart.timeScale();
        // The visible range is pinned by lockAxis, so a position is just a share of the pane's width.
        const range = scale.getVisibleLogicalRange();
        const width = scale.width();
        if (!range || width <= 0 || range.to <= range.from) return;
        const x = (logical: number) => ((logical - range.from) / (range.to - range.from)) * width;
        const lockAt = (start + moveSec - first.time) / frame;
        const nowAt = Math.max(bars.length - 0.5, (Date.now() / 1000 - first.time) / frame);
        const right = x(lockAt);
        const left = x(Math.min(nowAt, lockAt));
        const bottom = `${scale.height()}px`;
        shade.style.display = right - left > 4 ? "block" : "none";
        shade.style.left = `${left}px`;
        shade.style.width = `${Math.max(0, right - left)}px`;
        shade.style.bottom = bottom;
        line.style.display = "block";
        line.style.left = `${right}px`;
        line.style.bottom = bottom;
      };

      const redraw = () => {
        bars = toBars(points, frame);
        byTime = new Map(bars.map((bar) => [bar.time, bar]));
        const prices = bars.flatMap((bar) => [bar.high, bar.low]);
        if (prices.length) {
          const reference = card.insuredValue ? card.insuredValue / 1e6 : null;
          const low = Math.min(...prices);
          const high = Math.max(...prices);
          // Only pulls the insured line into view when that keeps the candles readable.
          const near = reference !== null && reference > low * 0.6 && reference < high * 1.6;
          band.fit(near ? Math.min(low, reference) : low, near ? Math.max(high, reference) : high);
        }
        candles.setData(bars as never);
        lockAxis();
        place();
        const last = bars[bars.length - 1];
        setLatest(last ? { ...last } : null);
        if (boughtPrice && last) candles.setMarkers([{ time: last.time, position: "aboveBar", color: colors.gold, shape: "circle", text: "Bought" }] as never);
      };

      const loop = (now: number) => {
        raf = 0;
        const bar = bars[bars.length - 1];
        if (glide && bar) {
          const t = Math.min(1, (now - glide.start) / GLIDE_MS);
          const eased = 1 - (1 - t) ** 3;
          settle(bar, glide.from + (glide.to - glide.from) * eased);
          if (t === 1) glide = null;
        }
        const widening = band.step();
        if (bar) candles.update(bar as never);
        if (glide || widening) raf = requestAnimationFrame(loop);
      };

      const merge = (incoming: Array<[number, number]>) => {
        let changed = false;
        for (const [second, price] of incoming) {
          if (points.get(second) !== price) {
            points.set(second, price);
            changed = true;
          }
        }
        if (changed) redraw();
      };

      const tick = (second: number, price: number) => {
        const previous = bars[bars.length - 1];
        const time = Math.floor(second / frame) * frame;
        if (!previous || time < previous.time) return merge([[second, price]]);
        points.set(second, price);
        if (glide) {
          settle(previous, glide.to);
          glide = null;
        }
        if (time > previous.time) {
          const open = previous.close;
          const bar = { time, open, high: open, low: open, close: open };
          bars.push(bar);
          byTime.set(time, bar);
        }
        const bar = bars[bars.length - 1]!;
        band.fit(Math.min(bar.low, price), Math.max(bar.high, price));
        place();
        setLatest({ ...bar, high: Math.max(bar.high, price), low: Math.min(bar.low, price), close: price });
        if (calm || document.hidden) {
          settle(bar, price);
          candles.update(bar as never);
          return;
        }
        glide = { from: bar.close, to: price, start: performance.now() };
        if (!raf) raf = requestAnimationFrame(loop);
      };

      let line: ReturnType<typeof candles.createPriceLine> | null = null;
      const setLimit = (price: number | null) => {
        if (line) candles.removePriceLine(line);
        line = price ? candles.createPriceLine({ price: price / 1e6, color: colors.up, lineStyle: LineStyle.Dotted, lineWidth: 1, axisLabelVisible: true, title: "Auto-buy" }) : null;
      };

      chart.subscribeCrosshairMove((param) => setHovered(typeof param.time === "number" ? byTime.get(param.time) ?? null : null));
      chart.timeScale().subscribeVisibleLogicalRangeChange(place);
      chart.timeScale().subscribeSizeChange(place);

      for (const [second, price] of toPoints(seed.current.prices)) points.set(second, price);
      redraw();
      setLimit(seed.current.limit);
      handle.current = { merge, setLimit };

      // Once a card is bought its chart stops, so later ticks are ignored.
      const stop = stopped
        ? () => {}
        : onPriceTick((items, at) => {
            const item = items.find((i) => i.id === card.id);
            // Seconds count from the moment the card opened, the same way the server does.
            if (item) tick(start + Math.floor((new Date(at).getTime() - opens) / 1000), item.p / 1e6);
          });

      cleanup = () => {
        stop();
        if (raf) cancelAnimationFrame(raf);
        handle.current = null;
        chart.remove();
      };
    });

    return () => {
      removed = true;
      cleanup();
    };
  }, [boughtPrice, card.id, card.insuredValue, frame, moveSec, opens, start, stopped, theme]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    handle.current?.merge(toPoints(prices));
  }, [prices]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    handle.current?.setLimit(limit);
  }, [limit]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 px-2.5 py-2">
        <Segmented
          label="Timeframe"
          value={String(frame)}
          onChange={(value) => setFrame(Number(value))}
          options={FRAMES.map((seconds) => ({ value: String(seconds), label: <span className="num">{seconds}s</span> }))}
        />
        <div className="flex min-w-0 items-center gap-3 text-[12.5px] text-faint">
          {status}
          {card.insuredValue ? <span className="hidden items-center gap-1.5 sm:flex"><span className="h-0 w-3.5 border-t border-dashed border-gold" /> Insured</span> : null}
        </div>
      </div>
      <div className="relative min-h-0 flex-1">
        <Legend bar={hovered ?? latest} first={card.openPrice / 1e6} />
        <div ref={box} className="absolute inset-0" role="img" aria-label="Live candlestick price chart" />
        <div
          ref={zone}
          className="pointer-events-none absolute top-0 z-[1] hidden"
          style={{ backgroundImage: "repeating-linear-gradient(135deg, color-mix(in srgb, var(--bone) 5%, transparent) 0 6px, transparent 6px 12px)" }}
          aria-hidden="true"
        >
          <span className="pixel absolute bottom-2 left-2 whitespace-nowrap text-[10px] uppercase leading-none text-faint">Time left</span>
        </div>
        <div ref={lockLine} className="pointer-events-none absolute top-0 z-[1] hidden border-l border-dashed border-gold/70" aria-hidden="true">
          <span className="pixel absolute bottom-2 right-1.5 whitespace-nowrap text-[10px] uppercase leading-none text-gold">Lock</span>
        </div>
      </div>
    </div>
  );
}
