/**
 * WORLD v6 map events on the server (rules: @extract/shared world-events.ts): supply drops, hot
 * zones and combat signals — what pulls 24 players on a 28 km² map into the same fights.
 *
 * Everything that must not be predictable comes from the shard's secret loot seed (schedules,
 * zone and point choices, crate and refill contents). What goes public:
 * - BattleState.wev (schema WorldEvent, unfiltered): the announced drop circle, the landed crate
 *   point, the hot POI and their times — world facts, never a player's position;
 * - BattleState.heat: coarse 2 km fight heat of the last minute, only cells with ≥ HEAT_MIN
 *   shots / blasts;
 * - per listener `fight` entries ([sector, band] of a 512 px fight cell's centre within
 *   FIGHT.RADIUS; the listener's own shots never count): a hidden shooter moving inside a cell
 *   gives a byte-identical payload, like quantized hidden sounds.
 * The crate itself is a Corpse search target ("sd<n>", containers.ts addSupplyDrop) and goes
 * through AOI like any body. Replays get a `wev` MatchEvent per transition (replay-recorder.ts).
 *
 * Late refill (late joiners): from LATE_REFILL.START_MS a seeded share of the EMPTIED, unguarded
 * T0–T2 containers refills once, LATE_REFILL.COOLDOWN_* after being emptied, while no living human is
 * within LATE_REFILL.HUMAN_MIN_PX (stepLate; containers.ts refill).
 *
 * Economy: crate, hot-zone and late refill rolls share one junk-CR budget per cycle
 * (EVENT_BUDGET.JUNK_CR; late refills at most LATE_REFILL.JUNK_CR_MAX of it); a crate's lost-pool
 * unique comes only from pool-place.ts (dropPoolCandidates), never minted.
 */

import {
  DROP,
  EVENT_BUDGET,
  FIGHT,
  HOT,
  HOT_ZONE_LOOT,
  LATE_REFILL,
  LATE_REFILL_LOOT,
  SUPPLY_DROP_LOOT,
  SoundKind,
  WEV_KIND,
  WEV_STATE,
  WorldEvent,
  CONTAINER_STATE,
  centreWeight,
  containerGuarded,
  encodeHeat,
  eventJunkCr,
  eventSeed,
  fightCellCentre,
  fightCellOf,
  heatLevel,
  lateRefillPlan,
  mulberry32,
  planHotZones,
  planSupplyDrops,
  quantizeFight,
  resolveCircle,
  rollEventLoot,
  rollEventLootCapped,
  supplyDropId,
  walkCellOf,
  type DropPlan,
  type HotPlan,
  type ItemLike,
  type Rng,
  type Zone,
} from "@extract/shared";
import { makeItem } from "./items.js";
import type { SearchTarget } from "./containers.js";
import type { Match } from "./match.js";
import { emitSound } from "./sound.js";
import type { PlayerRuntime } from "./types.js";

const DROP_POINT_SALT = 0x0d20_9a11;
const DROP_LOOT_SALT = 0x0d20_7007;
const HOT_PICK_SALT = 0x4072_1c4e;
const HOT_LOOT_SALT = 0x4072_7007;
const LATE_LOOT_SALT = 0x1a7e_7007;

/** One supply drop of this cycle. */
export interface DropRt {
  plan: DropPlan;
  key: string;
  zone: Zone | null;
  /** Exact landing point (chosen at the announcement). */
  x: number;
  y: number;
  /** Announced circle centre. */
  cx: number;
  cy: number;
  state: number;
  ev: WorldEvent | null;
  /** The crate's search target once landed. */
  target: SearchTarget | null;
  /** Pool uniques placed into the crate. */
  poolItems: number;
}

/** One hot zone of this cycle. */
export interface HotRt {
  plan: HotPlan;
  key: string;
  zone: Zone | null;
  state: number;
  ev: WorldEvent | null;
  /** Containers refilled at the start (MapData.containers indexes). */
  refilled: number[];
}

/** Tests: fixed drop / hot-zone timings instead of the seeded schedule (cycle clock). */
export interface WorldEventsOverride {
  drops?: DropPlan[];
  hots?: HotPlan[];
}

