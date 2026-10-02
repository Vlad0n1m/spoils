import { z } from "zod";
import {
  CONTAINER_KINDS,
  MAP_IDS,
  type ContainerKind,
  type GameServerBoot,
  type MapId,
  type MatchEndReport,
  type PlayerExitReport,
  type RaidStartRequest,
  type SettledItem,
} from "@extract/shared";

/**
 * Zod mirrors of the shared game-server → web payloads (types.ts). The bodies are HMAC-signed,
 * so these guard against version skew and bugs, not attackers: bounds are generous but finite.
 */

const uuid = z.string().uuid();
const mapId = z.enum(MAP_IDS as unknown as [MapId, ...MapId[]]);
const containerKind = z.enum(CONTAINER_KINDS as unknown as [ContainerKind, ...ContainerKind[]]);
const exitType = z.enum(["extract", "dead", "timeout"]);

export const settledItemSchema = z.object({
  uid: z.string().max(64),
  def: z.string().min(1).max(32),
  qty: z.number().int().min(1).max(10_000),
  rarity: z.number().int().min(0).max(3),
  dur: z.number().finite().min(0).max(10_000),
  label: z.string().max(64).optional(),
  lvl: z.number().int().min(0).max(1000).optional(),
  victim: z.string().max(64).optional(),
}) satisfies z.ZodType<SettledItem>;

export const raidStartRequestSchema = z.object({
  matchId: uuid,
  mode: z.enum(["live", "demo"]),
  mapId,
  matchSeed: z.number().int().min(0).max(0xffffffff),
  players: z
    .array(
      z.object({
        userId: z.string().min(1).max(64),
        /** "" = free kit. */
        loadoutId: z.union([z.literal(""), uuid]),
      }),
    )
    .max(64),
  containers: z
    .array(z.object({ idx: z.number().int().min(0).max(100_000), kind: containerKind, tier: z.number().int().min(0).max(4) }))
    .max(4096),
  bossSlots: z.number().int().min(0).max(8),
  instanceId: z.string().min(1).max(64).optional(),
  serverId: z.string().min(1).max(64).optional(),
}) as unknown as z.ZodType<RaidStartRequest>;

export const gameServerBootSchema = z.object({
  serverId: z.string().min(1).max(64),
  instanceId: z.string().min(1).max(64),
  bootedAt: z.number().finite().min(0),
}) satisfies z.ZodType<GameServerBoot>;

const statsSchema = z.object({
  shotsFired: z.number().int().min(0).default(0),
  dmgDealt: z.number().finite().min(0).default(0),
  containersSearched: z.number().int().min(0).default(0),
  corpsesSearched: z.number().int().min(0).default(0),
  bossKills: z.number().int().min(0).default(0),
});

export const playerExitReportSchema = z.object({
  matchId: uuid,
  /** Registered users and guests both have uuid ids; bots are never reported. */
  userId: uuid,
  exit: exitType,
  atMs: z.number().finite().min(0),
  kills: z.number().int().min(0).max(1000),
  level: z.number().int().min(0).max(1000),
  extracted: z.array(settledItemSchema).max(64),
  lost: z.array(settledItemSchema).max(64),
  destroyed: z.array(settledItemSchema).max(64),
  stats: statsSchema.default({}),
}) as unknown as z.ZodType<PlayerExitReport>;

export const matchEndReportSchema = z.object({
  matchId: uuid,
  mapId,
  matchSeed: z.number().int().min(0).max(0xffffffff),
  startedAt: z.number().finite(),
  endedAt: z.number().finite(),
  participants: z
    .array(
      z.object({
        userId: z.string().max(64).nullable(),
        nickname: z.string().max(64),
        isBot: z.boolean(),
        exitType,
        kills: z.number().int().min(0),
      }),
    )
    .max(64),
  leftOnMap: z.array(settledItemSchema).max(8192),
  minted: z.array(settledItemSchema).max(8192).default([]),
  botLost: z.array(settledItemSchema).max(8192).optional(),
  botDestroyed: z.array(settledItemSchema).max(8192).optional(),
}) as unknown as z.ZodType<MatchEndReport>;
