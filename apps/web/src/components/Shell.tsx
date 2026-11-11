"use client";

import { BRAND } from "@gemdex/core";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Bot, Compass, FileText, Gift, Landmark, LayoutGrid, LogOut, Moon, Radar, Settings2, Sun, Wallet, type LucideIcon } from "lucide-react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api } from "@/lib/api";
import { useBuySize } from "@/lib/buySize";
import { clock, compactUsd, money, pauseReason } from "@/lib/format";
import { connectStream, resyncLive, useLive } from "@/lib/live";
import { phaseOf, usePulse, usePulseFeed } from "@/lib/pulse";
import { signOut, useMe, useMeta, useTrade, useUserEvents } from "@/lib/session";
import { serverNow, useNow, useUi } from "@/lib/ui";
import { Logo, Sheet } from "./bits";
import { PixelIcon, type PixelName } from "./pixel";
import { CommandPalette, ConnectModal, RevealModal, Toasts } from "./overlays";
import { Tour } from "./Tour";
import { AccessBanner } from "./AccessBanner";
import { GiftBanner } from "./GiftBanner";

/** Only loaded when real sign-in is configured, so paper mode never ships wallet code. */
const WalletBridge = process.env.NEXT_PUBLIC_PRIVY_APP_ID ? dynamic(() => import("./WalletBridge"), { ssr: false }) : () => null;

interface NavItem {
  href: string;
  label: string;
  icon: PixelName;
  phone?: boolean;
}

const NAV: NavItem[] = [
  { href: "/", label: "Pulse", icon: "pulse", phone: true },
  { href: "/scanner", label: "Scanner", icon: "scanner", phone: true },
  { href: "/market", label: "Market", icon: "market", phone: true },
  { href: "/gacha", label: "Gacha", icon: "pack" },
  { href: "/portfolio", label: "Portfolio", icon: "slab", phone: true },
  { href: "/tracker", label: "Tracker", icon: "eye" },
  { href: "/rewards", label: "Rewards", icon: "star" },
];

const PHONE_TABS = NAV.filter((item) => item.phone);

const useIsActive = () => {
  const pathname = usePathname();
  return (href: string) => (href === "/" ? pathname === "/" : pathname.startsWith(href));
};

function useLiveCount() {
  const newPullSec = usePulse((s) => s.newPullSec);
  return usePulse((s) => {
    const now = serverNow();
    return Object.values(s.cards).filter((card) => phaseOf(card, now, newPullSec) !== "final").length;
  });
}

/** Closes on an outside click or Escape. */
function usePopover() {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      if (!box.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && setOpen(false);
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);
  return { open, setOpen, box };
}

const menuItem = "flex h-9 min-h-11 w-full items-center gap-2.5 px-cut px-2.5 text-left text-[14px] font-medium text-mute transition-colors hover:bg-bone/[0.07] hover:text-bone sm:min-h-0";

/**
 * The page menu, built like a handheld game's. A cursor marks the current page and hops to
 * whatever you point at. There is room for every label on wide screens. On narrower ones every
 * page keeps its icon and only the current page shows its name, so nothing moves into a dropdown.
 */
function Dock() {
  const pathname = usePathname();
  const isActive = useIsActive();
  const count = useLiveCount();
  const bar = useRef<HTMLElement>(null);
  const cursor = useRef<HTMLSpanElement>(null);

  const pointAt = (target: HTMLElement | null | undefined) => {
    const mark = cursor.current;
    if (!mark) return;
    mark.style.opacity = target ? "1" : "0";
    if (target) mark.style.transform = `translateX(${target.offsetLeft + 7}px)`;
  };
  const goHome = () => pointAt(bar.current?.querySelector<HTMLElement>("[data-active]"));

  useEffect(() => {
    goHome();
    const nav = bar.current;
    if (!nav) return;
    const observer = new ResizeObserver(goHome);
    observer.observe(nav);
    return () => observer.disconnect();
  }, [pathname]);

  return (
    <nav ref={bar} aria-label="Main" onMouseLeave={goHome} className="px-box relative hidden h-[46px] min-w-0 items-center px-[5px] sm:flex">
      <span ref={cursor} aria-hidden="true" className="dock-cursor pointer-events-none absolute left-0 top-1/2 z-10 -mt-[8px] text-gold opacity-0"><PixelIcon name="cursor" /></span>
      {NAV.map((item) => {
        const active = isActive(item.href);
        const live = item.href === "/" && count > 0;
        return (
          <Link
            key={item.href}
            href={item.href}
            title={item.label}
            aria-label={item.label}
            data-active={active || undefined}
            aria-current={active ? "page" : undefined}
            onMouseEnter={(event) => pointAt(event.currentTarget)}
            onFocus={(event) => pointAt(event.currentTarget)}
            className={`flex h-9 shrink-0 items-center gap-1.5 whitespace-nowrap pl-[20px] pr-1.5 transition-colors lg:pr-2.5 ${active ? "px-box px-well text-gold" : "text-faint hover:text-bone"}`}
          >
            <PixelIcon name={item.icon} />
            <span className={`pixel text-[13px] uppercase leading-none ${active ? "hidden md:inline" : "hidden min-[1380px]:inline"}`}>{item.label}</span>
            {live ? <span className="pixel text-[12px] leading-none text-gold">{count}</span> : null}
          </Link>
        );
      })}
    </nav>
  );
}