export class WorldEvents {
  readonly drops: DropRt[];
  readonly hots: HotRt[];
  /** Junk CR the event tables may still add this cycle. */
  readonly budget = { left: EVENT_BUDGET.JUNK_CR as number };
  /** Junk CR / consumable units rolled into crates and refills so far (tests, logs, the harness). */
  readonly rolled = { junkCr: 0, items: 0, crates: 0, refills: 0, lateRefills: 0, lateJunkCr: 0 };
  /** Junk CR late refills may still take out of `budget` this cycle (LATE_REFILL.JUNK_CR_MAX). */
  readonly lateCap = { left: LATE_REFILL.JUNK_CR_MAX as number };
  /** Late refills of this cycle: container index → match clock (once per container per cycle). */
  readonly late = new Map<number, number>();
  /** Containers that may late-refill at all (tier, unguarded, seeded share) and their cooldowns. */
  private lateEligible: Array<{ idx: number; cooldownMs: number }> | null = null;
  private nextLateAt = LATE_REFILL.START_MS as number;
  /** Fight cells with a shot / blast in the signal window: cell → last clock and the sources. */
  private readonly recent = new Map<number, { at: number; srcs: Set<number> }>();
  /** Heat buckets (HEAT_BUCKET_MS each, ring over HEAT_WINDOW_MS): bucket start and cell counts. */
  private readonly buckets: Array<{ start: number; cells: Map<number, number> }>;
  private nextSignalAt = 0;
  private nextHeatAt = 0;
  private dropHead = 0;
  private hotHead = 0;

  constructor(private readonly m: Match, readonly enabled: boolean, override: WorldEventsOverride = {}) {
    const seed = m.lootSeed;
    const hasZones = m.map.zones.length > 0;
    const dropPlans = override.drops ?? (enabled && hasZones ? planSupplyDrops(seed, WORLD_CYCLE(m)) : []);
    const hotPlans = override.hots ?? (enabled && hasZones ? planHotZones(seed, WORLD_CYCLE(m)) : []);
    this.drops = dropPlans.map((plan) => ({
      plan, key: `d${plan.n}`, zone: null, x: 0, y: 0, cx: 0, cy: 0, state: -1, ev: null, target: null, poolItems: 0,
    }));
    this.hots = hotPlans.map((plan) => ({ plan, key: `h${plan.n}`, zone: null, state: -1, ev: null, refilled: [] }));
    const n = Math.ceil(FIGHT.HEAT_WINDOW_MS / FIGHT.HEAT_BUCKET_MS);
    this.buckets = Array.from({ length: n }, () => ({ start: -Infinity, cells: new Map<number, number>() }));
  }

  // ---------------------------------------------------------------- per tick

  /** After deliverSounds in Match.step (world mode). Cheap when nothing is due. */
  step(): void {
    if (!this.enabled) return;
    const clock = this.m.clock;
    this.stepDrops(clock);
    this.stepHots(clock);
    if (clock >= this.nextLateAt) {
      this.nextLateAt = clock + LATE_REFILL.SWEEP_MS;
      this.stepLate(clock);
    }
    if (clock >= this.nextSignalAt) {
      this.nextSignalAt = clock + FIGHT.SIGNAL_EVERY_MS;
      this.signals(clock);
    }
    if (clock >= this.nextHeatAt) {
      this.nextHeatAt = clock + FIGHT.HEAT_BUCKET_MS;
      this.publishHeat(clock);
    }
  }

  private stepDrops(clock: number): void {
    for (let i = this.dropHead; i < this.drops.length; i++) {
      const d = this.drops[i]!;
      if (d.state < WEV_STATE.ANNOUNCED && clock >= d.plan.announceAt) this.announceDrop(d);
      if (d.state === WEV_STATE.ANNOUNCED && clock >= d.plan.landAt) this.landDrop(d);
      if (d.state === WEV_STATE.ACTIVE && clock >= d.plan.landAt + DROP.FLARE_MS) {
        d.state = WEV_STATE.DONE;
        if (d.ev) d.ev.state = WEV_STATE.DONE;
      }
      if (d.state === WEV_STATE.DONE && i === this.dropHead) this.dropHead++;
    }
  }

