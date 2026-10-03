/**
 * Game server ↔ web API payloads (HMAC-signed, headers in constants.ts HEADERS) and the personal
 * outcome message. Flow (critique "Settlement and loadout flow"):
 *   web: lock loadout → JoinTicket{loadoutId}
 *   MatchmakingRoom.launch → POST /api/raids/start (RaidStartRequest, idempotent, 3 retries)
 *   each human leaving the map → POST /api/raids/exit (PlayerExitReport, idempotent per user)
 *   match end → POST /api/raids/end (MatchEndReport)
 * Every unique uid appears in exactly one report per match (server ledger invariant).
 * WORLD v6 (spec §2.6): no matchmaking; the directory opens a shard (raids/open, ShardOpenRequest),
 * each entry is admitted with raids/enter (EntryRequest), every exit is keyed by entryId, and the
 * wipe posts raids/end. One uid may live several lives in one match (extract X, re-enter with X).
 */

import type { WorldPhase } from "./constants.js";
import type { XpLine } from "./economy.js";
import type { InvErrCode, LoadoutEntry, LoadoutErrCode, SlotKey } from "./inventory.js";
import { BOSS_KINDS, type BossKind, type ContainerKind, type LootTier, type MapId } from "./map/types.js";

/**
 * How a human left the map. "timeout" = legacy roster matches only; "mia" = WORLD v6: still on the
 * map (connected or not) at the wipe — everything carried enters the lost pool with no wear (D9).
 */
export type ExitType = "extract" | "dead" | "timeout" | "mia";

/** One item in a report or snapshot (uid "" = fungible). Replaces v1 ItemRef. */
export interface SettledItem {
  uid: string;
  def: string;
  qty: number;
  rarity: number;
  /** Weapons 0..100 %, armor absorb points (convert with armorPct at the API boundary). */
  dur: number;
  /** Dog tag: victim nickname. */
  label?: string;
  /** Dog tag: victim level. */
  lvl?: number;
  /** Dog tag: victim userId (resolved by the server from InvItem.ref; absent for guest victims). */
  victim?: string;
  /**
   * WORLD v6 (D22) dog tag: the killer's userId (server-resolved). Full price only when it equals
   * the extracting user; anyone else gets DOG_TAG.NON_KILLER_MULT.
   */
  by?: string;
}

/** A locked loadout as accepted by raids/start. */
export interface LoadoutSnapshot {
  loadoutId: string;
  userId: string;
  /** Player level at raid start (dog tag value, XP). */
  level: number;
  entries: Array<SettledItem & { key: SlotKey }>;
}

export type RaidMode = "live" | "demo";

/** Game server (MatchmakingRoom) → web. Idempotent per matchId (the stored response is replayed). */
/** One spawned boss and its pool slots (RaidStartRequest.bosses). */
export interface RaidBossSlots {
  kind: BossKind;
  /** One entry per slot: the minimum uniqueTierScore wanted (fallback: best available). */
  slots: number[];
}

/** RaidStartResponse.containerLoot key of a boss's pool items (v4; the legacy key was "boss"). */
export type BossLootKey = `boss:${BossKind}`;
export function bossLootKey(kind: BossKind): BossLootKey {
  return `boss:${kind}`;
}
/** The boss kind of a containerLoot key, or null for container keys / the legacy "boss". */
export function bossKindOfLootKey(key: string): BossKind | null {
  if (!key.startsWith("boss:")) return null;
  const k = key.slice(5);
  return (BOSS_KINDS as readonly string[]).includes(k) ? (k as BossKind) : null;
}

