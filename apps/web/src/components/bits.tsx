"use client";

import { certUrl } from "@gemdex/core";
import { Check, ShieldCheck, X, Zap } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { gradeShort } from "@/lib/format";
import { sized } from "@/lib/image";
import { MARK, MARK_HEIGHT, MARK_WIDTH } from "@/lib/logo";

/** Original mark: a graded slab, label bar on top, gem in the window. */
/** The Tenner mark. Size is its height in pixels, and it follows the theme's colors. */
export function Logo({ size = 22 }: { size?: number }) {
  return (
    <svg width={(size * MARK_WIDTH) / MARK_HEIGHT} height={size} viewBox={`0 0 ${MARK_WIDTH} ${MARK_HEIGHT}`} shapeRendering="crispEdges" aria-hidden="true">
      {/* Yellow uses gold: the same in dark theme, and deep enough to read on the light theme's cream. */}
      {MARK.map(([x, y, w, h, tone], i) => <rect key={i} x={x} y={y} width={w} height={h} fill={tone === "volt" ? "var(--gold)" : `var(--${tone})`} />)}
    </svg>
  );
}

export const BOLT = <Zap size={14} strokeWidth={2.6} fill="currentColor" aria-hidden="true" />;

type Tone = "plain" | "good" | "warn" | "bad" | "info";

const PILL_TONES: Record<Tone, string> = {
  plain: "bg-bone/[0.07] text-mute",
  good: "bg-teal/15 text-teal",
  warn: "bg-volt/15 text-gold",
  bad: "bg-loss/15 text-loss",
  info: "bg-rare/15 text-rare",
};

export function Pill({ children, tone = "plain", title }: { children: ReactNode; tone?: Tone; title?: string }) {
  return (
    <span title={title} className={`inline-flex h-[22px] shrink-0 items-center gap-1 whitespace-nowrap px-cut px-1.5 text-[12px] font-semibold ${PILL_TONES[tone]}`}>
      {children}
    </span>
  );
}

const RARITIES = ["common", "uncommon", "rare", "epic"] as const;

/** Rare and epic get a faint outline in their color, so the better pulls stand out in a list. */
const RARITY_TAG: Record<string, string> = {
  common: "bg-common/12 text-common",
  uncommon: "bg-uncommon/12 text-uncommon",
  rare: "bg-rare/14 text-rare shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--r-rare)_35%,transparent)]",
  epic: "bg-epic/16 text-epic shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--r-epic)_45%,transparent)]",
};

/**
 * A rarity tag like a game's item label: the tier in pixel type, with 1 to 4 lit bars so the level
 * reads at a glance and never rests on color alone.
 */
export function Rarity({ rarity }: { rarity: string | null | undefined }) {
  if (!rarity) return null;
  const level = RARITIES.indexOf(rarity as (typeof RARITIES)[number]) + 1;
  if (level === 0) return <Pill>{rarity}</Pill>;
  return (
    <span title={`${rarity[0]!.toUpperCase()}${rarity.slice(1)}, tier ${level} of 4`} className={`inline-flex h-[22px] shrink-0 items-center gap-1.5 whitespace-nowrap px-cut pl-1.5 pr-2 ${RARITY_TAG[rarity]}`}>
      <span className="flex items-end gap-px" aria-hidden="true">
        {RARITIES.map((_, i) => <span key={i} className={`w-[3px] bg-current ${i < level ? "" : "opacity-25"}`} style={{ height: 4 + i * 2 }} />)}
      </span>
      <span className="pixel text-[10.5px] uppercase leading-none tracking-[0.04em]">{rarity}</span>
    </span>
  );
}

export function rarityBorder(rarity: string | null | undefined): string {
  return { common: "border-line-strong", uncommon: "border-uncommon/50", rare: "border-rare/60", epic: "border-epic/80" }[rarity ?? ""] ?? "border-line";
}

export const rarityWash = (rarity: string | null | undefined): string => (rarity ? `wash-${rarity}` : "");

/** A 10 is what "gem" means, so it gets the brand gold. */
export function Grade({ grader, grade }: { grader: string | null | undefined; grade: string | null | undefined }) {
  const text = gradeShort(grader, grade);
  if (!text) return null;
  const gem = /\b10$/.test(text);
  return <span className={`num inline-flex h-[22px] shrink-0 items-center whitespace-nowrap px-cut px-1.5 text-[12px] font-semibold ${gem ? "bg-volt/15 text-gold" : "bg-bone/[0.08] text-bone"}`}>{text}</span>;
}

const ZOOM_WIDTH = 300;
const ZOOM_HEIGHT = 402;
const ZOOM_GAP = 8;

