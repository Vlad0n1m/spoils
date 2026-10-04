"use client";

/**
 * Tab inventory overlay for the raid (WP-B2): equipment (W1/W2/armor/backpack), 4 pockets, the
 * backpack grid sized by its level, carry value, plus the search panel docked to the right while
 * a container or corpse is open.
 *
 * Interactions (all keyboard reachable: tiles are buttons, Enter/Space = click):
 * - click: quick action — equip/unequip weapons, armor, backpacks; use a med; move a stack
 *   pocket ↔ backpack; take a loot item (auto-place)
 * - drag onto a slot: targeted move / swap / targeted take; drag onto the dimmed backdrop: drop
 * - right-click or Delete/G on a focused own item: drop on the ground
 * - arrow keys: move focus between tiles; T take all; Esc close (bindInventoryHotkeys)
 *
 * `InventoryOverlay` binds to an InventoryClient; `InventoryView` is the pure, props-only part
 * (used by the dev page and tests).
 */

import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore, type KeyboardEvent } from "react";
import clsx from "clsx";
import {
  POCKET_SLOTS,
  accepts,
  bagKeys,
  isSlotKey,
  itemDef,
  type SlotKey,
} from "@extract/shared";
import type { InvSnapshot, InventoryClient } from "@/game/inventory-client";
import { useItemDrag, type DragSource, type DropTarget } from "@/hooks/use-item-drag";
import { describeItem, fmtCr, quickTarget, recordStore } from "@/lib/items-ui";
import { useTouchMode } from "@/components/use-touch-mode";
import { InvSlot } from "./inv-slot";
import { SearchPanel } from "./search-panel";

export type InventoryActions = Pick<
  InventoryClient,
  "move" | "take" | "takeAll" | "drop" | "closeSearch" | "useMed" | "escape" | "dismissToast"
>;

export interface InventoryOverlayProps {
  client: InventoryClient;
}

/** Store-bound overlay: re-renders only when the inventory snapshot changes. */
export function InventoryOverlay({ client }: InventoryOverlayProps) {
  const snap = useSyncExternalStore(client.subscribe, client.getSnapshot, client.getSnapshot);
  return <InventoryView snap={snap} clockMs={client.clockMs} actions={client} />;
}

export interface InventoryViewProps {
  snap: InvSnapshot;
  clockMs: () => number;
  actions: InventoryActions;
}

/** Is `target` a slot that can receive the dragged item? (highlight only; the server decides). */
export function dropAllowed(snap: InvSnapshot, source: DragSource, target: DropTarget | null): boolean {
  if (!target) return false;
  if (target.kind === "ground") return source.from === "self";
  if (target.kind === "loot") return false;
  if (!isSlotKey(target.key)) return false;
  if (source.from === "self" && source.key === target.key) return false;
  const d = itemDef(source.def);
  if (!d || !accepts(target.key, d)) return false;
  if (/^b\d/.test(target.key)) {
    const lvl = source.from === "self" && source.key === "bp" ? 0 : snap.bpLevel;
    if (!bagKeys(lvl).includes(target.key as SlotKey)) return false;
  }
  return true;
}

