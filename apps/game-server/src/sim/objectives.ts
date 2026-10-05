/**
 * In-raid objectives on the server (rules: @extract/shared objectives.ts, map/locks.ts; design §7d):
 * locked rooms + keys, safe cracking, hidden caches and their clue notes, objective XP.
 *
 * Everything secret comes from the shard's loot seed (never in BattleState): which locks have a key
 * this cycle and who holds it, the cache points, which containers hold the clue notes. Public:
 * BattleState.lockState (per lock, deferred like a container flip, disclosure.ts) and the layout
 * facts every client derives itself (lockedRooms, crackSafes).
 *
 * Gates and window bars live in this match's own collision index copy (Match.idx,
 * matchCollisionIndex): all on when objectives run, a gate off once unlocked.
 *
 * Channels (unlock at a gate, crack at a safe) are one per player: started by F (Match.interact /
 * ContainerSystem.open), broken by damage (combat.ts), firing / rolling / dying / leaving
 * (closeSearch reasons) or moving more than LOCK.MOVE_TOL_PX away from where it started.
 *
 * Hidden caches are corpse-like search targets ("hc<n>", kind "cache") that the AOI never sends to a
 * client before that human has been within CACHE.FIND_PX with line of sight of it (aoi.ts hide /
 * reveal); nearestOpenable / openKey skip unknown caches the same way.
 */

import {
  CACHE,
  CACHE_LOOT,
  CACHE_NOTE_DEF,
  CRACK,
  KEY,
  LOCK,
  LOCK_STATE,
  OBJ_BUDGET,
  SOLID,
  STRONGROOM_LOOT,
  SoundKind,
  cacheId,
  clueCircle,
  clueText,
  crackSafes,
  encodeClueRef,
  eventJunkCr,
  eventSeed,
  hasLineOfSight,
  landmarkPhrase,
  lockedRooms,
  lockOfContainer,
  mulberry32,
  pickWeighted,
  resolveCircle,
  rollEventLoot,
  setGateOpen,
  setLocksEnabled,
  walkCellOf,
  type BossKind,
  type ItemLike,
  type LockedRoom,
  type NpcSquadSpawn,
  type ObjMsg,
  type Rng,
} from "@extract/shared";
import { consumeUnits, syncPublic } from "./bag.js";
import type { SearchTarget } from "./containers.js";
import { makeItem } from "./items.js";
import type { Match } from "./match.js";
import { emitSound } from "./sound.js";
import type { PlayerRuntime } from "./types.js";
import { creditRaidXp } from "./xp.js";

const KEY_SALT = 0x6b65_7901;
const CACHE_SALT = 0xcac4_e001;
const CACHE_LOOT_SALT = 0xcac4_7007;
const NOTE_SALT = 0x0e07_e001;
const STRONG_SALT = 0x5700_7007;
/** Cache discovery / gate reveal sweep period (ms). */
const SWEEP_MS = 250;
/** closeSearch reasons that also break an objective channel. */
const BREAKERS: ReadonlySet<string> = new Set(["fired", "death", "left", "disconnect", "roll", "close", "hit"]);

export interface ObjChannel {
  kind: "unlock" | "crack";
  /** Lock id / container index. */
  i: number;
  x: number;
  y: number;
  until: number;
  nextTickAt: number;
}

export interface CacheRt {
  /** 1-based (Corpse id hc<n>). */
  n: number;
  x: number;
  y: number;
  zone: string;
  clue: string;
  /** Fuzzy circle written on the notes. */
  circle: { x: number; y: number; r: number };
  target: SearchTarget | null;
  /** Roster indexes of humans who found it (AOI knowers). */
  finders: Set<number>;
}

/** Where a lock's key was put this cycle (tests, logs). */
export interface KeyPlan {
  lock: number;
  holder: "none" | "container" | "marauder" | "boss";
  /** Container index / "post.member" / boss kind. */
  at: string;
}

export interface ObjectivesSetup {
  /** Event / rolled bosses of this match. */
  bosses: ReadonlyArray<{ kind: BossKind; zone: string }>;
  squads: readonly NpcSquadSpawn[];
}

