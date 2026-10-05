/**
 * Types shared by the simulation modules. Everything here is plain data: the Colyseus room is a
 * thin wrapper around the simulation, so nothing in sim/ may depend on networking.
 *
 * Routing is by rosterIndex everywhere (critique "Event and sound recipients"): sessionIds change on
 * reconnect, roster indexes never do. Messages that go to clients still carry sessionIds (that is
 * what the client knows entities by).
 */

import type {
  BoomMsg,
  BossEvMsg,
  XpMsg,
  BossKind,
  GrenadeMsg,
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
  SettledItem,
  SoundMsg,
  WeaponId,
  ReplayWorldEv,
} from "@extract/shared";

/**
 * One human seat of a match (NPC MODEL v5: the roster is humans only; NPCs are created by the match
 * itself from the map's boss spots and NPC posts and never appear here).
 */
export interface RosterEntry {
  /** The player's userId (null only in pre-v5 rosters). */
  userId: string | null;
  nickname: string;
  /**
   * @deprecated v5 has no player-bots. Absent or false; battle-room.sanitizeRoster rejects a roster
   * with `isBot: true` and Match skips such entries (pre-v5 benches / tools).
   */
  isBot?: boolean;
  /** Locked loadout id from the JoinTicket; "" = free kit. */
  loadoutId?: string;
}

/** Where a known unique uid came from (ledger, inventory memo §2.6). */
export type UidOrigin = "loadout" | "pool" | "minted";
/**
 * How one life of a known uid left the match; every life ends in exactly one of these.
 * WORLD v6: "returned" = an entry's pool item never placed (extract before POOL.APPLY_AFTER_MS,
 * PlayerExitReport.unplaced); "expired" = vanished with a player corpse / player-dropped ground item
 * (MatchEndReport.expired → treasury); "expired_pool" = vanished with an NPC corpse
 * (MatchEndReport.expiredToPool → pool, untaxed). Addendum A6.
 */
export type UidResolution = "extract" | "lost" | "destroyed" | "left" | "returned" | "expired" | "expired_pool";

/** WORLD v6 (spec §3.4): one admitted entry (web raids/enter accepted) to put on the map. */
export interface EntryInit {
  entryId: string;
  userId: string;
  nickname: string;
  /** "" = free kit. */
  loadoutId: string;
  guest: boolean;
  level: number;
  snapshot: LoadoutSnapshot | null;
  /** Lost-pool items released for this entry (placed by pool-place.ts after POOL.APPLY_AFTER_MS). */
  pool: SettledItem[];
  /** Boss bag items (D19), stowed on the event boss once it is not engaged. */
  bossFill: SettledItem[];
  /**
   * Party (shared party.ts, JoinTicket.partyId): no damage between runtimes of the same party,
   * S2C.PARTY positions. Absent / "" = solo.
   */
  partyId?: string;
  /** Party drop this entry follows (JoinTicket.dropId): spawn next to the drop's first member (spawn.ts). */
  dropId?: string;
  /** Alpha (JoinTicket.tutorial): the player's first raid — spawn by pickTutorialSpawn (solo only). */
  tutorial?: boolean;
  /** Equipped skin id (JoinTicket.skin) → Player.skin. */
  skin?: string;
}

/**
 * Per-player server-only bookkeeping (input queue, trigger edges, report lists). The public Player
 * and the owner-only SelfState are referenced directly: a reconnect re-keys the Player inside
 * state.players but keeps the same instance, and the self entry key (p<rosterIndex>) never changes.
 */
