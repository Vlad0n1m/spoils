/**
 * In-raid inventory glue between the synced state and the React inventory UI (WP-B2).
 *
 * - Reads the owner-only `state.self.get(selfKey).slots` and the searcher-only `state.loot` entry
 *   after every patch, but publishes a new immutable snapshot ONLY when an item actually changed
 *   (string signature), so the overlay re-renders on inventory changes, not at the 20–30 Hz
 *   patch/HUD rate. React reads it with useSyncExternalStore(subscribe, getSnapshot).
 * - Sends C2S.INV_MOVE / INV_TAKE_ALL / INV_DROP / SEARCH_CLOSE / HEAL. Every op carries the
 *   uid+def of what the player is looking at (the server's stale-click guard), is pre-checked
 *   locally for the cheap, certain failures (empty source, hidden/broken loot, wrong slot type,
 *   non-empty backpack, open delay), and marks its source "pending" until the source changes,
 *   an INV_ERR arrives or a timeout passes, so double clicks cannot fire two ops at one item.
 * - Owns the overlay UI state (Tab open, search panel hidden optimistically on close, error toast)
 *   so the renderer/input can ask `isBlocking()` to suppress fire and freeze aim while it is open.
 *
 * No Pixi, no React, no DOM except the optional `bindInventoryHotkeys` helper: unit-tested with a
 * fake room in inventory-client.test.ts.
 */

import {
  C2S,
  ITEM_FLAG,
  S2C,
  SEARCH,
  DROP,
  isSupplyDropId,
  accepts,
  bagKeys,
  BACKPACK_SLOTS,
  canRemoveBackpack,
  containerOpenMs,
  isBagKey,
  isSlotKey,
  itemDef,
  type ContainerKind,
  type HealKind,
  type InvDropMsg,
  type InvErrCode,
  type InvErrMsg,
  type InvMoveMsg,
  type ItemLike,
  type SlotKey,
  type SlotStore,
} from "@extract/shared";
import type { Room } from "colyseus.js";
import type { BattleState } from "@extract/shared";
import { INV_ERR_TEXT, containerTitle, itemValueCr, tierName } from "../lib/items-ui";
import { bodyTitle } from "./npc-labels";

// ------------------------------------------------------------------------------------------ types

/** Plain, frozen copy of one synced InvItem (never a live schema object: React must not see mutation). */
export interface InvItemView extends ItemLike {
  lvl: number;
}

/** One cell of a searched container, by slot index 0..total-1. */
export type LootCell =
  | { kind: "item"; item: InvItemView }
  /** Not revealed yet (the server never sends unrevealed items). */
  | { kind: "hidden" }
  /** Revealed and already taken by someone. */
  | { kind: "taken" };

export interface SearchView {
  /** Loot map key: "c<containerIdx>" | "k<corpseId>". */
  key: string;
  kind: "corpse" | "container";
  /** "Nick's body" / "Supply crate". */
  title: string;
  /** Tier name for containers ("Rare"), "" for corpses. */
  subtitle: string;
  containerKind: ContainerKind | null;
  /** MapData tier 0..4 (containers), -1 for corpses. */
  tier: number;
  /** Match clock: open delay start / end (progress ring until open). */
  openStartAt: number;
  readyAt: number;
  /** Contents arrived (loot entry is in our view). */
  loaded: boolean;
  total: number;
  revealed: number;
  /** Match clock of the next reveal (0 = paused); the cell at index `revealed` is "revealing". */
  nextRevealAt: number;
  /** Match clock when the current reveal started (last observed reveal, or readyAt). */
  revealFrom: number;
  cells: LootCell[];
  /** Revealed, not taken, not broken. */
  takeable: number;
}

export interface InvToast {
  id: number;
  code: InvErrCode | "info";
  text: string;
  /** Wall clock (ms) when it was raised. */
  at: number;
}

