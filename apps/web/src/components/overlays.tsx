"use client";

import { BRAND } from "@gemdex/core";
import { useQuery } from "@tanstack/react-query";
import { ArrowRight, CheckCircle2, CircleAlert, Info, Search, Zap } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { api } from "@/lib/api";
import { cardTitle, money } from "@/lib/format";
import { useMeta, useSignIn } from "@/lib/session";
import type { Listing } from "@/lib/types";
import { useUi, type Toast } from "@/lib/ui";
import { Button, CardThumb, Grade, Logo, Rarity, inputClass, rarityBorder, rarityWash } from "./bits";
import { sized } from "@/lib/image";

function Modal({ children, onClose, label, wide }: { children: ReactNode; onClose: () => void; label: string; wide?: boolean }) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-black/70 p-4 backdrop-blur-[3px]" role="dialog" aria-modal="true" aria-label={label} onClick={onClose}>
      <div className={`sheet my-auto w-full ${wide ? "max-w-[560px]" : "max-w-[420px]"}`} onClick={(event) => event.stopPropagation()}>
        {children}
      </div>
    </div>
  );
}

const TOAST_ICON: Record<Toast["tone"], ReactNode> = {
  ok: <CheckCircle2 size={18} className="text-teal" aria-hidden="true" />,
  bad: <CircleAlert size={18} className="text-loss" aria-hidden="true" />,
  win: <Zap size={18} fill="currentColor" className="text-gold" aria-hidden="true" />,
  info: <Info size={18} className="text-mute" aria-hidden="true" />,
};

export function Toasts() {
  const toasts = useUi((s) => s.toasts);
  const dismiss = useUi((s) => s.dismiss);
  return (
    <div className="pointer-events-none fixed bottom-[76px] left-3 right-3 z-[60] flex flex-col items-end gap-2 sm:bottom-11 sm:left-auto sm:w-[340px]" aria-live="polite">
      {toasts.map((toast) => (
        <button key={toast.id} type="button" onClick={() => dismiss(toast.id)} className="toast pointer-events-auto flex w-full items-start gap-2.5 px-cut border border-line-strong bg-surface p-3 text-left shadow-[var(--shadow-lift)]">
          <span className="mt-px shrink-0">{TOAST_ICON[toast.tone]}</span>
          <span className="min-w-0">
            <span className="block font-bold">{toast.title}</span>
            {toast.detail ? <span className="block truncate text-[13px] text-mute">{toast.detail}</span> : null}
          </span>
        </button>
      ))}
    </div>
  );
}

export function RevealModal() {
  const reveal = useUi((s) => s.reveal);
  const setReveal = useUi((s) => s.setReveal);
  if (!reveal) return null;
  const { card, insuredValue, paid, rarity, label, soldBack } = reveal;
  const name = String(card.name ?? "Common sold back");
  return (
    <Modal onClose={() => setReveal(null)} label={label}>
      <div className={`win-flash pointer-events-none fixed inset-0 ${rarity === "epic" ? "bg-epic/30" : "bg-volt/20"}`} />
      <div className={`slab reveal flex flex-col items-center border-2 p-5 text-center ${rarityBorder(rarity)} ${rarityWash(rarity)}`}>
        <div className="pixel text-[15px] uppercase text-gold">{label}</div>
        {card.image ? (
          <img src={sized(card.image, 320)} alt={name} className="mt-3 max-h-[42dvh] max-w-full px-cut object-contain" />
        ) : (
          <div className="mt-3 flex h-[170px] w-full items-center justify-center px-cut bg-raised text-mute">Turbo sold this Common back</div>
        )}
        <div className="mt-3 line-clamp-2 text-[18px] font-bold leading-tight">{cardTitle(name)}</div>
        <div className="mt-2 flex items-center gap-1.5">
          <Rarity rarity={rarity} />
          <Grade grader={card.grader} grade={card.grade} />
        </div>
        <div className="mt-3 grid w-full grid-cols-2 gap-2 text-left">
          <div className="px-cut bg-bone/[0.06] p-2.5">
            <div className="text-[12.5px] text-faint">Insured value</div>
            <div className="num text-[17px] font-semibold">{money(insuredValue)}</div>
          </div>
          <div className="px-cut bg-bone/[0.06] p-2.5">
            <div className="text-[12.5px] text-faint">{soldBack ? "Sold back for" : paid ? "You paid" : "Delivery"}</div>
            <div className="num text-[17px] font-semibold text-teal">{soldBack ? money(soldBack) : paid ? money(paid) : "Your wallet"}</div>
          </div>
        </div>
        <div className="mt-3 flex w-full gap-2">
          <Link href="/portfolio" onClick={() => setReveal(null)} className="flex h-11 flex-1 items-center justify-center px-cut bg-raised font-semibold hover:bg-raised-2">
            View portfolio
          </Link>
          <Button tone="snipe" className="h-11 flex-1" onClick={() => setReveal(null)}>
            Keep going
          </Button>
        </div>
      </div>
    </Modal>
  );
}

