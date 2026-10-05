"use client";

import { Children, cloneElement, isValidElement, useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type ElementType, type ReactElement, type ReactNode } from "react";
import clsx from "clsx";
import { playUi } from "@/game/audio/ui-sounds";

/**
 * Game-style paging instead of a scroll area (no-scroll menu). The children flow top to bottom into
 * columns exactly as tall as the box (CSS multi-column, `column-fill: auto`); each screenful of
 * `cols` columns is a page. Pages turn with the big ‹ › buttons, the page dots, a horizontal swipe
 * (pointer drag, mouse or finger), the mouse wheel and PageUp / PageDown. Nothing in here scrolls:
 * the box is `overflow: hidden` and the strip of columns moves with a transform.
 *
 * The box takes the free height of its flex column parent (`flex-1 min-h-0`), so every parent
 * up to the panel must be a flex column with a definite height. Children keep their order and
 * never split across a page edge when they fit (`break-inside: avoid`); taller ones still split.
 * The pager bar only shows when there is more than one page.
 */
export function Paged({
  as: Tag = "div",
  children,
  className,
  flowClassName,
  gap = 8,
  colGap = 16,
  minCol = 300,
  maxCols = 1,
  resetKey,
  seek,
  label = "Pages",
  ariaLabel,
  ariaBusy,
}: {
  as?: ElementType;
  children: ReactNode;
  /** The outer box (the viewport and the bar under it). */
  className?: string;
  /** The column strip (the list element when `as` is ul / ol). */
  flowClassName?: string;
  /** Vertical space between the children, px. */
  gap?: number;
  /** Space between the columns of a page, px. */
  colGap?: number;
  /** Narrowest column, px: wider boxes show more columns per page, up to `maxCols`. */
  minCol?: number;
  maxCols?: number;
  /** A new value turns back to the first page (a new tab, filter, sort). */
  resetKey?: unknown;
  /** A selector: after a reset, open the page that holds the first match (e.g. your own row). */
  seek?: string;
  /** Names the pager bar ("Leaderboard pages"). */
  label?: string;
  ariaLabel?: string;
  ariaBusy?: boolean;
}) {
  const view = useRef<HTMLDivElement>(null);
  const flow = useRef<HTMLElement>(null);
  const [geo, setGeo] = useState({ w: 0, cols: 1, pages: 1 });
  const geoRef = useRef(geo);
  const flips = useRef({ at: 0, n: 0 });
  const [page, setPage] = useState(0);
  const sought = useRef(false);

  const pitch = geo.w + colGap;

  const measure = useCallback(() => {
    const v = view.current;
    const f = flow.current;
    if (!v || !f) return;
    const w = v.clientWidth;
    if (w <= 0) return;
    const cols = Math.max(1, Math.min(maxCols, Math.floor((w + colGap) / (minCol + colGap))));
    f.style.columnCount = String(cols);
    // The furthest fragment of the last child: where the strip of columns ends.
    const origin = f.getBoundingClientRect().left;
    let right = 0;
    for (const el of f.querySelectorAll(":scope > :not(.paged-group), .paged-group > :not(.paged-group)"))
      for (const r of el.getClientRects()) right = Math.max(right, r.right - origin);
    const pages = Math.max(1, Math.ceil((right + colGap - 2) / (w + colGap)));
    // Only a real change sets state: this runs after every render.
    const g = geoRef.current;
    if (g.w === w && g.cols === cols && g.pages === pages) return;
    // Safety valve: a box whose width depends on its own content could flip forever; freeze it.
    const now = performance.now();
    const f2 = flips.current;
    if (now - f2.at > 1000) {
      f2.at = now;
      f2.n = 0;
    }
    if (++f2.n > 12) return;
    geoRef.current = { w, cols, pages };
    setGeo(geoRef.current);
  }, [colGap, maxCols, minCol]);

  useLayoutEffect(() => {
    measure();
  });
  useEffect(() => {
    const v = view.current;
    const f = flow.current;
    if (!v || !f) return;
    const ro = new ResizeObserver(() => measure());
    ro.observe(v);
    const mo = new MutationObserver(() => measure());
    mo.observe(f, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["open"] });
    // Web fonts change line heights after the first paint.
    void document.fonts?.ready.then(() => measure());
    return () => {
      ro.disconnect();
      mo.disconnect();
    };
  }, [measure]);

  useEffect(() => {
    setPage(0);
    sought.current = false;
  }, [resetKey]);
  useEffect(() => {
    if (page > geo.pages - 1) setPage(geo.pages - 1);
  }, [geo.pages, page]);

  // Jump to the page with `seek` once per reset (after the rows have arrived).
  useEffect(() => {
    if (!seek || sought.current || !flow.current || geo.w === 0) return;
    const el = flow.current.querySelector(seek);
    if (!el) return;
    sought.current = true;
    const x = el.getBoundingClientRect().left - flow.current.getBoundingClientRect().left + page * pitch;
    setPage(Math.max(0, Math.min(geo.pages - 1, Math.floor((x + 1) / pitch))));
  });

  const { go, dragX, handlers } = usePageTurns(geo.pages, page, setPage, geo.w);

  // Tabbing to a control on another page: open that page (the browser would scroll the box).
  const onFocus = (e: React.FocusEvent) => {
    const v = view.current;
    const f = flow.current;
    if (!v || !f || pitch <= 0) return;
    v.scrollLeft = 0;
    v.scrollTop = 0;
    const x = (e.target as HTMLElement).getBoundingClientRect().left - f.getBoundingClientRect().left + page * pitch;
    const p = Math.max(0, Math.min(geo.pages - 1, Math.floor((x + 1) / pitch)));
    if (p !== page) setPage(p);
  };

  const reduced = typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  const many = geo.pages > 1;

  return (
    <div
      className={clsx("flex min-h-0 flex-1 flex-col", className)}
      onKeyDown={(e) => {
        if (e.key === "PageDown" || e.key === "PageUp") {
          e.preventDefault();
          go(page + (e.key === "PageDown" ? 1 : -1));
        }
      }}
    >
      <div
        ref={view}
        className="relative min-h-[3rem] flex-1 overflow-hidden [touch-action:pan-y_pinch-zoom]"
        {...handlers}
        onFocus={onFocus}
        onScroll={(e) => {
          e.currentTarget.scrollLeft = 0;
          e.currentTarget.scrollTop = 0;
        }}
      >
        <Tag
          ref={flow}
          aria-label={ariaLabel}
          aria-busy={ariaBusy}
          className={clsx("paged-flow h-full", flowClassName)}
          style={{
            columnGap: colGap,
            ["--paged-gap" as string]: `${gap}px`,
            transform: `translate3d(${-page * pitch + dragX}px,0,0)`,
            transition: dragX !== 0 || reduced ? "none" : "transform 260ms cubic-bezier(.2,.8,.2,1)",
          }}
        >
          {children}
        </Tag>
      </div>
      {many && <PagerBar page={page} pages={geo.pages} onGo={go} label={label} />}
    </div>
  );
}

