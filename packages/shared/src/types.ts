/**
 * Game server ↔ web API payloads (HMAC-signed, headers in constants.ts HEADERS) and the personal
 * outcome message. Flow (critique "Settlement and loadout flow"):
 *   web: lock loadout → JoinTicket{loadoutId}
 *   MatchmakingRoom.launch → POST /api/raids/start (RaidStartRequest, idempotent, 3 retries)
 *   each human leaving the map → POST /api/raids/exit (PlayerExitReport, idempotent per user)
 *   match end → POST /api/raids/end (MatchEndReport)
 * Every unique uid appears in exactly one report per match (server ledger invariant).
 */

import type { InvErrCode, SlotKey } from "./inventory.js";
import { BOSS_KINDS, type BossKind, type ContainerKind, type LootTier, type MapId } from "./map/types.js";

export type ExitType = "extract" | "dead" | "timeout";

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
  /** Death: uniques that broke (→ lost pool at −8 dur). Timeout: everything carried. */
  lost: SettledItem[];
  /** Durability hit 0 during the raid (armor fully absorbed). */
  destroyed: SettledItem[];
  stats: RaidStats;
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
  sig: string;
}

/** Payload string that a JoinTicket signature covers. */
export function joinTicketPayload(t: Pick<JoinTicket, "userId" | "nickname" | "issuedAt" | "loadoutId">): string {
  return `${t.userId}.${t.nickname}.${t.issuedAt}.${t.loadoutId}`;
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
