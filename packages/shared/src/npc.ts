/**
 * NPC MODEL v5 ("humans + NPCs, no player-bots"; scratchpad npc5 design). Decided by Vlad: no bot
 * may behave like a player. A map holds real humans (1..WORLD.CAPACITY) and NPCs only:
 * - boss + guards (loot economy v4, economy.ts BOSSES), and
 * - Marauders (NPC_ROLE.MARAUDER): squads of 1..3 holding a post (MapData.npcPosts) at a POI or a
 *   road camp in the wilds. They never loot, never extract, never roam the map, never respawn
 *   (waves are config-only, default OFF), never fight other NPCs; they drop a small CR-economy bag
 *   (rollNpcLoot) when killed. T3/T4 marauders may also carry ONE pool unique (NPC_CARRIER): a third
 *   destination of the same risk-tied release, never minted.
 *
 * Everything here is pure and deterministic: rollNpcSpawns / rollNpcLoot / rollMarauderKit give the
 * same answer for the same seed (match setup, sim harness, tests).
 * All NPC gear (weapon, armor, backpack, reserve ammo) is ITEM_FLAG.FREE = NPC_GEAR_FLAGS: never in
 * a corpse, never extracted, never valued, never ledger-tracked. No new flag is needed.
 */

import { BOSSES } from "./economy.js";
import { ITEM_FLAG } from "./inventory.js";
import { itemDef } from "./item-defs.js";
import type { Rarity, WeaponId } from "./items.js";
import type { BossKind, LootTier, MapData, NpcPost } from "./map/types.js";
import { mulberry32, pickWeighted, type Rng } from "./rng.js";

export const NPC = {
  /**
   * All NPCs of a raid, boss groups included. Over the cap, rollNpcSpawns drops whole squads.
   * POI garrison v1 (2026-10): 60 → 64. Garrison v2 (a group at every POI building + a POI minimum,
   * T4 ≥ 20): 64 → 200. E NPCs ≈ 175 on a world map (event boss), ≈ 178 legacy (all bosses at their
   * chance), max seen 201; the highest Steppe garrison (174) + all three boss groups (10) fits, so the
   * cap never cuts a garrison, only road camps / extra squads in the rare worst roll, and leaves room
   * for the Commander's call and respawns. Measured (perf.bench 24 humans, 3 min, docs/SCALING.md):
   * step avg 0.29 → 0.66 ms (scripted) and 0.64 → 1.40 ms (tour, every NPC awake), p99 ≤ 2.8 ms, max
   * 5.8 ms of the 50 ms tick.
   */
  MAX_PER_RAID: 200,
  /** Which marauder squads go first when over the cap: road camps, then POI posts by tier. */
  CAP_DROP_ORDER: ["road", 1, 2, 3, 4] as const,
  /** rollNpcSpawns: mulberry32(matchSeed ^ SALT), exactly 2 draws per post. */
  SALT: 0x6d4a_7a01,
  /** rollNpcLoot / rollMarauderKit streams (mixed with postId and member). */
  LOOT_SALT: 0x10_07_5a17,
  /** Placement clearances (generator; scaled with the block on the 853 px fallback map). */
  SPAWN_CLEAR_PX: 2500,
  EXTRACT_CLEAR_PX: 2000,
  BOSS_CLEAR_PX: 1500,
  POST_MIN_SEP_PX: 900,
  ROAD_CAMPS: 5,
  /** validateMap errors below this many road camps. */
  ROAD_CAMPS_MIN: 3,
  ROAD_CAMP_SEP_PX: 4000,
  /**
   * Road camps keep this far from every zone rect. The design said 1500, but on the Steppe that
   * leaves only 2 camps (the west highway runs 615 px from Kolkhoz and inside the west spawn
   * clearance); 1000 gives the 5 camps of the design (N–S road, ford trail, radar spur, rail line,
   * highway east of the checkpoint).
   */
  ROAD_CAMP_ZONE_CLEAR_PX: 1000,
  /**
   * Before this match time an NPC only returns fire (was bot.ts BOT_PEACE_MS) — except at a human who
   * walks into its post (within its leash of the anchor, or within PEACE_CLOSE_PX of the NPC): the
   * peace window protects spawns, it is not a free pass to loot next to a camp (v5 review fix).
   */
  PEACE_MS: 30_000,
  PEACE_CLOSE_PX: 600,
  /**
   * NPC sight cap while calm (was VISION.BOT_RANGE_CAP, 800): a careful human gets the first look.
   * Alpha softening (2026-10): 800 → 650. Fair perception (2026-10): the sight shape is now the
   * NPC_SIGHT_CALM / NPC_SIGHT_ALERT ellipse (≤ these radii); these two stay as the calm / alert
   * flag values of PlayerRuntime.viewCap.
   */
  VIEW_RANGE_CAP: 650,
  /**
   * NPC sight cap while its squad is alerted or it was hit recently: the full human VISION.RANGE, so
   * nobody can shoot an NPC from 800–1000 px without being seen back (v5 review fix: rifle kiting
   * at 870 px killed every marauder class and whole boss groups with 0 return fire). Alpha softening
   * (2026-10): 1000 → 850, so a careful human outranges an alerted NPC again (accepted for alpha).
   */
  VIEW_RANGE_ALERT: 850,
  /**
   * Hit by someone it cannot see or cannot reach with its weapon (a sniper beyond sight, a kiter
   * outside its chase radius): break line of sight to the threat within this radius of where it
   * stands (inside its chase radius), instead of standing at the chase edge as a target.
   */
  COVER_SEARCH_PX: 450,
  /** How long being hit keeps an NPC "under fire" (cover / alert sight / no boss heal). */
  UNDER_FIRE_MS: 4000,
  /**
   * FREE pistol sidearm (+ FREE light rounds) for every NPC whose primary is a shotgun: it switches
   * to the pistol for targets beyond shotgun range (v5 review fix: a pistol kiting at 470–560 px
   * killed shotgun marauders that saw it for seconds with 0 return fire).
   */
  SIDEARM_AMMO: 36,
  /** Dormant (no think / move / vision as viewer) with no living human within WAKE_PX and no squad alert. */
  WAKE_PX: 3600,
  /** Think every THINK_MS within LOD_PX of a human, else every LOD_THINK_MS. */
  LOD_PX: 2000,
  THINK_MS: 100,
  LOD_THINK_MS: 500,
  SUSPICIOUS_MS: 4000,
  SEARCH_MS: 12_000,
  SEARCH_SWEEP_DEG: 60,
  /** While it sees the target an NPC may chase up to leash + this. */
  CHASE_EXTRA_PX: 300,
  SQUAD_ALERT_MS: 15_000,
  SQUAD_ALERT_HEAR_PX: 900,
  IDLE_LOOK_MS: [3000, 8000] as const,
  BURST: { SHOTS: [3, 6] as const, PAUSE_MS: [250, 500] as const },
  /** NPC → NPC bullets do 0 damage (all roles are one "locals" faction). */
  FRIENDLY_FIRE: false,
  /** Every NPC role skips BREAK_CHANCE_ON_DEATH (replaces BOSS_AI.NO_BREAK, kept as an alias). */
  NO_BREAK: true,
  /**
   * WORLD v6 (D15, replaces the unused WAVES): a fully cleared marauder squad respawns at its post
   * at most MAX_PER_POST times per cycle, AFTER_MS after its last member died, only when no human is
   * within MIN_HUMAN_DIST_PX and at least MIN_CYCLE_LEFT_MS of the cycle remain. Fresh FREE kit, bag
   * at the full junk table, consumables × CONSUMABLE_MULT; SALT mixes the respawned bag's stream.
   * Bosses and guards never respawn.
   */
  RESPAWN: {
    ENABLED: true,
    AFTER_MS: 900_000,
    MAX_PER_POST: 1,
    MIN_HUMAN_DIST_PX: 3600,
    MIN_CYCLE_LEFT_MS: 600_000,
    CONSUMABLE_MULT: 0.5,
    SALT: 0x5e59a77,
  },
  /**
   * Radio chatter from awake idle squads (players hear a camp before walking into it). Needs a
   * SoundKind.voice entry, which is NOT in sound.ts yet (it lands together with the client / server
   * sound tables); until then the server must not emit it.
   */
  CHATTER: { ENABLED: true, EVERY_MS: [20_000, 40_000] as const, RADIUS_PX: 900 },
} as const;