  private stepHots(clock: number): void {
    for (let i = this.hotHead; i < this.hots.length; i++) {
      const h = this.hots[i]!;
      if (h.state < WEV_STATE.ANNOUNCED && clock >= h.plan.announceAt) this.announceHot(h);
      if (h.state === WEV_STATE.ANNOUNCED && clock >= h.plan.startAt) this.startHot(h);
      if (h.state === WEV_STATE.ACTIVE && clock >= h.plan.endAt) this.endHot(h);
      if (h.state === WEV_STATE.DONE && i === this.hotHead) this.hotHead++;
    }
  }

  // ---------------------------------------------------------------- supply drops

  private announceDrop(d: DropRt): void {
    const m = this.m;
    const rng = mulberry32(eventSeed(m.lootSeed, DROP_POINT_SALT, d.plan.n));
    const taken = new Set(this.drops.filter((o) => o !== d && o.zone).map((o) => o.zone!.id));
    const at = pickDropPoint(m, rng, taken);
    if (!at) {
      // No valid point anywhere (a hand-made test map): the drop is skipped.
      d.state = WEV_STATE.DONE;
      return;
    }
    d.zone = at.zone;
    d.x = at.x;
    d.y = at.y;
    // The circle centre: up to ZONE_OFFSET_MAX × R from the point, so the point is never its centre.
    const a = rng() * Math.PI * 2;
    const off = DROP.ZONE_R * DROP.ZONE_OFFSET_MAX * (0.35 + 0.65 * rng());
    d.cx = Math.round(at.x + Math.cos(a) * off);
    d.cy = Math.round(at.y + Math.sin(a) * off);
    const ev = new WorldEvent();
    ev.kind = WEV_KIND.DROP;
    ev.state = WEV_STATE.ANNOUNCED;
    ev.x = d.cx;
    ev.y = d.cy;
    ev.r = DROP.ZONE_R;
    ev.at = d.plan.landAt;
    ev.until = d.plan.landAt + DROP.FLARE_MS;
    ev.zoneId = at.zone?.id ?? "";
    ev.zone = at.zone?.name ?? "";
    d.ev = ev;
    d.state = WEV_STATE.ANNOUNCED;
    m.state.wev.set(d.key, ev);
    m.emit({ type: "wev", ev: "drop_announce", n: d.plan.n, x: d.cx, y: d.cy, r: DROP.ZONE_R, zone: ev.zone });
  }

  private landDrop(d: DropRt): void {
    const m = this.m;
    const rng = mulberry32(eventSeed(m.lootSeed, DROP_LOOT_SALT, d.plan.n));
    const items: ItemLike[] = rollEventLoot(rng, SUPPLY_DROP_LOOT, DROP.ROLLS, this.budget).map((f) => this.count(makeItem(f.def, { qty: f.qty })));
    d.target = m.containers.addSupplyDrop(supplyDropId(d.plan.n), d.x, d.y, items);
    d.state = WEV_STATE.ACTIVE;
    this.rolled.crates++;
    const ev = d.ev!;
    ev.state = WEV_STATE.ACTIVE;
    ev.x = d.x;
    ev.y = d.y;
    ev.r = 0;
    // The landing thud: a loud world sound (quantized for those out of sight), NPCs hear it too.
    emitSound(m, null, SoundKind.explosion, d.x, d.y, DROP.SOUND_VARIANT, { rangeMult: DROP.SOUND_RANGE_MULT });
    m.emit({ type: "wev", ev: "drop_land", n: d.plan.n, x: d.x, y: d.y, r: 0, zone: ev.zone });
  }

  /** Count a rolled fungible against the stats (the budget was charged by rollEventLoot). */
  private count(it: ItemLike): ItemLike {
    const v = eventJunkCr(it.def, it.qty);
    this.rolled.junkCr += v;
    this.rolled.items++;
    return it;
  }

  /**
   * Pool placement targets (pool-place.ts): landed crates nobody has touched yet, holding fewer than
   * DROP.POOL_MAX pool items. `far` = the human-distance rule of the caller.
   */
  dropPoolCandidates(): Array<{ x: number; y: number; weight: number; drop: DropRt }> {
    const out: Array<{ x: number; y: number; weight: number; drop: DropRt }> = [];
    for (const d of this.drops) {
      const t = d.target;
      if (!t || d.poolItems >= DROP.POOL_MAX || !this.m.containers.untouchedTarget(t)) continue;
      out.push({ x: d.x, y: d.y, weight: DROP.POOL_WEIGHT, drop: d });
    }
    return out;
  }