export class Objectives {
  readonly locks: readonly LockedRoom[];
  /** Truth per lock (LOCK_STATE); BattleState.lockState is the deferred public copy. */
  private readonly open: Uint8Array;
  readonly crack: ReadonlySet<number>;
  readonly cracked = new Set<number>();
  /** Junk CR strongroom rolls and caches may still add this cycle (OBJ_BUDGET.JUNK_CR). */
  readonly budget = { left: OBJ_BUDGET.JUNK_CR as number };
  readonly rolled = { junkCr: 0, items: 0, keys: 0, notes: 0, caches: 0, strongroom: 0, unlocks: 0, cracks: 0, cachesOpened: 0 };
  readonly keyPlans: KeyPlan[] = [];
  readonly caches: CacheRt[] = [];
  /** Container index → extra items rolled in on first open (keys, notes). */
  private readonly extra = new Map<number, ItemLike[]>();
  private readonly bossKeys = new Map<BossKind, ItemLike[]>();
  private readonly npcKeys = new Map<string, ItemLike[]>();
  private readonly channels = new Map<PlayerRuntime, ObjChannel>();
  /** Per lock: humans already told it is open (personal "unlocked" before the public flag). */
  private readonly told: Array<Set<number>>;
  private nextSweepAt = 0;

  constructor(private readonly m: Match, readonly enabled: boolean, setup: ObjectivesSetup) {
    this.locks = enabled ? lockedRooms(m.map) : [];
    this.open = new Uint8Array(this.locks.length);
    this.told = this.locks.map(() => new Set<number>());
    this.crack = enabled ? crackSafes(m.map) : new Set<number>();
    setLocksEnabled(m.idx, m.map, enabled);
    if (!enabled) return;
    for (let i = 0; i < this.locks.length; i++) m.state.lockState.push(LOCK_STATE.LOCKED);
    this.planKeys(setup);
    this.planCaches();
  }

  // ---------------------------------------------------------------- setup (secret seed)

  private planKeys(setup: ObjectivesSetup): void {
    const m = this.m;
    const posts = new Map((m.map.npcPosts ?? []).map((p) => [p.id, p]));
    for (const l of this.locks) {
      const rng = mulberry32(eventSeed(m.lootSeed, KEY_SALT, l.id));
      const plan: KeyPlan = { lock: l.id, holder: "none", at: "" };
      this.keyPlans.push(plan);
      if (rng() >= KEY.SPAWN_CHANCE) continue;
      const boxes: number[] = [];
      m.map.containers.forEach((c, i) => {
        if (c.zone === l.zone && !lockOfContainer(m.map, i) && !this.crack.has(i)) boxes.push(i);
      });
      const npcs = setup.squads.filter((s) => {
        const p = posts.get(s.postId);
        return !!p && p.kind !== "road" && p.zone === l.zone && s.members > 0;
      });
      const boss = setup.bosses.find((b) => b.zone === l.zone) ?? null;
      const opts: Array<{ kind: KeyPlan["holder"]; weight: number }> = [];
      if (boxes.length) opts.push({ kind: "container", weight: KEY.HOLDER_WEIGHT.container });
      if (npcs.length) opts.push({ kind: "marauder", weight: KEY.HOLDER_WEIGHT.marauder });
      if (boss) opts.push({ kind: "boss", weight: KEY.HOLDER_WEIGHT.boss });
      if (opts.length === 0) continue;
      const kind = pickWeighted(rng, opts).kind;
      const key = makeItem(l.key);
      this.rolled.keys++;
      if (kind === "container") {
        const idx = boxes[Math.floor(rng() * boxes.length)]!;
        this.addExtra(idx, key);
        plan.holder = "container";
        plan.at = String(idx);
      } else if (kind === "marauder") {
        const s = npcs[Math.floor(rng() * npcs.length)]!;
        const k = `${s.postId}.${Math.floor(rng() * s.members)}`;
        this.npcKeys.set(k, [...(this.npcKeys.get(k) ?? []), key]);
        plan.holder = "marauder";
        plan.at = k;
      } else {
        this.bossKeys.set(boss!.kind, [...(this.bossKeys.get(boss!.kind) ?? []), key]);
        plan.holder = "boss";
        plan.at = boss!.kind;
      }
    }
  }

  private addExtra(idx: number, it: ItemLike): void {
    this.extra.set(idx, [...(this.extra.get(idx) ?? []), it]);
  }

