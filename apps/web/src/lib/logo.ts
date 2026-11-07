/**
 * The Tenner mark as pixels, the one source for the navbar, sign-in, the PnL card and the favicon.
 * An italic T speeding forward, with a spark for a perfect 10. Each entry is [x, y, width, height, tone].
 */
export type Tone = "bone" | "volt" | "cherry" | "teal" | "ink";
export type Pixels = Array<[x: number, y: number, w: number, h: number, tone: Tone]>;

export const MARK_WIDTH = 25;
export const MARK_HEIGHT = 17;

export const MARK: Pixels = [
  // Speed lines trailing the T. The red one is the longest and thickest.
  [3, 4, 5, 1, "volt"],
  [0, 6, 8, 1, "volt"],
  [1, 8, 10, 2, "cherry"],
  [2, 11, 8, 1, "volt"],
  // The T, leaning forward one pixel every three rows.
  [9, 4, 11, 3, "bone"],
  [12, 7, 5, 3, "bone"],
  [11, 10, 5, 3, "bone"],
  [10, 13, 5, 3, "bone"],
  // The spark: a perfect 10.
  [22, 0, 1, 7, "volt"],
  [20, 3, 5, 1, "volt"],
  [21, 2, 3, 3, "volt"],
  // A small teal glint.
  [6, 14, 1, 3, "teal"],
  [5, 15, 3, 1, "teal"],
];

/** For 16px browser tabs, where four thin lines turn to mush: the T, one line each and the spark. */
export const FAVICON_SIZE = 16;
export const FAVICON: Pixels = [
  [1, 0, 14, 16, "ink"],
  [0, 1, 16, 14, "ink"],
  [1, 6, 4, 2, "cherry"],
  [2, 9, 3, 1, "volt"],
  [4, 3, 9, 2, "bone"],
  [7, 5, 4, 3, "bone"],
  [6, 8, 4, 3, "bone"],
  [5, 11, 4, 2, "bone"],
  [14, 0, 1, 4, "volt"],
  [13, 1, 3, 2, "volt"],
];

/** The dark theme's colors, for places with no CSS variables: the canvas PnL card and the favicon file. */
export const TONE_HEX: Record<Tone, string> = {
  bone: "#f7f5f0",
  volt: "#ffcc33",
  cherry: "#f03e45",
  teal: "#2fd4a7",
  ink: "#0a0c12",
};
