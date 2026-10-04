"use client";

import { useEffect, useId, useRef } from "react";
import clsx from "clsx";
import { TAB_LABEL } from "@/lib/lobby/panels";

export type PanelVariant = "screen" | "drawer-left" | "drawer-right" | "drawer-right-wide";

/** Landscape phones (≤ 500 px tall, md+): the panel covers the top bar too, 8 px from the edges. */
const SHORT = "md:[@media(max-height:500px)]:top-2 md:[@media(max-height:500px)]:bottom-2";

const VARIANT: Record<PanelVariant, string> = {
  screen: `md:inset-x-4 md:top-[4.5rem] md:bottom-4 md:mx-auto md:max-w-7xl md:animate-panel-in ${SHORT}`,
  "drawer-left": `md:left-4 md:right-auto md:top-[4.5rem] md:bottom-4 md:w-[min(36rem,calc(100vw-2rem))] md:animate-drawer-in-left ${SHORT}`,
  "drawer-right": `md:right-4 md:left-auto md:top-[4.5rem] md:bottom-4 md:w-[min(36rem,calc(100vw-2rem))] md:animate-drawer-in-right ${SHORT}`,
  "drawer-right-wide": `md:right-4 md:left-auto md:top-[4.5rem] md:bottom-4 md:w-[min(44rem,calc(100vw-2rem))] md:animate-drawer-in-right ${SHORT}`,
};

/**
 * Panel shell of the main menu (WORLD v6 spec §6.3): "screen" (Inventory, Shop) or a drawer from
 * its button's side (Info left; News, Leaderboards right). Full screen from the bottom on phones.
 * role=dialog + aria-modal; the menu behind is `inert`, which is the focus trap. Focus lands on the
 * title on open; Escape (unless a dialog inside the panel is open), the × and the backdrop close
 * it. Tabs: role=tablist, ←/→ switch.
 */
