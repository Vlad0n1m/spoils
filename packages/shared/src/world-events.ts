/**
 * WORLD v6 map events (encounter density): supply drops, hot zones and combat signals. The rules
 * and the pure parts live here (schedules, loot tables, quantization, the heat encoding) so the
 * game server, the client and the tests share one definition; the game server's
 * sim/world-events.ts runs them.
 *
 * - SUPPLY DROP: 2–3 per cycle at times drawn from the shard's secret loot seed (first announce at
 *   ≥ 8:00, last landing ≥ 6 min before the wipe). Announced to everyone 60 s before landing with a
 *   400 px zone circle (the exact point is somewhere inside it); at landing the crate (a search
 *   target, Corpse id "sd<n>") lands with a flare / smoke column and a loud world sound. Contents:
 *   SUPPLY_DROP_LOOT (CR economy) plus, at most, ONE lost-pool unique placed by the normal pool
 *   placement (it is a pool target like a T3/T4 container while nobody has touched it): never
 *   minted. Opening takes DROP.OPEN_MS and is interrupted by damage.
 * - HOT ZONE: one POI every ~15 min is "hot" for 8 min (announced 60 s ahead). At its start the
 *   POI's EMPTIED containers (at most HOT.MAX_REFILL) refill from HOT_ZONE_LOOT (CR economy only,
 *   never a pool target), and container XP inside it pays × HOT.XP_MULT while it lasts.
 * - COMBAT SIGNALS: gunfire / explosions within FIGHT.RADIUS reach the minimap as a quantized
 *   (sector, band) "fight nearby" marker computed from the fight's FIGHT.CELL cell centre (moving
 *   the shooter anywhere inside the cell gives the same payload); the full map shows the last
 *   60 s of fights as coarse HEAT_CELL heat (a cell needs HEAT_MIN events to show at all).
 * - LATE REFILL (late joiners): from minute LATE_REFILL.START_MS a seeded share of the map's
 *   EMPTIED, unguarded T0–T2 containers refill LATE_REFILL.COOLDOWN_MIN..MAX_MS after they were
 *   emptied, only while no living human is within LATE_REFILL.HUMAN_MIN_PX, at most once each per
 *   cycle, from LATE_REFILL_LOOT (cheap junk + consumables; never a pool target, never minted).
 * - BUDGET: the junk CR these events add to a cycle is capped (EVENT_BUDGET.JUNK_CR, shared by
 *   crates, hot-zone refills and late refills; late refills may take at most LATE_REFILL.JUNK_CR_MAX
 *   of it); past it the event tables roll consumables only.
 */

import { SOUND, type Band } from "./sound.js";
import { WORLD } from "./constants.js";
import { HOT_ZONE_XP_MULT } from "./economy.js";
import { itemDef } from "./item-defs.js";
import { mulberry32, pickWeighted, type Rng } from "./rng.js";

export const DROP = {
  COUNT_MIN: 2,
  COUNT_MAX: 3,
  /** The first announcement is at least this far into the cycle. */
  FIRST_ANNOUNCE_MS: 8 * 60_000,
  /** No landing in the last this-many ms of the cycle. */
  NO_LAND_LAST_MS: 6 * 60_000,
  /** Announcement → landing. */
  WARN_MS: 60_000,
  /** Radius of the announced zone circle (the landing point is inside it, never at its centre). */
  ZONE_R: 400,
  /** The landing point sits at most this share of ZONE_R from the circle centre. */
  ZONE_OFFSET_MAX: 0.7,
  /** Open delay of the crate (the 6 s channel; damage interrupts it). */
  OPEN_MS: 6_000,
  /** The flare / smoke column burns this long after landing (a fixed time: it never tells who looted it). */
  FLARE_MS: 150_000,
  /** Client fall animation before the crate is on the ground. */
  FALL_MS: 1_400,
  /** Landing sound: a world explosion-class sound, radius × this. */
  SOUND_RANGE_MULT: 1.5,
  /** SoundKind.explosion variant of the landing thud (not counted as a fight). */
  SOUND_VARIANT: 1,
  /** Fixed rolls of SUPPLY_DROP_LOOT (no empty rolls). */
  ROLLS: 4,
  /** Pool placement weight of an untouched crate (poolContainerWeight of a T4 container is 25). */
  POOL_WEIGHT: 50,
  /** Pool uniques a crate may hold. */
  POOL_MAX: 1,
  /** Landing point: clearance from solids, and distance from extracts and map spawns. */
  CLEAR_PX: 48,
  EXTRACT_MIN_PX: 1_200,
  /** Point samples tried per candidate zone. */
  TRIES_PER_ZONE: 24,
} as const;

