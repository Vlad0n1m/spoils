"use client";

/**
 * Search panel for a container or corpse (docked next to the inventory overlay). While the open
 * delay runs it shows a progress ring; afterwards items appear one by one in index order (the
 * server only ever sends revealed items), the cell being revealed shows a filling "?" ring.
 * Click = take (auto-place), drag onto your own slot = targeted take, T / button = take all,
 * Esc / button = close. Pure props; the clock is read per animation frame from `clockMs()`.
 */

import { useEffect, useState } from "react";
import clsx from "clsx";
import { ITEM_FLAG } from "@extract/shared";
import type { InvItemView, SearchView } from "@/game/inventory-client";
import type { DragSource, UseItemDrag } from "@/hooks/use-item-drag";
import { InvSlot } from "./inv-slot";

export interface SearchPanelProps {
  search: SearchView;
  pending: Readonly<Record<string, true>>;
  clockMs: () => number;
  drag: UseItemDrag;
  onTake: (index: number, item: InvItemView) => void;
  onTakeAll: () => void;
  onClose: () => void;
  /** Touch HUD: a 44 px "Close" instead of the Esc keycap, no T keycap on Take all. */
  touch?: boolean;
}

/** Sprite for the panel header. */
export function searchIcon(s: Pick<SearchView, "kind" | "containerKind" | "tier">): string {
  if (s.kind === "corpse") return "/sprites/corpse.png";
  if (s.containerKind === "crate" || s.containerKind === "toolbox" || s.containerKind === "med_case") {
    return "/sprites/crate.png";
  }
  const t = Math.max(0, Math.min(4, s.tier));
  return `/sprites/chest_${t <= 1 ? "common" : t === 2 ? "rare" : t === 3 ? "epic" : "legendary"}.png`;
}

