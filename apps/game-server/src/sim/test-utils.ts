/** Helpers for the node:test suites: a tiny open map and deterministic matches driven by hand. */

import {
  Extract,
  ITEM_FLAG,
  WORLD,
  LEGACY_WORLD,
  MAP_GEN_VERSION,
  SERVER_TICK_MS,
  SOLID,
  circleIsFree,
  getCollisionIndex,
  itemDef,
  legacyMapData,
  mulberry32,
  type ContainerSpot,
  type BossKind,
  type InputSample,
  type LoadoutSnapshot,
  type MapData,
  type MapRect,
  type NpcPost,
  type Player,
  type Rarity,
  type SelfState,
  type SettledItem,
  type SlotKey,
  type WeaponId,
} from "@extract/shared";
import { placeItem, syncPublic } from "./bag.js";
import { cloneItem, makeItem, type ItemInit } from "./items.js";
import { Match, type MatchOptions } from "./match.js";
import type { EntryInit, MatchEvent, PlayerRuntime, RosterEntry } from "./types.js";

export interface TestMapOpts {
  walls?: Array<{ x: number; y: number; w: number; h: number }>;
  /** Window segments (k "window", SOLID.WINDOW: no walking, the roll vaults, bullets and sight pass). */
  windows?: Array<{ x: number; y: number; w: number; h: number }>;
  bushes?: Array<{ x: number; y: number; r: number }>;
  containers?: ContainerSpot[];
}

/** Empty 4800 px arena: border walls, one crate wall for bullet tests (x 3000..3064, y 3000..3400). */
export function testMap(o: TestMapOpts = {}): MapData {
  const W = LEGACY_WORLD.WIDTH;
  const H = LEGACY_WORLD.HEIGHT;
  const B = LEGACY_WORLD.BORDER;
  const cell = 64;
  const cols = Math.ceil(W / cell), rows = Math.ceil(H / cell);
  const rect = (x: number, y: number, w: number, h: number, k: MapRect["k"], f: number = SOLID.ALL): MapRect => ({ x, y, w, h, f, k });
  return {
    id: "steppe", genVersion: MAP_GEN_VERSION, seed: 0x7e57, width: W, height: H,
    terrain: new Uint8Array(cols * rows), terrainCols: cols, terrainRows: rows, terrainCell: cell,
    zones: [], roads: [], river: [],
    rects: [
      rect(0, 0, W, B, "border"), rect(0, H - B, W, B, "border"), rect(0, 0, B, H, "border"), rect(W - B, 0, B, H, "border"),
      rect(3000, 3000, 64, 400, "crate"),
      ...(o.walls ?? []).map((w) => rect(w.x, w.y, w.w, w.h, "wall")),
      ...(o.windows ?? []).map((w) => rect(w.x, w.y, w.w, w.h, "window", SOLID.WINDOW)),
    ],
    circles: [],
    bushes: o.bushes ?? [],
    decals: [],
    buildings: [],
    containers: o.containers ?? [],
    lootSpots: [],
    spawns: Array.from({ length: 8 }, (_, i) => ({ x: 1000 + i * 150, y: 1000, side: 0 as const })),
    extracts: [],
    bosses: [],
    ambient: [],
  };
}

let uidSeq = 0;
export function counterUid(): string {
  return `uid-${(uidSeq++).toString().padStart(5, "0")}`;
}

export function humans(n: number): RosterEntry[] {
  return Array.from({ length: n }, (_, i) => ({ userId: `user${i}`, nickname: `P${i}` }));
}

/** A marauder post for hand-made test maps (default: a lone T1 "low" marauder that holds its post). */
export function testPost(id: number, x: number, y: number, o: Partial<NpcPost> = {}): NpcPost {
  return { id, zone: null, tier: 1, kind: "poi", x, y, patrol: [], size: [1, 1], chance: 1, ...o };
}

/** Match options that always spawn one squad per post, at its largest size (size[1]). */
export function npcOpts(posts: NpcPost[]): Partial<MatchOptions> {
  return { npcPosts: posts, npcSpawns: posts.map((p) => ({ postId: p.id, members: p.size[1] })) };
}

/**
 * `count` marauder posts on free ground of the legacy map of `mapSeed` (≥ 700 px apart, away from
 * the border); every 2nd one is T3 (carrier-eligible, "high" class), the rest T1 ("low").
 */