export const HOT = {
  /** One hot zone per period: slot k starts in [k·PERIOD + FIRST_MS, … + JITTER_MS]. */
  PERIOD_MS: 15 * 60_000,
  FIRST_MS: 4 * 60_000,
  JITTER_MS: 3 * 60_000,
  WARN_MS: 60_000,
  DURATION_MS: 8 * 60_000,
  /** Container XP inside an active hot zone pays this multiple (the containers line; economy.ts). */
  XP_MULT: HOT_ZONE_XP_MULT,
  /** Emptied containers refilled per hot zone. */
  MAX_REFILL: 12,
  /** Chance a refilled container gets a roll at all. */
  FILL_CHANCE: 0.8,
  /** Weight scale (px) of the pull toward the map centre and toward the humans' centroid. */
  CENTRE_SCALE_PX: 9_000,
  BETWEEN_SCALE_PX: 7_000,
} as const;

export const FIGHT = {
  /** A listener hears of fights this far away (well past a gunshot's hearing radius). */
  RADIUS: 5_000,
  /** Fight positions are snapped to the centre of this cell before quantization. */
  CELL: 512,
  /** Signals go out this often (per listener, one batch of entries). */
  SIGNAL_EVERY_MS: 1_000,
  /** A cell counts as an active fight for this long after its last shot / blast. */
  SIGNAL_WINDOW_MS: 3_000,
  /** Full-map heat: cells, window, bucket and the level thresholds (events in the window). */
  HEAT_CELL: 2_048,
  HEAT_WINDOW_MS: 60_000,
  HEAT_BUCKET_MS: 10_000,
  HEAT_MIN: 3,
  HEAT_LEVELS: [3, 15, 40] as const,
  /** Most cells published (the hottest). */
  HEAT_MAX_CELLS: 24,
} as const;

/** Junk CR (item value × qty) events may add to one cycle; past it they roll consumables only. */
export const EVENT_BUDGET = {
  JUNK_CR: 1_200,
} as const;

/** WorldEvent.kind / .state (schema). */
export const WEV_KIND = { DROP: 1, HOT: 2 } as const;
export const WEV_STATE = { ANNOUNCED: 0, ACTIVE: 1, DONE: 2 } as const;

/** One weighted entry of an event table (qty per roll). */
export interface EventLootEntry {
  def: string;
  weight: number;
  qty: number;
}

/**
 * Supply crate: what a fight is worth — ammo of every kind, meds, grenades and a little mid junk.
 * EV per roll ≈ 35 junk CR + 86 CR-eq consumables (× DROP.ROLLS = ≈ 140 + 345 per crate).
 */
export const SUPPLY_DROP_LOOT: readonly EventLootEntry[] = [
  { def: "ammo_light", weight: 30, qty: 30 },
  { def: "ammo_shell", weight: 20, qty: 10 },
  { def: "ammo_heavy", weight: 8, qty: 10 },
  { def: "ammo_bolt", weight: 6, qty: 6 },
  { def: "bandage", weight: 20, qty: 2 },
  { def: "medkit", weight: 10, qty: 1 },
  { def: "grenade", weight: 14, qty: 1 },
  { def: "junk_battery", weight: 10, qty: 1 },
  { def: "junk_circuit", weight: 8, qty: 1 },
  { def: "junk_hdd", weight: 4, qty: 1 },
];

/**
 * Hot-zone refill: cheap junk and a few consumables. EV per refilled container ≈ 22 junk CR +
 * 11 CR-eq (FILL_CHANCE included), so a full refill (MAX_REFILL) ≈ 270 junk CR.
 */
export const HOT_ZONE_LOOT: readonly EventLootEntry[] = [
  { def: "junk_apple", weight: 30, qty: 1 },
  { def: "junk_water", weight: 25, qty: 1 },
  { def: "junk_canned", weight: 20, qty: 1 },
  { def: "junk_bolts", weight: 20, qty: 1 },
  { def: "junk_wires", weight: 15, qty: 1 },
  { def: "junk_battery", weight: 6, qty: 1 },
  { def: "ammo_light", weight: 20, qty: 15 },
  { def: "ammo_shell", weight: 12, qty: 5 },
  { def: "bandage", weight: 12, qty: 1 },
  { def: "grenade", weight: 4, qty: 1 },
];

