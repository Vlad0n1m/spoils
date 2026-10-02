/**
 * Loose ground items (critique "Ground items"): GroundItem {id, def, x, y, qty, rarity} in state,
 * the full item (uid, mag, dur, flags, dog tag fields) in a server runtime map. Pickups query a
 * UniformGrid instead of scanning every item (autoPickup over all items was 50% of a tick on the
 * big map). Ammo and meds are picked up by walking over them; everything else needs F.
 */

import {
  GroundItem,
  ITEM_FLAG,
  PLAYER,
  SOLID,
  UniformGrid,
  WORLD,
  armorIsUpgrade,
  bpLevelOf,
  circleIsFree,
  hasLineOfSight,
  itemDef,
  type ItemLike,
} from "@extract/shared";
import { placeItem, syncPublic } from "./bag.js";
import { cloneItem, isTrackedUnique, toPlain } from "./items.js";
import type { Match } from "./match.js";
import type { PlayerRuntime } from "./types.js";

export interface GroundRt {
  /** Numeric grid id. */
  n: number;
  schema: GroundItem;
  item: ItemLike;
}

/** Ground bookkeeping owned by the Match (one per match). */
export class GroundStore {
  readonly byId = new Map<string, GroundRt>();
  private readonly byN = new Map<number, GroundRt>();
  readonly grid: UniformGrid;
  private seq = 0;
  private readonly scratch: number[] = [];

  constructor(width: number, height: number) {
    this.grid = new UniformGrid(width, height, 256);
  }

  /**
   * `actor` = the player whose action put it there (drop, swap overflow): only the actor and those
   * who see them get it in their view until disclosure.ts publishes it (aoi.ts restriction).
   */
  add(m: Match, item: ItemLike, x: number, y: number, actor?: PlayerRuntime): GroundItem {
    const n = this.seq++;
    const g = new GroundItem();
    g.id = `g${n.toString(36)}`;
    g.def = item.def;
    g.x = x;
    g.y = y;
    g.qty = item.qty;
    g.rarity = item.rarity;
    const rt: GroundRt = { n, schema: g, item: toPlain(item) };
    this.byId.set(g.id, rt);
    this.byN.set(n, rt);
    this.grid.set(n, x, y);
    m.state.items.set(g.id, g);
    if (actor) {
      m.aoi.restrict(g, "spawn", actor);
      m.disclosure.defer(`g${g.id}`, x, y, [actor], () => m.aoi.unrestrict(g));
    }
    return g;
  }

  /**
   * Gone from the server's truth at once. Taken by `actor`: the schema entity stays in state for
   * viewers who do not see the actor (a ghost) until disclosure.ts publishes the pickup.
   */
  remove(m: Match, id: string, actor?: PlayerRuntime): void {
    const rt = this.byId.get(id);
    if (!rt) return;
    this.byId.delete(id);
    this.byN.delete(rt.n);
    this.grid.delete(rt.n);
    const g = rt.schema;
    // A drop nobody else was shown yet (only the dropper's viewers hold it): just delete it.
    if (!actor || m.aoi.restrictedAs(g) === "spawn") {
      m.aoi.unrestrict(g);
      m.state.items.delete(id);
      return;
    }
    m.aoi.restrict(g, "ghost", actor);
    m.disclosure.defer(`g${id}`, g.x, g.y, [actor], () => {
      m.aoi.unrestrict(g);
      if (m.state.items.get(id) === g) m.state.items.delete(id);
    });
  }

  /** New quantity in the truth at once; the public field once `actor` left (disclosure.ts). */
  setQty(m: Match, rt: GroundRt, qty: number, actor?: PlayerRuntime): void {
    rt.item.qty = qty;
    const g = rt.schema;
    const publish = () => {
      if (g.qty !== rt.item.qty) g.qty = rt.item.qty;
    };
    if (actor) m.disclosure.defer(`q${g.id}`, g.x, g.y, [actor], publish);
    else publish();
  }

  /** Items whose centre is within `r` of (x, y). */
  near(x: number, y: number, r: number): GroundRt[] {
    const out: GroundRt[] = [];
    const r2 = r * r;
    for (const n of this.grid.queryCircle(x, y, r, this.scratch)) {
      const g = this.byN.get(n);
      if (g && (g.schema.x - x) ** 2 + (g.schema.y - y) ** 2 <= r2) out.push(g);
    }
    return out;
  }

  all(): IterableIterator<GroundRt> {
    return this.byId.values();
  }
}

/** `actor` = the player who put it there (see GroundStore.add); none for world spawns. */
export function spawnGroundItem(m: Match, item: ItemLike, x: number, y: number, actor?: PlayerRuntime): GroundItem {
  return m.ground.add(m, item, x, y, actor);
}

/**
 * Position for the n-th item scattered around (x, y): a golden-angle spiral, skipping spots inside
 * solids so loot never ends up unreachable inside a crate or wall, and spots behind a wall so loot
 * from a container or body indoors never lands outside the building (or vice versa).
 */
