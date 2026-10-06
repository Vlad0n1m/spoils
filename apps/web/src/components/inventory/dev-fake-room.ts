/**
 * A tiny in-browser stand-in for the battle room, for /dev/inventory and the inventory-client
 * tests. It mimics the server rules of the inventory memo with the shared slot engine: open delay,
 * one-by-one reveal (revealMs), stale-click guard, auto-place / targeted move / swap, take all,
 * drop, search close, heal. NOT the authoritative implementation (that is game-server
 * sim/inventory); it only has to be faithful enough to exercise the UI.
 */

import {
  C2S,
  ITEM_FLAG,
  S2C,
  accepts,
  canRemoveBackpack,
  consumeKey,
  itemDef,
  planPlace,
  revealMs,
  type InvDropMsg,
  type InvErrCode,
  type InvErrMsg,
  type InvMoveMsg,
  type ItemLike,
  type SlotKey,
} from "@extract/shared";
import type { InvRoomLike } from "../../game/inventory-client";

export interface FakeItem extends ItemLike {
  lvl: number;
}

export function fakeItem(def: string, extra: Partial<FakeItem> = {}): FakeItem {
  const d = itemDef(def);
  return {
    uid: d?.unique ? `u${Math.random().toString(36).slice(2, 9)}` : "",
    def,
    qty: 1,
    rarity: d?.rarity ?? 0,
    dur: d?.cat === "weapon" ? 100 : d?.cat === "armor" ? 80 : 0,
    mag: 0,
    flags: 0,
    label: "",
    lvl: 0,
    ...extra,
  };
}

interface FakeSelf {
  slots: Map<string, FakeItem>;
  active: string;
  searching: string;
  searchReadyAt: number;
}
interface FakeLoot {
  slots: Map<string, FakeItem>;
  total: number;
  revealed: number;
  nextRevealAt: number;
  hidden: FakeItem[];
}
export interface FakeState {
  clockMs: number;
  self: Map<string, FakeSelf>;
  loot: Map<string, FakeLoot>;
  corpses: Map<string, { label: string }>;
}

export class FakeInventoryRoom implements InvRoomLike {
  readonly state: FakeState;
  readonly sent: Array<{ type: string; msg: unknown }> = [];
  /** Artificial server latency (ms of fake clock) before an op applies. */
  latencyMs = 60;
  private stateCbs = new Set<(s: unknown) => void>();
  private msgCbs = new Map<string, Set<(m: unknown) => void>>();
  private queue: Array<{ at: number; fn: () => void }> = [];

  constructor(readonly selfKey = "p0") {
    this.state = { clockMs: 0, self: new Map(), loot: new Map(), corpses: new Map() };
    this.state.self.set(selfKey, { slots: new Map(), active: "w1", searching: "", searchReadyAt: 0 });
  }

  get me(): FakeSelf {
    return this.state.self.get(this.selfKey)!;
  }

  // ------------------------------------------------------------------ InvRoomLike
  send(type: string, msg?: unknown): void {
    this.sent.push({ type, msg });
    this.queue.push({ at: this.state.clockMs + this.latencyMs, fn: () => this.handle(type, msg) });
  }
  onMessage(type: string, cb: (m: never) => void): () => void {
    let set = this.msgCbs.get(type);
    if (!set) this.msgCbs.set(type, (set = new Set()));
    set.add(cb as (m: unknown) => void);
    return () => set!.delete(cb as (m: unknown) => void);
  }
  onStateChange = Object.assign(
    (cb: (s: never) => void) => {
      this.stateCbs.add(cb as (s: unknown) => void);
    },
    { remove: (cb: (s: never) => void) => void this.stateCbs.delete(cb as (s: unknown) => void) },
  );

  // ------------------------------------------------------------------ driving
  /** Advance the fake clock: apply queued ops, run reveals, then "patch". */
  tick(dtMs = 50): void {
    this.state.clockMs += dtMs;
    const now = this.state.clockMs;
    const due = this.queue.filter((q) => q.at <= now);
    this.queue = this.queue.filter((q) => q.at > now);
    for (const q of due) q.fn();
    const self = this.me;
    if (self.searching && now >= self.searchReadyAt) {
      const l = this.state.loot.get(self.searching);
      if (l) {
        if (l.nextRevealAt === 0) l.nextRevealAt = Math.max(self.searchReadyAt, now) + revealMs(l.hidden[l.revealed] ?? fakeItem("apple"));
        while (l.revealed < l.total && now >= l.nextRevealAt) {
          l.slots.set(String(l.revealed), l.hidden[l.revealed]!);
          l.revealed++;
          l.nextRevealAt = l.revealed < l.total ? l.nextRevealAt + revealMs(l.hidden[l.revealed]!) : 0;
        }
      }
    }
    this.patch();
  }