/**
 * Late refill (late joiners, GAME_DESIGN §7b): the map is stripped by minute ~15 and containers
 * never refill on their own, so a late entry found almost nothing. A seeded SHARE of the T0–MAX_TIER
 * containers outside every boss's guarded radius (POOL.GUARDED_RADIUS_PX) refills once per cycle,
 * COOLDOWN_MIN..MAX_MS (seeded per container) after it was emptied, once the cycle clock is past
 * START_MS and before the last STOP_BEFORE_END_MS, and only while no living human is within
 * HUMAN_MIN_PX (nobody watches a box fill itself). Checked every SWEEP_MS, at most PER_SWEEP
 * containers per sweep and MAX_PER_CYCLE per cycle.
 * Economy: its junk comes out of the SAME per-cycle event budget (EVENT_BUDGET.JUNK_CR) and at most
 * JUNK_CR_MAX of it, so the cycle's event junk cap does not move; past either cap it rolls
 * consumables only. EV ≈ 24 junk CR + ≈ 7 CR-eq consumables per roll (× ROLLS per container).
 */
export const LATE_REFILL = {
  START_MS: 15 * 60_000,
  STOP_BEFORE_END_MS: 5 * 60_000,
  COOLDOWN_MIN_MS: 10 * 60_000,
  COOLDOWN_MAX_MS: 12 * 60_000,
  /** Share of the eligible containers that ever refill (seeded per cycle and container). */
  SHARE: 0.5,
  /** Highest container tier that refills (T3/T4 pool tiers never do). */
  MAX_TIER: 2,
  /** No living human this close to the container. */
  HUMAN_MIN_PX: 1_500,
  SWEEP_MS: 5_000,
  PER_SWEEP: 4,
  MAX_PER_CYCLE: 80,
  /** Rolls of LATE_REFILL_LOOT per refilled container (no empty rolls). */
  ROLLS: 2,
  /** Most junk CR late refills may take out of EVENT_BUDGET.JUNK_CR in one cycle. */
  JUNK_CR_MAX: 400,
} as const;

/** Late refill: the cheapest junk (≤ 55 CR) and a few consumables, never mid junk. */
export const LATE_REFILL_LOOT: readonly EventLootEntry[] = [
  { def: "junk_apple", weight: 30, qty: 1 },
  { def: "junk_water", weight: 25, qty: 1 },
  { def: "junk_canned", weight: 20, qty: 1 },
  { def: "junk_bolts", weight: 20, qty: 1 },
  { def: "junk_wires", weight: 12, qty: 1 },
  { def: "ammo_light", weight: 25, qty: 15 },
  { def: "ammo_shell", weight: 12, qty: 5 },
  { def: "bandage", weight: 14, qty: 1 },
];

const LATE_PICK_SALT = 0x1a7e_5e1f;

/**
 * Late refill plan of container `idx` in the cycle of `lootSeed` (secret seed): whether it is in
 * the refilling SHARE and its cooldown after being emptied. Tier / guard checks are the caller's.
 */
export function lateRefillPlan(lootSeed: number, idx: number): { refills: boolean; cooldownMs: number } {
  const rng = mulberry32(eventSeed(lootSeed, LATE_PICK_SALT, idx));
  const refills = rng() < LATE_REFILL.SHARE;
  const cooldownMs = Math.round(LATE_REFILL.COOLDOWN_MIN_MS + rng() * (LATE_REFILL.COOLDOWN_MAX_MS - LATE_REFILL.COOLDOWN_MIN_MS));
  return { refills, cooldownMs };
}

/**
 * rollEventLoot charged against the shared `budget` but never past `cap.left` either (a sub-cap of
 * one event kind inside the shared budget). Both are reduced by the junk CR actually rolled.
 */