/** Below the card if it fits, then above, then beside it. Never off screen. */
function zoomPosition(rect: DOMRect) {
  const roomBelow = window.innerHeight - rect.bottom - ZOOM_GAP * 2;
  const roomAbove = rect.top - ZOOM_GAP * 2;
  const left = Math.max(ZOOM_GAP, Math.min(rect.left, window.innerWidth - ZOOM_WIDTH - ZOOM_GAP));
  if (roomBelow >= ZOOM_HEIGHT) return { left, top: rect.bottom + ZOOM_GAP };
  if (roomAbove >= ZOOM_HEIGHT) return { left, top: rect.top - ZOOM_HEIGHT - ZOOM_GAP };
  const beside = rect.right + ZOOM_GAP + ZOOM_WIDTH < window.innerWidth ? rect.right + ZOOM_GAP : rect.left - ZOOM_WIDTH - ZOOM_GAP;
  return { left: Math.max(ZOOM_GAP, beside), top: Math.max(ZOOM_GAP, Math.min(rect.top, window.innerHeight - ZOOM_HEIGHT - ZOOM_GAP)) };
}

export function CardThumb({ src, alt, size = 62, tag, zoom }: { src: string | null | undefined; alt: string; size?: number; tag?: ReactNode; zoom?: boolean }) {
  const box = useRef<HTMLDivElement>(null);
  const [spot, setSpot] = useState<{ left: number; top: number } | null>(null);

  useEffect(() => {
    if (!spot) return;
    // A scroll moves the card out from under the preview, so it closes.
    const close = () => setSpot(null);
    window.addEventListener("scroll", close, true);
    return () => window.removeEventListener("scroll", close, true);
  }, [spot]);

  const show = () => {
    if (!zoom || !src || !box.current || !window.matchMedia("(hover: hover)").matches) return;
    setSpot(zoomPosition(box.current.getBoundingClientRect()));
  };

  return (
    <div ref={box} onMouseEnter={show} onMouseLeave={() => setSpot(null)} className="relative shrink-0 overflow-hidden rounded-[2px] bg-bone/[0.05]" style={{ width: size, height: size * 1.34 }}>
      {src ? <img src={sized(src, size)} alt={alt} loading="lazy" decoding="async" className="h-full w-full object-cover" /> : null}
      {tag ? <div className="absolute bottom-0 right-0">{tag}</div> : null}
      {spot && src
        ? createPortal(
            <div className="zoom-in pointer-events-none fixed z-[60] overflow-hidden px-cut border border-line-strong bg-surface p-2 shadow-[var(--shadow-lift)]" style={{ left: spot.left, top: spot.top, width: ZOOM_WIDTH, height: ZOOM_HEIGHT }} aria-hidden="true">
              <img src={sized(src, ZOOM_WIDTH)} alt="" className="h-full w-full object-contain" />
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}

/** Heading row of a panel. */
export function SectionTitle({ children, right, icon }: { children: ReactNode; right?: ReactNode; icon?: ReactNode }) {
  return (
    // At least 44px, not exactly: on phones a Segmented on the right is taller than that and would spill out.
    <div className="flex min-h-11 shrink-0 items-center justify-between gap-2 pl-3.5 pr-2.5">
      <h2 className="pixel flex min-w-0 items-center gap-2 truncate text-[13px] uppercase leading-none text-bone">
        {icon}
        {children}
      </h2>
      {right}
    </div>
  );
}

export function PageHeader({ title, subtitle, right }: { title: string; subtitle?: ReactNode; right?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3 pb-0.5 pt-2">
      <div className="min-w-0">
        <h1 className="pixel text-[20px] uppercase leading-none">{title}</h1>
        {subtitle ? <p className="mt-1.5 max-w-[65ch] text-[14px] leading-relaxed text-faint">{subtitle}</p> : null}
      </div>
      {right}
    </div>
  );
}

export function Stat({ label, value, tone, hint }: { label: string; value: ReactNode; tone?: "good" | "bad" | "warn"; hint?: ReactNode }) {
  const color = tone === "good" ? "text-teal" : tone === "bad" ? "text-loss" : tone === "warn" ? "text-gold" : "text-bone";
  return (
    <div className="min-w-0">
      <div className="truncate text-[13px] font-medium text-faint">{label}</div>
      <div className={`num mt-0.5 truncate text-[20px] font-semibold leading-tight ${color}`}>{value}</div>
      {hint ? <div className="mt-0.5 truncate text-[12.5px] text-faint">{hint}</div> : null}
    </div>
  );
}

export function StatTile(props: Parameters<typeof Stat>[0]) {
  return (
    <div className="min-w-0 px-cut bg-raised px-3 py-2.5">
      <Stat {...props} />
    </div>
  );
}

export function Empty({ title, children, icon }: { title: string; children?: ReactNode; icon?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-2 px-6 py-14 text-center">
      {icon ? <div className="mb-1 flex h-12 w-12 items-center justify-center px-cut bg-bone/[0.07] text-mute">{icon}</div> : null}
      <div className="text-[16px] font-bold">{title}</div>
      {children ? <div className="max-w-sm text-mute">{children}</div> : null}
    </div>
  );
}

export function Skeleton({ rows = 6 }: { rows?: number }) {
  return (
    <div className="flex flex-col gap-2 p-2" aria-hidden="true">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="h-[92px] animate-pulse px-cut bg-raised" style={{ opacity: 1 - i * 0.12 }} />
      ))}
    </div>
  );
}

