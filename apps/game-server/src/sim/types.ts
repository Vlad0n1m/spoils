/**
 * Types shared by the simulation modules. Everything here is plain data: the Colyseus room is a
 * thin wrapper around the simulation, so nothing in sim/ may depend on networking.
 */

import type {
  AmmoType,
  ChestOpenedMsg,
  ExitType,
  HitMsg,
  InputSample,
  ItemRef,
  KillMsg,
  MatchSettlementPayload,
  OutcomeMsg,
  Rarity,
  ShotMsg,
  WeaponId,
} from "@extract/shared";

export interface RosterEntry {
  /** null for bots. */
  userId: string | null;
  nickname: string;
  isBot: boolean;
}

/**
 * Per-player server-only bookkeeping that must not be synced to clients (input queue, trigger
 * edges, settlement lists). Keyed by the same id as BattleState.players, which changes when a
 * human (re)connects, so the runtime keeps `id` current and holds no other reference to the key.
 */
export interface PlayerRuntime {
  id: string;
  rosterIndex: number;
  userId: string | null;
  nickname: string;
  isBot: boolean;
  connected: boolean;

  queue: InputSample[];
  /** Highest seq ever queued; older or repeated samples are replays and are dropped. */
  lastQueuedSeq: number;
  /** Movement time the player has earned but not yet spent (anti speed-hack budget). */
  allowanceMs: number;

  triggerHeld: boolean;
  /** A trigger press (rising edge) not yet turned into a shot; expires after PRESS_BUFFER_MS. */
  pressPending: boolean;
  pressAt: number;
  nextFireAt: number;
  /** Match clock when the player's position last changed (bots: "standing still in a bush"). */
  movedAt: number;
  /** Last other player who damaged this one, and when (bots return fire during the peace window). */
  lastHitBy: PlayerRuntime | null;
  lastHitAt: number;
  /** Slot the running reload belongs to (the active slot when it started). */
  reloadSlot: number;

  exit: ExitType | null;
  extracted: ItemRef[];
  lost: ItemRef[];
  dropped: ItemRef[];
  killedBy: string;
  outcome: OutcomeMsg | null;
}

/** Contents of a chest or anything that can become a GroundItem. */
export type LootDrop =
  | { kind: "weapon"; weapon: WeaponId; rarity: Rarity; mag: number; uid: string }
  | { kind: "armor"; level: 1 | 2 | 3; dur: number; uid: string }
  | { kind: "ammo"; ammo: AmmoType; qty: number }
  | { kind: "bandage" | "medkit"; qty: number };

export interface Bullet {
  owner: PlayerRuntime;
  weapon: WeaponId;
  x: number;
  y: number;
  dx: number;
  dy: number;
  speed: number;
  remaining: number;
  damage: number;
}

export type MatchEvent =
  | { type: "shot"; msg: ShotMsg }
  | { type: "hit"; msg: HitMsg }
  | { type: "kill"; msg: KillMsg }
  | { type: "chest"; msg: ChestOpenedMsg }
  /** `to` is the player's current state key (the client's sessionId once connected). */
  | { type: "outcome"; to: string; msg: OutcomeMsg }
  | { type: "ended"; settlement: MatchSettlementPayload };