/**
 * Page turning shared by the paged boxes: ‹ › (`go`), a horizontal swipe that follows the finger
 * (`dragX`) and turns past 15 % of the width, one mouse-wheel notch per page; a drag never clicks.
 * Spread `handlers` on the viewport.
 */
function usePageTurns(pages: number, page: number, setPage: (p: number) => void, width: number) {
  const [dragX, setDragX] = useState(0);
  const go = useCallback(
    (to: number, sound = true) => {
      const next = Math.max(0, Math.min(pages - 1, to));
      if (next === page) return;
      if (sound) playUi("click");
      setPage(next);
    },
    [pages, page, setPage],
  );
  const drag = useRef<{ id: number; x: number; y: number; on: boolean } | null>(null);
  const swallowClick = useRef(false);
  const wheelAt = useRef(0);
  const end = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    drag.current = null;
    if (!d.on) return;
    swallowClick.current = true;
    window.setTimeout(() => (swallowClick.current = false), 0);
    const dx = e.clientX - d.x;
    setDragX(0);
    if (Math.abs(dx) > Math.min(90, width * 0.15)) go(page + (dx < 0 ? 1 : -1));
  };
  const handlers = {
    onPointerDown: (e: React.PointerEvent) => {
      if (pages <= 1 || (e.pointerType === "mouse" && e.button !== 0)) return;
      if ((e.target as HTMLElement).closest("input, textarea, select, [data-no-swipe]")) return;
      drag.current = { id: e.pointerId, x: e.clientX, y: e.clientY, on: false };
    },
    onPointerMove: (e: React.PointerEvent<HTMLElement>) => {
      const d = drag.current;
      if (!d || d.id !== e.pointerId) return;
      const dx = e.clientX - d.x;
      if (!d.on) {
        if (Math.abs(dx) < 10 || Math.abs(dx) < Math.abs(e.clientY - d.y)) return;
        d.on = true;
        try {
          e.currentTarget.setPointerCapture(e.pointerId);
        } catch {
          // a synthetic or already-ended pointer: dragging still works without capture
        }
      }
      // Resist past the first and the last page.
      const edge = (page === 0 && dx > 0) || (page === pages - 1 && dx < 0);
      setDragX(edge ? dx / 3 : dx);
    },
    onPointerUp: end,
    onPointerCancel: end,
    onClickCapture: (e: React.MouseEvent) => {
      if (swallowClick.current) {
        e.preventDefault();
        e.stopPropagation();
      }
    },
    // One notch, one page (a cooldown eats the trackpad's inertia).
    onWheel: (e: React.WheelEvent) => {
      if (pages <= 1) return;
      const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
      if (Math.abs(delta) < 12) return;
      const now = performance.now();
      const cool = now - wheelAt.current < 420;
      wheelAt.current = now;
      if (!cool) go(page + (delta > 0 ? 1 : -1));
    },
  };
  return { go, dragX, handlers };
}

