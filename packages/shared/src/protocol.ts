/**
 * Room messages. Client → server inputs are validated on the server (never trusted).
 * Server → client messages are cosmetic events and personal results; the state is the truth.
 */

import type { WeaponId } from "./items.js";

/** Client → server message names. */
export const C2S = {
  /** InputSample (movement + aim + trigger), every INPUT_DT_MS. */
  INPUT: "input",
  /** {} — open the nearest chest or pick up the nearest weapon/armor within PLAYER.INTERACT_RADIUS. */
  INTERACT: "interact",
  /** {} — reload the active weapon. */
  RELOAD: "reload",
  /** { slot: 0 | 1 } */
  SWITCH: "switch",
  /** { kind: "bandage" | "medkit" } */
  HEAL: "heal",
  /** { t: number } — latency probe, answered with PONG. */
  PING: "ping",
} as const;

/** Server → client message names. */
export const S2C = {
  /** JoinedMsg, sent once to the joining client. */
  JOINED: "joined",
  /** ShotMsg, broadcast: somebody fired (client draws tracers, stopped by walls). */
  SHOT: "shot",
  /** HitMsg, broadcast: a bullet hit a player. */
  HIT: "hit",
  /** KillMsg, broadcast: kill feed. */
  KILL: "kill",
  /** ChestOpenedMsg, broadcast. */
  CHEST: "chest",
  /** OutcomeMsg, to one client: their personal result (extract / death / timeout). */
  OUTCOME: "outcome",
  /** MatchSettlementPayload, broadcast at the end. */
  SETTLED: "settled",
  /** { t } echo of PING. */
  PONG: "pong",
} as const;

export interface JoinedMsg {
  sessionId: string;
  matchId: string;
}

export interface ShotMsg {
  /** Shooter sessionId. */
  s: string;
  w: WeaponId;
  /** Muzzle position. */
  x: number;
  y: number;
  /** Angle of every pellet. */
  a: number[];
}

export interface HitMsg {
  /** Target sessionId. */
  t: string;
  /** Shooter sessionId. */
  s: string;
  x: number;
  y: number;
  /** HP actually lost. */
  d: number;
  /** Armor absorbed something. */
  ar: boolean;
}

export interface KillMsg {
  /** Victim nickname / sessionId. */
  victim: string;
  victimId: string;
  /** Killer nickname / sessionId ("" when not killed by a player). */
  killer: string;
  killerId: string;
  weapon: WeaponId | "";
}

export interface ChestOpenedMsg {
  id: string;
  by: string;
}

/** Reference to a valuable item (weapon or armor) for outcomes and settlement. */
export interface ItemRef {
  uid: string;
  kind: "weapon" | "armor";
  /** WeaponId for weapons, "armor" for armor. */
  type: string;
  rarity: number;
  /** Armor level (armor only). */
  level?: number;
}

export type ExitType = "extract" | "dead" | "timeout";

export interface OutcomeMsg {
  matchId: string;
  exit: ExitType;
  /** Valuable items the player brought out (extract) — empty otherwise. */
  extracted: ItemRef[];
  /** Items lost: broken on death or left on the map. */
  lost: ItemRef[];
  /** Items that survived the death and lie on the map for others. */
  dropped: ItemRef[];
  kills: number;
  killedBy: string;
  /** Match clock at the moment of the outcome. */
  atMs: number;
}