  /** Cache points: one per distinct zone, next to a landmark prop, outdoors, reachable; then notes. */
  private planCaches(): void {
    const m = this.m;
    const rng = mulberry32(eventSeed(m.lootSeed, CACHE_SALT));
    const cands = shuffled(rng, cacheCandidates(m));
    const used = new Set<string>();
    for (const c of cands) {
      if (this.caches.length >= CACHE.COUNT) break;
      if (used.has(c.zone)) continue;
      if (!cachePointValid(m, c.x, c.y)) continue;
      used.add(c.zone);
      const n = this.caches.length + 1;
      this.caches.push({ n, x: c.x, y: c.y, zone: c.zone, clue: clueText(c.phrase, c.zoneName), circle: clueCircle(m.lootSeed, n, c.x, c.y), target: null, finders: new Set() });
    }
    // Contents and the hidden search targets.
    for (const ch of this.caches) {
      const lrng = mulberry32(eventSeed(m.lootSeed, CACHE_LOOT_SALT, ch.n));
      const items = this.roll(lrng, CACHE_LOOT, CACHE.ROLLS);
      ch.target = m.containers.addHiddenCache(cacheId(ch.n), ch.x, ch.y, items);
      this.rolled.caches++;
    }
    // Clue notes: NOTES_PER_CACHE distinct containers each (T1–T3, outside locked rooms, not cracked safes).
    const nrng = mulberry32(eventSeed(m.lootSeed, NOTE_SALT));
    const pool: number[] = [];
    m.map.containers.forEach((c, i) => {
      if (c.tier < CACHE.NOTE_MIN_TIER || c.tier > CACHE.NOTE_MAX_TIER || c.kind === "stash") return;
      if (lockOfContainer(m.map, i) || this.crack.has(i)) return;
      pool.push(i);
    });
    const taken = new Set<number>();
    for (const ch of this.caches) {
      for (let k = 0; k < CACHE.NOTES_PER_CACHE && taken.size < pool.length; k++) {
        let idx = pool[Math.floor(nrng() * pool.length)]!;
        for (let guard = 0; taken.has(idx) && guard < 32; guard++) idx = pool[Math.floor(nrng() * pool.length)]!;
        if (taken.has(idx)) continue;
        taken.add(idx);
        this.addExtra(idx, makeItem(CACHE_NOTE_DEF, { label: ch.clue, ref: encodeClueRef(ch.n, ch.circle.x, ch.circle.y, ch.circle.r) }));
        this.rolled.notes++;
      }
    }
  }

  /** Event-table roll charged to OBJ_BUDGET (consumables only once it is spent). */
  private roll(rng: Rng, table: Parameters<typeof rollEventLoot>[1], rolls: number): ItemLike[] {
    return rollEventLoot(rng, table, rolls, this.budget).map((f) => {
      this.rolled.junkCr += eventJunkCr(f.def, f.qty);
      this.rolled.items++;
      return makeItem(f.def, { qty: f.qty });
    });
  }

  // ---------------------------------------------------------------- hooks from other systems

  /** ContainerSystem.roll: keys, notes and the strongroom rolls of container `idx` (once). */
  extraItems(idx: number): ItemLike[] {
    if (!this.enabled) return [];
    const out = this.extra.get(idx) ?? [];
    this.extra.delete(idx);
    if (lockOfContainer(this.m.map, idx)) {
      const rng = mulberry32(eventSeed(this.m.lootSeed, STRONG_SALT, idx));
      out.push(...this.roll(rng, STRONGROOM_LOOT, LOCK.STRONGROOM_ROLLS));
      this.rolled.strongroom++;
    }
    return out;
  }

  /** boss.ts equipBoss: a key this boss carries this cycle. */
  takeBossKeys(kind: BossKind): ItemLike[] {
    const out = this.bossKeys.get(kind) ?? [];
    this.bossKeys.delete(kind);
    return out;
  }

  /** npc.ts equipMarauder: a key this marauder (post id, member) carries this cycle. */
  takeNpcKeys(postId: number, member: number): ItemLike[] {
    const k = `${postId}.${member}`;
    const out = this.npcKeys.get(k) ?? [];
    this.npcKeys.delete(k);
    return out;
  }

  /** Is container `idx` behind a gate that is still locked (truth)? */
  containerLocked(idx: number): boolean {
    if (!this.enabled) return false;
    const l = lockOfContainer(this.m.map, idx);
    return !!l && this.open[l.id] === LOCK_STATE.LOCKED;
  }

  /** Pool placement weight multiplier of container `idx` (pool-place.ts). */
  poolWeightMult(idx: number): number {
    return this.enabled && lockOfContainer(this.m.map, idx) ? LOCK.POOL_WEIGHT_MULT : 1;
  }

  /** Is lock `id` open (truth)? */
  isOpen(id: number): boolean {
    return this.open[id] === LOCK_STATE.OPEN;
  }

