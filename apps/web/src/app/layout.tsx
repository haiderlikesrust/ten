import { BRAND } from "@gemdex/core";
import type { Metadata, Viewport } from "next";
import { Figtree, Geist_Mono, Silkscreen } from "next/font/google";
import type { ReactNode } from "react";
import { Shell } from "@/components/Shell";
import "./globals.css";
import { Providers } from "./providers";

const silkscreen = Silkscreen({ weight: ["400", "700"], subsets: ["latin"], variable: "--font-silkscreen", display: "swap" });
const figtree = Figtree({ subsets: ["latin"], variable: "--font-figtree", display: "swap" });
const geistMono = Geist_Mono({ subsets: ["latin"], variable: "--font-geist-mono", display: "swap" });

export const metadata: Metadata = {
  title: `${BRAND.name} | ${BRAND.tagline}`,
  description: "Trade tokenized graded cards, open packs, and buy live-priced cards on Pulse, funded by token creator fees.",
};

export const viewport: Viewport = {
  themeColor: "#0a0c12",
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${silkscreen.variable} ${figtree.variable} ${geistMono.variable}`}>
      <body>
        <Providers>
          <Shell>{children}</Shell>
        </Providers>
      </body>
    </html>
  );
}
