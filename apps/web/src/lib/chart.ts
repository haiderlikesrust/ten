/** One look for every chart, read from the live theme so light and dark both work. */
export function chartColors() {
  const css = getComputedStyle(document.documentElement);
  const read = (name: string) => css.getPropertyValue(name).trim();
  return {
    text: read("--faint"), line: read("--line"), lineStrong: read("--line-strong"), raised: read("--raised-2"), bone: read("--bone"),
    up: read("--teal"), down: read("--loss"), gold: read("--gold"), rare: read("--r-rare"), epic: read("--r-epic"),
  };
}

/** Whole dollars drop the cents, so an axis reads $150, not $150.00. */
export const formatPrice = (value: number): string =>
  value >= 1000 || Math.abs(value - Math.round(value)) < 0.005 ? `$${Math.round(value).toLocaleString("en-US")}` : `$${value.toFixed(2)}`;

export function withAlpha(hex: string, alpha: number): string {
  const part = Math.round(alpha * 255).toString(16).padStart(2, "0");
  return `${hex}${part}`;
}

const pad = (n: number) => String(n).padStart(2, "0");

/** The library works in UTC. Traders read their own clock. */
export function localTime(unixSeconds: number, seconds = true): string {
  const d = new Date(unixSeconds * 1000);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}${seconds ? `:${pad(d.getSeconds())}` : ""}`;
}

export function baseChartOptions(colors: ReturnType<typeof chartColors>, seconds: boolean) {
  return {
    autoSize: true,
    layout: {
      // The credit sits in the status bar and on the terms page, so it does not cover the data.
      attributionLogo: false,
      background: { color: "transparent" },
      textColor: colors.text,
      fontFamily: "var(--font-geist-mono), monospace",
      fontSize: 11,
    },
    grid: {
      vertLines: { color: withAlpha(colors.line, 0.55) },
      horzLines: { color: withAlpha(colors.line, 0.55) },
    },
    crosshair: {
      vertLine: { color: colors.lineStrong, labelBackgroundColor: colors.raised },
      horzLine: { color: colors.lineStrong, labelBackgroundColor: colors.raised },
    },
    rightPriceScale: { borderColor: colors.line },
    timeScale: {
      borderColor: colors.line,
      timeVisible: true,
      secondsVisible: seconds,
      tickMarkFormatter: (time: number) => localTime(time, seconds),
    },
    localization: { timeFormatter: (time: number) => localTime(time), priceFormatter: formatPrice },
  };
}