  patch(): void {
    for (const cb of [...this.stateCbs]) cb(this.state);
  }

  /** Start searching a container / corpse with the given contents (dev buttons, tests). */
  openSearch(key: string, items: FakeItem[], openMs: number, label?: string): void {
    if (key.startsWith("k") && label) this.state.corpses.set(key.slice(1), { label });
    let l = this.state.loot.get(key);
    if (!l) {
      l = { slots: new Map(), total: items.length, revealed: 0, nextRevealAt: 0, hidden: items };
      this.state.loot.set(key, l);
    } else {
      l.nextRevealAt = 0; // progress is kept; the reveal timer restarts after the open delay
    }
    this.me.searching = key;
    this.me.searchReadyAt = this.state.clockMs + openMs;
    this.patch();
  }

  /** Another player grabs a revealed loot item (stale-click / race demo). */
  stealLoot(index: number): void {
    const l = this.me.searching ? this.state.loot.get(this.me.searching) : undefined;
    l?.slots.delete(String(index));
    this.patch();
  }

  /** F on a ground item that does not fit: the server's INV_ERR full with the item's def. */
  pickupFull(def: string): void {
    this.err("full", { item: def });
  }

  // ------------------------------------------------------------------ server rules
  private err(code: InvErrCode, extra: Partial<InvErrMsg> = {}) {
    const msg: InvErrMsg = { code, ...extra };
    for (const cb of this.msgCbs.get(S2C.INV_ERR) ?? []) cb(msg);
  }

  private handle(type: string, raw: unknown) {
    const self = this.me;
    switch (type) {
      case C2S.INV_MOVE:
        return this.move(self, raw as InvMoveMsg);
      case C2S.INV_TAKE_ALL:
        return this.takeAll(self);
      case C2S.INV_DROP: {
        const m = raw as InvDropMsg;
        const it = self.slots.get(m.key);
        if (!it || it.uid !== m.uid || it.def !== m.def) return this.err("gone");
        if (m.key === "bp" && !canRemoveBackpack(self.slots)) return this.err("bp_not_empty");
        if (m.qty && m.qty < it.qty) it.qty -= m.qty;
        else self.slots.delete(m.key);
        return;
      }
      case C2S.SEARCH_CLOSE: {
        const l = this.state.loot.get(self.searching);
        if (l) l.nextRevealAt = 0;
        self.searching = "";
        return;
      }
      case C2S.HEAL: {
        const kind = (raw as { kind: string }).kind;
        const k = consumeKey(self.slots, kind);
        if (!k) return;
        const it = self.slots.get(k)!;
        if (--it.qty <= 0) self.slots.delete(k);
        return;
      }
    }
  }

  private move(self: FakeSelf, m: InvMoveMsg) {
    let src: FakeItem | undefined;
    let loot: FakeLoot | undefined;
    if (m.from === "loot") {
      loot = this.state.loot.get(self.searching);
      if (!loot) return this.err("not_searching");
      if (this.state.clockMs < self.searchReadyAt) return this.err("not_ready");
      src = loot.slots.get(m.key);
    } else {
      src = self.slots.get(m.key);
    }
    if (!src || src.uid !== m.uid || src.def !== m.def) return this.err("gone");
    if (src.flags & ITEM_FLAG.BROKEN) return this.err("broken");
    const qty = Math.min(m.qty ?? src.qty, src.qty);
    if (m.from === "self" && m.key === "bp" && m.to !== "bp" && !canRemoveBackpack(self.slots)) {
      return this.err("bp_not_empty");
    }

    // Work on a copy without the source so a self move can land anywhere (incl. a swap).
    const removeSrc = (n: number) => {
      const from = m.from === "loot" ? loot!.slots : self.slots;
      if (n >= src!.qty) from.delete(m.key);
      else src!.qty -= n;
    };

    if (m.to) {
      const d = itemDef(src.def)!;
      if (!accepts(m.to, d)) return this.err("bad_slot");
      const plan = planPlace(self.slots, src, qty, m.to);
      if (plan.ok) {
        this.apply(self, src, plan.steps);
        removeSrc(plan.placed);
        return;
      }
      if (plan.code !== "full") return this.err(plan.code);
      // Occupied, not mergeable → swap.
      const tgt = self.slots.get(m.to)!;
      if (m.from === "self") {
        const td = itemDef(tgt.def)!;
        if (accepts(m.key, td) && !(m.to === "bp" || m.key === "bp")) {
          self.slots.set(m.to, src);
          self.slots.set(m.key, tgt);
          return;
        }
      }
      // Re-place the target item elsewhere, then put the source in.
      self.slots.delete(m.to);
      const re = planPlace(self.slots, tgt);
      if (!re.ok || re.placed < tgt.qty) {
        self.slots.set(m.to, tgt);
        return this.err("full");
      }
      this.apply(self, tgt, re.steps);
      self.slots.set(m.to, { ...src, qty });
      removeSrc(qty);
      return;
    }
    // Auto-place. A self item being auto-placed must not merge into itself.
    if (m.from === "self") self.slots.delete(m.key);
    const plan = planPlace(self.slots, src, qty);
    if (m.from === "self") self.slots.set(m.key, src);
    if (!plan.ok) return this.err(plan.code);
    if (m.from === "self" && plan.steps.some((s) => s.key === m.key)) return;
    this.apply(self, src, plan.steps);
    removeSrc(plan.placed);
  }