/**
 * Fair NPC perception (2026-10, Vlad: "NPCs see you and shoot you while you cannot see them").
 * Every tunable of who an NPC may see / shoot lives here; all NPC roles (marauders, guards, bosses)
 * use the same rules.
 *
 * Sight shape: the camera keeps REF_VIEW_W × REF_VIEW_H of world area on every screen (renderer.ts
 * baseZoom), so the smallest view is the landscape phone (PHONE_W × PHONE_H CSS px): ≈ 1765 × 816
 * world px, half-extent ≈ 883 × 408. An NPC sees a human only inside an ellipse with those
 * half-axes × ALERT_FRAC (alerted / under fire / a muzzle flash) or × CALM_FRAC (calm), so the
 * human always has the NPC on screen first — on a phone too. Weather / night shrink it further
 * (VISION.RANGE × env), walls / fences block it (SIGHT rays, shared canSee).
 *
 * Firing: only at a target inside the current sight ellipse with a raw line of sight (SIGHT mask,
 * not the 300 ms published hysteresis) and a clear line of fire (SHOT mask) at this decision. A
 * first sighting waits the role's reactMs (never below REACT_MIN_MS); a re-sighting of the same
 * enemy within the NPC's enemy memory waits REACQUIRE_MS. Lost line of sight = search the
 * last-known position, never shooting through the wall. Being hit alerts (widened ellipse, cover,
 * squad search) but never lets it fire without a line of sight.
 */
