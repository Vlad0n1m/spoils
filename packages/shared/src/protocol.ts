/**
 * Room messages v2. Client → server inputs are validated on the server (never trusted).
 * Server → client: one batched `ev` message per client per tick (EventsMsg), built per recipient by
 * the server's audience routing so nothing leaks positions the client cannot see. The standalone
 * v1 SHOT / HIT / KILL / CHEST broadcasts are gone. State (through StateView) is the truth.
 */

import type { SlotKey } from "./inventory.js";
import type { WeaponId } from "./items.js";
import type { SoundMsg } from "./sound.js";

/** Colyseus room names. */
export const ROOMS = {
  /** Single demo matchmaking queue. Join with { ticket }. */
  MATCHMAKING: "mm",
  /** One room per match. Join by id with BattleJoinOptions. */
  BATTLE: "battle",
} as const;

/** Matchmaking room → client: the battle is created, join it by id. */
export const MM_BATTLE_READY = "battle_ready";
export interface BattleReadyMsg {
  battleRoomId: string;
}

/** Options of joinById(battleRoomId, …). */
export interface BattleJoinOptions {
  /** JSON JoinTicket (or a guest ticket). */
  ticket: unknown;
  /** mapHash(map) computed by the client; the server logs / rejects a mismatch (generator drift). */
  mapHash: string;
}

/**
 * WebSocket close codes the rooms use when kicking a client. Above 4100: Colyseus reserves
 * 4000–4010 (e.g. 4002 = WS_CLOSE_WITH_ERROR).
 */
export const CLOSE_CODES = {
  /** Battle: the ticket's user is not in this match's roster. */
  NOT_IN_ROSTER: 4101,
  /** Matchmaking: the queue already launched its battle. */
  QUEUE_CLOSED: 4102,
  /** The same user connected again from another tab / device; the old connection is dropped. */
  JOINED_ELSEWHERE: 4103,
  /** raids/start rejected this player's loadout (not locked / expired / wrong user). */
  LOADOUT_REJECTED: 4104,
  /** Matchmaking: the battle room could not be created. */
  LAUNCH_FAILED: 4150,
} as const;

/** Client → server message names. */
export const C2S = {
  /** InputSample (movement + aim + trigger + roll + walk), every INPUT_DT_MS. */
  INPUT: "input",
  /** {} — F: open the nearest container / corpse (search), else pick up the nearest ground item. */
  INTERACT: "interact",
  /** {} — reload the active weapon. */
  RELOAD: "reload",
  /** SwitchMsg */
  SWITCH: "switch",
  /** HealMsg */
  HEAL: "heal",
  /** {} — close the current search. */
  SEARCH_CLOSE: "search_close",
  /** InvMoveMsg */
  INV_MOVE: "inv_move",
  /** {} — take every revealed takeable item of the current search (T). */
  INV_TAKE_ALL: "inv_take_all",
  /** InvDropMsg — own item → ground (FREE items just vanish). */
  INV_DROP: "inv_drop",
  /** { t: number } — latency probe, answered with PONG. */
  PING: "ping",
} as const;

/** Server → client message names. */
export const S2C = {
  /** JoinedMsg, sent once to the joining client. */
  JOINED: "joined",
  /** EventsMsg, at most one per client per tick, only when non-empty. */
  EV: "ev",
  /** InvErrMsg (types.ts), to one client. */
  INV_ERR: "inv_err",
  /** OutcomeMsg (types.ts), to one client: their personal result. */
  OUTCOME: "outcome",
  /** MatchSummaryMsg (types.ts), broadcast at the end. */
  SETTLED: "settled",
  /** { t } echo of PING. */
  PONG: "pong",
} as const;

export interface SwitchMsg {
  slot: "w1" | "w2";
}

export interface HealMsg {
  kind: "bandage" | "medkit";
}

export interface JoinedMsg {
  sessionId: string;
  matchId: string;
  /** This client's key in BattleState.self ("p<rosterIndex>"). */
  selfKey: string;
}

/** Move one item (or part of a stack) into the player's own inventory. */
export interface InvMoveMsg {
  /** "self" = rearrange own slots; "loot" = take from the current search. */
  from: "self" | "loot";
  /** Source key: own SlotKey, or the loot slot index ("0".."total-1"). */
  key: string;
  /** Stale-click guard: what the client believes is in `key` (uid "" for stacks). */
  uid: string;
  def: string;
  /** Target slot in own inventory; omitted = auto-place (planPlace). */
  to?: SlotKey;
  /** Partial stack move; omitted = whole stack. */
  qty?: number;
}

export interface InvDropMsg {
  key: SlotKey;
  uid: string;
  def: string;
  qty?: number;
}

export interface ShotMsg {
  /** Shooter sessionId; "" when the shooter is hidden and the tracer was clipped to the view circle. */
  s: string;
  w: WeaponId;
  /** Muzzle position (where tracers start); for clipped shots the entry point into the view circle. */
  x: number;
  y: number;
  /** Shooter centre (wall test origin); equals x/y for clipped shots. */
  cx: number;
  cy: number;
  /** Angle of every pellet. */
  a: number[];
}

export interface HitMsg {
  /** Target sessionId. */
  t: string;
  /** Shooter sessionId ("" if the target cannot see the shooter). */
  s: string;
  x: number;
  y: number;
  /** HP actually lost. */
  d: number;
  /** Armor absorbed something. */
  ar: boolean;
  /** Target's own copy only: angle target → shooter (damage-direction arc), quantised to 2π/64. */
  fa?: number;
}

/**
 * Broadcast to everyone ("names only" per critique: no positions). The sessionIds carry no
 * position either; the client only uses them to find an entity it already renders (death
 * animation) or to tell "you killed" / "you died".
 */
export interface KillMsg {
  /** Victim nickname / sessionId. */
  victim: string;
  victimId: string;
  /** Killer nickname / sessionId ("" when not killed by a player). */
  killer: string;
  killerId: string;
  weapon: WeaponId | "";
}

/** A static container was opened (lid / sound cue) — MapData.containers index. */
export interface ChestEvent {
  idx: number;
  /** Opener sessionId, only when the recipient sees the opener. */
  by?: string;
}

/** Batched per-tick events for one client. Missing keys = nothing of that kind this tick. */
export interface EventsMsg {
  shots?: ShotMsg[];
  hits?: HitMsg[];
  kills?: KillMsg[];
  snd?: SoundMsg;
  chest?: ChestEvent[];
}

/** Quantise an angle to 2π/64 (HitMsg.fa): enough for a damage arc, too coarse to aim with. */
export function quantizeFa(angle: number): number {
  const step = (Math.PI * 2) / 64;
  return Math.round(angle / step) * step;
}
