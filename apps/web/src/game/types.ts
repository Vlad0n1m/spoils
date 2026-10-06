/**
 * Contract between the Pixi renderer (src/game/*) and the React UI (src/components/*).
 * The renderer owns the canvas, input and the room's realtime messages it needs for visuals;
 * the UI owns HUD/overlays and reads everything through HudSnapshot (via the HUD store).
 *
 * v2: self data comes from the owner-only SelfState (state.self.get(selfKey)) — the inventory is a
 * slot map, so the per-weapon / ammo / meds summary below is derived from slots.
 */

import type { Room } from "colyseus.js";
import type { BossKind, HealKind, KillWeapon, MapData, RaidXpKey, SpectateEndReason, WeaponId } from "@extract/shared";
import type { KillTally } from "./npc-labels";

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
  /** Ammo counts carried (all stacks in pockets and backpack). Weapons v2: crossbow bolts. */
  ammo: { light: number; shell: number; heavy: number; bolt: number };
  bandages: number;
  medkits: number;
  /** Weapons v2: hand grenades carried (G / 5, the touch grenade button). */
  grenades: number;
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
  /** In-raid XP estimate (SelfState.raidXp); the settled XP comes on the outcome screen. */
  raidXp: number;
}

export interface KillFeedEntry {
  id: number;
  killer: string;
  victim: string;
  /** Gun or (Weapons v2) "grenade"; "" = no weapon. */
  weapon: KillWeapon | "";
  /**
   * NPC_ROLE of the killer / victim (0 = a human; KillMsg.killerRole / victimRole, NPC MODEL v5).
   * NPC names render in their role colour with the NPC badge.
   */
  killerRole?: number;
  victimRole?: number;
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

/** Wipe warning just crossed (seconds before the wipe: WORLD.WARN_AT_MS / 1000), 0 = none. */
export type WipeWarn = 0 | 600 | 300 | 60;

/** The map's event boss (BattleState.bossKind / bossZone / bossState). */
export interface HudBoss {
  kind: BossKind;
  /** Display name of the boss spot's zone ("Grain Elevator"). */
  zone: string;
  /** 1 alive · 2 killed. */
  state: 1 | 2;
}

export interface HudSnapshot {
  phase: "drop" | "open" | "ended";
  clockMs: number;
  durationMs: number;
  /**
   * Match clock when THIS player's extraction points open: the personal arm (SelfState.extractArmAt,
   * WORLD v6) or, on a legacy match, the earliest extract openAt.
   */
  extractOpenAtMs: number;
  /** WORLD v6: the wipe warning to show right now (shown WIPE_WARN_SHOW_MS after each threshold). */
  wipeWarn: WipeWarn;
  /** WORLD v6: the event boss of this map, null without one. */
  boss: HudBoss | null;
  /** WORLD v6: match clock when this player's entry started (SelfState.enteredAt), 0 = unknown / legacy. */
  enteredAtMs: number;
  self: HudSelf | null;
  /**
   * Human players still on the map (alive and not extracted) — from BattleState.aliveCount, which
   * the server counts over humans only (NPC MODEL v5: NPCs are never players and never counted).
   * After the raid ends this holds the last count taken while it was running.
   */
  aliveCount: number;
  /** Human roster size of this raid; does not shrink when players die or leave. */
  totalPlayers: number;
  /** Direction to the nearest ALLOWED extraction point that is open (or will open). */
  nearestExtract: { dx: number; dy: number; dist: number; open: boolean } | null;
  /** Allowed extraction points, nearest first (empty when unknown / not on the map). */
  extracts: HudExtract[];
  /** Context hint for the interact key, e.g. "F — search Supply crate", "F — pick up Rifle". */
  interactHint: string | null;
  killFeed: KillFeedEntry[];
  /** The local player's kills this raid split by victim kind (players / NPCs / bosses). */
  killTally?: KillTally;
  /** Round-trip latency in ms, null until measured. */
  pingMs: number | null;
  /** The canvas full map is open (the touch HUD hides its bottom bar and compass over it). */
  mapOpen?: boolean;
  /** The local player's drawn position and aim (the first-raid tutorial reads it); null off the map. */
  pose?: { x: number; y: number; aim: number } | null;
  /** In-raid XP actions of the last XP_GAIN_SHOW_MS, oldest first (EventsMsg.xp). */
  xpGains?: XpGain[];
  /** Spectating a party mate after the run (S2C.SPECTATE). */
  spectate?: HudSpectate;
  /** The death replay (killcam.ts). */
  replay?: HudReplay;
}

/** Spectate state for the outcome screen and the spectate bar. */
export interface HudSpectate {
  /** Party mates still on the map (S2C.PARTY), in message order: who can be watched. */
  mates: Array<{ key: string; name: string }>;
  /** The mate being watched, with the bars from their Player entry. */
  watching: {
    key: string;
    name: string;
    alive: boolean;
    hp: number;
    maxHp: number;
    armor: number;
    armorDur: number;
    armorMax: number;
    weapon: string;
  } | null;
  /** A request is out, no answer yet. */
  pending: boolean;
  /** Why the last watch ended or was refused (null after a manual stop). */
  ended: { reason: SpectateEndReason; name: string } | null;
}

export interface HudReplay {
  /** The local player died and the record is long enough to replay. */
  available: boolean;
  playing: boolean;
  /** 0..1 of the running replay. */
  progress: number;
  /** A replay ran (and ended or was skipped) at least once. */
  played: boolean;
  /** Plays by itself once after the death beat (off under reduced motion: offered as a button). */
  autoPlay: boolean;
}

/** One counted XP action (EventsMsg.xp) as the HUD shows it. */
export interface XpGain {
  id: number;
  k: RaidXpKey;
  /** XP added to the estimate; 0 = the line is capped (containers past XP.CONTAINER_MAX). */
  xp: number;
  /** This entry's count of that line so far. */
  n: number;
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
  /** After the run: watch the party mate with this S2C.PARTY key, or stop (null). */
  spectate?(key: string | null): void;
  /** Play the death replay; false when there is none. */
  startReplay?(): boolean;
  /** Skip the death replay. */
  stopReplay?(): void;
  /** Touch HUD: switch weapons (the same action as the swap button). */
  swapWeapon?(): void;
}