export function rollEventLootCapped(
  rng: Rng,
  table: readonly EventLootEntry[],
  rolls: number,
  budget: { left: number },
  cap: { left: number },
): Array<{ def: string; qty: number }> {
  const view = { left: Math.max(0, Math.min(budget.left, cap.left)) };
  const before = view.left;
  const out = rollEventLoot(rng, table, rolls, view);
  const spent = before - view.left;
  budget.left -= spent;
  cap.left -= spent;
  return out;
}

/** Junk CR of one entry (0 for consumables). */
export function eventJunkCr(def: string, qty: number): number {
  const d = itemDef(def);
  return d && d.cat === "junk" ? (d.value ?? 0) * qty : 0;
}

/**
 * Roll `rolls` entries of `table`; a junk entry that would take `budget.left` below 0 is re-drawn
 * from the table's consumables (the budget only ever caps junk CR). Same-def rolls merge.
 */
export function rollEventLoot(
  rng: Rng,
  table: readonly EventLootEntry[],
  rolls: number,
  budget: { left: number },
): Array<{ def: string; qty: number }> {
  const consumables = table.filter((e) => eventJunkCr(e.def, e.qty) === 0);
  const out: Array<{ def: string; qty: number }> = [];
  for (let i = 0; i < rolls; i++) {
    let e = pickWeighted(rng, table);
    const cr = eventJunkCr(e.def, e.qty);
    if (cr > 0) {
      if (cr > budget.left) {
        if (consumables.length === 0) continue;
        e = pickWeighted(rng, consumables);
      } else {
        budget.left -= cr;
      }
    }
    const d = itemDef(e.def);
    if (!d) continue;
    const prev = out.find((o) => o.def === e.def && o.qty + e.qty <= d.stack);
    if (prev) prev.qty += e.qty;
    else out.push({ def: e.def, qty: Math.min(e.qty, d.stack) });
  }
  return out;
}

// ---------------------------------------------------------------- schedules (secret seed)

const DROP_SALT = 0x5d0b_1e55;
const HOT_SALT = 0x4071_2a3e;

/** Seed of one event stream (drops / hot zones) of a shard. */
export function eventSeed(lootSeed: number, salt: number, n = 0): number {
  return (Math.imul((lootSeed ^ salt) >>> 0, 0x9e3779b1) ^ Math.imul(n + 1, 0x85ebca6b)) >>> 0;
}

export interface DropPlan {
  /** 1-based drop number (Corpse id "sd<n>"). */
  n: number;
  announceAt: number;
  landAt: number;
}

/**
 * Supply drops of a cycle from the secret loot seed: COUNT_MIN..COUNT_MAX landings spread over
 * [FIRST_ANNOUNCE_MS + WARN_MS, CYCLE_MS − NO_LAND_LAST_MS] in equal segments (each landing in the
 * middle 60 % of its segment, so two drops are ≥ 40 % of a segment apart).
 */
export function planSupplyDrops(lootSeed: number, cycleMs: number = WORLD.CYCLE_MS): DropPlan[] {
  const rng = mulberry32(eventSeed(lootSeed, DROP_SALT));
  const count = DROP.COUNT_MIN + Math.floor(rng() * (DROP.COUNT_MAX - DROP.COUNT_MIN + 1));
  const from = DROP.FIRST_ANNOUNCE_MS + DROP.WARN_MS;
  const to = cycleMs - DROP.NO_LAND_LAST_MS;
  const seg = (to - from) / count;
  const out: DropPlan[] = [];
  for (let i = 0; i < count; i++) {
    const landAt = Math.round(from + i * seg + seg * (0.2 + 0.6 * rng()));
    out.push({ n: i + 1, announceAt: landAt - DROP.WARN_MS, landAt });
  }
  return out;
}

export interface HotPlan {
  /** 1-based hot zone number. */
  n: number;
  announceAt: number;
  startAt: number;
  endAt: number;
}

/** Hot zones of a cycle from the secret loot seed: one per HOT.PERIOD_MS, each over before the wipe. */
export function planHotZones(lootSeed: number, cycleMs: number = WORLD.CYCLE_MS): HotPlan[] {
  const rng = mulberry32(eventSeed(lootSeed, HOT_SALT));
  const out: HotPlan[] = [];
  for (let k = 0; ; k++) {
    const startAt = Math.round(k * HOT.PERIOD_MS + HOT.FIRST_MS + rng() * HOT.JITTER_MS);
    const endAt = startAt + HOT.DURATION_MS;
    if (endAt > cycleMs) break;
    out.push({ n: k + 1, announceAt: startAt - HOT.WARN_MS, startAt, endAt });
  }
  return out;
}

