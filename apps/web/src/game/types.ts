/**
 * Contract between the Pixi renderer (src/game/*) and the React UI (src/components/*).
 * The renderer owns the canvas, input and the room's realtime messages it needs for visuals;
 * the UI owns HUD/overlays and reads everything through HudSnapshot.
 */

import type { Room } from "colyseus.js";
import type { HealKind, WeaponId } from "@extract/shared";

export interface HudSlot {
  weapon: WeaponId | "";
  rarity: number;
  mag: number;
  magSize: number;
  free: boolean;
}

export interface HudSelf {
  alive: boolean;
  hp: number;
  maxHp: number;
  /** Armor level 0..3 and durability left / max for that level. */
  armor: number;
  armorDur: number;
  armorMax: number;
  slots: [HudSlot, HudSlot];
  active: 0 | 1;
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
}

export interface KillFeedEntry {
  id: number;
  killer: string;
  victim: string;
  weapon: WeaponId | "";
  /** Match clock when it happened. */
  atMs: number;
}

export interface HudSnapshot {
  phase: "drop" | "open" | "ended";
  clockMs: number;
  durationMs: number;
  /** Match clock when extraction points open. */
  extractOpenAtMs: number;
  self: HudSelf | null;
  /**
   * Players still on the map (alive and not extracted), humans and bots. After the raid ends
   * this holds the last count taken while it was running (the server's end-of-match timeout
   * takes everyone off the map, which would otherwise read 0).
   */
  aliveCount: number;
  /** Roster size (humans + bots) of this raid; does not shrink when players die or leave. */
  totalPlayers: number;
  /** Direction to the nearest extraction point that is open (or will open), relative to the player. */
  nearestExtract: { dx: number; dy: number; dist: number; open: boolean } | null;
  /** Context hint for the interact key, e.g. "F — open chest", "F — pick up Rifle (rare)". */
  interactHint: string | null;
  killFeed: KillFeedEntry[];
  /** Round-trip latency in ms, null until measured. */
  pingMs: number | null;
}

export interface RendererOptions {
  mountEl: HTMLElement;
  /** Joined battle room (state: BattleState). */
  room: Room;
  /** Called at most ~30 times per second. */
  onHud: (snapshot: HudSnapshot) => void;
}

/** Public surface of the renderer used by battle-screen.tsx. */
export interface GameRendererApi {
  start(): Promise<void>;
  stop(): void;
}
