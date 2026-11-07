/**
 * Collector Crypt's images come far bigger than they're shown: a 52px thumbnail was pulling a
 * 170 KB photo, and a machine tile up to 3.4 MB. Next resizes the ones from their two hosts to the
 * size on screen. Other hosts load as is.
 */
const RESIZABLE = new Set(["d1xpxki1g4htqu.cloudfront.net", "degwuxynwtb2zaso.public.blob.vercel-storage.com"]);

/** Must match images.imageSizes and images.deviceSizes in next.config.mjs. */
const WIDTHS = [64, 96, 128, 256, 384, 640, 828];

export function sized(src: string | null | undefined, shown: number): string | undefined {
  if (!src) return undefined;
  let host = "";
  try {
    host = new URL(src).host;
  } catch {
    return src;
  }
  if (!RESIZABLE.has(host)) return src;
  // Twice the shown size, so it stays sharp on high-density screens.
  const width = WIDTHS.find((w) => w >= shown * 2) ?? WIDTHS[WIDTHS.length - 1]!;
  return `/_next/image?url=${encodeURIComponent(src)}&w=${width}&q=75`;
}