export function CertLink({ grader, cert }: { grader: string | null; cert: string | null }) {
  const href = certUrl(grader, cert);
  if (!href) return null;
  return (
    <a href={href} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1.5 font-medium text-rare hover:underline">
      <ShieldCheck size={15} aria-hidden="true" /> Verify cert {cert}
    </a>
  );
}

export function Button({
  children, onClick, tone = "plain", disabled, className = "", type = "button", title,
}: {
  children: ReactNode; onClick?: () => void; tone?: "plain" | "primary" | "snipe" | "ghost" | "danger"; disabled?: boolean; className?: string; type?: "button" | "submit"; title?: string;
}) {
  const tones = {
    plain: "bg-raised text-bone hover:bg-raised-2",
    primary: "bg-cherry text-white hover:brightness-110",
    snipe: "bg-volt text-[var(--on-volt)] hover:brightness-105",
    ghost: "text-mute hover:bg-bone/[0.07] hover:text-bone",
    danger: "bg-loss/12 text-loss hover:bg-loss/20",
  };
  // Main actions all read like the Buy button on Pulse: a pixel label, with any price in a .num span.
  const main = tone === "primary" || tone === "snipe" ? `pixel uppercase leading-none ${/\btext-\[/.test(className) ? "" : "text-[13px]"}` : "";
  return (
    <button
      type={type}
      title={title}
      disabled={disabled}
      onClick={onClick}
      className={`inline-flex h-10 min-h-11 shrink-0 items-center justify-center gap-1.5 whitespace-nowrap px-cut px-3.5 font-semibold transition active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-60 disabled:!bg-raised disabled:!text-faint sm:min-h-0 ${tones[tone]} ${main} ${className}`}
    >
      {children}
    </button>
  );
}

export function Segmented<T extends string>({ value, options, onChange, label }: { value: T; options: Array<{ value: T; label: ReactNode }>; onChange: (value: T) => void; label: string }) {
  return (
    <div role="tablist" aria-label={label} className="no-scrollbar inline-flex max-w-full items-center gap-0.5 overflow-x-auto px-cut bg-raised p-1">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="tab"
          aria-selected={value === option.value}
          onClick={() => onChange(option.value)}
          className={`h-7 min-h-11 shrink-0 whitespace-nowrap px-cut px-2.5 text-[13px] font-medium transition-colors sm:min-h-0 ${value === option.value ? "bg-surface text-gold" : "text-faint hover:text-bone"}`}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label className="flex min-w-0 flex-col gap-1.5">
      <span className="text-[12.5px] font-medium text-mute">{label}</span>
      {children}
      {hint ? <span className="text-[12px] text-faint">{hint}</span> : null}
    </label>
  );
}

export function Toggle({ checked, onChange, children }: { checked: boolean; onChange: (checked: boolean) => void; children: ReactNode }) {
  return (
    <label className="flex cursor-pointer items-start gap-2.5 text-mute">
      <input type="checkbox" className="peer sr-only" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span className={`mt-px flex h-5 w-5 shrink-0 items-center justify-center rounded-[2px] border transition-colors peer-focus-visible:outline-2 peer-focus-visible:outline-gold ${checked ? "border-volt bg-volt text-[var(--on-volt)]" : "border-line-strong bg-raised"}`}>
        {checked ? <Check size={14} strokeWidth={3.2} aria-hidden="true" /> : null}
      </span>
      <span>{children}</span>
    </label>
  );
}

export const inputClass = "h-10 min-h-11 w-full min-w-0 px-cut border border-line bg-raised px-3 text-[15px] text-bone placeholder:text-faint transition-colors focus:border-gold focus:outline-none sm:min-h-0";

/** Slides up from the bottom on phones, sits centered on bigger screens. */
export function Sheet({ title, onClose, children, wide }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  // Panels are their own layers, so a popup opened from inside one has to render outside it.
  if (typeof document === "undefined") return null;
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/65 backdrop-blur-[2px] sm:items-center sm:p-4" role="dialog" aria-modal="true" aria-label={title} onClick={onClose}>
      <div className={`sheet slab flex max-h-[88dvh] w-full flex-col overflow-hidden [--px-line:var(--line-strong)] ${wide ? "sm:max-w-[720px]" : "sm:max-w-[460px]"} `} onClick={(event) => event.stopPropagation()}>
        <div className="flex h-14 shrink-0 items-center justify-between gap-2 pl-5 pr-3">
          <h2 className="pixel truncate text-[14px] uppercase leading-none">{title}</h2>
          <button type="button" aria-label="Close" onClick={onClose} className="flex h-11 w-11 items-center justify-center px-cut text-mute hover:bg-bone/[0.07] hover:text-bone sm:h-9 sm:w-9">
            <X size={19} aria-hidden="true" />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
      </div>
    </div>,
    document.body,
  );
}