export const NPC_PERCEPTION = {
  REF_VIEW_W: 1600,
  REF_VIEW_H: 900,
  PHONE_W: 844,
  PHONE_H: 390,
  /** Was a 850 px circle (alerted) and VISION.RANGE 1000 for a muzzle flash. */
  ALERT_FRAC: 0.9,
  /** Was a 650 px circle. */
  CALM_FRAC: 0.72,
  /** Floor of the first-sighting reaction delay (every role, boss phase 2 included). */
  REACT_MIN_MS: 400,
  /** Re-sighting the same enemy within ENEMY_MEMORY_MS (was 0: it fired at once after a peek). */
  REACQUIRE_MS: [250, 400] as readonly [number, number],
  ENEMY_MEMORY_MS: 3000,
  /** Aim error half-width (rad, × sloppiness): base + per 1000 px + a moving target at full speed… */
  AIM_ERR_BASE: 0.1,
  AIM_ERR_PER_1000PX: 0.12,
  AIM_ERR_MOVING: 0.1,
  /** …plus this per 1000 px beyond AIM_ERR_FAR_FROM_PX (long range a little less accurate; new). */
  AIM_ERR_FAR_FROM_PX: 400,
  AIM_ERR_FAR_PER_1000PX: 0.15,
} as const;

/** World half-extent of a landscape phone screen (the smallest in-match view). */
export function phoneViewHalf(): { hx: number; hy: number } {
  const P = NPC_PERCEPTION;
  const zoom = Math.sqrt((P.PHONE_W * P.PHONE_H) / (P.REF_VIEW_W * P.REF_VIEW_H));
  return { hx: P.PHONE_W / zoom / 2, hy: P.PHONE_H / zoom / 2 };
}

/** NPC sight ellipse (world-axis half-axes, px). */
export interface NpcSightEllipse {
  rx: number;
  ry: number;
}

const PHONE_HALF = phoneViewHalf();
/** Alerted / under fire / muzzle flash: ≈ 794 × 367 px. */
export const NPC_SIGHT_ALERT: NpcSightEllipse = {
  rx: Math.round(PHONE_HALF.hx * NPC_PERCEPTION.ALERT_FRAC),
  ry: Math.round(PHONE_HALF.hy * NPC_PERCEPTION.ALERT_FRAC),
};
/** Calm: ≈ 635 × 294 px. */
export const NPC_SIGHT_CALM: NpcSightEllipse = {
  rx: Math.round(PHONE_HALF.hx * NPC_PERCEPTION.CALM_FRAC),
  ry: Math.round(PHONE_HALF.hy * NPC_PERCEPTION.CALM_FRAC),
};

/** Offset (dx, dy) from the NPC to its target lies inside the ellipse. */
export function inSightEllipse(e: NpcSightEllipse, dx: number, dy: number): boolean {
  const u = dx / e.rx, v = dy / e.ry;
  return u * u + v * v <= 1;
}

/** Distance to the ellipse edge in the direction of (dx, dy) (its rx for a zero offset). */
export function sightReach(e: NpcSightEllipse, dx: number, dy: number): number {
  const d = Math.hypot(dx, dy);
  if (d < 1e-9) return e.rx;
  const c = dx / d, s = dy / d;
  return 1 / Math.sqrt((c * c) / (e.rx * e.rx) + (s * s) / (e.ry * e.ry));
}

/** Bit flags every NPC gear item carries (weapon, armor, backpack, reserve ammo): FREE. */
export const NPC_GEAR_FLAGS = ITEM_FLAG.FREE;

export type NpcClass = "low" | "mid" | "high" | "top";
/** T0 / T1 / road camps = low, T2 = mid, T3 = high, T4 = top. */
export const NPC_CLASS_BY_TIER: Readonly<Record<LootTier, NpcClass>> = { 0: "low", 1: "low", 2: "mid", 3: "high", 4: "top" };
export const NPC_CLASSES: readonly NpcClass[] = ["low", "mid", "high", "top"];

export function npcClassOfTier(tier: number): NpcClass {
  return NPC_CLASS_BY_TIER[Math.max(0, Math.min(4, Math.floor(tier))) as LootTier];
}

export interface MarauderWeapon {
  weapon: WeaponId;
  rarity: Rarity;
  w: number;
}

export interface MarauderDef {
  name: "Marauder";
  hp: number;
  /** Armor level worn when the armorChance draw hits (NPC-only FREE armor). */
  armor: 0 | 1 | 2;
  armorChance: number;
  weapons: readonly MarauderWeapon[];
  /** At most this many snipers per squad (top class); extra sniper draws become the first non-sniper entry. */
  sniperMaxPerSquad?: number;
  /** Weapons v2: at most this many light machine guns per squad (top class); extra draws become the first entry. */
  lmgMaxPerSquad?: number;
  /** Aim error multiplier (guards 0.85, boss 0.7). */
  sloppiness: number;
  reactMs: readonly [number, number];
  leashPx: number;
  /** FREE reserve rounds of its weapon's ammo (vanish on death). */
  freeAmmo: number;
}