/**
 * Same-size tiles (stash items, the sell picker) in pages of a grid sized to the box: as many
 * columns and rows as fit, row by row, a page per screenful, turned like `Paged`. The tiles are
 * the children (keyed elements, e.g. <li>); the first one sets the tile size.
 */
export function PagedTiles({
  as: Tag = "ul",
  children,
  className,
  gap = 8,
  resetKey,
  label = "Pages",
}: {
  as?: ElementType;
  children: ReactNode;
  className?: string;
  /** Space between the tiles, px. */
  gap?: number;
  resetKey?: unknown;
  label?: string;
}) {
  const view = useRef<HTMLDivElement>(null);
  const flow = useRef<HTMLElement>(null);
  const items = Children.toArray(children).filter(isValidElement) as Array<ReactElement<{ style?: React.CSSProperties }>>;
  const [geo, setGeo] = useState({ w: 0, h: 0, tw: 0, th: 0 });
  const [page, setPage] = useState(0);

  const measure = useCallback(() => {
    const v = view.current;
    const first = flow.current?.firstElementChild as HTMLElement | null;
    if (!v || !first) return;
    const next = { w: v.clientWidth, h: v.clientHeight, tw: first.offsetWidth, th: first.offsetHeight };
    setGeo((g) => (g.w === next.w && g.h === next.h && g.tw === next.tw && g.th === next.th ? g : next));
  }, []);
  useLayoutEffect(() => {
    measure();
  }, [measure, items.length]);
  useEffect(() => {
    const v = view.current;
    if (!v) return;
    const ro = new ResizeObserver(() => measure());
    ro.observe(v);
    return () => ro.disconnect();
  }, [measure]);

  const cols = geo.tw > 0 ? Math.max(1, Math.floor((geo.w + gap) / (geo.tw + gap))) : 1;
  const rows = geo.th > 0 ? Math.max(1, Math.floor((geo.h + gap) / (geo.th + gap))) : 1;
  const per = cols * rows;
  const pages = Math.max(1, Math.ceil(items.length / per));
  const pitch = geo.w + gap;
  const inset = Math.max(0, (geo.w - (cols * geo.tw + (cols - 1) * gap)) / 2);

  useEffect(() => setPage(0), [resetKey]);
  useEffect(() => {
    if (page > pages - 1) setPage(pages - 1);
  }, [pages, page]);
  const { go, dragX, handlers } = usePageTurns(pages, page, setPage, geo.w);
  const reduced = typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

  return (
    <div className={clsx("flex min-h-0 flex-1 flex-col", className)}>
      <div
        ref={view}
        className="relative min-h-[3rem] flex-1 overflow-hidden [touch-action:pan-y_pinch-zoom]"
        {...handlers}
        onFocus={(e) => {
          e.currentTarget.scrollLeft = 0;
          e.currentTarget.scrollTop = 0;
          const i = items.findIndex((_, j) => flow.current?.children[j]?.contains(e.target as Node));
          if (i >= 0 && Math.floor(i / per) !== page) setPage(Math.floor(i / per));
        }}
        onScroll={(e) => {
          e.currentTarget.scrollLeft = 0;
          e.currentTarget.scrollTop = 0;
        }}
      >
        <Tag
          ref={flow}
          className="absolute inset-0"
          style={{
            transform: `translate3d(${-page * pitch + dragX}px,0,0)`,
            transition: dragX !== 0 || reduced ? "none" : "transform 260ms cubic-bezier(.2,.8,.2,1)",
          }}
        >
          {items.map((el, i) => {
            const p = Math.floor(i / per);
            const k = i % per;
            const pos: React.CSSProperties =
              geo.tw > 0
                ? { position: "absolute", left: p * pitch + inset + (k % cols) * (geo.tw + gap), top: Math.floor(k / cols) * (geo.th + gap) }
                : { position: "absolute", left: 0, top: 0, visibility: "hidden" };
            return cloneElement(el, { style: { ...el.props.style, ...pos } });
          })}
        </Tag>
      </div>
      {pages > 1 && <PagerBar page={page} pages={pages} onGo={go} label={label} />}
    </div>
  );
}