function PhoneNav({ onMore }: { onMore: () => void }) {
  const isActive = useIsActive();
  const count = useLiveCount();
  const tab = "relative flex h-full min-w-0 flex-1 flex-col items-center justify-center gap-1";
  return (
    <div className="shrink-0 px-1.5 pb-[calc(env(safe-area-inset-bottom)+6px)] pt-1 sm:hidden">
      <nav aria-label="Main" className="px-box flex h-[58px] items-stretch p-[3px]">
        {PHONE_TABS.map((item) => {
          const active = isActive(item.href);
          return (
            <Link key={item.href} href={item.href} aria-current={active ? "page" : undefined} className={`${tab} ${active ? "px-box px-well text-gold" : "text-faint"}`}>
              <PixelIcon name={item.icon} />
              <span className="pixel max-w-full truncate text-[11px] uppercase leading-none">{item.label}</span>
              {item.href === "/" && count > 0 ? <span className="pixel absolute left-[calc(50%+10px)] top-1 text-[10px] leading-none text-gold">{count}</span> : null}
            </Link>
          );
        })}
        <button type="button" onClick={onMore} className={`${tab} text-faint`}>
          <PixelIcon name="menu" />
          <span className="pixel text-[11px] uppercase leading-none">More</span>
        </button>
      </nav>
    </div>
  );
}

function ModeBadge() {
  const meta = useMeta();
  const mode = meta.data?.mode;
  // A marker for the test modes (paper, devnet). Mainnet is the real site, so it shows nothing.
  if (!mode || mode === "mainnet") return null;
  return <span className={`pixel inline-flex h-[18px] shrink-0 items-center px-1 text-[10px] uppercase leading-none text-gold`} title={mode === "paper" ? "Simulated money, real market data" : mode}>{mode}</span>;
}

function ThemeButton({ wide }: { wide?: boolean }) {
  const theme = useUi((s) => s.theme);
  const setTheme = useUi((s) => s.setTheme);
  const next = theme === "dark" ? "light" : "dark";
  const Icon = theme === "dark" ? Sun : Moon;
  return (
    <button type="button" onClick={() => setTheme(next)} aria-label={`Switch to ${next} theme`} className={wide ? menuItem : "inline-flex items-center gap-1 hover:text-bone"}>
      <Icon size={wide ? 16 : 13} aria-hidden="true" /> {next === "light" ? "Light theme" : "Dark theme"}
    </button>
  );
}

function MenuLinks({ onClose }: { onClose: () => void }) {
  const me = useMe();
  const client = useQueryClient();
  const links: Array<[string, string, LucideIcon]> = [
    ["/wallet", "Trading wallet", Wallet],
    ["/portfolio", "Portfolio", LayoutGrid],
    ["/rewards", "Rewards", Gift],
  ];
  return (
    <>
      {links.map(([href, label, Icon]) => (
        <Link key={href} href={href} onClick={onClose} className={menuItem}><Icon size={16} aria-hidden="true" /> {label}</Link>
      ))}
      {me?.isAdmin ? <Link href="/admin" onClick={onClose} className={menuItem}><Settings2 size={16} aria-hidden="true" /> Admin</Link> : null}
      <ThemeButton wide />
      <button type="button" className={menuItem} onClick={() => { signOut(client); onClose(); }}>
        <LogOut size={16} aria-hidden="true" /> Sign out
      </button>
    </>
  );
}