/** Re-render on every animation frame while `on` (open delay / reveal rings). */
function useFrameClock(clockMs: () => number, on: boolean): number {
  const [t, setT] = useState(() => clockMs());
  useEffect(() => {
    if (!on) {
      setT(clockMs());
      return;
    }
    let raf = 0;
    const tick = () => {
      setT(clockMs());
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [clockMs, on]);
  return t;
}

/** 0..1 of a [from, to] window at `now` (0 when the window is empty or unknown). */
export function windowProgress(from: number, to: number, now: number): number {
  if (!(to > from)) return now >= to ? 1 : 0;
  return Math.max(0, Math.min(1, (now - from) / (to - from)));
}

export function SearchPanel({ search, pending, clockMs, drag, onTake, onTakeAll, onClose, touch = false }: SearchPanelProps) {
  const animating = search.revealed < search.total || !search.loaded;
  const now = useFrameClock(clockMs, animating);
  const opening = now < search.readyAt;
  const openP = windowProgress(search.openStartAt, search.readyAt, now);
  const revealP = search.nextRevealAt > 0 ? windowProgress(search.revealFrom, search.nextRevealAt, now) : 0;
  const allPending = !!pending["loot:*"];
  const done = search.loaded && search.revealed >= search.total;
  const empty = done && search.takeable === 0;

  return (
    <section
      data-drop="loot"
      aria-label={`Searching ${search.title}`}
      className="toon-panel flex w-[min(92vw,22rem)] flex-col bg-[#1d2333]/95 p-4 [@media(max-height:500px)]:w-[20rem] [@media(max-height:500px)]:p-3 [@media(max-height:500px)_and_(max-width:731px)]:order-first"
    >
      <header className="flex items-center gap-3">
        <div className="relative grid h-14 w-14 shrink-0 place-items-center rounded-xl border-[3px] border-black bg-[#2b3142]">
          {/* eslint-disable-next-line @next/next/no-img-element -- static sprite */}
          <img src={searchIcon(search)} alt="" className="h-11 w-11 object-contain" draggable={false} />
          {opening && <OpenRing progress={openP} />}
        </div>
        <div className="min-w-0 flex-1">
          <h2 className="toon-text-thin truncate text-xl tracking-wide text-white [@media(max-height:500px)]:text-lg">{search.title}</h2>
          <p className="font-body mt-0.5 text-xs font-semibold text-white/60">
            {opening
              ? `Opening… ${Math.max(0, (search.readyAt - now) / 1000).toFixed(1)} s`
              : !search.loaded
                ? "Opening…"
                : done
                  ? empty
                    ? "Nothing left"
                    : `${search.total} item${search.total === 1 ? "" : "s"}`
                  : `Searching ${search.revealed}/${search.total}`}
            {search.subtitle && <span className="ml-2 uppercase tracking-wider text-white/40">{search.subtitle}</span>}
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          className={clsx("toon-btn-ghost shrink-0 gap-1.5 text-sm", touch ? "h-11 min-w-11 px-3" : "h-9 px-2.5")}
          aria-label={touch ? "Close search" : "Close search (Esc)"}
        >
          {touch ? <span className="optical-center">Close</span> : <span className="toon-key">Esc</span>}
        </button>
      </header>

      {/* Reveal progress: one bar for the whole container. */}
      <div className="mt-3 h-2.5 overflow-hidden rounded-full border-2 border-black bg-black/50" aria-hidden>
        <div
          className="h-full bg-zooa-lime transition-[width] duration-150"
          style={{
            width: `${opening || !search.total ? openP * 8 : Math.min(100, ((search.revealed + revealP) / search.total) * 100)}%`,
          }}
        />
      </div>

      <div className="mt-4 grid grid-cols-4 gap-2.5" role="list">
        {search.cells.map((c, i) => {
          if (c.kind === "item") {
            const it = c.item;
            const broken = (it.flags & ITEM_FLAG.BROKEN) !== 0;
            const src: DragSource | null = broken ? null : { from: "loot", key: String(i), def: it.def, uid: it.uid };
            const isDragged = drag.drag?.source.from === "loot" && drag.drag.source.key === String(i);
            return (
              <div role="listitem" key={i} className="animate-outcome-enter">
                <InvSlot
                  item={it}
                  pending={!!pending[`loot:${i}`] || (allPending && !broken)}
                  dragging={isDragged}
                  onClick={broken ? undefined : () => onTake(i, it)}
                  {...drag.bind(src)}
                />
              </div>
            );
          }
          const revealing = c.kind === "hidden" && i === search.revealed && !opening && search.nextRevealAt > 0;
          return (
            <div role="listitem" key={i}>
              <InvSlot state={revealing ? "revealing" : c.kind} progress={revealP} />
            </div>
          );
        })}
        {search.loaded && search.total === 0 && (
          <p className="font-body col-span-4 py-4 text-center text-sm text-white/55">Empty.</p>
        )}
        {!search.loaded &&
          Array.from({ length: 4 }, (_, i) => (
            <div key={`ph${i}`} aria-hidden>
              <InvSlot state="hidden" />
            </div>
          ))}
      </div>

      <button
        type="button"
        onClick={onTakeAll}
        disabled={opening || search.takeable === 0 || allPending}
        className="toon-btn mt-4 min-h-12 w-full gap-2 text-lg tracking-wide"
      >
        <span className="optical-center">Take all</span>
        {!touch && <span className="toon-key">T</span>}
      </button>
    </section>
  );
}

function OpenRing({ progress }: { progress: number }) {
  const r = 44;
  const c = 2 * Math.PI * r;
  return (
    <svg viewBox="0 0 100 100" className="pointer-events-none absolute -inset-1.5" aria-hidden>
      <circle cx="50" cy="50" r={r} fill="none" stroke="rgba(0,0,0,0.55)" strokeWidth="8" />
      <circle
        cx="50"
        cy="50"
        r={r}
        fill="none"
        stroke="#CCFF00"
        strokeWidth="8"
        strokeLinecap="round"
        strokeDasharray={`${c * Math.max(0, Math.min(1, progress))} ${c}`}
        transform="rotate(-90 50 50)"
      />
    </svg>
  );
}