export function Panel({
  title,
  variant,
  tabs,
  tab,
  onTab,
  onClose,
  headerExtra,
  tabLabels,
  children,
}: {
  title: string;
  variant: PanelVariant;
  tabs: readonly string[];
  tab: string;
  onTab: (t: string) => void;
  onClose: () => void;
  headerExtra?: React.ReactNode;
  /** Labels of tabs outside the URL panels (lib/lobby/panels TAB_LABEL covers those). */
  tabLabels?: Readonly<Record<string, string>>;
  children: React.ReactNode;
}) {
  const id = useId();
  const section = useRef<HTMLElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);

  useEffect(() => {
    heading.current?.focus({ preventScroll: true });
  }, []);

  // A new tab starts at its top, not at the scroll position of the previous tab.
  useEffect(() => {
    body.current?.scrollTo({ top: 0 });
  }, [tab]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      const inner = section.current?.querySelector('[role="dialog"][aria-modal="true"]');
      if (inner) return;
      e.preventDefault();
      onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const onTabKey = (e: React.KeyboardEvent<HTMLButtonElement>, i: number) => {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    e.preventDefault();
    const j = (i + (e.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length;
    onTab(tabs[j]!);
    tabRefs.current[j]?.focus();
  };

  return (
    <div className="fixed inset-0 z-40">
      <div className="absolute inset-0 bg-black/55 animate-panel-in motion-reduce:animate-none" onClick={onClose} aria-hidden />
      <section
        ref={section}
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${id}-title`}
        className={clsx(
          // pl/pr: out of a landscape phone's camera cutout (viewport-fit=cover; 0 elsewhere).
          "toon-panel absolute inset-0 flex flex-col overflow-hidden rounded-none bg-[#121722]/[0.97] pl-[env(safe-area-inset-left,0px)] pr-[env(safe-area-inset-right,0px)] animate-sheet-up motion-reduce:animate-none md:rounded-2xl",
          VARIANT[variant],
        )}
      >
        {/* Landscape phones (≤ 500 px tall): title, tabs, chip and × on one row, so the body keeps
            most of the height instead of ~170 px; the tabs get narrower so the side sheets' three tabs
            (Friends) fit beside the chip and × instead of the last one scrolling out of sight. */}
        <header className="flex flex-wrap items-center gap-3 border-b-[3px] border-black bg-[linear-gradient(180deg,#26314d,#18203a)] px-3 py-3 shadow-[inset_0_3px_0_rgba(255,255,255,0.12)] md:px-5 [@media(max-height:500px)]:flex-nowrap [@media(max-height:500px)]:py-2">
          <button
            type="button"
            onClick={onClose}
            aria-label="Back"
            className="menu-chip grid h-11 w-11 shrink-0 place-items-center bg-white text-black md:hidden"
          >
            <svg viewBox="0 0 20 20" className="h-5 w-5" aria-hidden>
              <path d="M12.5 4 6.5 10l6 6" fill="none" stroke="currentColor" strokeWidth="2.8" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
          <h2
            ref={heading}
            id={`${id}-title`}
            tabIndex={-1}
            className="menu-label mr-auto text-3xl leading-none tracking-wide text-white focus:outline-none md:text-4xl [@media(max-height:500px)]:mr-0 [@media(max-height:500px)]:shrink-0 [@media(max-height:500px)]:!text-2xl"
          >
            <span className="optical-center">{title}</span>
          </h2>
          {headerExtra && <div className="contents [@media(max-height:500px)]:flex [@media(max-height:500px)]:shrink-0 [@media(max-height:500px)]:order-2 [@media(max-height:500px)]:empty:hidden">{headerExtra}</div>}
          <button
            type="button"
            onClick={onClose}
            aria-label={`Close ${title}`}
            className="menu-chip hidden h-11 w-11 shrink-0 place-items-center bg-[linear-gradient(180deg,#fb7185,#e11d48)] text-white focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-zooa-lime/70 md:grid [@media(max-height:500px)]:order-3"
          >
            <svg viewBox="0 0 20 20" className="h-5 w-5" aria-hidden>
              <path d="M5 5l10 10M15 5 5 15" stroke="currentColor" strokeWidth="3.2" strokeLinecap="round" />
            </svg>
          </button>
          {tabs.length > 1 && (
            <div
              role="tablist"
              aria-label={`${title} sections`}
              className="flex w-full gap-2 overflow-x-auto px-0.5 pb-1.5 pt-0.5 [@media(max-height:500px)]:order-1 [@media(max-height:500px)]:w-auto [@media(max-height:500px)]:min-w-0 [@media(max-height:500px)]:flex-1"
            >
              {tabs.map((t, i) => {
                const on = t === tab;
                return (
                  <button
                    key={t}
                    ref={(el) => {
                      tabRefs.current[i] = el;
                    }}
                    type="button"
                    role="tab"
                    aria-selected={on}
                    aria-controls={`${id}-body`}
                    tabIndex={on ? 0 : -1}
                    onClick={() => onTab(t)}
                    onKeyDown={(e) => onTabKey(e, i)}
                    className={clsx(
                      "menu-chip min-h-11 shrink-0 px-4 text-sm tracking-wide focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-zooa-lime/70 md:text-base [@media(max-height:500px)]:px-3 [@media(max-height:500px)]:text-sm",
                      on
                        ? "bg-[linear-gradient(180deg,#f0ff7a,#ccff00_55%,#a6d400)] text-black"
                        : "bg-[#141a29] text-white/85 hover:text-white",
                    )}
                  >
                    <span className="optical-center">{tabLabels?.[t] ?? TAB_LABEL[t] ?? t}</span>
                  </button>
                );
              })}
            </div>
          )}
        </header>
        <div
          ref={body}
          id={`${id}-body`}
          role={tabs.length > 1 ? "tabpanel" : undefined}
          className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))] md:p-6 [@media(max-height:500px)]:p-3"
        >
          {children}
        </div>
      </section>
    </div>
  );
}