export interface InvSnapshot {
  /** Bumps on every published change. */
  version: number;
  /** Own self entry is in the state (false before JOINED / after the view dropped it). */
  ready: boolean;
  selfKey: string | null;
  /** SlotKey → item (only occupied slots). */
  slots: Readonly<Record<string, InvItemView>>;
  active: "w1" | "w2";
  bpLevel: 0 | 1 | 2 | 3;
  /** Backpack slots available (BACKPACK_SLOTS[bpLevel]). */
  bagCap: number;
  /** Tab overlay requested by the player. */
  tabOpen: boolean;
  /** Overlay is on screen (Tab or an active search): the renderer must not fire / aim. */
  visible: boolean;
  search: SearchView | null;
  /** "self:<key>" | "loot:<index>" | "loot:*" → op in flight. */
  pending: Readonly<Record<string, true>>;
  toast: InvToast | null;
  carry: {
    /** Auto-sale value of carried junk at mult 1. */
    junkCr: number;
    /** Occupied storage slots (pockets + bag) / capacity. */
    used: number;
    cap: number;
  };
}

/** Structural view of BattleState that this module reads (BattleState satisfies it). */
export interface InvStateLike {
  clockMs: number;
  self: MapLike<SelfLike>;
  loot: MapLike<LootLike>;
  corpses?: MapLike<{ label: string }>;
}
export interface MapLike<T> {
  get(key: string): T | undefined;
  forEach(cb: (value: T, key: string) => void): void;
}
export interface SelfLike {
  slots: MapLike<SyncedItemLike>;
  active: string;
  searching: string;
  searchReadyAt: number;
}
export interface SyncedItemLike {
  uid: string;
  def: string;
  qty: number;
  rarity: number;
  dur: number;
  mag: number;
  flags: number;
  label: string;
  lvl?: number;
  ref?: string;
}
export interface LootLike {
  slots: MapLike<SyncedItemLike>;
  total: number;
  revealed: number;
  nextRevealAt: number;
}

/** What this module needs from a colyseus.js Room<BattleState>. */
export interface InvRoomLike {
  readonly state: InvStateLike | null | undefined;
  send(type: string, message?: unknown): void;
  /** colyseus.js 0.16 returns an unsubscribe function. */
  // `any`: the room is typed by its state class; this module only reads the structural subset.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  onMessage(type: string, cb: (message: any) => void): unknown;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  onStateChange: ((cb: (state: any) => void) => unknown) & { remove(cb: (state: any) => void): void };
}

export interface InventoryClientOptions {
  room: InvRoomLike;
  /** The local player's self key ("p<rosterIndex>"), known after S2C.JOINED. */
  selfKey: () => string | null;
  /** Static containers for search titles / open delay (MapData.containers). */
  containers?: () => ReadonlyArray<{ kind: ContainerKind; tier: number }> | null;
  /** Match clock (ms); default = state.clockMs extrapolated from the last patch. */
  clockMs?: () => number;
  /** Wall clock + timers, injectable for tests. */
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (h: unknown) => void;
}

/** Pending op auto-expires after this (server silently ignored it, or the patch was lost). */
export const PENDING_TIMEOUT_MS = 1500;
export const TOAST_TTL_MS = 2600;

export interface MoveRequest {
  from: "self" | "loot";
  /** Own SlotKey or loot index ("0".."total-1"). */
  key: string;
  /** Target own slot; omitted = auto-place (server planPlace). */
  to?: SlotKey;
  qty?: number;
  /** What the UI showed in `key` (extra stale guard on top of the latest snapshot). */
  expect?: { uid: string; def: string };
}

export interface InventoryClient {
  subscribe(listener: () => void): () => void;
  getSnapshot(): InvSnapshot;
  /** Match clock now (progress rings). */
  clockMs(): number;
  /** Re-read the state (called automatically after each patch). */
  refresh(): void;
  /** True while the overlay is on screen: suppress fire and freeze aim. */
  isBlocking(): boolean;
  setTabOpen(open: boolean): void;
  /** Tab: open the inventory, or close everything (also the search). */
  toggle(): void;
  /** Esc: close the search, else the inventory. Returns false when nothing was open. */
  escape(): boolean;
  /** null = sent; otherwise the local refusal code (a toast is raised too). */
  move(req: MoveRequest): InvErrCode | null;
  /** Click on a loot cell: auto-place it. */
  take(index: number): InvErrCode | null;
  /** T: take every revealed takeable item. */
  takeAll(): InvErrCode | null;
  drop(key: SlotKey, qty?: number): InvErrCode | null;
  closeSearch(): void;
  useMed(kind: HealKind): void;
  dismissToast(): void;
  dispose(): void;
}