/**
 * Marauder stats per class. Effective HP (effectiveHp): low 80, mid 100 / 125 armored, high 125, top 169.
 * v5 tuning: low pistol 60 / shotgun 40 → 85 / 15, mid shotgun 50 / rifle 50 → 15 / 85 (marauder
 * shotguns did 79 % of the damage before a T2 looter died; T2 looter survival 0.65 → ≈ 0.85).
 * v5 iteration 2: low sloppiness 1.25 → 1.6 (npc-threat bench, strafing human at 400 px: low hit
 * rate 27 % → 19 %, target 10–20 %). Top sloppiness stays 0.9: the top hit rate does not respond
 * to sloppiness (0.6–0.9 all measure 22–26 %; a running strafe caps rifle hits there).
 * Weapons v2 (docs/WEAPONS_V2.md §8): SMGs replace part of the mid / high rifles and shotguns
 * (mid rifle 85 → 70 + SMG 15; high rifle 70 → 55, shotgun 30 → 25 + rare SMG 20), the top class
 * trades rifle 80 → 65 for a rare LMG 15 (at most one per squad). Low stays pistol / shotgun. No NPC
 * carries a crossbow or grenades. Kits stay FREE (never dropped, never valued).
 * Alpha softening (2026-10, Vlad): sloppiness × 1.4 for every class (low 1.6 → 2.24, mid 1.1 → 1.54,
 * high 1.0 → 1.4, top 0.9 → 1.26), reaction +200 ms at both ends, and the top class drops its
 * sniper (its weight 20 goes to the rare rifle: 65 → 85). The hit-rate figures above are the
 * pre-alpha-softening measurement; the npc-threat bench has not been re-run since.
 */
export const MARAUDER: Readonly<Record<NpcClass, MarauderDef>> = {
  low: {
    name: "Marauder", hp: 80, armor: 0, armorChance: 0,
    weapons: [{ weapon: "pistol", rarity: 0, w: 85 }, { weapon: "shotgun", rarity: 0, w: 15 }],
    sloppiness: 2.24, reactMs: [850, 1200], leashPx: 500, freeAmmo: 60,
  },
  mid: {
    name: "Marauder", hp: 100, armor: 1, armorChance: 0.4,
    weapons: [{ weapon: "shotgun", rarity: 0, w: 15 }, { weapon: "rifle", rarity: 0, w: 70 }, { weapon: "smg", rarity: 0, w: 15 }],
    sloppiness: 1.54, reactMs: [750, 1050], leashPx: 700, freeAmmo: 90,
  },
  high: {
    name: "Marauder", hp: 100, armor: 1, armorChance: 1,
    weapons: [{ weapon: "rifle", rarity: 0, w: 55 }, { weapon: "shotgun", rarity: 1, w: 25 }, { weapon: "smg", rarity: 1, w: 20 }],
    sloppiness: 1.4, reactMs: [650, 950], leashPx: 800, freeAmmo: 120,
  },
  top: {
    name: "Marauder", hp: 110, armor: 2, armorChance: 1,
    weapons: [{ weapon: "rifle", rarity: 1, w: 85 }, { weapon: "lmg", rarity: 1, w: 15 }],
    sniperMaxPerSquad: 1, lmgMaxPerSquad: 1, sloppiness: 1.26, reactMs: [600, 850], leashPx: 900, freeAmmo: 150,
  },
};

/** Squads per zone id (+ "road" for the wild road camps). Size is uniform in [min, max]; one spawn draw per squad. */
export interface NpcCampDef {
  squads: number;
  size: readonly [number, number];
  chance: number;
}

/**
 * Squads of the ten places of the 24-block layout (+ "road"); map v2 places use steppe.ts ZONE_CAMPS.
 * Alpha softening (2026-10, Vlad): every spawn chance here, in ZONE_CAMPS and in CAMP_BY_TIER is the
 * old one × 0.75 (radar 1.0 → 0.75): on the Steppe E marauders 40.4 → ≈ 30, E NPCs ≈ 47 → ≈ 37.
 */
export const NPC_CAMPS: Readonly<Record<string, NpcCampDef>> = {
  dachas: { squads: 2, size: [1, 2], chance: 0.45 },
  fuel: { squads: 1, size: [1, 2], chance: 0.45 },
  zarya: { squads: 4, size: [1, 3], chance: 0.525 },
  kolkhoz: { squads: 1, size: [1, 3], chance: 0.525 },
  sawmill: { squads: 2, size: [1, 3], chance: 0.525 },
  depot: { squads: 2, size: [1, 3], chance: 0.525 },
  quarry: { squads: 2, size: [1, 3], chance: 0.525 },
  checkpoint: { squads: 1, size: [2, 3], chance: 0.6 },
  elevator: { squads: 2, size: [2, 3], chance: 0.675 },
  radar: { squads: 1, size: [2, 3], chance: 0.75 }, // v5 iteration 2 (C4): 2 → 1, Commander kill band
  road: { squads: 5, size: [1, 2], chance: 0.375 },
};

/**
 * POI garrison (2026-10, Vlad's playtest: a pistol-only run looted the T4 Radar to a full epic
 * backpack and extracted without meeting anyone). The per-post chance roll alone left a zone
 * unguarded in 5–56 % of maps (Radar T4 24 %, Relay T3 35 %, T1 places ≈ 55 %), and in world mode
 * the boss groups of the non-event bosses do not spawn at all.
 * Garrison v2 (owner, same day: "every building of the Radar must be held, ≥ 20 marauders there"):
 * - BUILDING_GROUP: every building of a POI has its own "bld" post (placeBuildingPosts: at an
 *   exterior door, or inside when no yard is free) holding a group of this size (uniform, one draw
 *   per post per match);
 * - POI_MIN: then each POI zone holds at least this many marauders (uniform, one draw per zone per
 *   match), counting the chance-rolled squads too; a short zone is topped up +1 round-robin over its
 *   building posts, then its other posts, up to SQUAD_MAX per post (a post that did not roll starts at 0).
 * The chance roll of the old posts still adds squads on top. The cap (NPC.MAX_PER_RAID) never cuts a
 * garrison on the Steppe (npc.test.ts). Individual NPC strength is unchanged: the class (MARAUDER
 * low/mid/high/top) already follows the tier.
 */