export function InventoryView({ snap, clockMs, actions }: InventoryViewProps) {
  const store = useMemo(() => recordStore(snap.slots), [snap.slots]);
  // Touch (phones, the TWA): a real Close button instead of the Tab hint, tap / drag wording.
  const touch = useTouchMode();
  const rootRef = useRef<HTMLDivElement | null>(null);

  const onDrop = useCallback(
    (source: DragSource, target: DropTarget | null) => {
      if (!target || !dropAllowed(snap, source, target)) return;
      if (target.kind === "ground") {
        if (source.from === "self" && isSlotKey(source.key)) actions.drop(source.key);
        return;
      }
      if (target.kind === "self" && isSlotKey(target.key)) {
        actions.move({ from: source.from, key: source.key, to: target.key, expect: { uid: source.uid, def: source.def } });
      }
    },
    [actions, snap],
  );
  const drag = useItemDrag(onDrop);

  const clickOwn = useCallback(
    (key: SlotKey) => {
      const it = snap.slots[key];
      if (!it) return;
      const d = itemDef(it.def);
      if (d?.cat === "med" && d.med) {
        actions.useMed(d.med);
        return;
      }
      const to = quickTarget(store, key, snap.active);
      if (to === null) return;
      actions.move({ from: "self", key, ...(to === "auto" ? {} : { to }), expect: { uid: it.uid, def: it.def } });
    },
    [actions, snap.slots, snap.active, store],
  );

  // Focus the panel when it opens so arrow keys / Enter work without a mouse.
  useEffect(() => {
    if (!snap.visible) return;
    const first = rootRef.current?.querySelector<HTMLElement>("button[data-drop^='self:'], section[data-drop='loot'] button");
    if (first && !rootRef.current?.contains(document.activeElement)) first.focus({ preventScroll: true });
  }, [snap.visible, snap.search?.key]);

  const onKeyDown = useCallback(
    (e: KeyboardEvent<HTMLDivElement>) => {
      const el = document.activeElement as HTMLElement | null;
      // Space is roll: it must never "click" the focused tile (the event still reaches the game).
      if (e.code === "Space") {
        e.preventDefault();
        return;
      }
      if ((e.code === "Delete" || e.code === "Backspace" || e.code === "KeyG") && el?.dataset.drop?.startsWith("self:")) {
        const key = el.dataset.drop.slice(5);
        if (isSlotKey(key) && snap.slots[key]) {
          e.preventDefault();
          actions.drop(key);
        }
        return;
      }
      if (e.code.startsWith("Arrow")) {
        const tiles = [...(rootRef.current?.querySelectorAll<HTMLElement>("button[title]") ?? [])].filter(
          (b) => !b.hasAttribute("disabled"),
        );
        const i = el ? tiles.indexOf(el) : -1;
        const step = e.code === "ArrowLeft" || e.code === "ArrowUp" ? -1 : 1;
        const next = tiles[(i + step + tiles.length) % Math.max(1, tiles.length)];
        if (next) {
          e.preventDefault();
          next.focus();
        }
      }
    },
    [actions, snap.slots],
  );

  if (!snap.visible) return null;

  const dragging = drag.drag;
  const ownTile = (key: SlotKey, opts: { size?: "sm" | "md" | "lg"; hotkey?: string; caption?: string } = {}) => {
    const it = snap.slots[key] ?? null;
    const over = dragging?.over;
    const isOver = over?.kind === "self" && over.key === key;
    const ok = isOver && dragging ? dropAllowed(snap, dragging.source, over) : false;
    const src: DragSource | null = it ? { from: "self", key, def: it.def, uid: it.uid } : null;
    return (
      <InvSlot
        key={key}
        item={it}
        slotKey={key}
        caption={opts.caption}
        size={opts.size ?? "md"}
        hotkey={opts.hotkey}
        active={(key === "w1" || key === "w2") && snap.active === key && !!it}
        dropId={`self:${key}`}
        pending={!!snap.pending[`self:${key}`]}
        dropOk={ok}
        dropBad={isOver && !ok}
        dragging={dragging?.source.from === "self" && dragging.source.key === key}
        onClick={it ? () => clickOwn(key) : () => undefined}
        onContextMenu={it ? () => actions.drop(key) : undefined}
        {...drag.bind(src)}
      />
    );
  };

  const pockets = Array.from({ length: POCKET_SLOTS }, (_, i) => `p${i}` as SlotKey);
  const bag = bagKeys(snap.bpLevel);
  const groundOver = dragging?.over?.kind === "ground" && dragging.source.from === "self";

  return (
    <div
      ref={rootRef}
      className="fixed inset-0 z-[70] flex items-start justify-center overflow-y-auto p-3 pt-[8vh] sm:p-6 sm:pt-[10vh] [@media(max-height:500px)]:p-2"
      onKeyDown={onKeyDown}
      onKeyUp={(e) => {
        if (e.code === "Space") e.preventDefault();
      }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {/* Backdrop = the ground: release a dragged own item here to drop it; a plain click closes. */}
      <div
        data-drop="ground"
        className={clsx(
          "absolute inset-0 bg-[radial-gradient(ellipse_at_center,rgba(6,8,12,0.35),rgba(6,8,12,0.78))] transition-colors",
          groundOver && "bg-rose-950/40",
        )}
        onClick={() => actions.escape()}
        aria-hidden
      />
      {groundOver && (
        <div className="toon-chip pointer-events-none fixed bottom-8 left-1/2 z-[2] -translate-x-1/2 px-4 py-2 text-base text-rose-300">
          Release to drop on the ground
        </div>
      )}

      {/* Landscape phones (≤ 500 px tall): inventory (24 rem) and the search panel (20 rem) side by
          side from ~732 px wide, so the loot is on screen next to the bag; narrower, the loot comes first. */}
      <div className="relative flex flex-wrap items-start justify-center gap-4 [@media(max-height:500px)]:gap-3">
        <section aria-label="Inventory" className="toon-panel w-[min(92vw,25rem)] bg-[#1d2333]/95 p-4 [@media(max-height:500px)]:w-[24rem] [@media(max-height:500px)]:p-3">
          <header className="flex items-center justify-between">
            <h2 className="toon-text text-2xl tracking-wide text-white">Inventory</h2>
            {touch ? (
              <button
                type="button"
                onClick={() => {
                  // Closes the search first, then the inventory (both when both are open).
                  for (let i = 0; i < 3 && actions.escape(); i++);
                }}
                className="toon-btn-ghost h-11 min-w-11 shrink-0 px-3 text-sm"
                aria-label="Close inventory"
              >
                <span className="optical-center">Close</span>
              </button>
            ) : (
              <span className="flex items-center gap-1.5 text-xs text-white/60">
                <span className="toon-key">Tab</span> close
              </span>
            )}
          </header>

          <div className="mt-4 grid grid-cols-[auto_1fr] gap-x-4 gap-y-3">
            <div className="flex flex-col gap-2">
              <SectionLabel>Weapons</SectionLabel>
              <div className="flex gap-2">
                {ownTile("w1", { size: "lg", hotkey: "1" })}
                {ownTile("w2", { size: "lg", hotkey: "2" })}
              </div>
            </div>
            <div className="flex flex-col gap-2">
              <SectionLabel>Gear</SectionLabel>
              <div className="flex gap-2">
                {ownTile("armor", { size: "lg" })}
                {ownTile("bp", { size: "lg" })}
              </div>
            </div>
          </div>

          <div className="mt-4">
            <SectionLabel>Pockets</SectionLabel>
            <div className="mt-2 grid grid-cols-4 gap-2.5">{pockets.map((k) => ownTile(k))}</div>
          </div>

          <div className="mt-4">
            <SectionLabel>
              {snap.slots.bp ? describeItem(snap.slots.bp).name : "Backpack"}
              <span className="ml-2 tabular-nums text-white/40">
                {bag.filter((k) => snap.slots[k]).length}/{bag.length}
              </span>
            </SectionLabel>
            {bag.length > 0 ? (
              <div className="mt-2 grid grid-cols-4 gap-2.5">{bag.map((k) => ownTile(k))}</div>
            ) : (
              <p className="font-body mt-2 rounded-xl border-2 border-dashed border-white/20 px-3 py-3 text-sm text-white/55">
                No backpack — find one to carry more loot out.
              </p>
            )}
          </div>

          <footer className="mt-4 flex flex-wrap items-center justify-between gap-2 border-t-[3px] border-black/50 pt-3">
            <span className="text-sm text-white/70" title="Auto-sale value of carried junk if you extract (before market multiplier)">
              Junk value <span className="toon-text-thin ml-1 text-lg text-amber-300">{fmtCr(snap.carry.junkCr)}</span>
            </span>
            <span className="text-sm tabular-nums text-white/60">
              Slots {snap.carry.used}/{snap.carry.cap}
            </span>
          </footer>
          <p className="font-body mt-2 text-[0.7rem] leading-snug text-white/45">
            {touch
              ? "Tap to equip / use · drag to move · drag onto the dark area to drop"
              : "Click to equip / use · drag to move · right-click or Del to drop"}
          </p>
        </section>

        {snap.search && (
          <SearchPanel
            search={snap.search}
            pending={snap.pending}
            clockMs={clockMs}
            drag={drag}
            onTake={(i, it) => actions.move({ from: "loot", key: String(i), expect: { uid: it.uid, def: it.def } })}
            onTakeAll={() => actions.takeAll()}
            onClose={() => actions.closeSearch()}
            touch={touch}
          />
        )}
      </div>

      {snap.toast && (
        <div
          key={snap.toast.id}
          role="alert"
          className="toon-chip fixed left-1/2 top-6 z-[3] -translate-x-1/2 animate-outcome-enter cursor-pointer px-5 py-2.5 text-base text-white"
          onClick={() => actions.dismissToast()}
        >
          <span className={snap.toast.code === "info" ? "text-zooa-lime" : "text-rose-300"}>{snap.toast.text}</span>
        </div>
      )}

      {dragging && <DragGhost def={dragging.source.def} x={dragging.x} y={dragging.y} />}
    </div>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return <h3 className="text-xs uppercase tracking-[0.18em] text-white/55">{children}</h3>;
}

function DragGhost({ def, x, y }: { def: string; x: number; y: number }) {
  const d = describeItem({ def });
  return (
    <div
      className="pointer-events-none fixed z-[5] grid h-16 w-16 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-xl border-[3px] border-black shadow-[0_6px_0_#000]"
      style={{ left: x, top: y, background: `radial-gradient(circle at 50% 35%, ${d.color}e6, ${d.color}66 72%)` }}
      aria-hidden
    >
      {/* eslint-disable-next-line @next/next/no-img-element -- static sprite */}
      <img src={d.icon} alt="" className="h-12 w-12 object-contain" draggable={false} />
    </div>
  );
}

