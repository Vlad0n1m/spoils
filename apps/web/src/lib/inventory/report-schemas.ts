import { z } from "zod";
import {
  ALPHA_LOOT,
  BOSS_KINDS,
  MAP_IDS,
  WORLD,
  type BossKind,
  type EntryRequest,
  type GameServerBoot,
  type MapId,
  type MatchEndReport,
  type PlayerExitReport,
  type SettledItem,
  type ShardOpenRequest,
  type WorldEventReport,
} from "@extract/shared";

/**
 * Zod mirrors of the shared game-server → web payloads (types.ts). The bodies are HMAC-signed,
 * so these guard against version skew and bugs, not attackers: bounds are generous but finite.
 */

const uuid = z.string().uuid();
const mapId = z.enum(MAP_IDS as unknown as [MapId, ...MapId[]]);
const exitType = z.enum(["extract", "dead", "timeout", "mia"]);
const bossKind = z.enum(BOSS_KINDS as unknown as [BossKind, ...BossKind[]]);
const npcCount = z.number().int().min(0).max(1000);
const npcCounts = z.object({ boss: npcCount, guard: npcCount, marauder: npcCount });

export const settledItemSchema = z.object({
  uid: z.string().max(64),
  def: z.string().min(1).max(32),
  qty: z.number().int().min(1).max(10_000),
  rarity: z.number().int().min(0).max(3),
  dur: z.number().finite().min(0).max(10_000),
  label: z.string().max(64).optional(),
  lvl: z.number().int().min(0).max(1000).optional(),
  victim: z.string().max(64).optional(),
  /** WORLD v6 (D22): dog tag killer userId. */
  by: z.string().max(64).optional(),
}) satisfies z.ZodType<SettledItem>;

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
  /** v5: marauders + guards killed (optional for older servers). */
  npcKills: z.number().int().min(0).max(1000).optional(),
  guardKills: z.number().int().min(0).max(1000).optional(),
  /** WORLD v6: containers searched inside an active hot zone (× HOT_ZONE_XP_MULT; optional for older servers). */
  hotContainers: z.number().int().min(0).max(1000).optional(),
  /** Objectives (rooms unlocked, safes cracked, caches opened; optional for older servers). */
  objectives: z.number().int().min(0).max(1000).optional(),
});

export const playerExitReportSchema = z.object({
  matchId: uuid,
  /** Registered users and guests both have uuid ids; NPCs are never reported. */
  userId: uuid,
  exit: exitType,
  atMs: z.number().finite().min(0),
  kills: z.number().int().min(0).max(1000),
  level: z.number().int().min(0).max(1000),
  extracted: z.array(settledItemSchema).max(64),
  lost: z.array(settledItemSchema).max(64),
  destroyed: z.array(settledItemSchema).max(64),
  stats: statsSchema.default({}),
  /** WORLD v6: this entry (world matches always set it; absent = a legacy roster match). */
  entryId: uuid.optional(),
  /** WORLD v6: cycle clock at admission. */
  enteredAtMs: z.number().finite().min(0).max(WORLD.CYCLE_MS).optional(),
  /** WORLD v6: userIds of the humans this entry killed (guests included; the web filters). */
  victims: z.array(z.string().max(64)).max(256).optional(),
  /** WORLD v6: this entry's pool items never placed → pool, untaxed. */
  unplaced: z.array(settledItemSchema).max(64).optional(),
  /** Alpha Pass: the entry joined on touch controls (the "phone" tester task). */
  touch: z.boolean().optional(),
  /** Boss fights: bosses this entry killed or helped kill (party) → bossTrophyId titles at settlement. */
  bossTrophies: z.array(bossKind).max(BOSS_KINDS.length).optional(),
  /** Death recap: who killed this entry (nickname / NPC role display key) and their NPC_ROLE. */
  killedBy: z.string().max(64).optional(),
  killedByRole: z.number().int().min(0).max(3).optional(),
  /** ALPHA LOOT: extracted uids the server minted this match (applyExit creates their item rows). */
  alphaFound: z.array(uuid).max(ALPHA_LOOT.MAX_PER_EXIT).optional(),
}) as unknown as z.ZodType<PlayerExitReport>;