export const POI_GARRISON = {
  BUILDING_GROUP: { 0: [0, 1], 1: [1, 1], 2: [1, 1], 3: [1, 2], 4: [2, 3] } as Readonly<Record<LootTier, readonly [number, number]>>,
  POI_MIN: { 0: [0, 2], 1: [2, 4], 2: [5, 8], 3: [10, 14], 4: [20, 24] } as Readonly<Record<LootTier, readonly [number, number]>>,
  SQUAD_MAX: 4,
  /** Building posts keep this far from every other post (block 1024 scale). */
  POST_SEP_PX: 320,
  /** Building posts keep this far from player spawns (other posts: NPC.SPAWN_CLEAR_PX 2500), beyond the T4 chase radius 1200. */
  SPAWN_CLEAR_PX: 1500,
  /** Garrison stream: mulberry32(matchSeed ^ SALT): one draw per building post, then one per zone (independent of NPC.SALT). */
  SALT: 0x6a77_15e0,
} as const;

function clampTier(tier: number): LootTier {
  return Math.max(0, Math.min(4, Math.floor(tier))) as LootTier;
}

/** POI-level minimum range of a zone of `tier` (POI_GARRISON.POI_MIN). */
export function garrisonRange(tier: number): readonly [number, number] {
  return POI_GARRISON.POI_MIN[clampTier(tier)];
}

/** Group size range of one building post of `tier` (POI_GARRISON.BUILDING_GROUP). */
export function buildingGroupRange(tier: number): readonly [number, number] {
  return POI_GARRISON.BUILDING_GROUP[clampTier(tier)];
}

/** One weighted entry of an NPC loot table (qty per draw). */
export interface NpcLootEntry {
  def: string;
  qty: number;
  weight: number;
}

/** One draw: nothing with `none`, else a pickWeighted over `table`. */
export interface NpcLootDraw {
  none: number;
  table: readonly NpcLootEntry[];
}

const L = (def: string, qty: number, weight: number): NpcLootEntry => ({ def, qty, weight });

/**
 * NPC bag (non-FREE, lootable): one consumables draw + one junk draw per NPC. Scarce by
 * construction: the consumables EV is ≈ 33–40 % of what killing that NPC costs (low 11/32,
 * mid 18/54, high 30/80, top 51/126 CR-eq), so every NPC fight is net negative on consumables, and
 * the WHOLE bag (consumables + junk, CR at autosell × 1) stays at or below the kill cost too, so no
 * NPC class is a CR farm (v5 review: high / top junk "nothing" 0.65 / 0.6 → 0.85; the bag was
 * 144 / 208 CR against kill costs 80 / 126).
 * EV per NPC (cons CR-eq at CONSUMABLES_CR / junk CR): low 11.4 / 12.9, mid 17.7 / 30.8,
 * high 30.3 / 48.8, top 50.9 / 58.8.
 * Weapons v2: a hand grenade in the high / top pockets (weight 3 / 5, WEAPONS_V2 §7) replaces part of
 * the medkits and light ammo (high medkit 5 → 3, light 40 → 39; top medkit 10 → 7, light 35 → 33), so
 * the table weights stay 100 and the consumables EV moves only +1.4 % / +1.9 % (30.7 / 51.9).
 */
export const NPC_LOOT: Readonly<Record<NpcClass, { cons: NpcLootDraw; junk: NpcLootDraw }>> = {
  low: {
    cons: { none: 0.6, table: [L("ammo_light", 10, 50), L("ammo_shell", 4, 25), L("bandage", 1, 25)] },
    junk: { none: 0.6, table: [L("junk_apple", 1, 30), L("junk_water", 1, 25), L("junk_canned", 1, 20), L("junk_bolts", 1, 25)] },
  },
  mid: {
    cons: { none: 0.5, table: [L("ammo_light", 15, 45), L("ammo_shell", 5, 25), L("bandage", 1, 25), L("ammo_heavy", 5, 5)] },
    junk: {
      none: 0.65,
      table: [L("junk_bolts", 1, 25), L("junk_wires", 1, 30), L("junk_battery", 1, 15), L("junk_pills", 1, 15), L("junk_fuel", 1, 10), L("junk_circuit", 1, 5)],
    },
  },
  high: {
    cons: {
      none: 0.4,
      table: [L("ammo_light", 20, 39), L("ammo_shell", 6, 20), L("ammo_heavy", 5, 15), L("bandage", 1, 20), L("medkit", 1, 3), L("grenade", 1, 3)],
    },
    junk: {
      none: 0.85,
      table: [L("junk_battery", 1, 20), L("junk_fuel", 1, 20), L("junk_circuit", 1, 22), L("junk_hdd", 1, 20), L("junk_keycard", 1, 12), L("junk_goldchain", 1, 6)],
    },
  },
  top: {
    cons: {
      none: 0.35,
      table: [L("ammo_light", 30, 33), L("ammo_heavy", 10, 20), L("ammo_shell", 6, 10), L("bandage", 1, 25), L("medkit", 1, 7), L("grenade", 1, 5)],
    },
    junk: {
      none: 0.85,
      table: [
        L("junk_battery", 1, 20), L("junk_fuel", 1, 16), L("junk_circuit", 1, 20), L("junk_hdd", 1, 20),
        L("junk_keycard", 1, 12), L("junk_goldchain", 1, 8), L("junk_gpu", 1, 4),
      ],
    },
  },
};

