/**
 * Types shared by the simulation modules. Everything here is plain data: the Colyseus room is a
 * thin wrapper around the simulation, so nothing in sim/ may depend on networking.
 *
 * Routing is by rosterIndex everywhere (critique "Event and sound recipients"): sessionIds change on
 * reconnect, roster indexes never do. Messages that go to clients still carry sessionIds (that is
 * what the client knows entities by).
 */

import type {
  HitMsg,
  InputSample,
  InvErrMsg,
  ItemLike,
  KillMsg,
  LoadoutSnapshot,
  MatchEndReport,
  MatchSummaryMsg,
  OutcomeMsg,
  Player,
  PlayerExitReport,
  SelfState,
  ShotMsg,
  SlotKey,
  SoundKind,
  SoundMsg,
  WeaponId,
} from "@extract/shared";

export interface RosterEntry {
  /** null for bots. */
  userId: string | null;
  nickname: string;
  isBot: boolean;
  /** Locked loadout id from the JoinTicket; "" = free kit (also every bot). */
  loadoutId?: string;
}

/** Where a known unique uid came from (ledger, inventory memo §2.6). */
export type UidOrigin = "loadout" | "pool" | "minted";
/** How a known uid left the match; every known uid ends in exactly one of these. */
export type UidResolution = "extract" | "lost" | "destroyed" | "left";

/**
 * Per-player server-only bookkeeping (input queue, trigger edges, report lists). The public Player
 * and the owner-only SelfState are referenced directly: a reconnect re-keys the Player inside
 * state.players but keeps the same instance, and the self entry key (p<rosterIndex>) never changes.
 */
export interface PlayerRuntime {
  /** Current key in state.players: the client's sessionId once connected, "bot<i>" / "pending<i>" before. */
  id: string;
  rosterIndex: number;
  /** BattleState.self key: selfKeyOf(rosterIndex). */
  selfKey: string;
  userId: string | null;
  nickname: string;
  isBot: boolean;
  connected: boolean;
  loadoutId: string;
  /** Player level at raid start (LoadoutSnapshot.level; 0 for free kit / bots): dog tag value, XP. */
  level: number;
  pub: Player;
  self: SelfState;

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
  /** Match clock of the last shot (vision: muzzle flash / bush reveal). */
  lastShotAt: number;
  /** Match clock when the player's position last changed (bots / vision: "standing still in a bush"). */
  movedAt: number;
  /** Position at the start of the current step (vision lead eye: velocity). */
  prevX: number;
  prevY: number;
  vx: number;
  vy: number;
  /** Non-roll travel since the last footstep sound (sound.ts). */
  stepAcc: number;
  /** Last other player who damaged this one, and when (bots return fire during the peace window). */
  lastHitBy: PlayerRuntime | null;
  lastHitAt: number;
  /** Weapon slot the running reload belongs to (the active slot when it started). */
  reloadKey: SlotKey | "";
  nextExtractSoundAt: number;
  nextSearchSoundAt: number;
  /** Search session (WP-B containers.ts); null = not searching. */
  search: { key: string; readyAt: number } | null;
  /** INV_* token bucket (SEARCH.OPS_PER_SEC). */
  opsBucket: { tokens: number; at: number };

  /** Uniques that hit 0 durability during the raid (armor fully used up). */
  destroyed: ItemLike[];
  /** Death: uniques that survived the break roll and stay on the map for others. */
  dropped: ItemLike[];
  stats: { shotsFired: number; dmgDealt: number; containersSearched: number; corpsesSearched: number; bossKills: number };
  killedBy: string;
  /** Set once the player left the map (extract / death / timeout). Bots get one too (never posted). */
  exitReport: PlayerExitReport | null;
  outcome: OutcomeMsg | null;
}

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

/**
 * Sim → room events. audience.ts turns the routable ones (shot / hit / kill / chest / sound / snd)
 * into one EventsMsg per client per tick; the rest are personal sends or web reports.
 */
export type MatchEvent =
  /** `src` = shooter rosterIndex. */
  | { type: "shot"; src: number; msg: ShotMsg }
  /** `src` = shooter rosterIndex or -1; `fa` = angle target → shooter (target's copy only). */
  | { type: "hit"; src: number; target: number; msg: HitMsg; fa: number | undefined }
  | { type: "kill"; msg: KillMsg }
  /** A static container (MapData.containers index) was opened by roster `src`. */
  | { type: "chest"; src: number; idx: number }
  /** A raw sound at a world position (sound.ts emitSound); radius before env.hear. */
  | { type: "sound"; src: number; kind: SoundKind; x: number; y: number; radius: number; variant: number }
  /** A per-listener sound payload built by deliverSounds (WP3). */
  | { type: "snd"; to: number; msg: SoundMsg }
  /** Add / remove a `loot` entry to / from one client's StateView (WP-B search sessions). */
  | { type: "view"; to: number; op: "add" | "remove"; key: string }
  | { type: "outcome"; to: number; msg: OutcomeMsg }
  /** A human left the map: POST /api/raids/exit. */
  | { type: "exit"; report: PlayerExitReport }
  | { type: "invErr"; to: number; msg: InvErrMsg }
  | { type: "ended"; report: MatchEndReport; summary: MatchSummaryMsg };

/** Loadouts accepted by raids/start, by userId. */
export type LoadoutMap = ReadonlyMap<string, LoadoutSnapshot>;