  /** Put an (already registered) pool item into crate `d` (pool-place.ts placeOne). */
  placeInDrop(d: DropRt, it: ItemLike): boolean {
    if (!d.target || d.poolItems >= DROP.POOL_MAX || !this.m.containers.addToUntouched(d.target, it)) return false;
    d.poolItems++;
    return true;
  }

  // ---------------------------------------------------------------- hot zones

  private announceHot(h: HotRt): void {
    const m = this.m;
    const rng = mulberry32(eventSeed(m.lootSeed, HOT_PICK_SALT, h.plan.n));
    const prev = this.hots.filter((o) => o !== h && o.zone).map((o) => o.zone!.id);
    const busy = new Set([...prev.slice(-1), ...this.drops.filter((d) => d.state === WEV_STATE.ANNOUNCED || d.state === WEV_STATE.ACTIVE).map((d) => d.zone?.id ?? "")]);
    const zone = pickHotZone(m, rng, busy);
    if (!zone) {
      h.state = WEV_STATE.DONE;
      return;
    }
    h.zone = zone;
    const ev = new WorldEvent();
    ev.kind = WEV_KIND.HOT;
    ev.state = WEV_STATE.ANNOUNCED;
    ev.x = Math.round(zone.rect.x + zone.rect.w / 2);
    ev.y = Math.round(zone.rect.y + zone.rect.h / 2);
    ev.r = 0;
    ev.at = h.plan.startAt;
    ev.until = h.plan.endAt;
    ev.zoneId = zone.id;
    ev.zone = zone.name;
    h.ev = ev;
    h.state = WEV_STATE.ANNOUNCED;
    m.state.wev.set(h.key, ev);
    m.emit({ type: "wev", ev: "hot_announce", n: h.plan.n, x: ev.x, y: ev.y, r: 0, zone: zone.name });
  }

  private startHot(h: HotRt): void {
    const m = this.m;
    const zone = h.zone!;
    const rng = mulberry32(eventSeed(m.lootSeed, HOT_LOOT_SALT, h.plan.n));
    // The POI's emptied containers, in a seeded order, at most MAX_REFILL of them.
    const idxs: number[] = [];
    m.map.containers.forEach((c, i) => {
      if (c.zone === zone.id && m.containers.stateOf(i) === CONTAINER_STATE.EMPTIED) idxs.push(i);
    });
    for (let i = idxs.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [idxs[i], idxs[j]] = [idxs[j]!, idxs[i]!];
    }
    for (const idx of idxs.slice(0, HOT.MAX_REFILL)) {
      const items = rng() < HOT.FILL_CHANCE ? rollEventLoot(rng, HOT_ZONE_LOOT, 1, this.budget).map((f) => this.count(makeItem(f.def, { qty: f.qty }))) : [];
      if (m.containers.refill(idx, items)) {
        h.refilled.push(idx);
        this.rolled.refills++;
      }
    }
    h.state = WEV_STATE.ACTIVE;
    h.ev!.state = WEV_STATE.ACTIVE;
    m.emit({ type: "wev", ev: "hot_start", n: h.plan.n, x: h.ev!.x, y: h.ev!.y, r: 0, zone: zone.name });
  }

  private endHot(h: HotRt): void {
    h.state = WEV_STATE.DONE;
    h.ev!.state = WEV_STATE.DONE;
    this.m.emit({ type: "wev", ev: "hot_end", n: h.plan.n, x: h.ev!.x, y: h.ev!.y, r: 0, zone: h.zone?.name ?? "" });
  }

  // ---------------------------------------------------------------- late refill (late joiners)

  /** Eligible containers of the map (LATE_REFILL rules that never change within a cycle). */
  private lateList(): Array<{ idx: number; cooldownMs: number }> {
    if (this.lateEligible) return this.lateEligible;
    const m = this.m;
    const out: Array<{ idx: number; cooldownMs: number }> = [];
    m.map.containers.forEach((c, idx) => {
      if (c.tier > LATE_REFILL.MAX_TIER || containerGuarded(c, m.map.bosses)) return;
      const plan = lateRefillPlan(m.lootSeed, idx);
      if (plan.refills) out.push({ idx, cooldownMs: plan.cooldownMs });
    });
    this.lateEligible = out;
    return out;
  }