/**
 * Pool uniques on T3/T4 marauders (allocation carriers): weight WEIGHT_MULT × (tier+1)² → T3 10, T4 15.6 (were 80 / 125 at WEIGHT_MULT 5).
 * v5 tuning: 2 → 3; v5 review: 3 → 5 after the radar squads went 2 → 1 (≈ 2.5 fewer T4 carriers per
 * raid): measured at R 24 over 200 Steppe seeds, carriers 0.38 → 0.61 items per raid (target 0.6–0.7),
 * containers 3.19 → 2.96.
 */
export const NPC_CARRIER = {
  MIN_TIER: 3,
  // POI garrison v2 (2026-10): ≈ 8.2× the carrier weight Σ(tier+1)² per raid (126 → 1034, all the new
  // T3/T4 building guards), so 5 → 0.625 (= 5 × 126 / 1034) keeps the carriers' weight share of the
  // non-boss release at ≈ 15 % (was 14.7 %; the loot-yield harness measured that as ≈ 17 % live).
  WEIGHT_MULT: 0.625,
  MAX_PER_NPC: 1,
} as const;

/** Optional per-kill "NPC tag" junk (a farmable faucet independent of the bag): default OFF. */
export const NPC_KILL = { TAG: false, TAG_CR: 15 } as const;

/** Client name tags (role 3). Guards keep BOSSES[kind].guardName, bosses their UPPERCASE name. */
export const NPC_TAG = { marauder: "Marauder", ru: "Мародёр" } as const;

// ---------------------------------------------------------------- posts

/** MapData.npcPosts, or [] for hand-built test maps. */
export function npcPostsOf(map: Pick<MapData, "npcPosts">): readonly NpcPost[] {
  return map.npcPosts ?? [];
}

/** Marauder class of a post: road camps are always "low", POI posts by zone tier. */
export function npcClassOfPost(post: Pick<NpcPost, "kind" | "tier">): NpcClass {
  return post.kind === "road" ? "low" : npcClassOfTier(post.tier);
}

/** Leash radius around the post anchor (MARAUDER[class].leashPx). Chase = leash + NPC.CHASE_EXTRA_PX. */
export function npcLeashPx(post: Pick<NpcPost, "kind" | "tier">): number {
  return MARAUDER[npcClassOfPost(post)].leashPx;
}

/** Expected marauders per raid on these posts (Σ chance × mean size), before the cap. */
export function expectedMarauders(posts: readonly NpcPost[]): number {
  return posts.reduce((s, p) => s + p.chance * ((p.size[0] + p.size[1]) / 2), 0);
}

// ---------------------------------------------------------------- spawn roll

/** NPC runtimes a spawned boss group adds: the boss + min(spot guard posts, BOSSES[kind].guards). */
export function bossGroupNpcCount(spawned: ReadonlyArray<{ kind: BossKind; guards: readonly unknown[] }>): number {
  return spawned.reduce((n, s) => n + 1 + Math.min(s.guards.length, BOSSES[s.kind].guards.length), 0);
}

export interface NpcSquadSpawn {
  postId: number;
  members: number;
}

/** Cap group of a post (index into NPC.CAP_DROP_ORDER): road camps first, then POI posts by tier. */
function capGroup(p: NpcPost): number {
  if (p.kind === "road") return 0;
  const i = NPC.CAP_DROP_ORDER.indexOf(p.tier as 1 | 2 | 3 | 4);
  return i < 0 ? 0 : i;
}

/**
 * The chance roll alone (no garrison, no cap): mulberry32((matchSeed ^ NPC.SALT) >>> 0), exactly
 * two draws per post in array order (spawn, size), also for posts that do not spawn, so one post's
 * chance never shifts another. Squads in post order.
 */
export function rollPostChances(matchSeed: number, posts: readonly NpcPost[]): NpcSquadSpawn[] {
  const rng = mulberry32((matchSeed ^ NPC.SALT) >>> 0);
  const out: NpcSquadSpawn[] = [];
  for (const p of posts) {
    const rSpawn = rng();
    const rSize = rng();
    if (!(rSpawn < p.chance)) continue;
    const lo = Math.max(1, Math.floor(p.size[0]));
    const hi = Math.max(lo, Math.floor(p.size[1]));
    const members = Math.min(hi, lo + Math.floor(rSize * (hi - lo + 1)));
    out.push({ postId: p.id, members });
  }
  return out;
}

/** This match's garrison: group size per building post, POI minimum per zone (POI_GARRISON). */
export interface GarrisonRoll {
  /** Building post id → its group size (0 possible at T0). */
  buildings: Map<number, number>;
  /** Zone id → POI minimum of marauders. */
  zones: Map<string, number>;
}

/**
 * Garrison draws, mulberry32(matchSeed ^ POI_GARRISON.SALT): one per building post in post order
 * (BUILDING_GROUP of its tier), then one per POI zone in order of its first post (POI_MIN of the
 * highest tier among its posts).
 */
