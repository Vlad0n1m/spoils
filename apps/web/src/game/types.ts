/**
 * Contract between the Pixi renderer (src/game/*) and the React UI (src/components/*).
 * The renderer owns the canvas, input and the room's realtime messages it needs for visuals;
 * the UI owns HUD/overlays and reads everything through HudSnapshot (via the HUD store).
 *
 * v2: self data comes from the owner-only SelfState (state.self.get(selfKey)) — the inventory is a
 * slot map, so the per-weapon / ammo / meds summary below is derived from slots.
 */

import type { Room } from "colyseus.js";
import type { HealKind, MapData, WeaponId } from "@extract/shared";

export interface HudSlot {
  weapon: WeaponId | "";
  rarity: number;
  /** Rounds in the magazine. */
  mag: number;
  magSize: number;
  /** FREE kit item (never breaks, never extracts). */
  free: boolean;
  /** BROKEN flag (cannot fire). */
  broken: boolean;
}

export interface HudSelf {
  alive: boolean;
  hp: number;
  maxHp: number;
  /** Armor level 0..3 and absorb points left / max for that level. */
  armor: number;
  armorDur: number;
  armorMax: number;
  /** Weapon slots w1, w2. */
  slots: [HudSlot, HudSlot];
  active: 0 | 1;
  /** Ammo counts carried (all stacks in pockets and backpack). */
  ammo: { light: number; shell: number; heavy: number };
  bandages: number;
  medkits: number;
  /** Progress bars: match-clock ms when started / finishes. */
  reloading: { startMs: number; untilMs: number } | null;
  healing: { kind: HealKind; startMs: number; untilMs: number } | null;
  extracting: { startedAtMs: number; channelMs: number } | null;
  kills: number;
  diedAt: number;
  extractedAt: number;

  // ------------------------------------------------------------------- v2 additions
  /**
   * Roll cooldown as match-clock times (predicted locally): the pie fills from `cdStartMs` to
   * `readyAtMs`; ready when the clock passes readyAtMs. `rolling` while the dodge is running.
   */
  roll: { readyAtMs: number; cdStartMs: number; rolling: boolean };
  /** Quiet walk (Shift) on the last input. */
  walking: boolean;
  /** Search of a container / corpse: open delay progress (match clock), null when not searching. */
  search: { key: string; title: string; startMs: number; readyAtMs: number } | null;
  /** Inventory summary: backpack level and used / total storage slots (pockets + backpack). */
  bpLevel: number;
  storageUsed: number;
  storageCap: number;
  /** Junk value carried at autosell mult 1 (non-FREE junk only): "≈ N CR if you extract". */
  creditsEstimate: number;
  /** Allowed extracts for this player (bit i = MapData.extracts[i]); 0xff when unknown. */
  extractMask: number;
}

export interface KillFeedEntry {
  id: number;
  killer: string;
  victim: string;
  weapon: WeaponId | "";
  /** Match clock when it happened. */
  atMs: number;
}

/** One extraction point as the HUD lists it (allowed ones only). */
export interface HudExtract {
  id: string;
  name: string;
  dx: number;
  dy: number;
  dist: number;
  open: boolean;
}

export interface HudSnapshot {
  phase: "drop" | "open" | "ended";
  clockMs: number;
  durationMs: number;
  /** Match clock when extraction points open. */
  extractOpenAtMs: number;
  self: HudSelf | null;
  /**
   * Players still on the map (alive and not extracted), humans and bots — from
   * BattleState.aliveCount (state.players only holds visible players in v2). After the raid
   * ends this holds the last count taken while it was running.
   */
  aliveCount: number;
  /** Roster size (humans + bots) of this raid; does not shrink when players die or leave. */
  totalPlayers: number;
  /** Direction to the nearest ALLOWED extraction point that is open (or will open). */
  nearestExtract: { dx: number; dy: number; dist: number; open: boolean } | null;
  /** Allowed extraction points, nearest first (empty when unknown / not on the map). */
  extracts: HudExtract[];
  /** Context hint for the interact key, e.g. "F — search Supply crate", "F — pick up Rifle". */
  interactHint: string | null;
  killFeed: KillFeedEntry[];
  /** Round-trip latency in ms, null until measured. */
  pingMs: number | null;
}

/** Panel keys the input layer forwards (Tab / T / Esc / M); owned by the overlay UIs. */
export interface PanelActions {
  toggleInventory?(): void;
  takeAll?(): void;
  closePanel?(): void;
  toggleMap?(): void;
}

export interface RendererOptions {
  mountEl: HTMLElement;
  /** Joined battle room (state: BattleState). */
  room: Room;
  /** Called at most ~30 times per second. */
  onHud: (snapshot: HudSnapshot) => void;
  /**
   * The local player's self key from S2C.JOINED (captured by the screen right after join, before
   * the renderer module has loaded). Falls back to the only key of state.self (a client's view
   * holds just its own entry).
   */
  selfKey?: () => string | null;
  /** An overlay owns the mouse (inventory / search panel): no fire, aim frozen. */
  isInputBlocked?: () => boolean;
  panelActions?: PanelActions;
}

/** Public surface of the renderer used by battle-screen.tsx and the overlays. */
export interface GameRendererApi {
  start(): Promise<void>;
  stop(): void;
  /** The static map once known (search titles, minimap, full map). */
  map?(): MapData | null;
  /** The local player's self key once known. */
  selfKey?(): string | null;
}