// ------------------------------------------------------------------------------------- pure parts

export function viewOf(it: SyncedItemLike): InvItemView {
  return {
    uid: it.uid, def: it.def, qty: it.qty, rarity: it.rarity, dur: it.dur, mag: it.mag,
    flags: it.flags, label: it.label, lvl: it.lvl ?? 0, ...(it.ref ? { ref: it.ref } : {}),
  };
}

/** Change-detection signature of one item (dur rounded: float32 jitter must not re-render). */
export function itemSig(it: SyncedItemLike | InvItemView | undefined): string {
  if (!it) return "-";
  return `${it.uid}|${it.def}|${it.qty}|${it.rarity}|${Math.round(it.dur * 10)}|${it.mag}|${it.flags}|${it.label}|${it.lvl ?? 0}`;
}

/** Local token bucket mirroring the server's (SEARCH.OPS_PER_SEC / OPS_BURST). */
export function makeBucket(perSec: number, burst: number, now: () => number) {
  let tokens = burst;
  let last = now();
  return () => {
    const t = now();
    tokens = Math.min(burst, tokens + ((t - last) / 1000) * perSec);
    last = t;
    if (tokens < 1) return false;
    tokens -= 1;
    return true;
  };
}

/** Read-only SlotStore over a synced slots map (the engine only calls get on these paths). */
function asStore(m: MapLike<SyncedItemLike>): SlotStore<ItemLike> {
  return { get: (k) => m.get(k) as ItemLike | undefined, set: () => undefined, delete: () => undefined };
}

function corpseIdOf(lootKey: string): string | null {
  return lootKey.startsWith("k") ? lootKey.slice(1) : null;
}
function containerIdxOf(lootKey: string): number | null {
  if (!lootKey.startsWith("c")) return null;
  const n = Number(lootKey.slice(1));
  return Number.isInteger(n) && n >= 0 ? n : null;
}

const EMPTY_SNAPSHOT: InvSnapshot = Object.freeze({
  version: 0, ready: false, selfKey: null, slots: Object.freeze({}), active: "w1", bpLevel: 0, bagCap: 0,
  tabOpen: false, visible: false, search: null, pending: Object.freeze({}), toast: null,
  carry: Object.freeze({ junkCr: 0, used: 0, cap: 4 }),
}) as InvSnapshot;

// ------------------------------------------------------------------------------------ the client

