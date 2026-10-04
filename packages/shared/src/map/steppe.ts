/**
 * "The Outskirts" template, MAP_GEN_VERSION 4 (map v2), written in BLOCK units on a 28-block map so
 * WORLD.BLOCK = 853 still gives a smaller fallback without touching the layout. Coordinates are
 * fractions of a block; the generator multiplies by WORLD.BLOCK and rounds to integers.
 *
 * Geography: a N–S river at x ≈ 19–20 splits the map; the east bank (Radar Base, Relay Hill,
 * Quarry, Truck Stop) is the high-risk side. Exactly three crossings: the ford (north, SHALLOW
 * 0.6× speed), the highway bridge (centre, watched by the Checkpoint) and the rail bridge (south).
 * The ten places of the 24-block layout keep their ids and names; map v2 adds Millbrook (a small
 * town on the crossroads), the Pump Station, the Ranger Station, Relay Hill and the Truck Stop.
 */

import type { BossKind, LootTier, MapSide, Road, ZoneKind } from "./types.js";

export interface ZoneTemplate {
  id: string;
  name: string;
  kind: ZoneKind;
  tier: LootTier;
  /** [x, y, w, h] in blocks. */
  rect: readonly [number, number, number, number];
  boss?: BossKind;
}

export const STEPPE_ZONES: readonly ZoneTemplate[] = [
  { id: "zarya", name: "Dawnfield", kind: "village", tier: 2, rect: [2.5, 2.6, 7, 5.9] },
  { id: "kolkhoz", name: "Red Barn Farm", kind: "farm", tier: 2, rect: [1.2, 8.9, 3.8, 3.0] },
  { id: "dachas", name: "Summer Cabins", kind: "village", tier: 1, rect: [1.5, 17.4, 5, 5] },
  { id: "fuel", name: "Fuel Stop", kind: "gas", tier: 1, rect: [10.9, 14.7, 2.4, 2.2] },
  { id: "sawmill", name: "Sawmill", kind: "lumber", tier: 2, rect: [11.4, 1.4, 4.4, 3.4] },
  { id: "elevator", name: "Grain Elevator", kind: "industrial", tier: 3, rect: [11.0, 7.8, 6, 5.6], boss: "foreman" },
  { id: "depot", name: "Rail Depot", kind: "rail", tier: 2, rect: [7.0, 21.0, 8.5, 4.3], boss: "warden" },
  { id: "checkpoint", name: "Bridge Checkpoint", kind: "checkpoint", tier: 2, rect: [20.6, 13.0, 2.4, 2.4] },
  { id: "radar", name: "Radar Base", kind: "military", tier: 4, rect: [21.6, 1.8, 5.6, 5.6], boss: "commander" },
  { id: "quarry", name: "Quarry", kind: "quarry", tier: 2, rect: [22.0, 17.2, 4.4, 4.4] },
  // Map v2 places.
  { id: "millbrook", name: "Millbrook", kind: "village", tier: 2, rect: [5.0, 12.4, 5.4, 4.2] },
  { id: "pumpworks", name: "Pump Station", kind: "industrial", tier: 2, rect: [14.6, 16.6, 3.4, 3.0] },
  { id: "ranger", name: "Ranger Station", kind: "lumber", tier: 1, rect: [11.6, 18.2, 2.4, 2.2] },
  { id: "relay", name: "Relay Hill", kind: "military", tier: 3, rect: [23.0, 9.2, 3.2, 3.0] },
  { id: "truckstop", name: "Truck Stop", kind: "gas", tier: 1, rect: [23.6, 13.0, 2.6, 2.4] },
];

export interface RoadTemplate {
  id: string;
  kind: Road["kind"];
  /** Band width in px (not scaled with BLOCK: a road is as wide as a car, not as a block). */
  width: number;
  /** [x, y] pairs in blocks. */
  pts: ReadonlyArray<readonly [number, number]>;
}