export function rollGarrisons(matchSeed: number, posts: readonly NpcPost[]): GarrisonRoll {
  const rng = mulberry32((matchSeed ^ POI_GARRISON.SALT) >>> 0);
  const uniform = ([lo, hi]: readonly [number, number]) => Math.min(hi, lo + Math.floor(rng() * (hi - lo + 1)));
  const buildings = new Map<number, number>();
  for (const p of posts) if (p.kind === "bld") buildings.set(p.id, uniform(buildingGroupRange(p.tier)));
  const tierOf = new Map<string, number>();
  for (const p of posts) if (p.kind !== "road" && p.zone !== null) tierOf.set(p.zone, Math.max(tierOf.get(p.zone) ?? 0, p.tier));
  const zones = new Map<string, number>();
  for (const [zone, tier] of tierOf) zones.set(zone, uniform(garrisonRange(tier)));
  return { buildings, zones };
}

/**
 * Which marauder squads spawn this match:
 * 1. the chance roll of the old posts (rollPostChances; building posts have chance 0);
 * 2. the building groups (rollGarrisons().buildings);
 * 3. the POI minimum: a zone with fewer marauders than rollGarrisons().zones gets +1 member
 *    round-robin over its building posts, then over its other posts, up to POI_GARRISON.SQUAD_MAX;
 * 4. NPC.MAX_PER_RAID together with `bossNpcs` (bossGroupNpcCount(rollBossSpawns(...))): whole
 *    squads are dropped in NPC.CAP_DROP_ORDER (road camps, then T1, T2, …), the last post of a group
 *    first, never a building squad and never one that takes its zone below its minimum; only if that
 *    is not enough (never on the Steppe, see npc.test.ts) the old order drops garrison squads too.
 * Squads in post order. Deterministic in (matchSeed, posts, bossNpcs).
 */
export function rollNpcSpawns(matchSeed: number, posts: readonly NpcPost[], bossNpcs = 0): NpcSquadSpawn[] {
  const byId = new Map(posts.map((p) => [p.id, p]));
  const spawned = new Map<number, number>();
  for (const s of rollPostChances(matchSeed, posts)) spawned.set(s.postId, s.members);
  const g0 = rollGarrisons(matchSeed, posts);
  for (const [id, n] of g0.buildings) if (n > 0) spawned.set(id, n);
  const garrison = g0.zones;
  const zoneTotal = new Map<string, number>();
  const addZone = (p: NpcPost, n: number) => { if (p.zone !== null && p.kind !== "road") zoneTotal.set(p.zone, (zoneTotal.get(p.zone) ?? 0) + n); };
  for (const [id, n] of spawned) addZone(byId.get(id)!, n);
  for (const [zone, want] of garrison) {
    let need = want - (zoneTotal.get(zone) ?? 0);
    if (need <= 0) continue;
    const zp = posts.filter((p) => p.zone === zone && p.kind !== "road");
    const order = [...zp.filter((p) => p.kind === "bld"), ...zp.filter((p) => p.kind !== "bld")];
    for (let grew = true; need > 0 && grew; ) {
      grew = false;
      for (const p of order) {
        if (need <= 0) break;
        const n = spawned.get(p.id) ?? 0;
        if (n >= POI_GARRISON.SQUAD_MAX) continue;
        spawned.set(p.id, n + 1);
        need--;
        grew = true;
      }
    }
    zoneTotal.set(zone, want - need);
  }
  const out: Array<NpcSquadSpawn & { group: number }> = posts
    .filter((p) => spawned.has(p.id))
    .map((p) => ({ postId: p.id, members: spawned.get(p.id)!, group: capGroup(p) }));
  let total = Math.max(0, Math.floor(bossNpcs)) + out.reduce((n, s) => n + s.members, 0);
  for (const keepGarrison of [true, false]) {
    for (let g = 0; g < NPC.CAP_DROP_ORDER.length && total > NPC.MAX_PER_RAID; g++) {
      for (let i = out.length - 1; i >= 0 && total > NPC.MAX_PER_RAID; i--) {
        const s = out[i]!;
        if (s.group !== g) continue;
        const p = byId.get(s.postId)!;
        const zone = p.kind !== "road" ? p.zone : null;
        if (keepGarrison && p.kind === "bld") continue;
        if (keepGarrison && zone !== null && (zoneTotal.get(zone) ?? 0) - s.members < (garrison.get(zone) ?? 0)) continue;
        if (zone !== null) zoneTotal.set(zone, (zoneTotal.get(zone) ?? 0) - s.members);
        total -= s.members;
        out.splice(i, 1);
      }
    }
  }
  return out.map(({ postId, members }) => ({ postId, members }));
}

// ---------------------------------------------------------------- per-NPC streams

/** Independent stream per (matchSeed, postId, member, stream): 0 = loot bag, 1 = kit. */
function npcRng(matchSeed: number, postId: number, member: number, stream: number): Rng {
  const base = Math.imul((matchSeed ^ NPC.LOOT_SALT) >>> 0, 0x01000193);
  const k = Math.imul(postId + 1, 0x85ebca6b) ^ Math.imul(member * 7 + stream + 1, 0xc2b2ae35);
  return mulberry32((base ^ k) >>> 0);
}

