"use client";

import { useMemo, useRef, useState } from "react";
import { fmtClock, type EventCat } from "@/lib/admin/replay-view";

/** Tick colour per event category (the side panel uses the same). */
export const CAT_COLOR: Record<EventCat, string> = {
  kill: "#ff6b6b",
  exit: "#3ee07a",
  spawn: "#74c0fc",
  boss: "#ffa94d",
  loot: "#e3c45a",
  world: "#ffb020",
  wipe: "#ffffff",
};

export interface TimelineTick {
  t: number;
  cat: EventCat;
}

/**
 * Admin replay scrubber: the cycle-clock span of the replay with loaded chunks shaded, gaps (no
 * chunk: dropped or never sent) hatched red, the listed events as coloured ticks and the playhead.
 * Click or drag anywhere to seek; the arrow keys are handled by the viewer.
 */
export function ReplayTimeline({
  start,
  end,
  t,
  loaded,
  gaps,
  ticks,
  onSeek,
}: {
  start: number;
  end: number;
  t: number;
  loaded: ReadonlyArray<readonly [number, number]>;
  gaps: ReadonlyArray<readonly [number, number]>;
  ticks: readonly TimelineTick[];
  onSeek: (t: number) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<{ x: number; t: number } | null>(null);
  const span = Math.max(1, end - start);
  const pct = (v: number) => `${(Math.max(0, Math.min(1, (v - start) / span)) * 100).toFixed(3)}%`;
  // The static layers do not change while the playhead moves (the viewer re-renders ~10 times a second).
  const layers = useMemo(() => {
    const p = (v: number) => `${(Math.max(0, Math.min(1, (v - start) / Math.max(1, end - start))) * 100).toFixed(3)}%`;
    return (
      <>
        {loaded.map(([a, b]) => (
          <div key={`l${a}`} className="absolute inset-y-0 bg-white/[0.09]" style={{ left: p(a), width: `calc(${p(b)} - ${p(a)})` }} />
        ))}
        {gaps.map(([a, b]) => (
          <div
            key={`g${a}`}
            title={`Нет записи ${fmtClock(a)}–${fmtClock(b)}`}
            className="absolute inset-y-0 bg-[repeating-linear-gradient(135deg,rgba(255,90,90,0.35)_0_4px,transparent_4px_8px)]"
            style={{ left: p(a), width: `calc(${p(b)} - ${p(a)})` }}
          />
        ))}
        {ticks.map((k, i) => (
          <div
            key={i}
            className="pointer-events-none absolute top-1.5 bottom-1.5 w-[2px] rounded-full"
            style={{ left: p(k.t), background: CAT_COLOR[k.cat], opacity: k.cat === "boss" ? 0.6 : 0.9 }}
          />
        ))}
      </>
    );
  }, [loaded, gaps, ticks, start, end]);
  const at = (clientX: number) => {
    const r = ref.current!.getBoundingClientRect();
    const k = Math.max(0, Math.min(1, (clientX - r.left) / Math.max(1, r.width)));
    return { x: clientX - r.left, t: start + k * span };
  };
  // Minute marks: every 5 min (every minute on a short replay).
  const step = span > 12 * 60_000 ? 5 * 60_000 : 60_000;
  const marks: number[] = [];
  for (let m = Math.ceil(start / step) * step; m <= end; m += step) marks.push(m);

  return (
    <div className="select-none">
      <div
        ref={ref}
        role="slider"
        aria-label="Время повтора"
        aria-valuemin={Math.round(start / 1000)}
        aria-valuemax={Math.round(end / 1000)}
        aria-valuenow={Math.round(t / 1000)}
        aria-valuetext={fmtClock(t)}
        tabIndex={-1}
        className="relative h-9 cursor-pointer touch-none rounded-md bg-white/[0.06]"
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          onSeek(at(e.clientX).t);
        }}
        onPointerMove={(e) => {
          const p = at(e.clientX);
          setHover(p);
          if (e.currentTarget.hasPointerCapture(e.pointerId)) onSeek(p.t);
        }}
        onPointerLeave={() => setHover(null)}
      >
        {layers}
        <div className="pointer-events-none absolute inset-y-0 -ml-px w-[2px] bg-zooa-lime" style={{ left: pct(t) }}>
          <div className="absolute -top-1 left-1/2 h-2.5 w-2.5 -translate-x-1/2 rounded-full bg-zooa-lime shadow" />
        </div>
        {hover ? (
          <div
            className="pointer-events-none absolute -top-7 -translate-x-1/2 rounded bg-black/85 px-1.5 py-0.5 text-[0.7rem] tabular-nums text-white"
            style={{ left: hover.x }}
          >
            {fmtClock(hover.t)}
          </div>
        ) : null}
      </div>
      <div className="relative mt-1 h-4 text-[0.65rem] tabular-nums text-white/40">
        {marks.map((m) => (
          <span key={m} className="absolute -translate-x-1/2" style={{ left: pct(m) }}>
            {fmtClock(m)}
          </span>
        ))}
      </div>
    </div>
  );
}