export interface PlayerRuntime {
  /** Current key in state.players: the client's sessionId once connected, "pending<i>" before; NPCs "npc<i>". */
  id: string;
  rosterIndex: number;
  /** BattleState.self key: selfKeyOf(rosterIndex). */
  selfKey: string;
  userId: string | null;
  nickname: string;
  /** Boss, guard or marauder (Player.role != NPC_ROLE.NONE): no client, no reports, never a "player". */
  isNpc: boolean;
  /** @deprecated alias of isNpc (pre-v5 benches read it); v5 has no player-bots. */
  isBot: boolean;
  /**
   * NPC dormancy (npc.ts, NPC.WAKE_PX): no living human near and no squad alert, so the NPC does
   * not think, move, listen or run vision as a viewer (it stays a target). Always false for humans.
   */
  dormant: boolean;
  /**
   * NPC viewers: sight cap of their vision row (npc.ts sets it each decision): NPC.VIEW_RANGE_CAP
   * while calm, NPC.VIEW_RANGE_ALERT while its squad is alerted or it is under fire. Humans: unused.
   */
  viewCap: number;
  connected: boolean;
  /**
   * Humans: wall ms (Match.now) since the runtime has been without a client — its admission until the
   * first attach, or its last detach; -1 while connected. Bounds how long it holds a seat (WORLD.IDLE_SEAT_MS).
   */
  idleSince: number;
  /** Match clock of the last INV_ERR "rate" sent to this client (at most one per second, security audit). */
  rateErrAt: number;
  loadoutId: string;
  /** Player level at raid start (LoadoutSnapshot.level; 0 for free kit / NPCs): dog tag value, XP. */
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
  /**
   * Match clock of the last shot (vision: muzzle flash / bush reveal). A weapon without a flash
   * (crossbow) sets it VISION.FLASH_MS in the past: the bush reveal applies, the flash never does.
   */
  lastShotAt: number;
  /** Weapons v2: earliest match clock of the next grenade throw (GRENADE.COOLDOWN_MS). */
  nextThrowAt: number;
  /**
   * Weapons v2: a C2S.THROW waiting for its place in the input stream (Match.requestThrow): it runs
   * right after the input `seq` is applied (or once the queue drains), from the post-input position,
   * exactly where the client's prediction threw it.
   */
  pendingThrow: { a: number; d: number; seq: number } | null;
  /** Match clock when the player's position last changed (NPCs / vision: "standing still in a bush"). */
  movedAt: number;
  /** Position at the start of the current step (vision lead eye: velocity). */
  prevX: number;
  prevY: number;
  vx: number;
  vy: number;
  /** Non-roll travel since the last footstep sound (sound.ts). */
  stepAcc: number;
  /** Part of stepAcc covered by non-walk inputs: a step is quiet only when all of it was walked. */
  stepRunAcc: number;
  /**
   * Facing the server vision cone uses (vision.ts): follows input aim at most VIEW_TURN_PER_INPUT
   * per input, so flipping aim every input cannot sweep the cone around the whole circle.
   */
  viewAim: number;
  /** Player.aim value viewAim last followed (an aim set outside the input path snaps the cone). */
  viewAimSrc: number;
  /** Human exit report held back while this player's own bullets are still in flight (match.ts). */
  exitHeld: boolean;
  /** Last other player who damaged this one, and when (NPCs return fire during the peace window). */
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
  /** RaidStats: bossKills = bosses killed, npcKills = marauders + guards killed, guardKills = the guards among them (v5). */
  stats: { shotsFired: number; dmgDealt: number; containersSearched: number; corpsesSearched: number; bossKills: number; npcKills: number; guardKills: number; hotContainers?: number };
  killedBy: string;
  /** Set once the player left the map (extract / death / timeout). NPCs get one too (never posted). */
  exitReport: PlayerExitReport | null;
  outcome: OutcomeMsg | null;