function Avatar({ handle }: { handle: string }) {
  return (
    <span className="px-box flex h-8 w-8 shrink-0 items-center justify-center [--s:2px]">
      <span className="pixel text-[14px] uppercase leading-none text-bone">{handle.slice(0, 1)}</span>
    </span>
  );
}

/** Each block is $10 of buying power, so a full bar can afford the top price on Pulse. */
function WalletMeter({ available }: { available: number }) {
  const blocks = Math.min(10, Math.ceil(available / 10_000_000));
  const tone = blocks > 4 ? "bg-teal" : blocks > 2 ? "bg-volt" : "bg-loss";
  return (
    <Link href="/wallet" title={`${money(available)} available. Each block is $10 of buying power on Pulse.`} className="flex flex-col gap-[5px] px-1.5">
      <span className="num text-[14px] font-semibold leading-none">{money(available)}</span>
      <span className="flex gap-px" aria-hidden="true">
        {Array.from({ length: 10 }, (_, i) => <span key={i} className={`h-1 w-[6px] ${i < blocks ? tone : "bg-bone/10"}`} />)}
      </span>
    </Link>
  );
}

function AccountMenu() {
  const me = useMe();
  const { open, setOpen, box } = usePopover();
  const setConnectOpen = useUi((s) => s.setConnectOpen);

  if (!me) {
    return (
      <button type="button" onClick={() => setConnectOpen(true)} className="px-box mr-0.5 flex h-8 min-h-11 shrink-0 items-center px-3 text-[var(--on-volt)] transition hover:brightness-105 active:translate-y-px [--px-fill:var(--volt)] [--px-line:var(--volt)] [--s:2px] sm:min-h-0">
        <span className="pixel text-[13px] uppercase leading-none">Connect</span>
      </button>
    );
  }

  return (
    <div ref={box} className="relative flex shrink-0 items-center gap-1">
      <WalletMeter available={me.available} />
      <Link href="/wallet" title="Add funds" aria-label="Add funds" className="hidden h-8 w-8 items-center justify-center text-faint transition-colors hover:text-gold md:flex">
        <PixelIcon name="plus" scale={1.5} />
      </Link>
      <button type="button" aria-haspopup="menu" aria-expanded={open} aria-label="Account menu" onClick={() => setOpen((v) => !v)} className="flex h-11 w-11 items-center justify-center transition-opacity hover:opacity-80 sm:h-8 sm:w-8">
        <Avatar handle={me.handle} />
      </button>
      {open ? (
        <div role="menu" className="sheet slab absolute right-0 top-[calc(100%+10px)] z-50 w-[230px] p-1.5 [--px-line:var(--line-strong)]">
          <div className="flex items-center gap-2.5 px-2.5 py-2">
            <Avatar handle={me.handle} />
            <div className="min-w-0">
              <div className="truncate font-semibold">@{me.handle}</div>
              <div className="truncate text-[12.5px] text-faint">{me.tier ? `${me.tier.name} holder` : "No holder tier"}</div>
            </div>
          </div>
          <div className="rule my-1" />
          <MenuLinks onClose={() => setOpen(false)} />
        </div>
      ) : null}
    </div>
  );
}

function SearchButton() {
  const setPaletteOpen = useUi((s) => s.setPaletteOpen);
  return (
    <button type="button" onClick={() => setPaletteOpen(true)} aria-label="Search" title="Search (Ctrl K)" className="hidden h-8 w-8 shrink-0 md:flex items-center justify-center text-faint transition-colors hover:text-gold">
      <PixelIcon name="search" scale={1.75} />
    </button>
  );
}

interface TokenData {
  priceUsd: number;
  marketCap: number;
  change24h: number | null;
}

function useTokens() {
  return useQuery({ queryKey: ["tokens"], queryFn: () => api<{ cards: TokenData | null; gdex: TokenData | null; gdexLaunched: boolean }>("/tokens"), refetchInterval: 60_000, staleTime: 50_000 });
}