export function createInventoryClient(opts: InventoryClientOptions): InventoryClient {
  const now = opts.now ?? (() => (typeof performance !== "undefined" ? performance.now() : Date.now()));
  const setTimer = opts.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearTimer = opts.clearTimer ?? ((h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>));
  const room = opts.room;

  const listeners = new Set<() => void>();
  let snap: InvSnapshot = EMPTY_SNAPSHOT;
  let lastSig = "";
  let disposed = false;

  // Clock extrapolation between patches (the server patches at 20 Hz).
  let patchClock = 0;
  let patchAt = now();

  // UI state.
  let tabOpen = false;
  /** Search key the player closed; hidden until the server clears self.searching. */
  let closedSearchKey: string | null = null;
  let lastSearchKey = "";
  let revealSeen = { key: "", revealed: -1, at: 0 };
  let toast: InvToast | null = null;
  let toastSeq = 0;
  let toastTimer: unknown = null;
  /** pending key → { sig of the source when sent, expires (wall clock) }. */
  const pending = new Map<string, { sig: string; until: number }>();
  let pendingTimer: unknown = null;
  const bucket = makeBucket(SEARCH.OPS_PER_SEC, SEARCH.OPS_BURST, now);

  const clockMs = opts.clockMs ?? (() => patchClock + Math.min(500, Math.max(0, now() - patchAt)));

  function selfEntry(): SelfLike | undefined {
    const key = opts.selfKey();
    const st = room.state;
    return key && st ? st.self.get(key) : undefined;
  }

  function sourceSig(pkey: string): string {
    const self = selfEntry();
    if (pkey.startsWith("self:")) return itemSig(self?.slots.get(pkey.slice(5)));
    if (pkey === "loot:*") {
      const l = self?.searching ? room.state?.loot.get(self.searching) : undefined;
      if (!l) return "-";
      let s = `${l.revealed}`;
      l.slots.forEach((it, k) => (s += `;${k}=${itemSig(it)}`));
      return s;
    }
    if (pkey.startsWith("loot:")) {
      const l = self?.searching ? room.state?.loot.get(self.searching) : undefined;
      return itemSig(l?.slots.get(pkey.slice(5)));
    }
    return "-";
  }

  function emit() {
    for (const l of [...listeners]) l();
  }

  function schedulePendingSweep() {
    if (pendingTimer !== null || pending.size === 0 || disposed) return;
    pendingTimer = setTimer(() => {
      pendingTimer = null;
      refresh();
      schedulePendingSweep();
    }, PENDING_TIMEOUT_MS / 3);
  }

  /** Rebuild the snapshot; publish only when something visible changed. */
  function refresh(force = false) {
    if (disposed) return;
    const st = room.state;
    if (st) {
      if (st.clockMs !== patchClock) patchAt = now();
      patchClock = st.clockMs;
    }
    const selfKey = opts.selfKey();
    const self = selfEntry();

    // Expire / resolve pending ops: a source that changed means the server applied (or refused) it.
    const t = now();
    for (const [k, p] of pending) {
      if (t >= p.until || sourceSig(k) !== p.sig) pending.delete(k);
    }

    const slots: Record<string, InvItemView> = {};
    let sig = `${selfKey}|${self ? 1 : 0}`;
    let active: "w1" | "w2" = "w1";
    let search: SearchView | null = null;
    if (self) {
      active = self.active === "w2" ? "w2" : "w1";
      sig += `|${active}`;
      const keys: string[] = [];
      self.slots.forEach((_it, k) => keys.push(k));
      keys.sort();
      for (const k of keys) {
        const it = self.slots.get(k);
        if (!it) continue;
        slots[k] = viewOf(it);
        sig += `|${k}=${itemSig(it)}`;
      }
      // Search panel.
      const sKey = self.searching;
      if (sKey !== lastSearchKey) {
        // The server switched search (or closed it): forget the optimistic hide.
        closedSearchKey = null;
        lastSearchKey = sKey;
      }
      if (sKey && sKey !== closedSearchKey) {
        search = buildSearch(sKey, self, st ?? null);
        sig += `|S${sKey}|${search.readyAt}|${search.loaded ? 1 : 0}|${search.total}|${search.revealed}|${search.nextRevealAt}`;
        for (const c of search.cells) sig += c.kind === "item" ? `|${itemSig(c.item)}` : `|${c.kind}`;
      }
    } else {
      lastSearchKey = "";
      closedSearchKey = null;
    }

    const pendSig = [...pending.keys()].sort().join(",");
    sig += `|P${pendSig}|T${tabOpen ? 1 : 0}|E${toast?.id ?? 0}`;
    if (!force && sig === lastSig) return;
    lastSig = sig;

    const bpLevel = (() => {
      const b = slots.bp;
      return (b ? (itemDef(b.def)?.bpLevel ?? 0) : 0) as 0 | 1 | 2 | 3;
    })();
    const bagCap = BACKPACK_SLOTS[bpLevel];
    let used = 0;
    let junkCr = 0;
    for (const [k, it] of Object.entries(slots)) {
      if (/^p[0-3]$/.test(k) || isBagKey(k)) used++;
      if (!(it.flags & ITEM_FLAG.BROKEN)) junkCr += itemValueCr(it);
    }
    const pend: Record<string, true> = {};
    for (const k of pending.keys()) pend[k] = true;
    snap = Object.freeze({
      version: snap.version + 1,
      ready: !!self,
      selfKey,
      slots: Object.freeze(slots),
      active,
      bpLevel,
      bagCap,
      tabOpen,
      visible: !!self && (tabOpen || search !== null),
      search,
      pending: Object.freeze(pend),
      toast,
      carry: Object.freeze({ junkCr, used, cap: 4 + bagCap }),
    });
    emit();
  }

  function buildSearch(sKey: string, self: SelfLike, st: InvStateLike | null): SearchView {
    const corpseId = corpseIdOf(sKey);
    const cIdx = containerIdxOf(sKey);
    let title = "Container";
    let subtitle = "";
    let containerKind: ContainerKind | null = null;
    let tier = -1;
    let openMs: number = SEARCH.OPEN_MS.cache;
    if (corpseId !== null) {
      const crate = isSupplyDropId(corpseId);
      title = crate ? "Supply drop" : bodyTitle(st?.corpses?.get(corpseId)?.label);
      openMs = crate ? DROP.OPEN_MS : SEARCH.OPEN_MS.corpse;
    } else if (cIdx !== null) {
      const spot = opts.containers?.()?.[cIdx];
      if (spot) {
        containerKind = spot.kind;
        tier = spot.tier;
        title = containerTitle(spot.kind);
        subtitle = tierName(spot.tier);
        openMs = containerOpenMs(spot as { kind: ContainerKind; tier: number });
      }
    }
    const loot = st?.loot.get(sKey);
    const total = loot?.total ?? 0;
    const revealed = Math.min(total, loot?.revealed ?? 0);
    const cells: LootCell[] = [];
    let takeable = 0;
    for (let i = 0; i < total; i++) {
      const it = loot!.slots.get(String(i));
      if (it) {
        const v = viewOf(it);
        cells.push({ kind: "item", item: v });
        if (!(v.flags & ITEM_FLAG.BROKEN)) takeable++;
      } else {
        cells.push(i < revealed ? { kind: "taken" } : { kind: "hidden" });
      }
    }
    // Track when the current reveal started: the moment we saw `revealed` change (patch time),
    // or the end of the open delay for the first one.
    const readyAt = self.searchReadyAt;
    if (revealSeen.key !== sKey) revealSeen = { key: sKey, revealed, at: readyAt };
    else if (revealSeen.revealed !== revealed) revealSeen = { key: sKey, revealed, at: Math.max(readyAt, clockMs()) };
    return {
      key: sKey,
      kind: corpseId !== null ? "corpse" : "container",
      title,
      subtitle,
      containerKind,
      tier,
      openStartAt: readyAt - openMs,
      readyAt,
      loaded: !!loot,
      total,
      revealed,
      nextRevealAt: loot?.nextRevealAt ?? 0,
      revealFrom: Math.max(readyAt, revealSeen.at),
      cells,
      takeable,
    };
  }

  function raise(code: InvErrCode | "info", text?: string) {
    toast = { id: ++toastSeq, code, text: text ?? (code === "info" ? "" : INV_ERR_TEXT[code]), at: now() };
    if (toastTimer !== null) clearTimer(toastTimer);
    const id = toast.id;
    toastTimer = setTimer(() => {
      toastTimer = null;
      if (toast?.id === id) {
        toast = null;
        refresh();
      }
    }, TOAST_TTL_MS);
    refresh();
  }

  function fail(code: InvErrCode): InvErrCode {
    raise(code);
    return code;
  }

  function markPending(pkey: string) {
    pending.set(pkey, { sig: sourceSig(pkey), until: now() + PENDING_TIMEOUT_MS });
    schedulePendingSweep();
  }

  function isPending(pkey: string): boolean {
    const p = pending.get(pkey);
    return !!p && now() < p.until && sourceSig(pkey) === p.sig;
  }

  function searchReady(self: SelfLike): boolean {
    return !!self.searching && clockMs() >= self.searchReadyAt;
  }

  function move(req: MoveRequest): InvErrCode | null {
    const self = selfEntry();
    if (!self) return fail("dead");
    const st = room.state;
    let src: SyncedItemLike | undefined;
    if (req.from === "self") {
      if (!isSlotKey(req.key)) return fail("bad_slot");
      src = self.slots.get(req.key);
    } else {
      if (!self.searching) return fail("not_searching");
      if (!searchReady(self)) return fail("not_ready");
      const loot = st?.loot.get(self.searching);
      if (!loot) return fail("not_ready");
      const idx = Number(req.key);
      if (!Number.isInteger(idx) || idx < 0 || idx >= loot.total) return fail("bad_slot");
      src = loot.slots.get(req.key);
      if (!src && idx >= loot.revealed) return fail("not_revealed");
    }
    if (!src) return fail("gone");
    if (req.expect && (req.expect.uid !== src.uid || req.expect.def !== src.def)) return fail("gone");
    if (src.flags & ITEM_FLAG.BROKEN) return fail("broken");
    const pkey = `${req.from}:${req.key}`;
    if (isPending(pkey) || (req.from === "loot" && isPending("loot:*"))) return null; // double click
    const d = itemDef(src.def);
    if (!d) return fail("bad_slot");
    if (req.to !== undefined) {
      if (req.from === "self" && req.to === req.key) return null;
      if (!isSlotKey(req.to) || !accepts(req.to, d)) return fail("bad_slot");
      if (isBagKey(req.to)) {
        // The bag that would exist after the move: moving the backpack itself out removes it.
        const lvl = req.from === "self" && req.key === "bp" ? 0 : bpLevelFromSlots(self);
        if (!bagKeys(lvl).includes(req.to)) return fail("bad_slot");
      }
      // Swapping a backpack out of its slot needs an empty bag (a bigger/smaller pack is a server call).
      if (req.from === "self" && req.key === "bp" && req.to !== "bp" && !canRemoveBackpack(asStore(self.slots))) {
        return fail("bp_not_empty");
      }
    } else if (req.from === "self" && req.key === "bp" && !canRemoveBackpack(asStore(self.slots))) {
      return fail("bp_not_empty");
    }
    if (!bucket()) return fail("rate");
    const msg: InvMoveMsg = { from: req.from, key: req.key, uid: src.uid, def: src.def };
    if (req.to !== undefined) msg.to = req.to;
    if (req.qty !== undefined && req.qty > 0 && req.qty < src.qty) msg.qty = Math.floor(req.qty);
    room.send(C2S.INV_MOVE, msg);
    markPending(pkey);
    if (req.to !== undefined && req.from === "self") markPending(`self:${req.to}`);
    refresh();
    return null;
  }

  function bpLevelFromSlots(self: SelfLike): number {
    const b = self.slots.get("bp");
    return b ? (itemDef(b.def)?.bpLevel ?? 0) : 0;
  }

  function takeAll(): InvErrCode | null {
    const self = selfEntry();
    if (!self) return fail("dead");
    if (!self.searching) return fail("not_searching");
    if (!searchReady(self)) return fail("not_ready");
    if (isPending("loot:*")) return null;
    const loot = room.state?.loot.get(self.searching);
    let any = false;
    loot?.slots.forEach((it) => {
      if (!(it.flags & ITEM_FLAG.BROKEN)) any = true;
    });
    if (!any) return null; // nothing to take yet: T while revealing is a harmless no-op
    if (!bucket()) return fail("rate");
    room.send(C2S.INV_TAKE_ALL, {});
    markPending("loot:*");
    refresh();
    return null;
  }

  function drop(key: SlotKey, qty?: number): InvErrCode | null {
    const self = selfEntry();
    if (!self) return fail("dead");
    const it = self.slots.get(key);
    if (!it) return fail("gone");
    if (key === "bp" && !canRemoveBackpack(asStore(self.slots))) return fail("bp_not_empty");
    const pkey = `self:${key}`;
    if (isPending(pkey)) return null;
    if (!bucket()) return fail("rate");
    const msg: InvDropMsg = { key, uid: it.uid, def: it.def };
    if (qty !== undefined && qty > 0 && qty < it.qty) msg.qty = Math.floor(qty);
    room.send(C2S.INV_DROP, msg);
    markPending(pkey);
    refresh();
    return null;
  }

  function closeSearch() {
    const self = selfEntry();
    if (!self?.searching) return;
    room.send(C2S.SEARCH_CLOSE, {});
    closedSearchKey = self.searching;
    refresh();
  }

  const onState = () => refresh();
  room.onStateChange(onState);
  const offErr = room.onMessage(S2C.INV_ERR, (m: InvErrMsg) => {
    // Ops are serial on the server: an error answers the oldest pending op; clear them all so
    // the player can retry right away.
    pending.clear();
    if (m.code === "full" && typeof m.taken === "number" && m.taken > 0) {
      raise("full", `Took ${m.taken} — no room for the rest`);
    } else if (m.code in INV_ERR_TEXT) {
      raise(m.code);
    } else {
      refresh();
    }
  });

  const client: InventoryClient = {
    subscribe(l) {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    getSnapshot: () => snap,
    clockMs,
    refresh: () => refresh(),
    isBlocking: () => snap.visible,
    setTabOpen(open) {
      if (tabOpen === open) return;
      tabOpen = open;
      refresh();
    },
    toggle() {
      if (snap.visible) {
        tabOpen = false;
        if (snap.search) closeSearch();
        refresh();
      } else {
        tabOpen = true;
        refresh();
      }
    },
    escape() {
      if (snap.search) {
        closeSearch();
        return true;
      }
      if (tabOpen) {
        tabOpen = false;
        refresh();
        return true;
      }
      return false;
    },
    move,
    take: (index) => move({ from: "loot", key: String(index) }),
    takeAll,
    drop,
    closeSearch,
    useMed(kind) {
      if (!selfEntry()) return;
      room.send(C2S.HEAL, { kind });
    },
    dismissToast() {
      if (!toast) return;
      toast = null;
      refresh();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      room.onStateChange.remove(onState);
      if (typeof offErr === "function") (offErr as () => void)();
      if (toastTimer !== null) clearTimer(toastTimer);
      if (pendingTimer !== null) clearTimer(pendingTimer);
      listeners.clear();
    },
  };
  refresh(true);
  return client;
}

/** Typed entry point for the battle screen: a colyseus Room<BattleState> is an InvRoomLike. */
export function createRoomInventoryClient(
  room: Room<BattleState>,
  rest: Omit<InventoryClientOptions, "room">,
): InventoryClient {
  return createInventoryClient({ room, ...rest });
}

// -------------------------------------------------------------------------------------- hotkeys

function isTypingTarget(t: EventTarget | null): boolean {
  const el = t as { tagName?: string; isContentEditable?: boolean } | null;
  if (!el || typeof el.tagName !== "string") return false;
  return el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || !!el.isContentEditable;
}

/**
 * Tab (toggle), Esc (close search, then inventory), T (take all while searching). Optional: the
 * input owner may route these keys itself instead. Returns the unbind function.
 */
export function bindInventoryHotkeys(client: InventoryClient, target: Pick<Window, "addEventListener" | "removeEventListener"> = window): () => void {
  const onKey = (e: KeyboardEvent) => {
    if (e.metaKey || e.ctrlKey || e.altKey || isTypingTarget(e.target)) return;
    if (e.code === "Tab") {
      // Keep focus in the game: Tab would otherwise walk the page's focus ring.
      e.preventDefault();
      if (!e.repeat) client.toggle();
    } else if (e.code === "Escape") {
      if (client.escape()) e.preventDefault();
    } else if (e.code === "KeyT" && !e.repeat) {
      if (client.getSnapshot().search) client.takeAll();
    }
  };
  target.addEventListener("keydown", onKey as EventListener);
  return () => target.removeEventListener("keydown", onKey as EventListener);
}