/** @deprecated v6: legacy roster matches only (world shards use ShardOpenRequest / EntryRequest). Deleted in S8. */
export interface RaidStartRequest {
  matchId: string;
  mode: RaidMode;
  mapId: MapId;
  matchSeed: number;
  /**
   * Server-secret seed of the pool allocation (the game server's per-match lootSeed, never sent to a
   * client). Absent (older servers): the web falls back to matchSeed, which clients know.
   */
  allocSeed?: number;
  /** loadoutId "" = free kit (no pool loot for that player). */
  players: Array<{ userId: string; loadoutId: string }>;
  /**
   * Static containers eligible for pool items (MapData.containers index). v4: `guarded` = within
   * POOL.GUARDED_RADIUS_PX of a BossSpot (containerGuarded), weight × POOL.GUARDED_WEIGHT.
   */
  containers: Array<{ idx: number; kind: ContainerKind; tier: LootTier; guarded?: boolean }>;
  /**
   * Legacy: Σ pool slots of the spawned bosses (bossSlotCount(bosses)); kept during the v4
   * rollout. 0 = no boss.
   */
  bossSlots: number;
  /**
   * v4: bosses that spawned this match (rollBossSpawns(lootSeed, map.bosses), raidBossSlots), each
   * with its pool slots (minimum uniqueTierScore per slot). Their items come back under
   * containerLoot[bossLootKey(kind)].
   */
  bosses?: RaidBossSlots[];
  /**
   * NPC MODEL v5 §3.3: spawned T3/T4 marauders that may carry ONE pool unique each (raidNpcCarriers
   * over rollNpcSpawns). planAllocation weighs them npcCarrierWeight(tier) next to the containers;
   * their items come back under containerLoot[key] (key = npcCarrierKey(postId, member)). Never
   * minted: same risk-tied release, a third destination.
   */
  carriers?: Array<{ key: string; tier: 3 | 4 }>;
  /**
   * Game server process that runs the match (GameServerBoot.instanceId). On its next boot the
   * server calls POST /api/raids/void-orphans and raids of an older instance are voided at once.
   */
  instanceId?: string;
  /** Stable id of the game server deployment (GameServerBoot.serverId); absent = "default". */
  serverId?: string;
}

/** Game server → web at process boot (POST /api/raids/void-orphans, HMAC-signed). */
export interface GameServerBoot {
  /** Stable id of this deployment (env GAME_SERVER_ID, default "default"). */
  serverId: string;
  /** Random per process: raids of the same serverId with another instanceId are orphans. */
  instanceId: string;
  /** Wall-clock ms of the boot. */
  bootedAt: number;
}

export interface VoidOrphansResponse {
  voided: string[];
}

/** @deprecated v6: legacy roster matches only. Deleted in S8. */
export interface RaidStartResponse {
  accepted: LoadoutSnapshot[];
  rejected: Array<{ userId: string; reason: "not_locked" | "wrong_user" | "expired" }>;
  /**
   * Lost-pool uniques allocated to containers, keyed by container index (decimal string in JSON);
   * v4 key bossLootKey(kind) ("boss:<kind>") = that boss's bag (pool slots, never break); v5 key
   * npcCarrierKey(postId, member) ("npc:<postId>.<member>") = one stowed unique on a marauder (never
   * breaks; unlooted → leftOnMap); legacy key "boss" = the old boss stash share. Fungibles are
   * rolled by the server itself.
   */
  containerLoot: Record<string, SettledItem[]>;
  /** Current autosell multiplier (shown in the outcome receipt). */
  autosellMult: number;
}

/** Per-raid stats for XP / quests. */
export interface RaidStats {
  shotsFired: number;
  dmgDealt: number;
  containersSearched: number;
  corpsesSearched: number;
  bossKills: number;
  /** NPC MODEL v5: marauders + guards killed (bosses count in bossKills). Optional for older servers. */
  npcKills?: number;
  /** The guards among npcKills (XP_GUARD instead of XP_NPC). Optional for older servers (then 0). */
  guardKills?: number;
}