/** Pull toward the map centre: 1 at the centre, 0.5 at `scale` px from it. */
export function centreWeight(x: number, y: number, w: number, h: number, scale: number): number {
  const d = Math.hypot(x - w / 2, y - h / 2) / scale;
  return 1 / (1 + d * d);
}

// ---------------------------------------------------------------- combat signals

/** Fight cell index of a world point (FIGHT.CELL grid over a map of width `mapW`). */
export function fightCellOf(x: number, y: number, mapW: number, cell: number = FIGHT.CELL): number {
  const cols = Math.ceil(mapW / cell);
  const c = Math.max(0, Math.min(cols - 1, Math.floor(x / cell)));
  const r = Math.max(0, Math.floor(y / cell));
  return r * cols + c;
}

/** Centre of fight cell `i`. */
export function fightCellCentre(i: number, mapW: number, cell: number = FIGHT.CELL): { x: number; y: number } {
  const cols = Math.ceil(mapW / cell);
  return { x: ((i % cols) + 0.5) * cell, y: (Math.floor(i / cols) + 0.5) * cell };
}

/**
 * "Fight nearby" for a listener at (lx, ly) and a fight cell centred on (cx, cy): [sector, band]
 * (SOUND.SECTORS sectors, bands by thirds of `radius`), or null when farther than `radius`.
 */
export function quantizeFight(lx: number, ly: number, cx: number, cy: number, radius: number = FIGHT.RADIUS): [number, Band] | null {
  const dx = cx - lx;
  const dy = cy - ly;
  const d = Math.hypot(dx, dy);
  if (d > radius) return null;
  const q = d / radius;
  const b: Band = q < 1 / 3 ? 0 : q < 2 / 3 ? 1 : 2;
  const step = (Math.PI * 2) / SOUND.SECTORS;
  const a = ((Math.round(Math.atan2(dy, dx) / step) % SOUND.SECTORS) + SOUND.SECTORS) % SOUND.SECTORS;
  return [a, b];
}

/** Heat level of `events` in the window (0 = not shown). */
export function heatLevel(events: number): number {
  const L = FIGHT.HEAT_LEVELS;
  return events >= L[2] ? 3 : events >= L[1] ? 2 : events >= L[0] ? 1 : 0;
}

/** BattleState.heat: "cell:level" pairs, comma separated, ascending cell ("" = no fights). */
export function encodeHeat(cells: ReadonlyMap<number, number>): string {
  return [...cells.entries()]
    .filter(([, l]) => l > 0)
    .sort((a, b) => a[0] - b[0])
    .map(([c, l]) => `${c}:${l}`)
    .join(",");
}

export function decodeHeat(s: string): Array<{ cell: number; level: number }> {
  if (!s) return [];
  const out: Array<{ cell: number; level: number }> = [];
  for (const part of s.split(",")) {
    const [c, l] = part.split(":");
    const cell = Number(c), level = Number(l);
    if (Number.isInteger(cell) && cell >= 0 && Number.isInteger(level) && level >= 1 && level <= 3) out.push({ cell, level });
  }
  return out;
}

/** EventsMsg.fight → [{sector, band}] (stride 2). */
export function decodeFight(f: readonly number[] | undefined): Array<{ a: number; b: Band }> {
  const out: Array<{ a: number; b: Band }> = [];
  if (!f) return out;
  for (let i = 0; i + 1 < f.length; i += 2) {
    const a = f[i]!, b = f[i + 1]!;
    if (Number.isInteger(a) && a >= 0 && a < SOUND.SECTORS && (b === 0 || b === 1 || b === 2)) out.push({ a, b: b as Band });
  }
  return out;
}

// ---------------------------------------------------------------- ids

/** Corpse id of supply crate n. */
export function supplyDropId(n: number): string {
  return `sd${n}`;
}

/** A Corpse id that is a supply crate ("sd<n>"). */
export function isSupplyDropId(id: string): boolean {
  return /^sd\d+$/.test(id);
}

/** A loot key ("k" + Corpse id) of a supply crate. */
export function isSupplyDropKey(key: string): boolean {
  return key.startsWith("k") && isSupplyDropId(key.slice(1));
}
