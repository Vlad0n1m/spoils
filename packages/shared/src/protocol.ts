/**
 * Room messages v2. Client → server inputs are validated on the server (never trusted).
 * Server → client: one batched `ev` message per client per tick (EventsMsg), built per recipient by
 * the server's audience routing so nothing leaks positions the client cannot see. The standalone
 * v1 SHOT / HIT / KILL / CHEST broadcasts are gone. State (through StateView) is the truth.
 */

import type { SlotKey } from "./inventory.js";
import type { KillWeapon, WeaponId } from "./items.js";
import type { SoundMsg } from "./sound.js";

/** Colyseus room names. */
export const ROOMS = {
  /** One room per match. Join by id with BattleJoinOptions. */
  BATTLE: "battle",
} as const;

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
  /** The same user connected again from another tab / device; the old connection is dropped. */
  JOINED_ELSEWHERE: 4103,
  /** raids/enter rejected this player's loadout (not locked / expired / wrong user). */
  LOADOUT_REJECTED: 4104,
  /** WORLD v6: the map was wiped (sent 8 s after the end report). */
  WIPED: 4105,
  /** WORLD v6: this connection has no runtime on this map (entry gone / settled). */
  NOT_IN_WORLD: 4109,
} as const;

/**
 * WORLD v6: ServerError messages of the battle room's static onAuth (admission), sent as "<code>" or
 * "<code>:<detail>" (e.g. "loadout_rejected:not_locked").
 */
export const WORLD_JOIN_ERR = {
  INVALID_TICKET: "invalid_ticket",
  MAP_MISMATCH: "map_mismatch",
  MAP_GONE: "map_gone",
  ENTRY_CLOSED: "entry_closed",
  WORLD_FULL: "world_full",
  EXIT_SETTLING: "exit_settling",
  IN_RAID: "in_raid",
  ENTRY_LIMIT: "entry_limit",
  LOADOUT_REJECTED: "loadout_rejected",
  WEB_UNAVAILABLE: "web_unavailable",
} as const;
export type WorldJoinErrCode = (typeof WORLD_JOIN_ERR)[keyof typeof WORLD_JOIN_ERR];

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
  /** ThrowMsg — Weapons v2: throw one hand grenade (G / 5, touch THROW button). */
  THROW: "throw",
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
  /**
   * PartyMsg (party.ts), sent at PARTY.POS_HZ to each party member while a party mate shares the
   * shard: {mates: [{key, id, name, x, y, alive}]}, the mates only (never the member, never anyone
   * outside the party). A member whose mates are all gone gets one empty list.
   */
  PARTY: "party",
} as const;

export interface SwitchMsg {
  slot: "w1" | "w2";
}

export interface HealMsg {
  kind: "bandage" | "medkit";
}

/**
 * Weapons v2: throw a hand grenade (GRENADE in items.ts). The server throws from the player's
 * current position; refused while rolling or reloading, within GRENADE.COOLDOWN_MS of the last
 * throw, or without a grenade in the inventory.
 */
export interface ThrowMsg {
  /** Throw direction, radians. */
  a: number;
  /** 0..1: distance between GRENADE.MIN_PX and MAX_PX (grenadeThrowPx). */
  d: number;
  /**
   * Seq of the client's newest input sent before the throw: the server throws right after applying
   * that input (input order, post-input position). Absent: after the newest input received so far.
   */
  q?: number;
}

export interface JoinedMsg {
  sessionId: string;
  matchId: string;
  /** This client's key in BattleState.self ("p<rosterIndex>"). */
  selfKey: string;
  /** WORLD v6: this stay's entry id (minted by the web at join). */
  entryId?: string;
  /** WORLD v6: the cycle of this map. */
  cycleId?: number;
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
  /**
   * Target sessionId. "" on the thrower's copy of a grenade hit on someone they do not see: then
   * x/y is the blast centre and d is 0, a "hit confirmed" without the target's spot or HP loss.
   */
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
  /** Gun, "grenade" (Weapons v2), or "" (no weapon). */
  weapon: KillWeapon | "";
  /**
   * NPC MODEL v5: NPC_ROLE of the killer / victim (absent = 0, a human; optional for older
   * servers). Marauder and guard deaths go only to their killer; boss and human deaths broadcast.
   */
  killerRole?: number;
  victimRole?: number;
}

/** A static container was opened (lid / sound cue) — MapData.containers index. */
export interface ChestEvent {
  idx: number;
  /** Opener sessionId, only when the recipient sees the opener. */
  by?: string;
}

/**
 * Weapons v2: a hand grenade in flight / on the ground. Sent once, at the throw (in full to the
 * thrower and to recipients that see the thrower), or as a resting grenade when it lands (to
 * recipients that see the landing point but not the thrower: `s` = "", `p` = the resting point).
 * The client moves it along `p` and shows the warning ring before `fuse`; the blast itself is a
 * BoomMsg (authoritative) and its audio the SoundKind.explosion entry of `snd`.
 */
export interface GrenadeMsg {
  /** Grenade id (unique per match). */
  id: number;
  /** Thrower sessionId, "" when the recipient does not see the thrower. */
  s: string;
  /** Polyline, stride 3: [x, y, t, …], t = ms after the throw (the last point is where it rests). */
  p: number[];
  /** Explosion time, ms after the throw. */
  fuse: number;
  /** ms after the throw at which this message describes the grenade (0 = the throw itself; landing copies: the landing time). */
  at: number;
}

/** Weapons v2: a hand grenade exploded at x/y (recipients that got its GrenadeMsg or see the point). */
export interface BoomMsg {
  id: number;
  x: number;
  y: number;
}

/** Batched per-tick events for one client. Missing keys = nothing of that kind this tick. */
export interface EventsMsg {
  shots?: ShotMsg[];
  hits?: HitMsg[];
  kills?: KillMsg[];
  snd?: SoundMsg;
  chest?: ChestEvent[];
  /** Weapons v2: grenades thrown (or landed in view) this tick. */
  nades?: GrenadeMsg[];
  /** Weapons v2: grenades that exploded this tick. */
  booms?: BoomMsg[];
}

/** Quantise an angle to 2π/64 (HitMsg.fa): enough for a damage arc, too coarse to aim with. */
export function quantizeFa(angle: number): number {
  const step = (Math.PI * 2) / 64;
  return Math.round(angle / step) * step;
}