/** Sent once per human as soon as they leave the map. */
export interface PlayerExitReport {
  matchId: string;
  userId: string;
  exit: ExitType;
  atMs: number;
  kills: number;
  /** Player level at raid start (echo of LoadoutSnapshot.level; XP). */
  level: number;
  /** Extract only: everything carried (non-FREE), incl. junk and dog tags. */
  extracted: SettledItem[];
  /** Death: uniques that broke (→ lost pool at −8 dur). Timeout / MIA: everything carried (no wear). */
  lost: SettledItem[];
  /** Durability hit 0 during the raid (armor fully absorbed). */
  destroyed: SettledItem[];
  stats: RaidStats;
  /** WORLD v6: this entry (one stay of one user on the map, minted by the web). World matches: always set. */
  entryId?: string;
  /** WORLD v6: cycle clock at admission (onMapMs = atMs − enteredAtMs). */
  enteredAtMs?: number;
  /** WORLD v6: userIds of humans this entry killed (guests included; the web filters). */
  victims?: string[];
  /** WORLD v6: this entry's pool items never placed (left before POOL.APPLY_AFTER_MS) → pool, untaxed. */
  unplaced?: SettledItem[];
}

export interface MatchEndParticipant {
  /** null only in reports of pre-v5 servers (bots). */
  userId: string | null;
  nickname: string;
  /** v5: participants are humans only, so always false (kept for older reports and the DB column). */
  isBot: boolean;
  exitType: ExitType;
  kills: number;
}

export interface MatchEndReport {
  matchId: string;
  mapId: MapId;
  matchSeed: number;
  startedAt: number;
  endedAt: number;
  participants: MatchEndParticipant[];
  /** Uniques still on the map: corpses, containers, ground (→ pool, no wear). */
  leftOnMap: SettledItem[];
  /** Demo mode only: uniques the server rolled itself (must be empty in live mode). */
  minted: SettledItem[];
  /**
   * NPC MODEL v5: NPCs that spawned and how many of them humans killed. Optional for older servers.
   */
  npcSummary?: NpcSummary;
  /**
   * @deprecated v5 never produces it (NPCs never break items: noBreak). Still parsed for one release
   * (in-flight / orphan reports of older servers): uniques that broke on a BOT's death → lost pool.
   */
  botLost?: SettledItem[];
  /** @deprecated v5 never produces it (NPCs never wear pool armor). Uniques destroyed on a bot → destroyed. */
  botDestroyed?: SettledItem[];
  /** WORLD v6: the cycle of this shard (worldCycleOf). */
  cycleId?: number;
  /** WORLD v6: shard index within the cycle (0 at launch). */
  shard?: number;
  /** WORLD v6: every materialized entryId of this shard (the web voids unlisted active entries). */
  entries?: string[];
  /**
   * WORLD v6 (addendum A6): uniques that vanished with an expired player corpse or as loose ground
   * items a player dropped / spilled (WORLD.GROUND_EXPIRE_MS / CORPSE_EXPIRE_MS) → state `treasury`,
   * no wear, no tax step (item_events kind `expire`, ref = matchId). Fungibles are destroyed, not listed.
   */
  expired?: SettledItem[];
  /**
   * WORLD v6 (A6): pool-allocated items that vanished with an expired NPC corpse → lost pool, untaxed
   * (they never belonged to a player, D20). An item is in exactly one of leftOnMap / expired /
   * expiredToPool / an exit report.
   */
  expiredToPool?: SettledItem[];
}

/** Counts per NPC kind (MatchEndReport.npcSummary). */
export interface NpcCounts {
  boss: number;
  guard: number;
  marauder: number;
}

export interface NpcSummary {
  spawned: NpcCounts;
  killedByHumans: NpcCounts;
}

/**
 * Issued by the web API (POST /api/matches/join) and verified by the game server in onAuth.
 * `sig` = hex HMAC-SHA256 over joinTicketPayload() with GAME_SERVER_HMAC_SECRET.
 */
export interface JoinTicket {
  userId: string;
  nickname: string;
  issuedAt: number;
  /** Locked loadout id; "" = free kit. */
  loadoutId: string;
  /** WORLD v6: the shard (match) this ticket admits to. */
  matchId?: string;
  /** WORLD v6: the entry minted by the web at join. */
  entryId?: string;
  sig: string;
}