function TokenCap({ ticker, token, missing }: { ticker: string; token: TokenData | null | undefined; missing: string }) {
  const change = token?.change24h ?? null;
  return (
    <span className="flex items-center gap-1.5 whitespace-nowrap" title={token ? `${ticker} market cap, price $${token.priceUsd}` : undefined}>
      <span className="font-medium text-mute">{ticker}</span>
      {token ? (
        <>
          <span className="num font-semibold text-bone">{compactUsd(token.marketCap)}</span>
          {change !== null ? <span className={`num ${change >= 0 ? "text-teal" : "text-loss"}`}>{change >= 0 ? "+" : ""}{change.toFixed(1)}%</span> : null}
        </>
      ) : <span>{missing}</span>}
    </span>
  );
}

function TokenCaps() {
  const { data } = useTokens();
  return (
    <>
      <TokenCap ticker={BRAND.tokenTicker} token={data?.gdex} missing={data && !data.gdexLaunched ? "Not launched" : "–"} />
      <TokenCap ticker="$CARDS" token={data?.cards} missing="–" />
    </>
  );
}

function StatusBar() {
  const connected = useLive((s) => s.connected);
  const status = useLive((s) => s.status);
  const pools = useLive((s) => s.pools);
  const now = useNow();
  const next = status?.nextDropAt ? (new Date(status.nextDropAt).getTime() - now) / 1000 : null;
  return (
    <footer className="px-box mx-2 mb-2 hidden h-8 shrink-0 items-center gap-4 px-3.5 text-[12px] text-faint sm:mx-3 sm:flex">
      <span className="flex items-center gap-1.5">
        <span className={`h-1.5 w-1.5 ${connected ? "bg-teal" : "bg-loss"}`} />
        {connected ? "Live" : "Reconnecting"}
      </span>
      <span className="flex items-center gap-1.5 whitespace-nowrap">
        Next card
        <span className="num font-semibold text-gold" title={pauseReason(status?.pausedFor)}>{status?.pausedFor ? "paused" : next !== null && next > 0 ? clock(next) : "soon"}</span>
      </span>
      <span className="hidden items-center gap-1.5 whitespace-nowrap xl:flex">Pool <span className="num font-semibold text-bone">{money(status?.dropsBalance ?? pools?.drops, true)}</span></span>
      <span className="h-3 w-px bg-line-strong" aria-hidden="true" />
      <TokenCaps />
      <span className="ml-auto hidden items-center gap-1 2xl:flex">
        <kbd className="num rounded bg-bone/[0.07] px-1 text-[11px]">Ctrl K</kbd> search
        <kbd className="num ml-2 rounded bg-bone/[0.07] px-1 text-[11px]">S</kbd> buy newest
        <kbd className="num ml-2 rounded bg-bone/[0.07] px-1 text-[11px]">1-{NAV.length}</kbd> pages
      </span>
      <a href="https://www.tradingview.com/" target="_blank" rel="noreferrer noopener" className="ml-2 hidden hover:text-bone xl:inline">Charts by TradingView</a>
      <button type="button" onClick={() => useUi.getState().setTourOpen(true)} className="ml-auto hidden items-center gap-1 hover:text-bone md:inline-flex xl:ml-2"><Compass size={12} aria-hidden="true" /> Tour</button>
      <Link href="/treasury" className="hidden items-center gap-1 hover:text-bone md:inline-flex"><Landmark size={12} aria-hidden="true" /> Treasury</Link>
      <Link href="/terms" className="hidden items-center gap-1 hover:text-bone md:inline-flex"><FileText size={12} aria-hidden="true" /> Terms</Link>
      <span className="ml-auto md:ml-0"><ThemeButton /></span>
    </footer>
  );
}