  // ---- WORLD v6 (spec §3.4). Legacy roster humans and NPCs: "", 0, false, [], null, [], 0, false.
  /** Entry id minted by the web (one stay of one user on the map); "" for roster humans and NPCs. */
  entryId: string;
  /** Match clock at admission (roster humans 0): NPC peace window, XP onMapMs, extract arm. */
  enteredAtMs: number;
  /** Guest entry (no dog tag on death, DOG_TAG.GUEST_TAG). */
  guest: boolean;
  /** userIds of humans this runtime killed (PlayerExitReport.victims). */
  victims: string[];
  /** userId of the human who killed this one (dog tag SettledItem.by); null otherwise. */
  killerUserId: string | null;
  /** Pool items released for this entry and not placed yet (pool-place.ts). */
  pendingPool: ItemLike[];
  /** Match clock when pendingPool goes to placement (enteredAtMs + POOL.APPLY_AFTER_MS). */
  poolApplyAt: number;
  /** The web applied this entry's exit (the room merges the receipt into the outcome). */
  exitSettled: boolean;
  /**
   * Party of this entry from its admission ticket ("" = solo, NPCs, roster humans). Runtimes with the
   * same non-empty partyId never damage each other (partyMates) and get S2C.PARTY. A rejoin keeps it.
   */
  partyId: string;
  /** Party drop this entry was admitted with ("" = none). */
  dropId: string;
  /** Alpha: admitted as a first-raid tutorial (pickTutorialSpawn). */
  tutorial: boolean;
  /** Alpha: a client of this entry joined on touch controls (PlayerExitReport.touch). */
  touch: boolean;
  /** Walking speed multiplier of an NPC's inputs (1; the Warden's dash, boss-fight.ts). Humans: always 1. */
  moveMult: number;
  /** Bosses whose trophy this human earned this raid (PlayerExitReport.bossTrophies). */
  bossTrophies: Set<BossKind>;
  /** Bosses only: humans who damaged it this life (party trophy, boss-fight.ts). */
  bossDamagers: Set<PlayerRuntime> | null;
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
  /**
   * `src` = shooter rosterIndex or -1; `fa` = angle target → shooter (target's copy only); `area` =
   * the blast centre of an area hit (grenade): an attacker who does not see the target gets only a
   * position-less "hit confirmed" copy (audience.ts), never the target's id or spot.
   */
  | { type: "hit"; src: number; target: number; msg: HitMsg; fa: number | undefined; area?: { x: number; y: number } }
  /** `src` = killer rosterIndex or -1 (audience: NPC deaths below boss go to the killer only). */
  | { type: "kill"; src: number; msg: KillMsg }
  /** A static container (MapData.containers index) was opened by roster `src`. */
  | { type: "chest"; src: number; idx: number }
  /** A raw sound at a world position (sound.ts emitSound); radius before env.hear. */
  | { type: "sound"; src: number; kind: SoundKind; x: number; y: number; radius: number; variant: number }
  /** A per-listener sound payload built by deliverSounds (WP3). */
  | { type: "snd"; to: number; msg: SoundMsg }
  /** Weapons v2: a grenade for one recipient (grenade.ts already applied the visibility rules). */
  | { type: "nade"; to: number; msg: GrenadeMsg }
  /** Boss fight beat (phase 2, reinforcement call) for one human in the boss's arena (boss-fight.ts). */
  | { type: "boss"; to: number; msg: BossEvMsg }
  /** Weapons v2: a grenade blast for one recipient. */
  | { type: "boom"; to: number; msg: BoomMsg }
  /** In-raid XP the recipient earned (xp.ts creditRaidXp): personal, to that player only. */
  | { type: "xp"; to: number; msg: XpMsg }
  /** Add / remove a `loot` entry to / from one client's StateView (WP-B search sessions). */
  | { type: "view"; to: number; op: "add" | "remove"; key: string }
  | { type: "outcome"; to: number; msg: OutcomeMsg }
  /** A human left the map: POST /api/raids/exit. */
  | { type: "exit"; report: PlayerExitReport }
  | { type: "invErr"; to: number; msg: InvErrMsg }
  /**
   * WORLD v6: the event boss died (POST /api/world/event). `by` = killer nickname, "" if not a human;
   * byUserId = the killer's userId when a registered (non-guest) human, else null.
   */
  | { type: "world"; kind: "boss_killed"; boss: BossKind; by: string; byUserId: string | null }
  /** WORLD v6 map event transition (world-events.ts): replay only, clients read BattleState.wev. */
  | { type: "wev"; ev: ReplayWorldEv; n: number; x: number; y: number; r: number; zone: string }
  /** WORLD v6 combat signals for one listener (world-events.ts already quantized them): [sector, band]…. */
  | { type: "fight"; to: number; msg: number[] }
  | { type: "ended"; report: MatchEndReport; summary: MatchSummaryMsg };

/** Accepted loadouts by userId (legacy roster mode; world entries come through addHuman). */
export type LoadoutMap = ReadonlyMap<string, LoadoutSnapshot>;
