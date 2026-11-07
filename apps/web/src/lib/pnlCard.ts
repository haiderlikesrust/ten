import { BRAND, formatUsd } from "@gemdex/core";
import { MARK, MARK_HEIGHT, MARK_WIDTH, TONE_HEX } from "./logo";
import type { HistoryPoint } from "./portfolio";

export interface PnlCardData {
  handle: string;
  value: number;
  unrealized: number;
  realized: number;
  invested: number;
  cards: number;
  history: HistoryPoint[];
}

/** The size of the art in /public/pnl-profit.webp and /public/pnl-loss.webp. */
export const PNL_WIDTH = 1012;
export const PNL_HEIGHT = 1082;

type Box = { x: number; y: number; w: number; h: number };

/** The inside edges of the art's boxes, measured from their borders. */
const BOX: Record<"brand" | "profit" | "chart" | "stats" | "owner", Box> = {
  brand: { x: 114, y: 128, w: 330, h: 178 },
  profit: { x: 114, y: 408, w: 330, h: 222 },
  chart: { x: 532, y: 408, w: 370, h: 222 },
  stats: { x: 114, y: 718, w: 788, h: 94 },
  owner: { x: 114, y: 880, w: 330, h: 88 },
};
/** The boxes' own fill, used to paint over the sample chart drawn into the art. */
const BOX_FILL = "#11141c";

const LINE = "#343b4a";
const BONE = "#f7f5f0";
const MUTE = "#b4bbc8";
const FAINT = "#8a92a3";
const UP = "#2fd4a7";
const DOWN = "#ff6b72";

const signed = (micros: number) => `${micros >= 0 ? "+" : "-"}${formatUsd(Math.abs(micros))}`;

const art = new Map<string, Promise<HTMLImageElement>>();
function loadArt(src: string): Promise<HTMLImageElement> {
  if (!art.has(src)) {
    art.set(src, new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error(`Could not load ${src}`));
      image.src = src;
    }));
  }
  return art.get(src)!;
}

/** Sets the largest font up to `size` that keeps `text` inside `width`. */
function fit(c: CanvasRenderingContext2D, text: string, font: (size: number) => string, size: number, width: number) {
  let current = size;
  c.font = font(current);
  while (current > 10 && c.measureText(text).width > width) {
    current -= 2;
    c.font = font(current);
  }
}

function drawLogo(c: CanvasRenderingContext2D, x: number, y: number, unit: number) {
  for (const [bx, by, w, h, tone] of MARK) {
    c.fillStyle = TONE_HEX[tone];
    c.fillRect(x + bx * unit, y + by * unit, w * unit, h * unit);
  }
}

/** Profit over time in stepped lines, since it only moves when a card is bought or sold. */
function drawHistory(c: CanvasRenderingContext2D, history: HistoryPoint[], box: Box, color: string, font: string) {
  const pad = 26;
  const x = box.x + pad;
  const y = box.y + pad + 14;
  const w = box.w - pad * 2;
  const h = box.h - pad * 2 - 14;
  c.fillStyle = FAINT;
  c.font = `13px ${font}`;
  c.textBaseline = "alphabetic";
  c.fillText("PROFIT OVER TIME", box.x + pad, box.y + pad + 4);
  if (history.length < 2) {
    c.textAlign = "center";
    c.fillText("STARTS WITH YOUR FIRST CARD", box.x + box.w / 2, box.y + box.h / 2 + 10);
    c.textAlign = "left";
    return;
  }
  const first = history[0]!.time;
  const span = Math.max(1, history[history.length - 1]!.time - first);
  const values = history.map((point) => point.pnl);
  const high = Math.max(0, ...values);
  const low = Math.min(0, ...values);
  const range = Math.max(1, high - low);
  const px = (time: number) => x + ((time - first) / span) * w;
  const py = (value: number) => y + h - ((value - low) / range) * h;

  c.strokeStyle = LINE;
  c.lineWidth = 2;
  c.setLineDash([6, 6]);
  c.beginPath();
  c.moveTo(x, py(0));
  c.lineTo(x + w, py(0));
  c.stroke();
  c.setLineDash([]);

  c.beginPath();
  c.moveTo(px(history[0]!.time), py(history[0]!.pnl));
  for (let i = 1; i < history.length; i++) {
    c.lineTo(px(history[i]!.time), py(history[i - 1]!.pnl));
    c.lineTo(px(history[i]!.time), py(history[i]!.pnl));
  }
  c.strokeStyle = color;
  c.lineWidth = 4;
  c.lineJoin = "miter";
  c.stroke();
}

