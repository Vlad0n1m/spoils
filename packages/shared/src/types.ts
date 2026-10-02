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
import type { ContainerKind, LootTier, MapId } from "./map/types.js";

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
export interface RaidStartRequest {
  matchId: string;
  mode: RaidMode;
  mapId: MapId;
  matchSeed: number;
  /** loadoutId "" = free kit (no pool loot for that player). */
  players: Array<{ userId: string; loadoutId: string }>;
  /** Static containers eligible for pool items (MapData.containers index). */
  containers: Array<{ idx: number; kind: ContainerKind; tier: LootTier }>;
  /** Boss stashes spawned this match (cut 3 → 0). */
  bossSlots: number;
}

export interface RaidStartResponse {
  accepted: LoadoutSnapshot[];
  rejected: Array<{ userId: string; reason: "not_locked" | "wrong_user" | "expired" }>;
  /**
   * Lost-pool uniques allocated to containers, keyed by container index (decimal string in JSON);
   * key "boss" = the boss stash share. Fungibles are rolled by the server itself.
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
  /** null for bots. */
  userId: string | null;
  nickname: string;
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

/** S2C.SETTLED, broadcast at the end: scoreboard only (no user ids, no items). */
export interface MatchSummaryMsg {
  matchId: string;
  participants: Array<{ nickname: string; isBot: boolean; exitType: ExitType; kills: number }>;
}

/** S2C.INV_ERR, to one client. */
export interface InvErrMsg {
  code: InvErrCode;
  key?: string;
  /** Take-all: how many were taken before stopping. */
  taken?: number;
}
