"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { SectionTitle } from "./bits";

export interface BoardColumn {
  key: string;
  title: string;
  dot?: string;
  count?: number;
  right?: ReactNode;
  children: ReactNode;
}

/**
 * Columns sit side by side when they fit. When they do not, the board swipes sideways and a
 * tab strip appears, so nothing is ever hidden and the same layout works at every width.
 */
export function Board({ columns }: { columns: BoardColumn[] }) {
  const board = useRef<HTMLDivElement>(null);
  const [overflowing, setOverflowing] = useState(false);
  const [active, setActive] = useState(0);

  useEffect(() => {
    const element = board.current;
    if (!element) return;
    const check = () => setOverflowing(element.scrollWidth > element.clientWidth + 4);
    check();
    const observer = new ResizeObserver(check);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const onScroll = () => {
    const element = board.current;
    const first = element?.children[0] as HTMLElement | undefined;
    if (!element || !first) return;
    setActive(Math.round(element.scrollLeft / (first.offsetWidth + 8)));
  };

  const go = (index: number) => {
    const element = board.current;
    const target = element?.children[index] as HTMLElement | undefined;
    if (element && target) element.scrollTo({ left: target.offsetLeft - element.offsetLeft - 8, behavior: "smooth" });
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      {overflowing ? (
        <div role="tablist" aria-label="Columns" className="no-scrollbar flex shrink-0 gap-1 overflow-x-auto px-3 pt-2 sm:pt-3">
          {columns.map((column, index) => (
            <button
              key={column.key}
              type="button"
              role="tab"
              aria-selected={active === index}
              onClick={() => go(index)}
              className={`flex h-9 min-h-11 shrink-0 items-center gap-1.5 whitespace-nowrap px-cut px-3 text-[14px] font-semibold transition-colors sm:min-h-0 ${active === index ? "bg-raised text-bone" : "text-mute hover:text-bone"}`}
            >
              {column.title}
              {column.count ? <span className="num text-[12px] text-faint">{column.count}</span> : null}
            </button>
          ))}
        </div>
      ) : null}
      <div ref={board} onScroll={onScroll} className="board no-scrollbar min-h-0 flex-1 px-2 pb-2 pt-0.5 sm:px-3">
        {columns.map((column) => (
          <section key={column.key} aria-label={column.title} className="slab flex min-h-0 min-w-0 flex-col">
            <SectionTitle
              icon={column.dot ? <span className={`h-2 w-2 ${column.dot}`} /> : undefined}
              right={column.right ?? (column.count !== undefined ? <span className="num text-[12.5px] text-faint">{column.count}</span> : null)}
            >
              {column.title}
            </SectionTitle>
            <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-1.5 pb-1.5 [&>*]:shrink-0">{column.children}</div>
          </section>
        ))}
      </div>
    </div>
  );
}