  /**
   * One late refill sweep (every LATE_REFILL.SWEEP_MS from START_MS): eligible containers EMPTIED
   * at least their cooldown ago, not refilled late this cycle, with no living human within
   * HUMAN_MIN_PX, oldest emptied first, at most PER_SWEEP now and MAX_PER_CYCLE per cycle.
   */
  private stepLate(clock: number): void {
    const m = this.m;
    const end = m.world?.durationMs ?? 0;
    if (end > 0 && clock > end - LATE_REFILL.STOP_BEFORE_END_MS) return;
    if (this.late.size >= LATE_REFILL.MAX_PER_CYCLE) return;
    const due: Array<{ idx: number; at: number }> = [];
    for (const e of this.lateList()) {
      if (this.late.has(e.idx)) continue;
      const at = m.containers.emptiedAt(e.idx);
      if (at < 0 || clock - at < e.cooldownMs) continue;
      due.push({ idx: e.idx, at });
    }
    if (due.length === 0) return;
    const humans: Array<{ x: number; y: number }> = [];
    for (const rt of m.allRuntimes()) if (!rt.isNpc && rt.pub.alive) humans.push(rt.pub);
    const r2 = LATE_REFILL.HUMAN_MIN_PX * LATE_REFILL.HUMAN_MIN_PX;
    due.sort((a, b) => a.at - b.at || a.idx - b.idx);
    let done = 0;
    for (const { idx } of due) {
      if (done >= LATE_REFILL.PER_SWEEP || this.late.size >= LATE_REFILL.MAX_PER_CYCLE) break;
      const c = m.map.containers[idx]!;
      if (humans.some((h) => (h.x - c.x) ** 2 + (h.y - c.y) ** 2 < r2)) continue;
      const rng = mulberry32(eventSeed(m.lootSeed, LATE_LOOT_SALT, idx));
      const before = this.budget.left;
      const items = rollEventLootCapped(rng, LATE_REFILL_LOOT, LATE_REFILL.ROLLS, this.budget, this.lateCap)
        .map((f) => this.count(makeItem(f.def, { qty: f.qty })));
      if (!m.containers.refill(idx, items)) continue;
      this.late.set(idx, clock);
      this.rolled.lateRefills++;
      this.rolled.lateJunkCr += before - this.budget.left;
      done++;
    }
  }

  /** The active hot zone containing (x, y), if any (container XP × HOT.XP_MULT). */
  hotAt(x: number, y: number): HotRt | null {
    for (const h of this.hots) {
      if (h.state !== WEV_STATE.ACTIVE || !h.zone) continue;
      const r = h.zone.rect;
      if (x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) return h;
    }
    return null;
  }

  // ---------------------------------------------------------------- combat signals

  /** Match.emit hook: a raw sound. Gunshots and grenade blasts are fights (the crate's thud is not). */
  onSound(src: number, kind: number, x: number, y: number, variant: number): void {
    if (!this.enabled) return;
    if (kind !== SoundKind.shot && !(kind === SoundKind.explosion && variant !== DROP.SOUND_VARIANT)) return;
    const clock = this.m.clock;
    const cell = fightCellOf(x, y, this.m.map.width);
    let r = this.recent.get(cell);
    if (!r || clock - r.at > FIGHT.SIGNAL_WINDOW_MS) {
      r = { at: clock, srcs: new Set() };
      this.recent.set(cell, r);
    }
    r.at = clock;
    r.srcs.add(src);
    // Heat ring: the bucket of this clock (reset when it starts a new window slot).
    const slot = Math.floor(clock / FIGHT.HEAT_BUCKET_MS);
    const b = this.buckets[slot % this.buckets.length]!;
    const start = slot * FIGHT.HEAT_BUCKET_MS;
    if (b.start !== start) {
      b.start = start;
      b.cells.clear();
    }
    const hc = fightCellOf(x, y, this.m.map.width, FIGHT.HEAT_CELL);
    b.cells.set(hc, (b.cells.get(hc) ?? 0) + 1);
  }

