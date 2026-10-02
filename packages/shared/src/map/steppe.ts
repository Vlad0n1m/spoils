/**
 * "Steppe Outskirts" template (map memo §3), written in BLOCK units so WORLD.BLOCK = 853 gives the
 * 20,480 px fallback (critique cut 8) without touching the layout. Coordinates are fractions of a
 * block; the generator multiplies by WORLD.BLOCK and rounds to integers.
 *
 * Geography: a N–S river at x ≈ 16–17 splits the map; the east bank (Radar Base, Quarry) is the
 * high-risk side. Exactly three crossings: the ford (north, SHALLOW 0.6× speed), the highway bridge
 * (centre, watched by the Checkpoint) and the rail bridge (south).
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
  { id: "zarya", name: "Zarya Village", kind: "village", tier: 2, rect: [2.5, 2.6, 7, 5.9] },
  { id: "kolkhoz", name: "Kolkhoz Farm", kind: "farm", tier: 2, rect: [1.2, 8.8, 4.3, 3.0] },
  { id: "dachas", name: "Dachas", kind: "village", tier: 1, rect: [1.5, 14.2, 5, 5] },
  { id: "fuel", name: "Fuel Stop", kind: "gas", tier: 1, rect: [6.5, 10.4, 2.4, 2.2] },
  { id: "sawmill", name: "Sawmill", kind: "lumber", tier: 2, rect: [10.6, 1.4, 4.4, 3.4] },
  { id: "elevator", name: "Grain Elevator", kind: "industrial", tier: 3, rect: [9.5, 7.6, 6, 5.6], boss: "foreman" },
  { id: "depot", name: "Rail Depot", kind: "rail", tier: 2, rect: [6.5, 17.3, 8.5, 4.3] },
  { id: "checkpoint", name: "Bridge Checkpoint", kind: "checkpoint", tier: 2, rect: [17.4, 11.0, 2.4, 2.4] },
  { id: "radar", name: "Radar Base", kind: "military", tier: 4, rect: [18.2, 2.0, 5, 5], boss: "commander" },
  { id: "quarry", name: "Quarry", kind: "quarry", tier: 2, rect: [18.6, 14.4, 4.4, 4.4] },
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
  // Highway: W edge → Fuel Stop → Elevator → bridge → Checkpoint → E edge. Straight over the river
  // so the bridge band (STEPPE_CROSSINGS[1]) contains it exactly.
  { id: "highway", kind: "asphalt", width: 256, pts: [[0, 12.4], [6, 12.0], [10, 13.7], [15.3, 12.2], [18.4, 12.2], [24, 12.6]] },
  // N–S road: N edge → Zarya → Fuel Stop → Depot → S edge.
  { id: "ns", kind: "dirt", width: 160, pts: [[6.2, 0], [6.1, 4], [6.0, 8.5], [6.0, 12.0], [8.6, 17.0], [9.0, 24]] },
  // Sawmill spur, continuing to the N2 extract.
  { id: "sawmill", kind: "dirt", width: 160, pts: [[6.05, 5.4], [11.2, 4.9], [13.0, 3.2], [13.4, 0]] },
  // Ford trail: Zarya → ford → Radar Base west gate.
  { id: "ford", kind: "dirt", width: 128, pts: [[9.4, 5.15], [12.0, 5.6], [15.2, 5.6], [17.4, 5.6], [18.2, 4.5]] },
  // Radar spur: Checkpoint → Radar Base south gate.
  { id: "radar", kind: "dirt", width: 160, pts: [[18.4, 12.2], [20.7, 9.6], [20.7, 6.6]] },
  // Quarry spur.
  { id: "quarry", kind: "dirt", width: 160, pts: [[18.6, 12.3], [20.4, 15.4]] },
  // Dacha spur.
  { id: "dacha", kind: "dirt", width: 160, pts: [[6.0, 12.2], [4.0, 15.2], [3.9, 19.1]] },
  // Rail main line W–E (rail bridge at x ≈ 16.5).
  { id: "rail", kind: "rail", width: 128, pts: [[0, 19.6], [24, 19.6]] },
  // Depot side tracks (wagon rows).
  { id: "track-n", kind: "rail", width: 128, pts: [[6.8, 18.85], [14.7, 18.85]] },
  { id: "track-s", kind: "rail", width: 128, pts: [[6.8, 20.35], [14.7, 20.35]] },
];

/** River centre line in blocks; ~420 px wide deep water (MOVE-only: you can shoot and see across). */
export const STEPPE_RIVER: ReadonlyArray<readonly [number, number]> = [
  [16.3, 0], [15.9, 6], [16.9, 11.6], [16.2, 17], [17.0, 24],
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
  { name: "Ford", y: 5.6, height: 384, kind: "ford" },
  { name: "Highway Bridge", y: 12.2, height: 256, kind: "bridge" },
  { name: "Rail Bridge", y: 19.6, height: 256, kind: "bridge" },
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
 * of extractMask. N2 and S2 close at 25:00 (memo §6); every side keeps an always-open option
 * among its allowed extracts.
 */
export const STEPPE_EXTRACTS: readonly ExtractTemplate[] = [
  { id: "N1", name: "Pine Trail", side: 0, at: [6.2, 0.42] },
  { id: "N2", name: "Sawmill Road", side: 0, at: [13.4, 0.42], closesAtMs: 25 * 60_000 },
  { id: "E1", name: "Radar Gate", side: 1, at: [23.58, 9.2] },
  { id: "E2", name: "Quarry Truck", side: 1, at: [23.58, 17.4] },
  { id: "S1", name: "Rail Tunnel", side: 2, at: [9.0, 23.58] },
  { id: "S2", name: "Southern Ford", side: 2, at: [20.6, 23.58], closesAtMs: 25 * 60_000 },
  { id: "W1", name: "Highway West", side: 3, at: [0.42, 12.4] },
  { id: "W2", name: "Dacha Fence", side: 3, at: [0.42, 16.6] },
];

export const EXTRACT_RADIUS = 150;

export const BOSS_CHANCE: Record<BossKind, number> = { foreman: 0.6, commander: 0.4 };
