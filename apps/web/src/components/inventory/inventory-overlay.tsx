"use client";

/**
 * In-raid inventory overlay (Tab / I, the touch Bag button): equipment (W1/W2/armor/backpack),
 * 4 pockets, the backpack grid sized by its level, an item bar with the selected item's actions,
 * plus the search panel next to it while a container or corpse is open.
 *
 * Layout (inventory v2):
 * - the panels sit on an opaque backdrop, so the HUD, sticks and buttons never show through;
 * - inventory panel = left column "Equipped" (2×2), right column "Pockets" + "Backpack"; the body
 *   scrolls when it does not fit; the header has a real Close button on every device;
 * - landscape phones (≤ 500 px tall): both panels fill the screen height side by side, and the item
 *   bar replaces the header's title while an item is selected (no footer, the height is precious);
 *   taller screens: the item bar is the panel's footer.
 *
 * Interactions (all keyboard reachable: tiles are buttons, Enter/Space = click):
 * - touch: tap = select (the item bar shows its name, Equip / Use / Move and Drop); tap the selected
 *   item again = its quick action; drag onto a slot = move; drag onto the dark area = drop
 * - mouse: click = quick action (equip/unequip, use a med, pocket ↔ backpack, take loot); hover /
 *   focus = select (item bar); right-click, G or Delete = drop; drag onto a slot / the dark area
 * - arrow keys: move focus between tiles; T take all; Tab / I / Esc close (the game input or
 *   bindInventoryHotkeys)
 * Dropping sends C2S.INV_DROP: the server puts the item on the ground at your feet, where anyone
 * (you too) can pick it up with F; FREE kit items vanish instead ("Discard").
 *
 * `InventoryOverlay` binds to an InventoryClient; `InventoryView` is the pure, props-only part
 * (used by the dev page and tests). A toast raised while the panel is closed (F on an item that
 * does not fit: "Bag full — no room for …") still shows, above the HUD's interact prompt.
 */

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent, type ReactNode } from "react";
import clsx from "clsx";
import {
  EQUIP_KEYS,
  POCKET_SLOTS,
  accepts,
  bagKeys,
  canRemoveBackpack,
  isSlotKey,
  itemDef,
  type SlotKey,
} from "@extract/shared";
import type { InvItemView, InvSnapshot, InvToast, InventoryClient } from "@/game/inventory-client";
import { useItemDrag, type DragSource, type DropTarget } from "@/hooks/use-item-drag";
import { describeItem, durInfo, fmtCr, isBroken, isFree, quickTarget, recordStore } from "@/lib/items-ui";
import { SOL_ECONOMY } from "@/lib/edition";
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

/** What the item bar offers for an own item (pure: unit-tested). */
export interface ItemBarActions {
  /** Quick action label ("Equip", "Unequip", "Use", "To backpack", "To pockets"), null = none. */
  primary: string | null;
  /** "Drop" (lands on the ground), "Discard" (FREE kit: vanishes), null = cannot (full backpack). */
  drop: "Drop" | "Discard" | null;
  /** Why the drop is refused (shown as the disabled button's title). */
  dropBlocked?: string;
}

export function itemBarActions(snap: Pick<InvSnapshot, "slots" | "active">, key: SlotKey): ItemBarActions {
  const it = snap.slots[key];
  if (!it) return { primary: null, drop: null };
  const d = itemDef(it.def);
  const store = recordStore(snap.slots);
  let primary: string | null = null;
  if (d?.cat === "med" && d.med) primary = "Use";
  else {
    const to = quickTarget(store, key, snap.active);
    if (to !== null) {
      const equipped = (EQUIP_KEYS as readonly string[]).includes(key);
      if (equipped) primary = "Unequip";
      else if (to === "w1" || to === "w2" || to === "armor" || to === "bp") primary = "Equip";
      else primary = key.startsWith("p") ? "To backpack" : "To pockets";
    }
  }
  if (key === "bp" && !canRemoveBackpack(store)) {
    return { primary, drop: null, dropBlocked: "Empty the backpack first" };
  }
  return { primary, drop: isFree(it) ? "Discard" : "Drop" };
}