function Hotkeys() {
  const router = useRouter();
  const setPaletteOpen = useUi((s) => s.setPaletteOpen);
  const cards = usePulse((s) => s.cards);
  const { snipe } = useTrade();
  const newest = useMemo(() => Object.values(cards).filter((card) => card.state === "LIVE" && !card.boughtBy).sort((a, b) => b.number - a.number)[0], [cards]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setPaletteOpen(true);
        return;
      }
      const target = event.target as HTMLElement;
      if (["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName) || event.ctrlKey || event.metaKey || event.altKey) return;
      // Behind an open dialog (the tour, a reveal), S must not buy and 1-8 must not change page.
      if (document.querySelector('[aria-modal="true"]')) return;
      if (event.key.toLowerCase() === "s" && newest) {
        // As on the Buy button: with the live feed down, never pay more than the last price seen.
        void snipe(newest, useLive.getState().connected ? undefined : newest.price);
        return;
      }
      const page = NAV[Number(event.key) - 1];
      if (page) router.push(page.href);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [newest, router, setPaletteOpen, snipe]);
  return null;
}

function MoreSheet({ onClose }: { onClose: () => void }) {
  const me = useMe();
  const setConnectOpen = useUi((s) => s.setConnectOpen);
  const pathname = usePathname();
  const opened = useRef(pathname);
  useEffect(() => {
    if (pathname !== opened.current) onClose();
  }, [onClose, pathname]);
  return (
    <Sheet title="More" onClose={onClose}>
      <div className="flex flex-col gap-0.5 px-2 pb-4">
        <div className="mb-1 flex flex-wrap gap-x-5 gap-y-1 px-2.5 pb-2 text-[12.5px] text-faint"><TokenCaps /></div>
        {NAV.filter((item) => !PHONE_TABS.includes(item)).map(({ href, label, icon }) => (
          <Link key={href} href={href} onClick={onClose} className={menuItem}><PixelIcon name={icon} /> {label}</Link>
        ))}
        <button type="button" className={menuItem} onClick={() => { onClose(); useUi.getState().setTourOpen(true); }}><Compass size={16} aria-hidden="true" /> How {BRAND.name} works</button>
        <Link href="/treasury" onClick={onClose} className={menuItem}><Landmark size={16} aria-hidden="true" /> Treasury</Link>
        <Link href="/terms" onClick={onClose} className={menuItem}><FileText size={16} aria-hidden="true" /> Terms and risks</Link>
        <div className="rule my-1" />
        {me ? <MenuLinks onClose={onClose} /> : (
          <>
            <ThemeButton wide />
            <button type="button" className={menuItem} onClick={() => { onClose(); setConnectOpen(true); }}><Wallet size={16} aria-hidden="true" /> Connect</button>
          </>
        )}
      </div>
    </Sheet>
  );
}

export function Shell({ children }: { children: ReactNode }) {
  const [moreOpen, setMoreOpen] = useState(false);
  useUserEvents();
  usePulseFeed();

  useEffect(() => {
    resyncLive();
    useBuySize.getState().load();
    connectStream();
    try {
      const saved = localStorage.getItem("gemdex.theme");
      if (saved === "light" || saved === "dark") useUi.getState().setTheme(saved);
    } catch {
      // Falls back to dark.
    }
  }, []);

  return (
    // On very wide screens the app stops widening and sits in the middle, instead of stretching every panel.
    <div className="mx-auto flex h-dvh w-full max-w-[1760px] flex-col overflow-hidden">
      <header className="relative z-40 flex h-[60px] shrink-0 items-center justify-between gap-1.5 px-2 sm:px-3 xl:grid xl:grid-cols-[1fr_auto_1fr] xl:gap-2">
        <div className="flex min-w-0 justify-start">
          <Link href="/" aria-label={`${BRAND.name} home`} className="px-box flex h-[46px] shrink-0 items-center gap-2 pl-2.5 pr-3 transition hover:brightness-110">
            <Logo size={21} />
            <span className="pixel hidden text-[17px] uppercase leading-none text-bone lg:inline">{BRAND.name}</span>
            <ModeBadge />
          </Link>
        </div>
        <Dock />
        <div className="flex min-w-0 justify-end xl:col-start-3">
          <div className="px-box flex h-[46px] min-w-0 items-center gap-0.5 pl-1.5 pr-[7px]">
            <SearchButton />
            <AccountMenu />
          </div>
        </div>
      </header>

      <AccessBanner />
      <GiftBanner />
      <main className="min-h-0 flex-1 overflow-hidden">{children}</main>

      <StatusBar />
      <PhoneNav onMore={() => setMoreOpen(true)} />

      {moreOpen ? <MoreSheet onClose={() => setMoreOpen(false)} /> : null}
      <Hotkeys />
      <WalletBridge />
      <Toasts />
      <RevealModal />
      <ConnectModal />
      <CommandPalette />
      <Tour />
    </div>
  );
}