  /** Does this safe still need cracking? */
  crackPending(idx: number): boolean {
    return this.enabled && this.crack.has(idx) && !this.cracked.has(idx);
  }

  /** A cache target a human may see / open (found it). */
  cacheKnown(t: SearchTarget, rt: PlayerRuntime): boolean {
    const ch = this.caches.find((c) => c.target === t);
    return !!ch && ch.finders.has(rt.rosterIndex);
  }

  /**
   * ContainerSystem.open on static container `idx`: a safe that needs cracking starts the crack
   * channel instead of a search. True = handled (no search session).
   */
  interceptOpen(rt: PlayerRuntime, idx: number): boolean {
    if (!this.crackPending(idx) || rt.isNpc) return false;
    const ch = this.channels.get(rt);
    if (ch && ch.kind === "crack" && ch.i === idx) return true;
    const spot = this.m.map.containers[idx]!;
    this.startChannel(rt, "crack", idx, CRACK.MS);
    // The first dial tick at once: the risk starts with the first second.
    emitSound(this.m, rt, SoundKind.search, spot.x, spot.y, CRACK.SOUND_VARIANT, { rangeMult: CRACK.SOUND_RANGE_MULT });
    return true;
  }

  /**
   * Match.interact before the container: F at a locked gate. `nearestContainer` = the container
   * index nearestOpenable found (or -1): a gate wins only when it is nearer. True = handled.
   */
  interact(rt: PlayerRuntime, nearestContainer: number): boolean {
    if (!this.enabled || rt.isNpc) return false;
    const p = rt.pub;
    let best: LockedRoom | null = null;
    let bestD = LOCK.INTERACT_PX * LOCK.INTERACT_PX;
    for (const l of this.locks) {
      if (this.open[l.id] === LOCK_STATE.OPEN) continue;
      for (const d of l.doors) {
        const nx = Math.max(d.x, Math.min(p.x, d.x + d.w));
        const ny = Math.max(d.y, Math.min(p.y, d.y + d.h));
        const dd = (nx - p.x) ** 2 + (ny - p.y) ** 2;
        if (dd > bestD) continue;
        // Line of sight to just outside the gate on the player's side (the gate itself is solid).
        const len = Math.sqrt(dd) || 1;
        const tx = nx + ((p.x - nx) / len) * 3, ty = ny + ((p.y - ny) / len) * 3;
        if (!hasLineOfSight(this.m.idx, p.x, p.y, tx, ty, SOLID.MOVE)) continue;
        best = l;
        bestD = dd;
      }
    }
    if (!best) return false;
    if (nearestContainer >= 0) {
      const c = this.m.map.containers[nearestContainer];
      if (c && (c.x - p.x) ** 2 + (c.y - p.y) ** 2 < bestD) return false;
    }
    const ch = this.channels.get(rt);
    if (ch && ch.kind === "unlock" && ch.i === best.id) return true;
    if (!hasItem(rt, best.key)) {
      this.tell(rt, { e: "locked", i: best.id });
      return true;
    }
    this.startChannel(rt, "unlock", best.id, LOCK.UNLOCK_MS);
    return true;
  }

  /** combat.ts: damage that cost HP breaks the victim's channel. */
  onHit(rt: PlayerRuntime): void {
    if (this.channels.has(rt)) this.stop(rt, "hit");
  }

  /** closeSearch hook: some reasons break the channel too. */
  onCloseSearch(rt: PlayerRuntime, reason: string): void {
    if (BREAKERS.has(reason) && this.channels.has(rt)) this.stop(rt, reason);
  }

  /** The running channel of a player (tests, scripted humans). */
  channelOf(rt: PlayerRuntime): ObjChannel | null {
    return this.channels.get(rt) ?? null;
  }

  // ---------------------------------------------------------------- channels

  private startChannel(rt: PlayerRuntime, kind: ObjChannel["kind"], i: number, ms: number): void {
    const m = this.m;
    this.stop(rt, "switch");
    const until = m.clock + ms;
    this.channels.set(rt, { kind, i, x: rt.pub.x, y: rt.pub.y, until, nextTickAt: m.clock + CRACK.TICK_MS });
    this.tell(rt, { e: kind, i, at: until });
    syncPublic(rt);
  }

  stop(rt: PlayerRuntime, _reason: string): void {
    if (!this.channels.delete(rt)) return;
    this.tell(rt, { e: "stop", i: -1 });
  }