  /**
   * Per listener (connected living humans): every recent fight cell within FIGHT.RADIUS of them,
   * as [sector, band] of the cell centre, deduped. A cell whose only source is the listener is
   * skipped (your own shots are not a fight "nearby").
   */
  private signals(clock: number): void {
    const m = this.m;
    for (const [cell, r] of this.recent) if (clock - r.at > FIGHT.SIGNAL_WINDOW_MS) this.recent.delete(cell);
    if (this.recent.size === 0) return;
    const centres = [...this.recent.entries()].map(([cell, r]) => ({ c: fightCellCentre(cell, m.map.width), srcs: r.srcs }));
    for (const l of m.allRuntimes()) {
      if (l.isNpc || !l.pub.alive || !l.connected) continue;
      const msg = fightSignalsFor(l, centres);
      if (msg.length > 0) m.emit({ type: "fight", to: l.rosterIndex, msg });
    }
  }

  /** BattleState.heat from the buckets of the last HEAT_WINDOW_MS. */
  private publishHeat(clock: number): void {
    const sum = new Map<number, number>();
    for (const b of this.buckets) {
      if (b.start <= clock - FIGHT.HEAT_WINDOW_MS) continue;
      for (const [c, n] of b.cells) sum.set(c, (sum.get(c) ?? 0) + n);
    }
    const levels = new Map<number, number>();
    const hottest = [...sum.entries()].filter(([, n]) => n >= FIGHT.HEAT_MIN).sort((a, b) => b[1] - a[1] || a[0] - b[0]).slice(0, FIGHT.HEAT_MAX_CELLS);
    for (const [c, n] of hottest) levels.set(c, heatLevel(n));
    const s = encodeHeat(levels);
    if (this.m.state.heat !== s) this.m.state.heat = s;
  }
}

/** The fight entries of one listener (exported for the fog tests). */
export function fightSignalsFor(
  l: Pick<PlayerRuntime, "rosterIndex" | "pub">,
  cells: ReadonlyArray<{ c: { x: number; y: number }; srcs: ReadonlySet<number> }>,
): number[] {
  const out: number[] = [];
  const seen = new Set<number>();
  for (const { c, srcs } of cells) {
    if (srcs.size === 1 && srcs.has(l.rosterIndex)) continue;
    const q = quantizeFight(l.pub.x, l.pub.y, c.x, c.y);
    if (!q) continue;
    const k = q[0] * 4 + q[1];
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(q[0], q[1]);
  }
  return out;
}

function WORLD_CYCLE(m: Match): number {
  return m.world?.durationMs ?? 0;
}

/**
 * A valid landing point (exported for tests): a POI (MapData.zones) drawn with centreWeight, not
 * in `taken`, not the live event boss's turf; inside it a seeded point that is outdoors (no
 * building floor), on a free walk cell in the spawn spots' connected component, DROP.CLEAR_PX
 * clear of solids and ≥ DROP.EXTRACT_MIN_PX from every extract. Null when no zone has one.
 */
export function pickDropPoint(m: Match, rng: Rng, taken: ReadonlySet<string>): { x: number; y: number; zone: Zone | null } | null {
  const map = m.map;
  const bossZone = m.eventBossSpot?.zone ?? null;
  let zones = map.zones.filter((z) => !taken.has(z.id) && z.id !== bossZone);
  for (let attempt = 0; attempt < map.zones.length && zones.length > 0; attempt++) {
    const total = zones.reduce((s, z) => s + zoneDropWeight(m, z), 0);
    let roll = rng() * total;
    let zone = zones[zones.length - 1]!;
    for (const z of zones) {
      roll -= zoneDropWeight(m, z);
      if (roll <= 0) {
        zone = z;
        break;
      }
    }
    for (let i = 0; i < DROP.TRIES_PER_ZONE; i++) {
      const inset = 96;
      const x = Math.round(zone.rect.x + inset + rng() * Math.max(1, zone.rect.w - 2 * inset));
      const y = Math.round(zone.rect.y + inset + rng() * Math.max(1, zone.rect.h - 2 * inset));
      if (dropPointValid(m, x, y)) return { x, y, zone };
    }
    zones = zones.filter((z) => z !== zone);
  }
  return null;
}