/** A fungible in an NPC bag (uid "" — never a DB item). Same shape as economy RolledFungible. */
export interface NpcLootItem {
  def: string;
  qty: number;
  rarity: Rarity;
}

/**
 * The non-FREE bag of marauder `member` of post `postId` (goes to its corpse, lootable). Fixed
 * draw order, always four draws: cons none, cons pick, junk none, junk pick — so the junk result
 * never depends on the consumables result. Deterministic in (matchSeed, postId, member, cls).
 */
export function rollNpcLoot(matchSeed: number, postId: number, member: number, cls: NpcClass): NpcLootItem[] {
  const rng = npcRng(matchSeed, postId, member, 0);
  const t = NPC_LOOT[cls];
  const out: NpcLootItem[] = [];
  for (const draw of [t.cons, t.junk]) {
    const none = rng() < draw.none;
    const e = pickWeighted(rng, draw.table);
    if (none) continue;
    const d = itemDef(e.def);
    if (!d) continue;
    out.push({ def: e.def, qty: Math.min(e.qty, d.stack), rarity: d.rarity });
  }
  return out;
}

export interface MarauderKit {
  weapon: WeaponId;
  rarity: Rarity;
  /** FREE armor level 0..2 (0 = none). */
  armor: 0 | 1 | 2;
}

/**
 * FREE kit of every member of a squad of `members` at post `postId`: per member one weapon draw
 * (pickWeighted over MARAUDER[cls].weapons) and one armor draw (< armorChance → armor). Over
 * sniperMaxPerSquad / lmgMaxPerSquad, a sniper / LMG becomes the first entry that is neither. The
 * server posts the sniper on the farthest post point. Deterministic in (matchSeed, postId, members, cls).
 */
export function rollMarauderKit(matchSeed: number, postId: number, members: number, cls: NpcClass): MarauderKit[] {
  const def = MARAUDER[cls];
  const fallback = def.weapons.find((w) => w.weapon !== "sniper" && w.weapon !== "lmg") ?? def.weapons[0]!;
  const out: MarauderKit[] = [];
  let snipers = 0;
  let lmgs = 0;
  for (let m = 0; m < members; m++) {
    const rng = npcRng(matchSeed, postId, m, 1);
    let w = pickWeighted(rng, def.weapons.map((x) => ({ ...x, weight: x.w })));
    const armorHit = rng() < def.armorChance;
    if (w.weapon === "sniper") {
      if (snipers >= (def.sniperMaxPerSquad ?? Infinity)) w = { ...fallback, weight: fallback.w };
      else snipers++;
    } else if (w.weapon === "lmg") {
      if (lmgs >= (def.lmgMaxPerSquad ?? Infinity)) w = { ...fallback, weight: fallback.w };
      else lmgs++;
    }
    out.push({ weapon: w.weapon, rarity: w.rarity, armor: armorHit ? def.armor : 0 });
  }
  return out;
}

// ---------------------------------------------------------------- pool carriers (§3.3)

/** containerLoot key of a carrier marauder (legacy allocation, sim harness): "npc:<postId>.<member>". */
export type NpcCarrierKey = `npc:${number}.${number}`;

export function npcCarrierKey(postId: number, member: number): NpcCarrierKey {
  return `npc:${postId}.${member}`;
}

/** { postId, member } of a carrier key, or null for container / boss keys and malformed input. */
export function parseNpcCarrierKey(key: string): { postId: number; member: number } | null {
  const m = /^npc:(\d{1,5})\.(\d{1,2})$/.exec(key);
  if (!m) return null;
  return { postId: Number(m[1]), member: Number(m[2]) };
}

/** May a marauder of this post tier carry a pool unique (tier >= NPC_CARRIER.MIN_TIER)? */
export function npcCarrierEligible(tier: number): boolean {
  return tier >= NPC_CARRIER.MIN_TIER;
}

/** planAllocation weight of one carrier: WEIGHT_MULT × (tier+1)² (T3 10, T4 15.6; containers T3 16/64, T4 25/100). */
export function npcCarrierWeight(tier: number): number {
  return NPC_CARRIER.WEIGHT_MULT * (tier + 1) * (tier + 1);
}

/** One carrier of the legacy allocation (planAllocation, sim harness). */
export interface RaidNpcCarrier {
  key: NpcCarrierKey;
  tier: 3 | 4;
}

/**
 * Legacy allocation carriers: every member of every spawned squad whose post is a POI post of tier
 * >= NPC_CARRIER.MIN_TIER (road camps never carry). Keyed npcCarrierKey(postId, member), in spawn order.
 */
export function raidNpcCarriers(spawns: readonly NpcSquadSpawn[], posts: readonly NpcPost[]): RaidNpcCarrier[] {
  const byId = new Map(posts.map((p) => [p.id, p]));
  const out: RaidNpcCarrier[] = [];
  for (const s of spawns) {
    const p = byId.get(s.postId);
    if (!p || p.kind === "road" || !npcCarrierEligible(p.tier)) continue;
    for (let m = 0; m < s.members; m++) out.push({ key: npcCarrierKey(p.id, m), tier: (p.tier >= 4 ? 4 : 3) as 3 | 4 });
  }
  return out;
}