export function legacyNpcPosts(mapSeed: number, count: number, size: [number, number] = [2, 2]): NpcPost[] {
  const map = legacyMapData(mapSeed);
  const idx = getCollisionIndex(map);
  const rng = mulberry32((mapSeed ^ 0x9057) >>> 0);
  const out: NpcPost[] = [];
  for (let tries = 0; out.length < count && tries < 1000; tries++) {
    const x = 900 + rng() * (map.width - 1800);
    const y = 900 + rng() * (map.height - 1800);
    if (!circleIsFree(idx, x, y, 60) || out.some((q) => Math.hypot(q.x - x, q.y - y) < 700)) continue;
    const t3 = out.length % 2 === 1;
    out.push({ id: out.length, zone: null, tier: t3 ? 3 : 1, kind: "poi", x, y, patrol: [], size, chance: 1 });
  }
  return out;
}

/** The NPC runtimes of a match (bosses, guards, marauders) in spawn order. */
export function npcsOf(m: Match): PlayerRuntime[] {
  return m.npcs.runtimes();
}

export function testMatch(n = 2, opts: Partial<MatchOptions> = {}): Match {
  return new Match({
    roster: humans(n),
    rng: mulberry32(42),
    map: testMap(),
    newUid: counterUid,
    now: () => 1_700_000_000_000,
    emptyWorld: true,
    strictLedger: true,
    envSeed: 1,
    weatherOverride: "clear",
    ...opts,
  });
}

/** State keys of roster players, in roster order. */
export function ids(m: Match): string[] {
  return m.allRuntimes().map((r) => r.id);
}

export function rtOf(m: Match, id: string): PlayerRuntime {
  const rt = m.runtime(id);
  if (!rt) throw new Error(`no player ${id}`);
  return rt;
}

export function pl(m: Match, id: string): Player {
  return rtOf(m, id).pub;
}

export function selfOf(m: Match, id: string): SelfState {
  return rtOf(m, id).self;
}

export function place(m: Match, id: string, x: number, y: number): void {
  const p = pl(m, id);
  p.x = x;
  p.y = y;
}

/**
 * Put an item into a slot (replacing what is there). Uniques get a fresh uid registered in the
 * ledger as a loadout item. Returns the uid ("" for stacks).
 */
export function giveItem(m: Match, id: string, def: string, key: SlotKey, init: ItemInit = {}): string {
  const rt = rtOf(m, id);
  const it = makeItem(def, init);
  if (it.uid === "" && itemDef(def)?.unique && !(it.flags & ITEM_FLAG.FREE)) it.uid = m.newUid();
  if (it.uid) m.ledger.register(it, "loadout");
  rt.self.slots.set(key, cloneItem(it));
  syncPublic(rt);
  return it.uid;
}

export function giveWeapon(m: Match, id: string, key: "w1" | "w2", weapon: WeaponId, rarity: Rarity = 0, mag?: number): string {
  return giveItem(m, id, weapon, key, mag === undefined ? { rarity } : { rarity, mag });
}

/** Auto-place a stack (ammo / meds / junk). Returns the units placed. */
export function giveStack(m: Match, id: string, def: string, qty: number): number {
  return placeItem(rtOf(m, id), makeItem(def, { qty }), qty).placed;
}

/** Remove every stack of `def` the player carries. */
export function clearDef(m: Match, id: string, def: string): void {
  const s = selfOf(m, id).slots;
  for (const [k, it] of [...s.entries()]) if (it.def === def) s.delete(k);
}

export function addExtract(m: Match, x: number, y: number, openAt = 0, closeAt = 0, r = 110): Extract {
  const e = new Extract();
  e.id = `e${m.state.extracts.size}`;
  e.x = x;
  e.y = y;
  e.r = r;
  e.openAt = openAt;
  e.closeAt = closeAt;
  m.state.extracts.set(e.id, e);
  return e;
}

/** Queue one sample with the next seq for that player. */
export function send(m: Match, id: string, s: Partial<Omit<InputSample, "seq">> = {}): boolean {
  const rt = m.runtime(id)!;
  return m.enqueueInput(id, { seq: rt.lastQueuedSeq + 1, mx: 0, my: 0, aim: 0, fire: false, ...s });
}

/**
 * Advance `ms` of match time in server ticks while feeding the given players a steady 30 Hz
 * input stream (what a real client does). Returns every event emitted meanwhile, with its clock.
 */