/** ‹ dots › (or "3 / 12" past six pages, so it fits a narrow column): the pager bar under a paged box. */
export function PagerBar({
  page,
  pages,
  onGo,
  label,
  className,
}: {
  page: number;
  pages: number;
  onGo: (p: number) => void;
  label: string;
  className?: string;
}) {
  return (
    <nav aria-label={label} className={clsx("mt-2 flex shrink-0 items-center justify-center gap-2 short:mt-1.5", className)}>
      <PagerArrow dir={-1} disabled={page <= 0} onClick={() => onGo(page - 1)} />
      {pages <= 6 ? (
        <span className="flex items-center">
          {Array.from({ length: pages }, (_, i) => (
            <button
              key={i}
              type="button"
              aria-label={`Page ${i + 1} of ${pages}`}
              aria-current={i === page ? "page" : undefined}
              onClick={() => onGo(i)}
              className="grid h-11 min-w-6 place-items-center px-1 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-zooa-lime/70 short:h-9"
            >
              <span
                className={clsx(
                  "block h-3 rounded-full border-2 border-black transition-all",
                  i === page ? "w-6 bg-zooa-lime shadow-[0_2px_0_#000]" : "w-3 bg-white/35",
                )}
              />
            </button>
          ))}
        </span>
      ) : (
        <span className="toon-text-thin min-w-[4.5rem] text-center text-lg tabular-nums text-white" aria-live="polite">
          {page + 1} / {pages}
        </span>
      )}
      <PagerArrow dir={1} disabled={page >= pages - 1} onClick={() => onGo(page + 1)} />
    </nav>
  );
}