  /** Per tick after stepSearches: channels, then (every SWEEP_MS) cache discovery and gate reveals. */
  step(): void {
    if (!this.enabled) return;
    const m = this.m;
    const tol2 = LOCK.MOVE_TOL_PX * LOCK.MOVE_TOL_PX;
    for (const [rt, ch] of [...this.channels]) {
      const p = rt.pub;
      if (!p.alive || m.ended) {
        this.stop(rt, "dead");
        continue;
      }
      if ((p.x - ch.x) ** 2 + (p.y - ch.y) ** 2 > tol2) {
        this.stop(rt, "moved");
        continue;
      }
      if (ch.kind === "crack" && m.clock >= ch.nextTickAt && m.clock < ch.until) {
        ch.nextTickAt += CRACK.TICK_MS;
        const s = m.map.containers[ch.i]!;
        emitSound(m, rt, SoundKind.search, s.x, s.y, CRACK.SOUND_VARIANT, { rangeMult: CRACK.SOUND_RANGE_MULT });
      }
      if (m.clock >= ch.until) {
        this.channels.delete(rt);
        if (ch.kind === "unlock") this.finishUnlock(rt, ch.i);
        else this.finishCrack(rt, ch.i);
      }
    }
    if (m.clock >= this.nextSweepAt) {
      this.nextSweepAt = m.clock + SWEEP_MS;
      this.sweep();
    }
  }

  private finishUnlock(rt: PlayerRuntime, id: number): void {
    const m = this.m;
    const l = this.locks[id]!;
    if (this.open[id] === LOCK_STATE.OPEN) return;
    if (consumeUnits(rt, l.key, 1) !== 1) {
      this.tell(rt, { e: "locked", i: id });
      return;
    }
    this.open[id] = LOCK_STATE.OPEN;
    setGateOpen(m.idx, m.map, id, true);
    this.rolled.unlocks++;
    const d = l.doors[0]!;
    const cx = d.x + d.w / 2, cy = d.y + d.h / 2;
    // The clank of the lock (a loot-class sound) and the notices: the unlocker and whoever sees them.
    emitSound(m, rt, SoundKind.loot, cx, cy);
    this.tellOpen(id, rt);
    for (const v of m.allRuntimes()) if (!v.isNpc && v !== rt && m.vision.sees(v.rosterIndex, rt.rosterIndex)) this.tellOpen(id, v);
    m.disclosure.defer(`l${id}`, cx, cy, [rt], () => {
      if (m.state.lockState[id] !== LOCK_STATE.OPEN) m.state.lockState[id] = LOCK_STATE.OPEN;
    });
    this.credit(rt);
    syncPublic(rt);
  }

  private finishCrack(rt: PlayerRuntime, idx: number): void {
    if (this.cracked.has(idx)) return;
    this.cracked.add(idx);
    this.rolled.cracks++;
    this.tell(rt, { e: "cracked", i: idx });
    this.credit(rt);
    // Straight into the ordinary search of the (now cracked) safe.
    this.m.containers.open(rt, idx);
  }

  /** ContainerSystem.countSearch on a cache: the first counted search of a user is an objective. */
  onCacheOpened(rt: PlayerRuntime): void {
    this.rolled.cachesOpened++;
    this.credit(rt);
  }

  private credit(rt: PlayerRuntime): void {
    if (rt.isNpc) return;
    rt.stats.objectives = (rt.stats.objectives ?? 0) + 1;
    creditRaidXp(this.m, rt, "objectives", rt.stats.objectives);
  }

  private tellOpen(id: number, v: PlayerRuntime): void {
    const told = this.told[id]!;
    if (told.has(v.rosterIndex)) return;
    told.add(v.rosterIndex);
    this.tell(v, { e: "unlocked", i: id });
  }

  private tell(rt: PlayerRuntime, msg: ObjMsg): void {
    if (!rt.isNpc) this.m.emit({ type: "obj", to: rt.rosterIndex, msg });
  }

