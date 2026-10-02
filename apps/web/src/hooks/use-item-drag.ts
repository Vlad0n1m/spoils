"use client";

/**
 * Pointer-events drag and drop for inventory tiles (no dependency, works with mouse, pen and
 * touch). A tile spreads `bind(source)` on itself; drop targets are any elements carrying
 * `data-drop="self:<SlotKey>" | "ground" | "loot"` (the hook hit-tests with elementFromPoint, so
 * targets need no handlers and the ghost never steals the hit test: it is pointer-events:none).
 *
 * A press that moves less than DRAG_THRESHOLD_PX is a click: the hook does nothing and the tile's
 * own onClick runs. After a real drag the click that the browser synthesises is swallowed.
 */

import { useCallback, useEffect, useRef, useState } from "react";

export const DRAG_THRESHOLD_PX = 6;

export interface DragSource {
  from: "self" | "loot";
  /** Own SlotKey or loot index. */
  key: string;
  /** Item def (ghost icon + drop-target highlighting). */
  def: string;
  /** Stale guard copied from what was rendered. */
  uid: string;
}

export type DropTarget =
  | { kind: "self"; key: string }
  /** Outside the panels: drop on the ground. */
  | { kind: "ground" }
  /** Back onto the loot panel: no-op (containers are take-only). */
  | { kind: "loot" };

export interface DragState {
  source: DragSource;
  /** Pointer position in CSS px (ghost). */
  x: number;
  y: number;
  /** Target under the pointer right now (for highlighting). */
  over: DropTarget | null;
}

/** Parse a `data-drop` attribute value. Pure, unit-tested. */
export function parseDropTarget(attr: string | null | undefined): DropTarget | null {
  if (!attr) return null;
  if (attr === "ground") return { kind: "ground" };
  if (attr === "loot") return { kind: "loot" };
  if (attr.startsWith("self:") && attr.length > 5) return { kind: "self", key: attr.slice(5) };
  return null;
}

export function passedThreshold(dx: number, dy: number, threshold = DRAG_THRESHOLD_PX): boolean {
  return dx * dx + dy * dy >= threshold * threshold;
}

/** Walk up from the hit element to the nearest `data-drop`. */
function targetAt(x: number, y: number): DropTarget | null {
  if (typeof document === "undefined") return null;
  let el = document.elementFromPoint(x, y) as HTMLElement | null;
  while (el) {
    const t = parseDropTarget(el.dataset?.drop);
    if (t) return t;
    el = el.parentElement;
  }
  return null;
}

export interface UseItemDrag {
  drag: DragState | null;
  /** Props to spread on a draggable tile. */
  bind(source: DragSource | null): {
    onPointerDown?: (e: React.PointerEvent<HTMLElement>) => void;
    onClickCapture?: (e: React.MouseEvent<HTMLElement>) => void;
  };
}

/**
 * `onDrop(source, target)` fires once per completed drag. `target` is null when released over
 * something that is not a drop zone (e.g. the panel background) — callers treat that as cancel.
 */
export function useItemDrag(onDrop: (source: DragSource, target: DropTarget | null) => void): UseItemDrag {
  const [drag, setDrag] = useState<DragState | null>(null);
  const onDropRef = useRef(onDrop);
  onDropRef.current = onDrop;
  const suppressClick = useRef(false);
  const cleanup = useRef<(() => void) | null>(null);

  useEffect(() => () => cleanup.current?.(), []);

  const start = useCallback((e: React.PointerEvent<HTMLElement>, source: DragSource) => {
    if (e.button !== 0 || !e.isPrimary) return;
    cleanup.current?.();
    const sx = e.clientX;
    const sy = e.clientY;
    let active = false;

    const move = (ev: PointerEvent) => {
      if (!active) {
        if (!passedThreshold(ev.clientX - sx, ev.clientY - sy)) return;
        active = true;
      }
      ev.preventDefault();
      setDrag({ source, x: ev.clientX, y: ev.clientY, over: targetAt(ev.clientX, ev.clientY) });
    };
    const up = (ev: PointerEvent) => {
      stop();
      if (!active) return;
      suppressClick.current = true;
      // The synthetic click follows pointerup in the same task; clear the flag right after it.
      window.setTimeout(() => (suppressClick.current = false), 0);
      setDrag(null);
      onDropRef.current(source, targetAt(ev.clientX, ev.clientY));
    };
    const cancel = () => {
      stop();
      setDrag(null);
    };
    const key = (ev: KeyboardEvent) => {
      if (ev.code === "Escape" && active) {
        ev.stopPropagation();
        cancel();
      }
    };
    function stop() {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
      window.removeEventListener("keydown", key, true);
      cleanup.current = null;
    }
    window.addEventListener("pointermove", move, { passive: false });
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel);
    window.addEventListener("keydown", key, true);
    cleanup.current = cancel;
  }, []);

  const bind = useCallback(
    (source: DragSource | null) => {
      if (!source) return {};
      return {
        onPointerDown: (e: React.PointerEvent<HTMLElement>) => start(e, source),
        onClickCapture: (e: React.MouseEvent<HTMLElement>) => {
          if (suppressClick.current) {
            e.stopPropagation();
            e.preventDefault();
          }
        },
      };
    },
    [start],
  );

  return { drag, bind };
}
