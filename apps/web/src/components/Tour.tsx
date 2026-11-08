"use client";

import { ArrowLeft, ArrowRight } from "lucide-react";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { shareOfSupply } from "@gemdex/core";
import { useMe, useMeta } from "@/lib/session";
import { TOUR_SKIP_ON, TOUR_STEPS, markTourSeen, tourSeen, type TourStep } from "@/lib/tour";
import { useUi } from "@/lib/ui";
import { Button, Logo } from "./bits";
import { PixelIcon } from "./pixel";

type FinalStep = TourStep & { action: "connect" | "pulse" };

function usePrefersReducedMotion() {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReduced(query.matches);
    const onChange = () => setReduced(query.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);
  return reduced;
}

/** The step's recording of the real app, looping and silent. With reduced motion it waits for a click. */
function Clip({ step }: { step: TourStep }) {
  const reduced = usePrefersReducedMotion();
  return (
    // On short screens the clip gives up height first, so the buttons stay in view.
    <div className="relative aspect-[16/10] max-h-[46dvh] w-full overflow-hidden bg-ink">
      {step.clip ? (
        <video
          key={step.clip}
          className="absolute inset-0 h-full w-full object-cover"
          poster={`${step.clip}.jpg`}
          autoPlay={!reduced}
          controls={reduced}
          muted
          loop
          playsInline
          preload="auto"
          aria-label={`${step.kicker} in action`}
        >
          <source src={`${step.clip}.mp4`} type="video/mp4" />
        </video>
      ) : (
        <div className="absolute inset-0 flex items-center justify-center">
          <Logo size={96} />
        </div>
      )}
    </div>
  );
}

/**
 * The first-visit tour: a few steps, each with a short recording of the real app, what it's for,
 * and a button that goes there. It opens once per browser, and the footer, the phone menu and
 * search can open it again.
 */
export function Tour() {
  const open = useUi((s) => s.tourOpen);
  const setOpen = useUi((s) => s.setTourOpen);
  const setConnectOpen = useUi((s) => s.setConnectOpen);
  const pathname = usePathname();
  const router = useRouter();
  const me = useMe();
  const accessBps = useMeta().data?.accessBps ?? 0;
  const [index, setIndex] = useState(0);
  const primary = useRef<HTMLButtonElement>(null);
  const firstPath = useRef(pathname);

  // First visit: open once the page has had a moment to load behind it.
  useEffect(() => {
    if (tourSeen() || TOUR_SKIP_ON.some((path) => firstPath.current.startsWith(path))) return;
    const timer = setTimeout(() => useUi.getState().setTourOpen(true), 900);
    return () => clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (open) setIndex(0);
  }, [open]);

  // The last step: connect a wallet, or, once connected, where things are.
  const steps = useMemo<Array<TourStep | FinalStep>>(() => {
    const last: FinalStep = me
      ? { id: "ready", icon: "star", kicker: "Ready", title: "You're set", body: "Your balance sits at the top right. Press Ctrl K to find any card, or S to buy the newest one on Pulse.", clip: null, cta: null, action: "pulse" }
      : { id: "start", icon: "star", kicker: "Start", title: "Connect your wallet", body: `${accessBps > 0 ? `Using Tenner takes at least ${shareOfSupply(accessBps)} of $TENR's supply in your wallet. ` : ""}You also get a trading wallet for one-click buys, and the cards you win go to the wallet you connect.`, clip: null, cta: null, action: "connect" };
    return [...TOUR_STEPS, last];
  }, [me, accessBps]);

  const step = steps[Math.min(index, steps.length - 1)]!;
  const isLast = index >= steps.length - 1;
  const next = steps[index + 1];

  const close = () => {
    markTourSeen();
    setOpen(false);
  };
  const go = (href: string) => {
    close();
    router.push(href);
  };
  const finish = () => {
    close();
    if (!("action" in step)) return;
    if (step.action === "connect") setConnectOpen(true);
    else router.push("/");
  };

  useEffect(() => {
    if (!open) return;
    primary.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
      if (event.key === "ArrowRight") setIndex((i) => Math.min(i + 1, steps.length - 1));
      if (event.key === "ArrowLeft") setIndex((i) => Math.max(i - 1, 0));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // close only writes storage and the store, so it doesn't need to be a dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, index, steps.length]);

  // Fetch the next step's first frame early, so moving on never shows an empty box.
  useEffect(() => {
    if (open && next?.clip) new Image().src = `${next.clip}.jpg`;
  }, [open, next]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-black/70 p-3 backdrop-blur-[3px] sm:p-4" onClick={close}>
      <div role="dialog" aria-modal="true" aria-labelledby="tour-title" className="sheet my-auto w-full max-w-[640px]" onClick={(event) => event.stopPropagation()}>
        <div className="slab overflow-hidden">
          <Clip step={step} />
          <div key={step.id} className="zoom-in px-5 pb-5 pt-4 sm:px-6">
            <div className="flex items-center gap-2 text-gold">
              <PixelIcon name={step.icon} />
              <span className="pixel text-[12px] uppercase leading-none">{step.kicker}</span>
              <span className="num ml-auto text-[12.5px] text-faint">{index + 1} / {steps.length}</span>
            </div>
            <h2 id="tour-title" className="mt-2.5 text-[21px] font-bold leading-tight tracking-tight">{step.title}</h2>
            <p className="mt-1.5 text-mute">{step.body}</p>
            {step.cta ? (
              <button type="button" onClick={() => go(step.cta!.href)} className="mt-3 inline-flex items-center gap-1 font-semibold text-teal hover:underline">
                {step.cta.label} <ArrowRight size={15} aria-hidden="true" />
              </button>
            ) : null}
          </div>
          <div className="rule" />
          <div className="flex items-center gap-2 px-4 py-3 sm:px-6">
            <Button tone="ghost" className="h-9 px-2.5 text-[13.5px]" onClick={close}>{isLast ? "Close" : "Skip tour"}</Button>
            <div className="mx-auto hidden items-center gap-1 sm:flex" aria-hidden="true">
              {steps.map((item, i) => (
                <span key={item.id} className={`h-1.5 w-5 ${i <= index ? "bg-gold" : "bg-raised-2"}`} />
              ))}
            </div>
            <div className="ml-auto flex items-center gap-1.5 sm:ml-0">
              {index > 0 ? (
                <Button tone="plain" className="h-9 w-9 px-0" title="Back" onClick={() => setIndex((i) => i - 1)}>
                  <ArrowLeft size={16} aria-label="Back" />
                </Button>
              ) : null}
              <button
                ref={primary}
                type="button"
                onClick={isLast ? finish : () => setIndex((i) => i + 1)}
                className="pixel inline-flex h-9 items-center gap-1.5 px-cut bg-volt px-3.5 text-[13px] uppercase leading-none text-[var(--on-volt)] transition hover:brightness-105 active:scale-[0.98]"
              >
                {isLast ? ("action" in step ? (step.action === "connect" ? "Connect wallet" : "Go to Pulse") : "Finish") : <>Next <ArrowRight size={15} aria-hidden="true" /></>}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