  /**
   * Cache discovery (FIND_PX + line of sight → AOI knower + "found"), and open gates whose public
   * flag is still deferred: humans that come within NEAR_REVEAL_PX learn it at once (they see it).
   */
  private sweep(): void {
    const m = this.m;
    const f2 = CACHE.FIND_PX * CACHE.FIND_PX;
    const n2 = LOCK.NEAR_REVEAL_PX * LOCK.NEAR_REVEAL_PX;
    for (const v of m.allRuntimes()) {
      if (v.isNpc || !v.pub.alive) continue;
      // A dropped client lost what it was told: tell it again once it is back near the gate.
      if (!v.connected) for (const t of this.told) t.delete(v.rosterIndex);
      const p = v.pub;
      for (const ch of this.caches) {
        const t = ch.target;
        if (!t || ch.finders.has(v.rosterIndex)) continue;
        if ((t.x - p.x) ** 2 + (t.y - p.y) ** 2 > f2) continue;
        if (!hasLineOfSight(m.idx, p.x, p.y, t.x, t.y, SOLID.SIGHT)) continue;
        ch.finders.add(v.rosterIndex);
        if (t.corpse) m.aoi.reveal(t.corpse, v.rosterIndex);
        this.tell(v, { e: "found", i: ch.n });
      }
      for (const l of this.locks) {
        if (!v.connected) break;
        if (this.open[l.id] !== LOCK_STATE.OPEN || m.state.lockState[l.id] === LOCK_STATE.OPEN) continue;
        const d = l.doors[0]!;
        if ((d.x + d.w / 2 - p.x) ** 2 + (d.y + d.h / 2 - p.y) ** 2 <= n2) this.tellOpen(l.id, v);
      }
    }
  }
}

function hasItem(rt: PlayerRuntime, def: string): boolean {
  for (const it of rt.self.slots.values()) if (it.def === def && it.qty > 0) return true;
  return false;
}

function shuffled<T>(rng: Rng, arr: T[]): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j]!, arr[i]!];
  }
  return arr;
}

interface CacheCandidate {
  x: number;
  y: number;
  zone: string;
  zoneName: string;
  phrase: string;
}

const candCache = new WeakMap<object, CacheCandidate[]>();

/**
 * Every landmark-side point of the map's POIs (memoized per map): next to a landmark prop or
 * circle inside a zone, 40 px out from its edge on each of the four sides. Validity is checked
 * per cycle (cachePointValid).
 */
export function cacheCandidates(m: Match): CacheCandidate[] {
  const have = candCache.get(m.map);
  if (have) return [...have];
  const out: CacheCandidate[] = [];
  const zoneAt = (x: number, y: number) =>
    m.map.zones.find((z) => x >= z.rect.x && x <= z.rect.x + z.rect.w && y >= z.rect.y && y <= z.rect.y + z.rect.h) ?? null;
  const push = (cx: number, cy: number, hw: number, hh: number, kind: string) => {
    const phrase = landmarkPhrase(kind);
    if (!phrase) return;
    const z = zoneAt(cx, cy);
    if (!z) return;
    const off = 40;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      out.push({ x: Math.round(cx + dx * (hw + off)), y: Math.round(cy + dy * (hh + off)), zone: z.id, zoneName: z.name, phrase });
    }
  };
  for (const r of m.map.rects) {
    if (r.k === "crate" && (r.w > 80 || r.h > 80)) continue;
    push(r.x + r.w / 2, r.y + r.h / 2, r.w / 2, r.h / 2, r.k);
  }
  for (const c of m.map.circles) {
    if (c.k === "tree") continue;
    push(c.x, c.y, c.r, c.r, c.k);
  }
  candCache.set(m.map, out);
  return [...out];
}

/** A cache point: on the map, outdoors, free of solids, on a walkable cell of the spawns' component, away from extracts. */
export function cachePointValid(m: Match, x: number, y: number): boolean {
  const map = m.map;
  if (x < 200 || y < 200 || x > map.width - 200 || y > map.height - 200) return false;
  for (const b of map.buildings) {
    const f = b.floor;
    if (x >= f.x - 32 && x <= f.x + f.w + 32 && y >= f.y - 32 && y <= f.y + f.h + 32) return false;
  }
  for (const e of map.extracts) if ((e.x - x) ** 2 + (e.y - y) ** 2 < 900 ** 2) return false;
  const rt = m.mapRt;
  const cell = walkCellOf(rt.walk, x, y);
  if (rt.walk.blocked[cell]) return false;
  const r = resolveCircle(m.idx, x, y, 22);
  if (Math.abs(r.x - x) > 1e-6 || Math.abs(r.y - y) > 1e-6) return false;
  const s = map.spawns[0];
  if (s) {
    const a = rt.regions.region[walkCellOf(rt.walk, s.x, s.y)] ?? -1;
    const b = rt.regions.region[cell] ?? -1;
    if (a < 0 || b < 0 || rt.regions.comp[a] !== rt.regions.comp[b]) return false;
  }
  return true;
}