/**
 * The share card: the art for a win or a loss, with everything real drawn on top of it. The art
 * holds the frame and decoration. The numbers, the chart, the name and the date are always live.
 */
export async function drawPnlCard(data: PnlCardData): Promise<HTMLCanvasElement> {
  const total = data.unrealized + data.realized;
  const won = total >= 0;
  const [base] = await Promise.all([loadArt(won ? "/pnl-profit.webp" : "/pnl-loss.webp"), document.fonts.ready]);

  const canvas = document.createElement("canvas");
  canvas.width = PNL_WIDTH;
  canvas.height = PNL_HEIGHT;
  const c = canvas.getContext("2d")!;
  c.imageSmoothingEnabled = false;
  const css = getComputedStyle(document.body);
  const pixel = `${css.getPropertyValue("--font-silkscreen").trim() || "monospace"}, monospace`;
  const mono = `${css.getPropertyValue("--font-geist-mono").trim() || "monospace"}, monospace`;
  const sans = `${css.getPropertyValue("--font-figtree").trim() || "sans-serif"}, sans-serif`;
  const color = won ? UP : DOWN;

  c.drawImage(base, 0, 0, PNL_WIDTH, PNL_HEIGHT);
  c.fillStyle = BOX_FILL;
  c.fillRect(BOX.chart.x, BOX.chart.y, BOX.chart.w, BOX.chart.h);

  // Brand: the mark and the name.
  const unit = 4;
  const { brand } = BOX;
  const markX = brand.x + 26;
  drawLogo(c, markX, brand.y + (brand.h - MARK_HEIGHT * unit) / 2, unit);
  c.fillStyle = BONE;
  c.textBaseline = "middle";
  const nameX = markX + MARK_WIDTH * unit + 18;
  fit(c, BRAND.name.toUpperCase(), (size) => `${size}px ${pixel}`, 34, brand.x + brand.w - 22 - nameX);
  c.fillText(BRAND.name.toUpperCase(), nameX, brand.y + brand.h / 2 + 2);

  // Profit: the headline number.
  const { profit } = BOX;
  c.textBaseline = "alphabetic";
  c.fillStyle = FAINT;
  c.font = `18px ${pixel}`;
  c.fillText(won ? "TOTAL PROFIT" : "TOTAL LOSS", profit.x + 24, profit.y + 46);
  c.fillStyle = color;
  fit(c, signed(total), (size) => `600 ${size}px ${mono}`, 78, profit.w - 48);
  c.fillText(signed(total), profit.x + 22, profit.y + 140);
  if (data.invested > 0) {
    const pct = (total / data.invested) * 100;
    const line = `${pct >= 0 ? "+" : ""}${pct.toFixed(1)}% on ${formatUsd(data.invested)} spent`;
    c.fillStyle = MUTE;
    fit(c, line, (size) => `500 ${size}px ${mono}`, 20, profit.w - 48);
    c.fillText(line, profit.x + 24, profit.y + profit.h - 30);
  }

  drawHistory(c, data.history, BOX.chart, color, pixel);

  // Stats: four columns across the bar.
  const { stats } = BOX;
  const columns: Array<[string, string, string]> = [
    ["COLLECTION", formatUsd(data.value), BONE],
    ["UNREALIZED", signed(data.unrealized), data.unrealized >= 0 ? UP : DOWN],
    ["REALIZED", signed(data.realized), data.realized >= 0 ? UP : DOWN],
    ["CARDS", String(data.cards), BONE],
  ];
  const column = (stats.w - 48) / columns.length;
  columns.forEach(([label, value, tone], i) => {
    const x = stats.x + 24 + i * column;
    c.fillStyle = FAINT;
    c.font = `14px ${pixel}`;
    c.fillText(label, x, stats.y + 36);
    c.fillStyle = tone;
    fit(c, value, (size) => `600 ${size}px ${mono}`, 30, column - 16);
    c.fillText(value, x, stats.y + 74);
  });

  // Owner: who and when, and what the values are based on.
  const { owner } = BOX;
  c.fillStyle = BONE;
  fit(c, `@${data.handle}`, (size) => `600 ${size}px ${sans}`, 26, owner.w - 48);
  c.fillText(`@${data.handle}`, owner.x + 24, owner.y + 40);
  c.fillStyle = FAINT;
  const note = `${new Date().toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })} · at insured value`;
  fit(c, note, (size) => `${size}px ${sans}`, 16, owner.w - 48);
  c.fillText(note, owner.x + 24, owner.y + 68);
  return canvas;
}
