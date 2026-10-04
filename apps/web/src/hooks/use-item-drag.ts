"use client";

/**
 * Pointer-events drag and drop for inventory tiles (no dependency, works with mouse, pen and
 * touch). A tile spreads `bind(source)` on itself; drop targets are any elements carrying
 * `data-drop="self:<SlotKey>" | "ground" | "loot"` (the hook hit-tests with elementFromPoint, so
 * targets need no handlers and the ghost never steals the hit test: it is pointer-events:none).
 *
 * A press that moves less than DRAG_THRESHOLD_PX is a click: the hook does nothing and the tile's
 * own onClick runs. After a real drag the click that the browser synthesises is swallowed. Only
 * the pointer that pressed the tile drives its drag (trackPointerDrag): a thumb held on a touch
 * stick neither blocks nor ends it.
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

/** The pointer fields the drag reads (a DOM PointerEvent, or a plain object in tests). */
export interface DragPointer {
  pointerId: number;
  clientX: number;
  clientY: number;
  button?: number;
  preventDefault?(): void;
}

/** Where the drag listens: `window` in the app, a fake in tests. */
export interface DragEventTarget {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  addEventListener(type: string, fn: (e: any) => void, opts?: AddEventListenerOptions | boolean): void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  removeEventListener(type: string, fn: (e: any) => void, opts?: EventListenerOptions | boolean): void;
}

export interface PointerDragHandlers {
  /** The pointer passed the threshold (first call) or moved on while dragging. */
  move(x: number, y: number): void;
  /** Released after a real drag. */
  drop(x: number, y: number): void;
  /** Cancelled after a real drag started (pointercancel, Escape, or abort()). */
  cancel(): void;
  /** Listening stopped, whatever the reason (also after a plain click). */
  end?(): void;
}

/**
 * A `contextmenu` that came from a finger: Android Chrome fires one on a touch long press, which is
 * how a touch drag usually begins (press, pause, then move). Only a mouse right-click (or a pen's
 * barrel button) may run a tile's right-click action, such as dropping the item on the ground.
 * `lastDownType` is the pointerType of the last pointerdown on that tile (contextmenu itself is a
 * PointerEvent in Chrome only).
 */
export function isTouchContextMenu(ev: { pointerType?: unknown }, lastDownType: string | null): boolean {
  return ev.pointerType === "touch" || lastDownType === "touch";
}

/**
 * A press on a tile may start a drag (left button; every finger, primary or not). Fingers are never
 * gated on isPrimary: on a phone a thumb usually still holds the move or aim stick when the other
 * one drags in the inventory, and only the first finger down is primary.
 */
export function canStartDrag(e: { button: number }): boolean {
  return e.button === 0;
}

/**
 * Follows one pointer from `origin` (its pointerdown) until it is released or cancelled. Events of
 * any other pointer (a thumb held on a touch stick, a second finger) are ignored, so they can
 * neither end nor hijack the drag. A press that moves less than DRAG_THRESHOLD_PX is a click: no
 * handler but `end` runs. Returns abort(): stops listening (idempotent) and cancels a started drag.
 */
export function trackPointerDrag(target: DragEventTarget, origin: DragPointer, h: PointerDragHandlers): () => void {
  const id = origin.pointerId;
  const sx = origin.clientX;
  const sy = origin.clientY;
  let active = false;
  let stopped = false;

  const move = (ev: DragPointer) => {
    if (ev.pointerId !== id) return;
    if (!active) {
      if (!passedThreshold(ev.clientX - sx, ev.clientY - sy)) return;
      active = true;
    }
    ev.preventDefault?.();
    h.move(ev.clientX, ev.clientY);
  };
  const up = (ev: DragPointer) => {
    if (ev.pointerId !== id) return;
    stop();
    if (active) h.drop(ev.clientX, ev.clientY);
  };
  const cancelEvent = (ev: DragPointer) => {
    if (ev.pointerId !== id) return;
    abort();
  };
  const key = (ev: KeyboardEvent) => {
    if (ev.code === "Escape" && active) {
      ev.stopPropagation();
      abort();
    }
  };
  function stop() {
    if (stopped) return;
    stopped = true;
    target.removeEventListener("pointermove", move);
    target.removeEventListener("pointerup", up);
    target.removeEventListener("pointercancel", cancelEvent);
    target.removeEventListener("keydown", key, true);
    h.end?.();
  }
  function abort() {
    if (stopped) return;
    stop();
    if (active) h.cancel();
  }
  target.addEventListener("pointermove", move, { passive: false });
  target.addEventListener("pointerup", up);
  target.addEventListener("pointercancel", cancelEvent);
  target.addEventListener("keydown", key, true);
  return abort;
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
    if (!canStartDrag(e)) return;
    cleanup.current?.();
    const abort = trackPointerDrag(window, e, {
      move: (x, y) => setDrag({ source, x, y, over: targetAt(x, y) }),
      drop: (x, y) => {
        suppressClick.current = true;
        // The synthetic click follows pointerup in the same task; clear the flag right after it.
        window.setTimeout(() => (suppressClick.current = false), 0);
        setDrag(null);
        onDropRef.current(source, targetAt(x, y));
      },
      cancel: () => setDrag(null),
      end: () => {
        if (cleanup.current === abort) cleanup.current = null;
      },
    });
    cleanup.current = abort;
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