export function ConnectModal() {
  const open = useUi((s) => s.connectOpen);
  const setOpen = useUi((s) => s.setConnectOpen);
  const meta = useMeta();
  const signIn = useSignIn();
  const [handle, setHandle] = useState("");
  const wallet = useUi((state) => state.wallet);
  if (!open) return null;
  return (
    <Modal onClose={() => setOpen(false)} label="Connect">
      <form
        className="slab flex flex-col gap-3.5 p-6"
        onSubmit={(event) => {
          event.preventDefault();
          signIn.mutate(handle);
        }}
      >
        <div className="flex items-center gap-2.5">
          <Logo size={26} />
          <div className="pixel text-[18px] uppercase">{BRAND.name}</div>
        </div>
        {meta.data?.paper !== false ? (
          <>
            <div>
              <h2 className="text-[20px] font-bold tracking-tight">Start paper trading</h2>
              <p className="mt-1 text-mute">Real Collector Crypt prices, cards and odds, with simulated money. You start with $500.</p>
            </div>
            <input className={inputClass} placeholder="Pick a name" value={handle} maxLength={18} autoFocus aria-label="Display name" onChange={(event) => setHandle(event.target.value)} />
            <Button tone="primary" type="submit" className="h-11" disabled={signIn.isPending}>
              {signIn.isPending ? "Starting" : "Start trading"}
            </Button>
          </>
        ) : (
          <>
            <div>
              <h2 className="text-[20px] font-bold tracking-tight">Connect your wallet</h2>
              <p className="mt-1 text-mute">You also get a trading wallet for one-click snipes, and won cards go to the wallet you connect.</p>
            </div>
            <Button tone="primary" className="h-11" disabled={!wallet} onClick={() => wallet?.login()}>{wallet ? "Connect wallet" : "Loading"}</Button>
          </>
        )}
        <p className="text-[12.5px] text-faint">
          By continuing you accept the <Link href="/terms" className="underline" onClick={() => setOpen(false)}>terms and risks</Link>.
        </p>
      </form>
    </Modal>
  );
}

const PAGES = [
  ["Pulse", "/"], ["Scanner", "/scanner"], ["Market", "/market"], ["Gacha Desk", "/gacha"], ["Portfolio", "/portfolio"], ["Trading wallet", "/wallet"],
  ["Tracker", "/tracker"], ["Auto-Buy", "/auto"], ["Rewards", "/rewards"], ["Flywheel", "/flywheel"], ["Admin", "/admin"], ["Terms and risks", "/terms"],
] as const;

export function CommandPalette() {
  const open = useUi((s) => s.paletteOpen);
  const setOpen = useUi((s) => s.setPaletteOpen);
  const router = useRouter();
  const [text, setText] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const search = useQuery({
    queryKey: ["palette", text],
    enabled: open && text.length >= 2,
    queryFn: () => api<{ rows: Listing[] }>(`/listings?search=${encodeURIComponent(text)}&limit=7&sort=newest`),
  });
  useEffect(() => {
    if (open) {
      setText("");
      input.current?.focus();
    }
  }, [open]);
  if (!open) return null;
  const go = (href: string) => {
    setOpen(false);
    router.push(href);
  };
  const pages = PAGES.filter(([label]) => label.toLowerCase().includes(text.toLowerCase()));
  const query = text.trim().toLowerCase();
  const tourMatch = !query || ["tour", "how it works", "help", "guide", BRAND.name.toLowerCase()].some((word) => word.startsWith(query) || query.includes(word));
  const cards = search.data?.rows ?? [];
  return (
    <Modal onClose={() => setOpen(false)} label="Search" wide>
      <div className="slab overflow-hidden">
        <div className="flex items-center gap-2.5 px-4">
          <Search size={19} className="shrink-0 text-faint" aria-hidden="true" />
          <input ref={input} value={text} onChange={(event) => setText(event.target.value)} placeholder="Search cards or jump to a page" aria-label="Search" className="h-14 w-full bg-transparent text-[16px] outline-none placeholder:text-faint" />
        </div>
        <div className="rule" />
        <div className="max-h-[52dvh] overflow-y-auto p-2">
          {cards.map((row) => (
            <button key={row.nft} type="button" onClick={() => go(`/card/${row.nft}`)} className="flex w-full items-center gap-3 px-cut p-2 text-left hover:bg-raised">
              <CardThumb src={row.image} alt="" size={34} />
              <span className="min-w-0 flex-1">
                <span className="block truncate font-bold">{cardTitle(row.name)}</span>
                <span className="block truncate text-[12.5px] text-faint">{row.set}</span>
              </span>
              <Grade grader={row.grader} grade={row.grade} />
              <span className="num w-16 text-right font-semibold text-teal">{money(row.price, true)}</span>
            </button>
          ))}
          {tourMatch ? (
            <button type="button" onClick={() => { setOpen(false); useUi.getState().setTourOpen(true); }} className="flex h-10 w-full items-center justify-between px-cut px-3 text-left font-medium hover:bg-raised">
              How {BRAND.name} works
              <ArrowRight size={15} className="text-faint" aria-hidden="true" />
            </button>
          ) : null}
          {pages.map(([label, href]) => (
            <button key={href} type="button" onClick={() => go(href)} className="flex h-10 w-full items-center justify-between px-cut px-3 text-left font-medium hover:bg-raised">
              {label}
              <ArrowRight size={15} className="text-faint" aria-hidden="true" />
            </button>
          ))}
        </div>
      </div>
    </Modal>
  );
}