/** Landscape phones (the `short` Tailwind screen): ≤ 500 px tall. */
const SHORT_QUERY = "(max-height: 500px)";
function subscribeShort(cb: () => void) {
  if (typeof window === "undefined" || !window.matchMedia) return () => {};
  const mq = window.matchMedia(SHORT_QUERY);
  mq.addEventListener("change", cb);
  return () => mq.removeEventListener("change", cb);
}
function useShortScreen(): boolean {
  return useSyncExternalStore(
    subscribeShort,
    () => (typeof window !== "undefined" && window.matchMedia ? window.matchMedia(SHORT_QUERY).matches : false),
    () => false,
  );
}

/** Empty equipment tiles: short captions that fit a 44 px tile. */
const EQUIP_CAPTION: Record<string, string> = { w1: "Gun 1", w2: "Gun 2", armor: "Armor", bp: "Pack" };

export function InventoryView({ snap, clockMs, actions }: InventoryViewProps) {
  const store = useMemo(() => recordStore(snap.slots), [snap.slots]);
  const touch = useTouchMode();
  const short = useShortScreen();
  const rootRef = useRef<HTMLDivElement | null>(null);
  /** Own slot shown in the item bar (tap on touch, hover / focus with a mouse). */
  const [selected, setSelected] = useState<SlotKey | null>(null);
  const selItem = selected ? (snap.slots[selected] ?? null) : null;

  // Forget the selection when the panel closes; keep it while the item stays in its slot.
  useEffect(() => {
    if (!snap.visible) setSelected(null);
  }, [snap.visible]);

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

  const quickAction = useCallback(
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

  const clickOwn = useCallback(
    (key: SlotKey) => {
      if (!snap.slots[key]) return;
      if (touch && selected !== key) {
        // Touch: the first tap selects (the item bar shows the actions); the second one acts.
        setSelected(key);
        return;
      }
      setSelected(key);
      quickAction(key);
    },
    [quickAction, selected, snap.slots, touch],
  );

  const dropKey = useCallback(
    (key: SlotKey) => {
      if (snap.slots[key]) actions.drop(key);
    },
    [actions, snap.slots],
  );

  // Focus the panel when it opens so arrow keys / Enter work without a mouse (not on touch: a focus
  // ring on a phone is noise).
  useEffect(() => {
    if (!snap.visible || touch) return;
    const first = rootRef.current?.querySelector<HTMLElement>("button[data-drop^='self:'], section[data-drop='loot'] button[title]");
    if (first && !rootRef.current?.contains(document.activeElement)) first.focus({ preventScroll: true });
  }, [snap.visible, snap.search?.key, touch]);

  const onKeyDown = useCallback(
    (e: KeyboardEvent<HTMLDivElement>) => {
      const el = document.activeElement as HTMLElement | null;
      // Space is roll: it must never "click" the focused tile (the event still reaches the game).
      if (e.code === "Space") {
        e.preventDefault();
        return;
      }
      if (e.code === "Delete" || e.code === "Backspace" || e.code === "KeyG") {
        // The item the bar shows (hovered / focused / tapped), else the focused tile.
        const focused = el?.dataset.drop?.startsWith("self:") ? el.dataset.drop.slice(5) : null;
        const key = selected && snap.slots[selected] ? selected : focused;
        if (!key) return;
        if (isSlotKey(key) && snap.slots[key]) {
          e.preventDefault();
          actions.drop(key);
        }
        return;
      }
      if (e.code.startsWith("Arrow")) {
        const tiles = [...(rootRef.current?.querySelectorAll<HTMLElement>("button[data-drop^='self:'], section[data-drop='loot'] button[title]") ?? [])].filter(
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
    [actions, selected, snap.slots],
  );

  if (!snap.visible) {
    // Closed: only a toast (a refused pickup) shows, above the HUD's interact prompt.
    return snap.toast ? <FloatingToast toast={snap.toast} touch={touch} onDismiss={actions.dismissToast} /> : null;
  }

  const closeAll = () => {
    // Closes the search first, then the inventory (both when both are open).
    for (let i = 0; i < 3 && actions.escape(); i++);
  };

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
        caption={opts.caption ?? EQUIP_CAPTION[key] ?? ""}
        size={opts.size ?? "md"}
        hotkey={touch ? undefined : opts.hotkey}
        active={(key === "w1" || key === "w2") && snap.active === key && !!it}
        selected={!!it && selected === key}
        dropId={`self:${key}`}
        pending={!!snap.pending[`self:${key}`]}
        dropOk={ok}
        dropBad={isOver && !ok}
        dragging={dragging?.source.from === "self" && dragging.source.key === key}
        onClick={it ? () => clickOwn(key) : () => undefined}
        onHover={!touch && it ? () => setSelected(key) : undefined}
        // Right-click drops; never on touch, where Android fires contextmenu on the long press that
        // starts a drag (touch drops with the item bar's Drop button or by dragging out).
        onContextMenu={it && !touch ? () => dropKey(key) : undefined}
        {...drag.bind(src)}
      />
    );
  };

  const pockets = Array.from({ length: POCKET_SLOTS }, (_, i) => `p${i}` as SlotKey);
  const bag = bagKeys(snap.bpLevel);
  const bagUsed = bag.filter((k) => snap.slots[k]).length;
  const groundOver = dragging?.over?.kind === "ground" && dragging.source.from === "self";
  const full = snap.carry.used >= snap.carry.cap;

  const itemBar =
    snap.toast ? (
      <ToastLine toast={snap.toast} onDismiss={actions.dismissToast} />
    ) : selected && selItem ? (
      <ItemBar
        item={selItem}
        actions={itemBarActions(snap, selected)}
        pending={!!snap.pending[`self:${selected}`]}
        onPrimary={() => quickAction(selected)}
        onDrop={() => dropKey(selected)}
        compact={short}
        keyHint={!touch}
      />
    ) : null;

  const closeBtn = (
    <button
      type="button"
      onClick={closeAll}
      className="toon-btn-ghost h-11 min-w-11 shrink-0 gap-1.5 px-3 text-sm"
      aria-label={touch ? "Close inventory" : "Close inventory (Tab / Esc)"}
      title={touch ? undefined : "Close (Tab, I or Esc)"}
    >
      <span className="optical-center">Close</span>
      {!touch && <span className="toon-key h-5 min-w-5 text-[0.6rem]">Tab</span>}
    </button>
  );

  const stats = (
    <div className="font-body flex min-w-0 items-center gap-3 text-xs font-semibold text-white/70">
      <span className={clsx("tabular-nums", full && "text-rose-300")} title="Storage slots used: pockets + backpack">
        Slots {snap.carry.used}/{snap.carry.cap}
      </span>
      <span title={`Auto-sale value of carried junk if you extract (before ${SOL_ECONOMY ? "market" : "the junker"} multiplier)`}>
        Junk <span className="toon-text-thin ml-0.5 font-sans text-sm text-amber-300">{fmtCr(snap.carry.junkCr)}</span>
      </span>
    </div>
  );

  const hint = touch
    ? "Tap an item for its actions · tap again to use it · drag to move"
    : "Click: equip / use · drag: move · G, Del or right-click: drop";

  return (
    <div
      ref={rootRef}
      className={clsx(
        "fixed inset-0 z-[70] flex justify-center overflow-hidden",
        short ? "items-stretch p-2" : "items-start p-4 pt-[8vh]",
      )}
      onKeyDown={onKeyDown}
      onKeyUp={(e) => {
        if (e.code === "Space") e.preventDefault();
      }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {/* Backdrop = the ground: release a dragged own item here to drop it; a plain click closes. It
          is nearly opaque so the HUD and the touch buttons below never show through the panels. */}
      <div
        data-drop="ground"
        className={clsx(
          "absolute inset-0 transition-colors",
          groundOver ? "bg-rose-950/90" : "bg-[#070a10]/[0.88] backdrop-blur-[3px]",
        )}
        onClick={() => actions.escape()}
        aria-hidden
      />
      {groundOver && (
        <div className="toon-chip pointer-events-none fixed bottom-3 left-1/2 z-[2] -translate-x-1/2 px-4 py-2 text-base text-rose-200">
          Release to drop on the ground
        </div>
      )}

      {/* The side margins keep the panels out of a landscape phone's camera cutout (viewport-fit=cover). */}
      <div
        className={clsx(
          "relative ml-[env(safe-area-inset-left,0px)] mr-[env(safe-area-inset-right,0px)] flex justify-center",
          short ? clsx("h-full min-h-0 w-full gap-2", snap.search ? "items-stretch" : "items-center") : "max-h-[84vh] flex-wrap items-start gap-4",
        )}
      >
        <section
          aria-label="Inventory"
          className={clsx(
            "toon-panel flex min-h-0 flex-col bg-[#1a2030] text-white",
            short ? clsx("min-w-0 shrink p-2", snap.search ? "h-full" : "max-h-full") : "max-h-[84vh] w-[min(94vw,34rem)] p-4",
          )}
        >
          <header className={clsx("flex shrink-0 items-center gap-2", short ? "h-11" : "h-11")}>
            {short && itemBar ? (
              <div className="min-w-0 flex-1">{itemBar}</div>
            ) : (
              <>
                <h2 className={clsx("toon-text shrink-0 tracking-wide text-white", short ? "text-lg" : "text-2xl")}>Inventory</h2>
                <div className="min-w-0 flex-1 pl-1">{stats}</div>
              </>
            )}
            {closeBtn}
          </header>

          <div className={clsx("flex min-h-0 flex-1 gap-3 overflow-y-auto overscroll-contain", short ? "mt-1.5 gap-2.5 pr-0.5" : "mt-3 gap-5")}>
            <div className="flex shrink-0 flex-col gap-1.5">
              <SectionLabel>Equipped</SectionLabel>
              <div className={clsx("grid grid-cols-2", short ? "gap-1.5" : "gap-2")}>
                {ownTile("w1", { size: "lg", hotkey: "1" })}
                {ownTile("w2", { size: "lg", hotkey: "2" })}
                {ownTile("armor", { size: "lg" })}
                {ownTile("bp", { size: "lg" })}
              </div>
            </div>

            <div className="flex min-w-0 flex-col gap-1.5">
              <SectionLabel>Pockets</SectionLabel>
              <div className={clsx("grid w-fit grid-cols-4", short ? "gap-1.5" : "gap-2")}>{pockets.map((k) => ownTile(k))}</div>

              <SectionLabel className={short ? "mt-1" : "mt-2"}>
                <span className="truncate">{snap.slots.bp ? describeItem(snap.slots.bp).name : "Backpack"}</span>
                {bag.length > 0 && (
                  <span className={clsx("ml-2 tabular-nums", bagUsed >= bag.length ? "text-rose-300" : "text-white/45")}>
                    {bagUsed}/{bag.length}
                  </span>
                )}
              </SectionLabel>
              {bag.length > 0 ? (
                <div className={clsx("grid w-fit", short ? "grid-cols-6 gap-1.5 tiny:grid-cols-5" : "grid-cols-4 gap-2")}>
                  {bag.map((k) => ownTile(k))}
                </div>
              ) : (
                <p className="font-body max-w-[15rem] rounded-xl border-2 border-dashed border-white/20 px-3 py-2 text-xs text-white/60">
                  No backpack — pick one up to carry more loot out.
                </p>
              )}
            </div>
          </div>

          {!short && (
            <footer className="mt-3 shrink-0 border-t-[3px] border-black/50 pt-3">
              {itemBar ?? <p className="font-body flex min-h-11 items-center text-xs text-white/55">{hint}</p>}
            </footer>
          )}
          {short && <p className={clsx("font-body mt-1 shrink-0 truncate text-[0.65rem] text-white/50", itemBar && "invisible")}>{hint}</p>}
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
            fill={short}
          />
        )}
      </div>

      {dragging && <DragGhost def={dragging.source.def} x={dragging.x} y={dragging.y} />}
    </div>
  );
}

function SectionLabel({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <h3 className={clsx("flex min-w-0 items-center text-[0.7rem] uppercase leading-none tracking-[0.16em] text-white/55", className)}>
      {children}
    </h3>
  );
}

/** The selected item: icon, name, rarity / count / durability, and its actions (≥ 44 px buttons). */
function ItemBar({
  item,
  actions,
  pending,
  onPrimary,
  onDrop,
  compact,
  keyHint,
}: {
  item: InvItemView;
  actions: ItemBarActions;
  pending: boolean;
  onPrimary: () => void;
  onDrop: () => void;
  compact: boolean;
  /** Desktop: the G keycap on the Drop button (G / Del / right-click on a focused tile). */
  keyHint: boolean;
}) {
  const d = describeItem(item);
  const dur = item.dur > 0 || itemDef(item.def)?.cat === "weapon" ? durInfo({ def: item.def, dur: item.dur }) : null;
  const broken = isBroken(item);
  const meta = [
    broken ? "Broken" : d.cat === "junk" || d.cat === "weapon" || d.cat === "armor" || d.cat === "backpack" ? d.rarityName : "",
    item.qty > 1 ? `×${item.qty}` : "",
    !broken && dur ? dur.text : "",
    isFree(item) ? "Basic gear" : "",
  ].filter(Boolean);
  return (
    <div className="flex h-11 min-w-0 items-center gap-2" aria-live="polite">
      <span
        className="grid h-10 w-10 shrink-0 place-items-center rounded-lg border-2 border-black"
        style={{ background: `radial-gradient(circle at 50% 35%, ${d.color}d9, ${d.color}4d 72%)` }}
        aria-hidden
      >
        {/* eslint-disable-next-line @next/next/no-img-element -- static sprite */}
        <img src={d.icon} alt="" className="h-8 w-8 object-contain" draggable={false} />
      </span>
      <div className="min-w-0 flex-1 leading-tight">
        <div className={clsx("toon-text-thin truncate tracking-wide text-white", compact ? "text-sm" : "text-base")}>{d.name}</div>
        <div className="font-body truncate text-[0.68rem] font-semibold" style={{ color: broken ? "#9ca3af" : d.color }}>
          {meta.join(" · ")}
        </div>
      </div>
      {actions.primary && (
        <button
          type="button"
          onClick={onPrimary}
          disabled={pending}
          className="toon-btn h-11 shrink-0 px-3 text-sm"
        >
          <span className="optical-center">{actions.primary}</span>
        </button>
      )}
      <button
        type="button"
        onClick={onDrop}
        disabled={pending || !actions.drop}
        title={actions.dropBlocked ?? (actions.drop === "Discard" ? "Basic gear vanishes when dropped" : "Drop it on the ground — anyone can pick it up")}
        className="inline-flex h-11 shrink-0 items-center justify-center gap-1.5 rounded-2xl border-[3px] border-black bg-rose-500 px-3 text-sm text-white shadow-[0_4px_0_#000] transition-[transform,box-shadow] hover:brightness-110 active:translate-y-[3px] active:shadow-[0_1px_0_#000] disabled:cursor-not-allowed disabled:opacity-50"
      >
        <span className="optical-center">{actions.drop ?? "Drop"}</span>
        {keyHint && <span className="toon-key h-5 min-w-5 text-[0.6rem]">G</span>}
      </button>
    </div>
  );
}

/** The toast inside the open panel (replaces the item bar for its few seconds; tap to dismiss). */
function ToastLine({ toast, onDismiss }: { toast: InvToast; onDismiss: () => void }) {
  return (
    <button
      type="button"
      key={toast.id}
      role="alert"
      onClick={onDismiss}
      className={clsx(
        "font-body flex h-11 w-full min-w-0 animate-outcome-enter items-center gap-2 rounded-xl border-2 px-3 text-left text-sm font-bold",
        toast.code === "info" ? "border-zooa-lime/60 bg-zooa-lime/10 text-zooa-lime" : "border-rose-400/70 bg-rose-500/15 text-rose-200",
      )}
    >
      <span className="truncate">{toast.text}</span>
    </button>
  );
}

/**
 * Toast while the panel is closed (a refused pickup): bottom centre, above the HUD's interact
 * prompt and bottom bar; with a hint how to open the bag and make room.
 */
function FloatingToast({ toast, touch, onDismiss }: { toast: InvToast; touch: boolean; onDismiss: () => void }) {
  return (
    // Centred by the full-width row (the enter animation owns the chip's transform).
    <div className={clsx("pointer-events-none fixed inset-x-0 z-[70] flex justify-center px-4", touch ? "bottom-[7.75rem] short:bottom-[7.25rem]" : "bottom-[12rem]")}>
    <div
      key={toast.id}
      role="alert"
      onClick={onDismiss}
      className={clsx(
        "toon-chip pointer-events-auto flex min-w-0 max-w-full animate-outcome-enter cursor-pointer items-center gap-2 border-rose-500 px-4 py-2 text-white",
        touch ? "text-sm" : "text-base",
      )}
    >
      <span className={clsx("truncate", toast.code === "info" ? "text-zooa-lime" : "text-rose-200")}>{toast.text}</span>
      {toast.dropHint && (
        <span className="font-body flex shrink-0 items-center gap-1.5 text-xs font-semibold text-white/80">
          <span className="h-4 w-px bg-white/25" aria-hidden />
          {touch ? <span className="toon-key px-1.5">Bag</span> : <span className="toon-key">Tab</span>}
          drop something
        </span>
      )}
    </div>
    </div>
  );
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