export function run(
  m: Match,
  ms: number,
  inputs: Record<string, Partial<Omit<InputSample, "seq">>> = {},
): Array<MatchEvent & { at: number }> {
  const out: Array<MatchEvent & { at: number }> = [];
  const acc: Record<string, number> = {};
  for (let t = 0; t < ms - 1e-6; t += SERVER_TICK_MS) {
    for (const [id, s] of Object.entries(inputs)) {
      acc[id] = (acc[id] ?? 0) + SERVER_TICK_MS;
      while (acc[id]! >= 1000 / 30 - 1e-6) {
        acc[id]! -= 1000 / 30;
        send(m, id, s);
      }
    }
    m.step(SERVER_TICK_MS);
    for (const e of m.drainEvents()) out.push({ ...e, at: m.clock });
  }
  return out;
}

export type Timed = MatchEvent & { at: number };
export const shotsBy = (events: Timed[], m: Match, id: string) =>
  events.filter((e): e is Extract2<Timed, { type: "shot" }> => e.type === "shot" && e.src === rtOf(m, id).rosterIndex);
type Extract2<T, U> = T extends U ? T : never;


// ---------------------------------------------------------------- WORLD v6 helpers

/** Wall ms of the test cycle's start (cycle 1000 × 45 min). */
export const WORLD_T0 = 1000 * WORLD.CYCLE_MS;

/** The injected wall clock of a world test match (`now()` reads `t`). */
export interface WallClock {
  t: number;
}

/**
 * A world-mode match on a hand-made map (default: the open test arena), driven by an injected wall
 * clock that starts `startOffsetMs` after the cycle start (negative = prewarmed). Strict ledger,
 * deterministic rng / uids, no floor loot.
 */
export function worldMatch(opts: Partial<MatchOptions> & { startOffsetMs?: number; bossEvent?: BossKind | null } = {}): { m: Match; wall: WallClock } {
  const { startOffsetMs = 0, bossEvent = null, ...rest } = opts;
  const wall: WallClock = { t: WORLD_T0 + startOffsetMs };
  const m = new Match({
    roster: [],
    rng: mulberry32(42),
    map: testMap(),
    newUid: counterUid,
    now: () => wall.t,
    emptyWorld: true,
    strictLedger: true,
    envSeed: 1,
    weatherOverride: "clear",
    world: { cycleId: 1000, shard: 0, cycleStartsAt: WORLD_T0, entryCloseMs: WORLD.CYCLE_MS - WORLD.ENTRY_CLOSE_MS, bossEvent },
    ...rest,
  });
  return { m, wall };
}

/** Advance the wall clock by `ms` in server ticks, stepping the match each tick. Returns the events. */
export function advance(m: Match, wall: WallClock, ms: number): Array<MatchEvent & { at: number }> {
  const out: Array<MatchEvent & { at: number }> = [];
  for (let t = 0; t < ms - 1e-6 && !m.ended; t += SERVER_TICK_MS) {
    wall.t += SERVER_TICK_MS;
    m.step(SERVER_TICK_MS);
    for (const e of m.drainEvents()) out.push({ ...e, at: m.clock });
  }
  return out;
}

/** Jump the wall clock by `ms` and run one step (the world clock follows the wall). Returns the events. */
export function jump(m: Match, wall: WallClock, ms: number): Array<MatchEvent & { at: number }> {
  wall.t += ms;
  m.step(SERVER_TICK_MS);
  return m.drainEvents().map((e) => ({ ...e, at: m.clock }));
}

let entrySeq = 0;
/** Admit an entry for `userId` (free kit unless a snapshot is given). */
export function enter(m: Match, userId: string, o: Partial<EntryInit> = {}): PlayerRuntime {
  return m.addHuman({
    entryId: `entry-${(entrySeq++).toString().padStart(4, "0")}`,
    userId,
    nickname: userId.toUpperCase(),
    loadoutId: o.snapshot?.loadoutId ?? "",
    guest: false,
    level: 3,
    snapshot: null,
    pool: [],
    bossFill: [],
    ...o,
  });
}

/** A one-entry loadout snapshot (unique with a fresh uid unless given). */
export function snapshotOf(userId: string, entries: Array<Partial<SettledItem> & { def: string; key: SlotKey }>): LoadoutSnapshot {
  return {
    loadoutId: `lo-${userId}-${entrySeq}`,
    userId,
    level: 3,
    entries: entries.map((e) => ({ uid: "", qty: 1, rarity: 0, dur: 100, ...e })),
  };
}

/** A settled pool item (unique) with uid `uid`. */
export function poolItem(uid: string, def = "rifle", rarity = 2): SettledItem {
  return { uid, def, qty: 1, rarity, dur: 100 };
}