export const STEPPE_ROADS: readonly RoadTemplate[] = [
  // Highway: W edge → Millbrook main street → Fuel Stop → under the Elevator → bridge → Checkpoint →
  // Truck Stop → E edge. Straight over the river so the bridge band (STEPPE_CROSSINGS[1]) holds it.
  { id: "highway", kind: "asphalt", width: 256, pts: [[0, 14.8], [4.6, 14.5], [11.0, 14.5], [14.2, 15.2], [17.6, 14.2], [21.8, 14.2], [28, 14.6]] },
  // N–S road: N edge → Dawnfield → Millbrook crossroads → Rail Depot → S edge.
  { id: "ns", kind: "dirt", width: 160, pts: [[6.2, 0], [6.1, 4], [6.0, 8.5], [7.4, 12.2], [7.6, 14.5], [7.8, 16.8], [10.0, 21.2], [10.4, 28]] },
  // Sawmill spur, continuing to the N2 extract.
  { id: "sawmill", kind: "dirt", width: 160, pts: [[6.05, 5.4], [11.2, 4.9], [13.2, 3.2], [13.6, 0]] },
  // Ford trail: Dawnfield → ford → Radar Base west gate.
  { id: "ford", kind: "dirt", width: 128, pts: [[9.4, 5.6], [12.2, 6.6], [17.0, 6.6], [21.2, 6.6], [22.0, 5.4]] },
  // Radar spur: Checkpoint → past Relay Hill → Radar Base south gate.
  { id: "radar", kind: "dirt", width: 160, pts: [[21.6, 14.2], [21.4, 10.6], [22.4, 8.6], [23.4, 7.0]] },
  // Relay Hill gate road.
  { id: "relay", kind: "dirt", width: 128, pts: [[21.45, 10.8], [24.4, 10.8]] },
  // Quarry spur.
  { id: "quarry", kind: "dirt", width: 160, pts: [[21.9, 14.3], [23.6, 17.0], [24.2, 19.4]] },
  // Dacha spur.
  { id: "dacha", kind: "dirt", width: 160, pts: [[7.8, 16.8], [4.4, 18.6], [4.1, 22.6]] },
  // Pump Station service road.
  { id: "pump", kind: "dirt", width: 160, pts: [[14.2, 15.2], [15.6, 16.6], [16.2, 18.2]] },
  // Ranger Station trail.
  { id: "ranger", kind: "dirt", width: 128, pts: [[9.05, 19.3], [12.8, 19.3]] },
  // Rail main line W–E (rail bridge at x ≈ 19.5).
  { id: "rail", kind: "rail", width: 128, pts: [[0, 23.2], [28, 23.2]] },
  // Depot side tracks (wagon rows).
  { id: "track-n", kind: "rail", width: 128, pts: [[7.3, 22.45], [15.2, 22.45]] },
  { id: "track-s", kind: "rail", width: 128, pts: [[7.3, 23.95], [15.2, 23.95]] },
];

/** River centre line in blocks; ~420 px wide deep water (MOVE-only: you can shoot and see across). */
export const STEPPE_RIVER: ReadonlyArray<readonly [number, number]> = [
  [19.3, 0], [18.9, 6.6], [19.9, 13.8], [19.2, 20], [20.0, 28],
];
export const RIVER_HALF_WIDTH = 210;
/** Muddy bank painted as DIRT around the water. */
export const RIVER_BANK = 96;

export interface CrossingTemplate {
  name: string;
  /** Centre y of the horizontal band, in blocks. */
  y: number;
  /** Band height in px; every WATER cell inside becomes BRIDGE / SHALLOW. */
  height: number;
  kind: "bridge" | "ford";
}

export const STEPPE_CROSSINGS: readonly CrossingTemplate[] = [
  { name: "Ford", y: 6.6, height: 384, kind: "ford" },
  { name: "Highway Bridge", y: 14.2, height: 256, kind: "bridge" },
  { name: "Rail Bridge", y: 23.2, height: 256, kind: "bridge" },
];

