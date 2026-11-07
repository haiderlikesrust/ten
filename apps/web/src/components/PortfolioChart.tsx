"use client";

import { useEffect, useRef } from "react";
import { baseChartOptions, chartColors, formatPrice, withAlpha } from "@/lib/chart";
import { evenly, type HistoryPoint } from "@/lib/portfolio";
import { useUi } from "@/lib/ui";

/**
 * Value is one neutral line. Profit sits on a baseline at zero, so above and below read
 * at once. Steps, because values only change when a card is bought or sold.
 */
export function PortfolioChart({ points, mode, onHover }: { points: HistoryPoint[]; mode: "value" | "pnl"; onHover: (point: HistoryPoint | null) => void }) {
  const box = useRef<HTMLDivElement>(null);
  const theme = useUi((s) => s.theme);
  const hover = useRef(onHover);
  hover.current = onHover;

  useEffect(() => {
    if (!box.current || points.length < 2) return;
    let removed = false;
    let cleanup = () => {};

    void import("lightweight-charts").then(({ createChart, LineType }) => {
      if (removed || !box.current) return;
      const colors = chartColors();
      const base = baseChartOptions(colors, false);
      const chart = createChart(box.current, {
        ...base,
        handleScroll: false,
        handleScale: false,
        grid: { vertLines: { visible: false }, horzLines: { color: withAlpha(colors.line, 0.5) } },
        rightPriceScale: { borderVisible: false, scaleMargins: { top: 0.1, bottom: 0.02 } },
        timeScale: { ...base.timeScale, borderVisible: false, fixLeftEdge: true, fixRightEdge: true },
      } as never);

      const shared = { lineWidth: 2 as const, lineType: LineType.WithSteps, priceLineVisible: false, lastValueVisible: false, priceFormat: { type: "custom" as const, formatter: formatPrice, minMove: 0.01 } };
      const even = evenly(points);
      const highest = Math.max(...even.map((point) => point.worth)) / 1e6;
      const series = mode === "value"
        ? chart.addAreaSeries({
            ...shared,
            lineColor: colors.bone, topColor: withAlpha(colors.bone, 0.1), bottomColor: withAlpha(colors.bone, 0),
            // Value starts from zero, so a small change never looks like a big one.
            autoscaleInfoProvider: () => ({ priceRange: { minValue: 0, maxValue: highest || 1 } }),
          })
        : chart.addBaselineSeries({
            ...shared,
            baseValue: { type: "price", price: 0 },
            topLineColor: colors.up, topFillColor1: withAlpha(colors.up, 0.16), topFillColor2: withAlpha(colors.up, 0.02),
            bottomLineColor: colors.down, bottomFillColor1: withAlpha(colors.down, 0.02), bottomFillColor2: withAlpha(colors.down, 0.16),
          });
      series.setData(even.map((point) => ({ time: point.time, value: (mode === "value" ? point.worth : point.pnl) / 1e6 })) as never);
      chart.timeScale().fitContent();

      const byTime = new Map(even.map((point) => [point.time, point]));
      chart.subscribeCrosshairMove((param) => hover.current(typeof param.time === "number" ? byTime.get(param.time) ?? null : null));
      cleanup = () => chart.remove();
    });

    return () => {
      removed = true;
      cleanup();
    };
  }, [mode, points, theme]);

  return <div ref={box} className="absolute inset-0" role="img" aria-label={mode === "value" ? "Net worth over time" : "Total profit over time"} />;
}