/** Payload string that a JoinTicket signature covers: `${userId}.${nickname}.${issuedAt}.${loadoutId}.${matchId ?? ""}.${entryId ?? ""}`. */
export function joinTicketPayload(t: Omit<JoinTicket, "sig">): string {
  return `${t.userId}.${t.nickname}.${t.issuedAt}.${t.loadoutId}.${t.matchId ?? ""}.${t.entryId ?? ""}`;
}

// ---------------------------------------------------------------- WORLD v6: game server → web (HMAC-signed)

/** The event boss of a shard: kind and the MapData zone id of its boss spot. */
export interface WorldBossRef {
  kind: BossKind;
  zone: string;
}

/** POST raids/open: a shard (one Colyseus battle room = one Match = one raids row, kind 'world'). */
export interface ShardOpenRequest {
  matchId: string;
  cycleId: number;
  shard: number;
  roomId: string;
  mode: RaidMode;
  mapId: MapId;
  matchSeed: number;
  /** Wall ms. */
  startsAt: number;
  entryClosesAt: number;
  endsAt: number;
  boss: WorldBossRef | null;
  nextBoss: WorldBossRef | null;
  serverId: string;
  instanceId: string;
}
export interface ShardOpenResponse {
  status: "opened" | "exists";
  autosellMult: number;
}

/** POST raids/enter: admission of one entry (idempotent per entryId; replays return the stored response). */
export interface EntryRequest {
  matchId: string;
  entryId: string;
  userId: string;
  /** "" = free kit. */
  loadoutId: string;
  /** Cycle clock at admission (stored; replays reuse it). */
  atMs: number;
  /** Match.poolTargetCount(). */
  targets: number;
  /** The event boss of this shard is alive. */
  bossAlive: boolean;
}
export type EntryRejectReason = "not_locked" | "wrong_user" | "expired" | "already_active" | "entry_limit" | "shard_closed";
export interface EntryResponse {
  status: "accepted" | "rejected";
  reason?: EntryRejectReason;
  /** null = free kit. */
  snapshot: LoadoutSnapshot | null;
  /** Always the user's level (0 for guests): dog tags, XP. */
  level: number;
  guest: boolean;
  /** Released for this entry (the server places them, D18). */
  pool: SettledItem[];
  /** Boss bag (D19), usually empty. */
  bossFill: SettledItem[];
  autosellMult: number;
}
/** POST /api/world/event. */
export interface WorldEventReport {
  matchId: string;
  cycleId: number;
  kind: "boss_killed";
  boss: BossKind;
  /** Killer nickname. */
  by: string;
  atMs: number;
}

// ---------------------------------------------------------------- WORLD v6: web → client