export interface ExtractTemplate {
  id: string;
  name: string;
  side: MapSide;
  /** [x, y] in blocks. */
  at: readonly [number, number];
  closesAtMs?: number;
}

/**
 * 8 always-open extracts, 2 per side (critique: paid/switch/timed are cut). Order is the bit order
 * of extractMask. N2 and S2 close early (memo §6); every side keeps an always-open option among
 * its allowed extracts.
 */
export const STEPPE_EXTRACTS: readonly ExtractTemplate[] = [
  { id: "N1", name: "Pine Trail", side: 0, at: [6.2, 0.42] },
  { id: "N2", name: "Sawmill Road", side: 0, at: [13.6, 0.42], closesAtMs: 25 * 60_000 },
  { id: "E1", name: "Radar Gate", side: 1, at: [27.58, 8.2] },
  { id: "E2", name: "Quarry Truck", side: 1, at: [27.58, 19.6] },
  { id: "S1", name: "Rail Tunnel", side: 2, at: [10.4, 27.58] },
  { id: "S2", name: "Southern Ford", side: 2, at: [24.0, 27.58], closesAtMs: 25 * 60_000 },
  { id: "W1", name: "Highway West", side: 3, at: [0.42, 14.8] },
  { id: "W2", name: "Cabin Fence", side: 3, at: [0.42, 20.0] },
];

export const EXTRACT_RADIUS = 150;

/**
 * Boss spawn chance per match (loot economy v4; BossSpot.chance, BOSSES[kind].spawnChance). Bosses
 * are not part of mapHash, so these never change the layout.
 */
export const BOSS_CHANCE: Readonly<Record<BossKind, number>> = { foreman: 0.8, commander: 0.7, warden: 0.6 };

/** Guard posts per boss (= BOSSES[kind].guards.length; the Commander's third post is the watch post). */
export const BOSS_GUARD_COUNT: Readonly<Record<BossKind, number>> = { foreman: 2, commander: 3, warden: 2 };

/** Building archetypes a boss prefers for its room, in order (placeBosses). */
export const BOSS_BUILDING_PREFS: Readonly<Record<BossKind, readonly ("office" | "warehouse" | "bunker" | "barracks")[]>> = {
  foreman: ["office", "warehouse"],
  commander: ["office", "bunker", "barracks"],
  warden: ["warehouse"],
};

/**
 * Marauder squads of the map v2 places (NPC MODEL v5 posts). NPC_CAMPS (npc.ts) keys squads by
 * zone id and only knows the ten places of the 24-block layout; a zone it does not list takes its
 * row here, else CAMP_BY_TIER. Sized by POI tier like the existing camps: T1 one small squad, T2
 * two, T3 one big one.
 */
export const ZONE_CAMPS: Readonly<Record<string, { squads: number; size: readonly [number, number]; chance: number }>> = {
  millbrook: { squads: 2, size: [1, 3], chance: 0.7 },
  pumpworks: { squads: 2, size: [1, 3], chance: 0.7 },
  ranger: { squads: 1, size: [1, 2], chance: 0.6 },
  // One squad: T3 marauders also carry pool uniques (NPC_CARRIER), and a second squad would grow
  // the carriers' share of the pool release past the containers' (+30 % carriers vs +36 % T3/T4 boxes).
  relay: { squads: 1, size: [2, 3], chance: 0.85 },
  truckstop: { squads: 1, size: [1, 2], chance: 0.6 },
};

/** Default squads by tier for a zone in neither NPC_CAMPS nor ZONE_CAMPS. */
export const CAMP_BY_TIER: Readonly<Record<LootTier, { squads: number; size: readonly [number, number]; chance: number }>> = {
  0: { squads: 0, size: [1, 2], chance: 0.5 },
  1: { squads: 1, size: [1, 2], chance: 0.6 },
  2: { squads: 2, size: [1, 3], chance: 0.7 },
  3: { squads: 2, size: [2, 3], chance: 0.85 },
  4: { squads: 1, size: [2, 3], chance: 1.0 },
};