export function dropSpot(m: Match, x: number, y: number, n: number): { x: number; y: number } {
  const B = WORLD.BORDER + 16;
  for (let attempt = 0; attempt < 16; attempt++) {
    const k = n + attempt * 3;
    const a = k * 2.399963 + 0.7;
    const r = 34 + 13 * Math.sqrt(k);
    const px = x + Math.cos(a) * r;
    const py = y + Math.sin(a) * r;
    if (px < B || py < B || px > m.map.width - B || py > m.map.height - B) continue;
    if (circleIsFree(m.idx, px, py, 12) && hasLineOfSight(m.idx, x, y, px, py, SOLID.MOVE)) return { x: px, y: py };
  }
  return { x, y };
}

function autoPicked(def: string): boolean {
  const c = itemDef(def)?.cat;
  return c === "ammo" || c === "med";
}

/**
 * Ammo and meds are picked up by walking over them, through the slot engine (merge into stacks,
 * then empty slots); whatever does not fit stays on the ground with the reduced quantity.
 */
export function autoPickup(m: Match, rt: PlayerRuntime): void {
  const p = rt.pub;
  for (const g of m.ground.near(p.x, p.y, PLAYER.AUTO_PICKUP_RADIUS)) {
    if (!autoPicked(g.item.def)) continue;
    const { placed } = placeItem(rt, g.item, g.item.qty);
    if (placed <= 0) continue;
    if (placed >= g.item.qty) m.ground.remove(m, g.schema.id, rt);
    else m.ground.setQty(m, g, g.item.qty - placed, rt);
  }
}

/** Nearest ground item within reach and line of sight (F), or null. */
export function nearestGroundItem(m: Match, rt: PlayerRuntime): GroundRt | null {
  const p = rt.pub;
  let best: GroundRt | null = null;
  let bestD = Infinity;
  for (const g of m.ground.near(p.x, p.y, PLAYER.INTERACT_RADIUS)) {
    const d = (g.schema.x - p.x) ** 2 + (g.schema.y - p.y) ** 2;
    if (d >= bestD || !hasLineOfSight(m.idx, p.x, p.y, g.schema.x, g.schema.y, SOLID.MOVE)) continue;
    best = g;
    bestD = d;
  }
  return best;
}

/**
 * F on a loose item. Weapons go to an empty weapon slot or replace the FREE pistol; with both
 * slots holding real weapons the new one goes into the active hand and the old one into storage
 * (or onto the ground when storage is full). Armor / backpacks are equipped when better (the old
 * one goes to storage or the ground), otherwise stored. Everything else is auto-placed.
 */
export function pickupGround(m: Match, rt: PlayerRuntime, g: GroundRt): boolean {
  const it = g.item;
  const d = itemDef(it.def);
  if (!d) return false;
  const s = rt.self.slots;
  const at = { x: g.schema.x, y: g.schema.y };

  /** Put `old` into storage; the ground at the pickup spot when it does not fit. */
  const stash = (old: ItemLike) => {
    if (placeItem(rt, old).placed < old.qty) spawnGroundItem(m, old, at.x, at.y, rt);
  };

  if (d.cat === "weapon" && s.get("w1") && s.get("w2")) {
    const free = (["w1", "w2"] as const).find((k) => s.get(k)!.flags & ITEM_FLAG.FREE);
    if (!free) {
      const key = rt.self.active;
      const old = toPlain(s.get(key)!);
      m.ground.remove(m, g.schema.id, rt);
      s.set(key, cloneItem(it));
      if (rt.reloadKey === key) rt.self.reloadUntil = 0;
      stash(old);
      syncPublic(rt);
      return true;
    }
  }
  if (d.cat === "armor" && s.get("armor")) {
    const worn = s.get("armor")!;
    const wornLevel = itemDef(worn.def)?.armorLevel ?? 0;
    if (armorIsUpgrade({ armor: wornLevel, armorDur: worn.dur }, d.armorLevel ?? 0, it.dur)) {
      const old = toPlain(worn);
      m.ground.remove(m, g.schema.id, rt);
      s.set("armor", cloneItem(it));
      stash(old);
      syncPublic(rt);
      return true;
    }
  }
  if (d.cat === "backpack" && s.get("bp") && (d.bpLevel ?? 0) > bpLevelOf(s)) {
    // Bigger pack: the bag contents belong to the player and keep their b-slots.
    const old = toPlain(s.get("bp")!);
    m.ground.remove(m, g.schema.id, rt);
    s.set("bp", cloneItem(it));
    stash(old);
    syncPublic(rt);
    return true;
  }
  const { placed } = placeItem(rt, it, it.qty);
  if (placed <= 0) return false;
  if (placed >= it.qty) m.ground.remove(m, g.schema.id, rt);
  else m.ground.setQty(m, g, it.qty - placed, rt);
  syncPublic(rt);
  return true;
}

/** Tracked uniques lying on the ground (MatchEndReport.leftOnMap). */
export function groundUniques(m: Match): ItemLike[] {
  const out: ItemLike[] = [];
  for (const g of m.ground.all()) if (isTrackedUnique(g.item)) out.push(g.item);
  return out;
}