export interface WorldBossDto {
  kind: BossKind;
  name: string;
  zone: string;
  zoneName: string;
  tier: number;
  guards: number;
  status: "alive" | "killed";
  killedBy: string | null;
}
/** GET /api/world/status (public, CDN-cached). */
export interface WorldStatusDto {
  v: 1;
  serverTime: number;
  cycle: number;
  mapNumber: number;
  phase: WorldPhase;
  openAt: number;
  entryClosesAt: number;
  wipeAt: number;
  /** A running world raids row exists for this cycle. */
  online: boolean;
  /** Active entries of this cycle. */
  humans: number;
  /** WORLD.CAPACITY × WORLD.MAX_SHARDS. */
  capacity: number;
  boss: WorldBossDto | null;
  next: {
    cycle: number;
    mapNumber: number;
    openAt: number;
    /** Absent until revealed (WORLD.NEXT_BOSS_REVEAL_MS before the wipe). */
    boss?: { kind: BossKind; name: string; zoneName: string } | null;
  };
  last: {
    cycle: number;
    mapNumber: number;
    extracted: number;
    died: number;
    mia: number;
    topKiller: { nickname: string; kills: number } | null;
    bossKilledBy: string | null;
  } | null;
}
/** POST /api/world/join success body. */
export interface WorldJoinResponse {
  ticket: JoinTicket;
  roomId: string;
  matchId: string;
  cycle: number;
  wipeAt: number;
  entryClosesAt: number;
  rejoin: boolean;
  serverTime: number;
  loadoutId: string;
  entries: LoadoutEntry[];
  pruned: boolean;
}
/** Error body of /api/world/join: { error, message, serverTime, openAt?, retryInMs?, settlesAt?, key? }. */
export type WorldJoinError = "unauthenticated" | "entry_closed" | "world_starting" | "in_raid" | "entry_limit" | LoadoutErrCode;
export interface LastRaidDto {
  entryId: string;
  cycle: number;
  mapNumber: number;
  exit: ExitType;
  at: number;
  onMapMs: number;
  xp: number;
  xpLines: XpLine[];
  credits: number;
  levelBefore: number;
  level: number;
  kills: { players: number; npcs: number; bosses: number };
}
/** GET /api/me/world (private). */
export interface MeWorldDto {
  serverTime: number;
  activeEntry: { matchId: string; entryId: string; cycle: number; wipeAt: number; rejoinable: boolean } | null;
  lastRaid: LastRaidDto | null;
}
export type LeaderboardBoard = "level" | "kills" | "npc";
export type LeaderboardPeriod = "map" | "week" | "all";
export interface LeaderboardDto {
  board: LeaderboardBoard;
  period: LeaderboardPeriod;
  cycle: number | null;
  updatedAt: number;
  /** ≤ 100 rows, ties share a rank. */
  rows: Array<{ rank: number; nickname: string; level: number; value: number }>;
}
export type LeaderboardMeDto = { rank: number; value: number } | null;
export interface WorldEventDto {
  id: string;
  at: number;
  cycle: number;
  mapNumber: number;
  kind: "boss_spawned" | "boss_killed" | "wiped";
  boss?: { kind: BossKind; name: string; zoneName: string };
  by?: string;
  stats?: { entries: number; extracted: number; died: number; mia: number };
}
export interface WorldEventsDto {
  events: WorldEventDto[];
}

/** Autosell receipt line (web fills it after applyExit; the server sends lines at mult 1). */
export interface SoldLine {
  def: string;
  qty: number;
  cr: number;
  label?: string;
}

/** S2C.OUTCOME, to one client: their personal result (extract / death / timeout). */
export interface OutcomeMsg {
  matchId: string;
  exit: ExitType;
  /** Everything the player brought out (extract) — empty otherwise. */
  extracted: SettledItem[];
  /** Broken on death, or everything carried on timeout. */
  lost: SettledItem[];
  /** Survived the death: lies in the corpse for others. */
  dropped: SettledItem[];
  /**
   * Durability hit 0 during the raid (armor fully absorbed) / broke for good: gone, not in the
   * pool. Always set by the server (optional only so older fixtures still type-check).
   */
  destroyed?: SettledItem[];
  kills: number;
  killedBy: string;
  /** Match clock at the moment of the outcome. */
  atMs: number;
  /** junkCredits(extracted) at mult 1 (final CR comes from the web after applyExit). */
  credits: number;
  /** Receipt lines for the autosold junk. */
  sold: SoldLine[];
  /** Guests: junk is not kept ("would sell for N CR — register to keep"). */
  guest: boolean;
  /** WORLD v6: XP granted by the web for this exit (absent until settled / legacy). */
  xp?: number;
  xpLines?: XpLine[];
  /** Level after this exit. */
  level?: number;
  levelUp?: boolean;
}

/** S2C.SETTLED, broadcast at the end: scoreboard only (no user ids, no items). v5: humans only. */
export interface MatchSummaryMsg {
  matchId: string;
  participants: Array<{ nickname: string; isBot: boolean; exitType: ExitType; kills: number }>;
  /** v5: NPC totals for the outcome screen ("NPCs killed M (boss K)"). Optional for older servers. */
  npcSummary?: NpcSummary;
}

/** S2C.INV_ERR, to one client. */
export interface InvErrMsg {
  code: InvErrCode;
  key?: string;
  /** Take-all: how many were taken before stopping. */
  taken?: number;
}