function zoneDropWeight(m: Match, z: Zone): number {
  return centreWeight(z.rect.x + z.rect.w / 2, z.rect.y + z.rect.h / 2, m.map.width, m.map.height, HOT.CENTRE_SCALE_PX);
}

let spawnCompCache: WeakMap<object, number> = new WeakMap();

/** Landing point rules (pickDropPoint). */
export function dropPointValid(m: Match, x: number, y: number): boolean {
  const map = m.map;
  const margin = 200;
  if (x < margin || y < margin || x > map.width - margin || y > map.height - margin) return false;
  for (const b of map.buildings) {
    const f = b.floor;
    if (x >= f.x - DROP.CLEAR_PX && x <= f.x + f.w + DROP.CLEAR_PX && y >= f.y - DROP.CLEAR_PX && y <= f.y + f.h + DROP.CLEAR_PX) return false;
  }
  for (const e of map.extracts) if ((e.x - x) ** 2 + (e.y - y) ** 2 < DROP.EXTRACT_MIN_PX ** 2) return false;
  const rt = m.mapRt;
  const cell = walkCellOf(rt.walk, x, y);
  if (rt.walk.blocked[cell]) return false;
  const r = resolveCircle(rt.idx, x, y, DROP.CLEAR_PX);
  if (Math.abs(r.x - x) > 1e-6 || Math.abs(r.y - y) > 1e-6) return false;
  // Reachable: the same connected walk component as the map's spawn spots.
  let comp = spawnCompCache.get(map);
  if (comp === undefined) {
    const s = map.spawns[0];
    const reg = s ? rt.regions.region[walkCellOf(rt.walk, s.x, s.y)] ?? -1 : -1;
    comp = reg >= 0 ? (rt.regions.comp[reg] ?? -1) : -1;
    spawnCompCache.set(map, comp);
  }
  if (comp >= 0) {
    const reg = rt.regions.region[cell] ?? -1;
    if (reg < 0 || rt.regions.comp[reg] !== comp) return false;
  }
  return true;
}

/**
 * The POI for a hot zone (exported for tests): weighted toward the map centre and toward the
 * centroid of the living humans (pulls players together), divided by 1 + the humans already
 * inside (it must not just reward whoever is there). Skips the live event boss's turf and `busy`.
 */
export function pickHotZone(m: Match, rng: Rng, busy: ReadonlySet<string>): Zone | null {
  const map = m.map;
  const bossZone = m.eventBossSpot?.zone ?? null;
  const zones = map.zones.filter((z) => !busy.has(z.id) && z.id !== bossZone && m.map.containers.some((c) => c.zone === z.id));
  if (zones.length === 0) return null;
  const humans: Array<{ x: number; y: number }> = [];
  for (const rt of m.allRuntimes()) if (!rt.isNpc && rt.pub.alive) humans.push(rt.pub);
  const cx = humans.length >= 2 ? humans.reduce((s, h) => s + h.x, 0) / humans.length : map.width / 2;
  const cy = humans.length >= 2 ? humans.reduce((s, h) => s + h.y, 0) / humans.length : map.height / 2;
  const weight = (z: Zone): number => {
    const zx = z.rect.x + z.rect.w / 2, zy = z.rect.y + z.rect.h / 2;
    const between = 1 / (1 + (Math.hypot(zx - cx, zy - cy) / HOT.BETWEEN_SCALE_PX) ** 2);
    let inside = 0;
    for (const h of humans) if (h.x >= z.rect.x && h.x <= z.rect.x + z.rect.w && h.y >= z.rect.y && h.y <= z.rect.y + z.rect.h) inside++;
    return (centreWeight(zx, zy, map.width, map.height, HOT.CENTRE_SCALE_PX) * between) / (1 + inside);
  };
  const total = zones.reduce((s, z) => s + weight(z), 0);
  let roll = rng() * total;
  for (const z of zones) {
    roll -= weight(z);
    if (roll <= 0) return z;
  }
  return zones[zones.length - 1]!;
}

/** Test helper: reset the spawn-component cache (hand-made maps reuse objects). */
export function resetDropCaches(): void {
  spawnCompCache = new WeakMap();
}