export const matchEndReportSchema = z.object({
  matchId: uuid,
  mapId,
  matchSeed: z.number().int().min(0).max(0xffffffff),
  startedAt: z.number().finite(),
  endedAt: z.number().finite(),
  /** v5: humans only (WORLD v6: one row per entry). Pre-v5 servers may still list bots: applyEnd drops them. */
  participants: z
    .array(
      z.object({
        userId: z.string().max(64).nullable(),
        nickname: z.string().max(64),
        /** v5: always false (humans only); absent = false. */
        isBot: z.boolean().default(false),
        exitType,
        kills: z.number().int().min(0),
      }),
    )
    .max(2048),
  leftOnMap: z.array(settledItemSchema).max(8192),
  minted: z.array(settledItemSchema).max(8192).default([]),
  npcSummary: z
    .object({
      spawned: npcCounts,
      killedByHumans: npcCounts,
    })
    .optional(),
  /** @deprecated pre-v5 servers only (player-bots); parsed for one release, never produced by v5. */
  botLost: z.array(settledItemSchema).max(8192).optional(),
  /** @deprecated pre-v5 servers only; see botLost. */
  botDestroyed: z.array(settledItemSchema).max(8192).optional(),
  /** WORLD v6: the shard's cycle and index. */
  cycleId: z.number().int().min(0).optional(),
  shard: z.number().int().min(0).max(64).optional(),
  /** WORLD v6: every materialized entryId (unlisted active entries are voided). */
  entries: z.array(uuid).max(4096).optional(),
  /** WORLD v6 (A6): expired player corpse / ground uniques → treasury. */
  expired: z.array(settledItemSchema).max(8192).optional(),
  /** WORLD v6 (A6): expired NPC-corpse pool items → pool, untaxed. */
  expiredToPool: z.array(settledItemSchema).max(8192).optional(),
}) as unknown as z.ZodType<MatchEndReport>;

// ---------------------------------------------------------------- WORLD v6 (strict: unknown keys are refused)

const worldBossRef = z.object({ kind: bossKind, zone: z.string().min(1).max(64) }).strict();
const wallMs = z.number().int().min(0).max(8.64e15);
const serverIdSchema = z.string().min(1).max(64);

export const shardOpenRequestSchema = z
  .object({
    matchId: uuid,
    cycleId: z.number().int().min(0).max(0x7fffffff),
    shard: z.number().int().min(0).max(64),
    roomId: z.string().min(1).max(64),
    mode: z.enum(["live", "demo"]),
    mapId,
    matchSeed: z.number().int().min(0).max(0xffffffff),
    startsAt: wallMs,
    entryClosesAt: wallMs,
    endsAt: wallMs,
    boss: worldBossRef.nullable(),
    nextBoss: worldBossRef.nullable(),
    serverId: serverIdSchema,
    instanceId: serverIdSchema,
  })
  .strict() satisfies z.ZodType<ShardOpenRequest>;

export const entryRequestSchema = z
  .object({
    matchId: uuid,
    entryId: uuid,
    /** Registered users and guests both have uuid ids. */
    userId: uuid,
    /** "" = free kit. */
    loadoutId: z.union([z.literal(""), uuid]),
    atMs: z.number().finite().min(0).max(WORLD.CYCLE_MS),
    targets: z.number().int().min(0).max(100_000),
    bossAlive: z.boolean(),
  })
  .strict() satisfies z.ZodType<EntryRequest>;

export const worldEventReportSchema = z
  .object({
    matchId: uuid,
    cycleId: z.number().int().min(0).max(0x7fffffff),
    kind: z.literal("boss_killed"),
    boss: bossKind,
    by: z.string().max(64),
    byUserId: uuid.optional(),
    atMs: z.number().finite().min(0).max(WORLD.CYCLE_MS),
  })
  .strict() satisfies z.ZodType<WorldEventReport>;