export function PagerArrow({ dir, disabled, onClick, className }: { dir: -1 | 1; disabled: boolean; onClick: () => void; className?: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={dir < 0 ? "Previous page" : "Next page"}
      className={clsx(
        "menu-chip grid h-11 w-11 shrink-0 place-items-center bg-white text-black disabled:opacity-35 short:h-9 short:w-9",
        className,
      )}
    >
      <svg viewBox="0 0 20 20" className="h-5 w-5" aria-hidden>
        <path
          d={dir < 0 ? "M12.5 4 6.5 10l6 6" : "M7.5 4l6 6-6 6"}
          fill="none"
          stroke="currentColor"
          strokeWidth="2.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </button>
  );
}

/**
 * A horizontal carousel (reward roads, the pass track): the strip is `overflow: hidden`, so the
 * player never scrolls it; ‹ › (`by`) turn it a screenful at a time, snapped to a child's edge, and
 * a swipe / drag or the mouse wheel does the same. `edge` disables the arrows at the ends.
 * Spread `handlers` on the strip; the strip's first element child holds the items.
 */
export function useCarousel<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [edge, setEdge] = useState({ start: true, end: true });

  const sync = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const start = el.scrollLeft < 8;
    const end = el.scrollLeft + el.clientWidth > el.scrollWidth - 8;
    setEdge((e) => (e.start === start && e.end === end ? e : { start, end }));
  }, []);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    sync();
    const ro = new ResizeObserver(sync);
    ro.observe(el);
    el.addEventListener("scroll", sync, { passive: true });
    return () => {
      ro.disconnect();
      el.removeEventListener("scroll", sync);
    };
  }, [sync]);

  /** Scroll to `left`, snapped to the nearest item edge at or before it. */
  const to = useCallback((left: number, smooth = true) => {
    const el = ref.current;
    if (!el) return;
    const items = [...(el.firstElementChild?.children ?? [])] as HTMLElement[];
    const max = el.scrollWidth - el.clientWidth;
    let x = Math.max(0, Math.min(max, left));
    if (x > 0 && x < max) {
      const snap = items.map((c) => c.offsetLeft - 8).filter((o) => o <= x + 1);
      if (snap.length) x = Math.max(0, snap[snap.length - 1]!);
    }
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    el.scrollTo({ left: x, behavior: smooth && !reduced ? "smooth" : "auto" });
  }, []);

  const by = useCallback(
    (dir: 1 | -1, sound = true) => {
      const el = ref.current;
      if (!el) return;
      if (sound) playUi("click");
      const step = Math.max(80, el.clientWidth * 0.85);
      if (dir > 0) {
        // The first item that does not fit whole becomes the first one on screen.
        const items = [...(el.firstElementChild?.children ?? [])] as HTMLElement[];
        const cut = items.find((c) => c.offsetLeft + c.offsetWidth > el.scrollLeft + el.clientWidth + 1);
        to(cut && cut.offsetLeft - 8 > el.scrollLeft + 8 ? cut.offsetLeft - 8 : el.scrollLeft + step);
      } else {
        to(el.scrollLeft - step);
      }
    },
    [to],
  );

  const drag = useRef<{ id: number; x: number; y: number; left: number; on: boolean } | null>(null);
  const swallow = useRef(false);
  const wheelAt = useRef(0);
  const handlers = {
    onPointerDown: (e: React.PointerEvent) => {
      const el = ref.current;
      if (!el || (e.pointerType === "mouse" && e.button !== 0)) return;
      if ((e.target as HTMLElement).closest("input, textarea, select, [data-no-swipe]")) return;
      drag.current = { id: e.pointerId, x: e.clientX, y: e.clientY, left: el.scrollLeft, on: false };
    },
    onPointerMove: (e: React.PointerEvent) => {
      const d = drag.current;
      const el = ref.current;
      if (!d || !el || d.id !== e.pointerId) return;
      const dx = e.clientX - d.x;
      if (!d.on) {
        if (Math.abs(dx) < 10 || Math.abs(dx) < Math.abs(e.clientY - d.y)) return;
        d.on = true;
        try {
          el.setPointerCapture(e.pointerId);
        } catch {
          // a synthetic or already-ended pointer: dragging still works without capture
        }
      }
      el.scrollLeft = d.left - dx;
    },
    onPointerUp: (e: React.PointerEvent) => {
      const d = drag.current;
      const el = ref.current;
      if (!d || !el || d.id !== e.pointerId) return;
      drag.current = null;
      if (!d.on) return;
      swallow.current = true;
      window.setTimeout(() => (swallow.current = false), 0);
      const dx = e.clientX - d.x;
      // A flick turns a whole screenful; a slow drag just settles on an item edge.
      if (Math.abs(dx) > 60) {
        el.scrollLeft = d.left;
        by(dx < 0 ? 1 : -1, false);
      } else to(el.scrollLeft);
    },
    onPointerCancel: (e: React.PointerEvent) => {
      if (drag.current?.id === e.pointerId) drag.current = null;
    },
    onClickCapture: (e: React.MouseEvent) => {
      if (swallow.current) {
        e.preventDefault();
        e.stopPropagation();
      }
    },
    onWheel: (e: React.WheelEvent) => {
      const el = ref.current;
      if (!el || el.scrollWidth <= el.clientWidth + 2) return;
      const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
      if (Math.abs(delta) < 12) return;
      const now = performance.now();
      const cool = now - wheelAt.current < 420;
      wheelAt.current = now;
      if (!cool) by(delta > 0 ? 1 : -1, false);
    },
  };
  return { ref, edge, by, to, handlers };
}