  private apply(self: FakeSelf, item: FakeItem, steps: ReadonlyArray<{ key: SlotKey; qty: number; merge: boolean }>) {
    for (const s of steps) {
      const cur = self.slots.get(s.key);
      if (s.merge && cur) cur.qty += s.qty;
      else self.slots.set(s.key, { ...item, qty: s.qty });
    }
  }

  private takeAll(self: FakeSelf) {
    const loot = this.state.loot.get(self.searching);
    if (!loot) return this.err("not_searching");
    if (this.state.clockMs < self.searchReadyAt) return this.err("not_ready");
    let taken = 0;
    for (let i = 0; i < loot.revealed; i++) {
      const it = loot.slots.get(String(i));
      if (!it || it.flags & ITEM_FLAG.BROKEN) continue;
      const plan = planPlace(self.slots, it);
      if (!plan.ok) {
        if (itemDef(it.def)?.unique) return this.err("full", { taken });
        continue;
      }
      this.apply(self, it, plan.steps);
      if (plan.placed >= it.qty) loot.slots.delete(String(i));
      else it.qty -= plan.placed;
      taken++;
    }
  }
}

/** Starting gear for the dev page: a mid-raid player with a hiking pack. */
export function devStartingGear(room: FakeInventoryRoom): void {
  const s = room.me.slots;
  s.set("w1", fakeItem("rifle", { rarity: 2, dur: 73, mag: 21 }));
  s.set("w2", fakeItem("pistol", { flags: ITEM_FLAG.FREE, mag: 12, uid: "" }));
  s.set("armor", fakeItem("armor_2", { dur: 54 }));
  s.set("bp", fakeItem("backpack_2"));
  s.set("p0", fakeItem("ammo_light", { qty: 47 }));
  s.set("p1", fakeItem("bandage", { qty: 3 }));
  s.set("p2", fakeItem("medkit", { qty: 1 }));
  s.set("b0", fakeItem("junk_bolts", { qty: 4 }));
  s.set("b1", fakeItem("junk_gpu"));
  s.set("b2", fakeItem("ammo_shell", { qty: 12 }));
  s.set("b5", fakeItem("junk_dogtag", { label: "Krolik", lvl: 7 }));
}

export function devCorpseLoot(): FakeItem[] {
  return [
    fakeItem("shotgun", { rarity: 1, dur: 64, mag: 3 }),
    fakeItem("sniper", { rarity: 3, flags: ITEM_FLAG.BROKEN, dur: 40 }),
    fakeItem("armor_3", { flags: ITEM_FLAG.BROKEN, dur: 120 }),
    fakeItem("ammo_heavy", { qty: 14 }),
    fakeItem("junk_coldwallet"),
    fakeItem("junk_canned", { qty: 3 }),
    fakeItem("bandage", { qty: 2 }),
    fakeItem("junk_dogtag", { label: "Sasha", lvl: 12 }),
  ];
}

export function devChestLoot(): FakeItem[] {
  return [
    fakeItem("junk_goldchain"),
    fakeItem("junk_wires", { qty: 2 }),
    fakeItem("backpack_3"),
    fakeItem("ammo_light", { qty: 30 }),
  ];
}