/**
 * Sub-pages of a screen as a row of chips (Level road · Task marks · Locker): a game-style switch
 * instead of one long panel to scroll. ←/→ move between the chips.
 */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
  label,
  className,
}: {
  options: ReadonlyArray<{ id: T; label: ReactNode; dot?: boolean }>;
  value: T;
  onChange: (v: T) => void;
  label: string;
  className?: string;
}) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  return (
    <div role="tablist" aria-label={label} className={clsx("flex shrink-0 gap-1.5 rounded-2xl border-[3px] border-black bg-black/35 p-1", className)}>
      {options.map((o, i) => {
        const on = o.id === value;
        return (
          <button
            key={o.id}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="tab"
            aria-selected={on}
            tabIndex={on ? 0 : -1}
            onClick={() => {
              if (!on) playUi("click");
              onChange(o.id);
            }}
            onKeyDown={(e) => {
              if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
              e.preventDefault();
              e.stopPropagation();
              const j = (i + (e.key === "ArrowRight" ? 1 : options.length - 1)) % options.length;
              onChange(options[j]!.id);
              refs.current[j]?.focus();
            }}
            className={clsx(
              "relative min-h-10 whitespace-nowrap rounded-xl px-3 text-sm tracking-wide focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-zooa-lime/70 short:min-h-9 short:px-2.5",
              on ? "bg-white text-black shadow-[0_3px_0_#000]" : "text-white/80 hover:text-white",
            )}
          >
            <span className="optical-center">{o.label}</span>
            {o.dot && <span className="absolute -right-0.5 -top-0.5 h-2.5 w-2.5 rounded-full border-2 border-black bg-rose-500" aria-hidden />}
          </button>
        );
      })}
    </div>
  );
}

const SHORT_QUERY = "(max-height: 500px)";
const subscribeShort = (cb: () => void) => {
  const m = window.matchMedia(SHORT_QUERY);
  m.addEventListener("change", cb);
  return () => m.removeEventListener("change", cb);
};

/** Landscape phone height (Tailwind `short`, ≤ 500 px tall): lists switch to their compact tiles. */
export function useShortScreen(): boolean {
  return useSyncExternalStore(subscribeShort, () => window.matchMedia(SHORT_QUERY).matches, () => false);
}
