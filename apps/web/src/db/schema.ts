import { sql } from "drizzle-orm";
import type {
  BossKind,
  EntryResponse,
  ExitType,
  JunkSellLine,
  LoadoutEntry,
  LoadoutSnapshot,
  MatchEndParticipant,
  MatchEndReport,
  PlayerExitReport,
  SettledItem,
  XpLine,
} from "@extract/shared";
import {
  pgTable,
  uuid,
  text,
  bigint,
  bigserial,
  timestamp,
  integer,
  smallint,
  boolean,
  doublePrecision,
  jsonb,
  date,
  pgEnum,
  uniqueIndex,
  index,
  primaryKey,
  check,
  customType,
} from "drizzle-orm/pg-core";

export const depositStatusEnum = pgEnum("deposit_status", [
  "pending",
  "confirmed",
  "swept",
  "failed",
]);

export const withdrawalStatusEnum = pgEnum("withdrawal_status", [
  "pending",
  "submitted",
  "confirmed",
  "failed",
]);

export const matchStatusEnum = pgEnum("match_status", [
  "lobby",
  "running",
  "settled",
]);

/** Legacy match_participants only (unused); raid_exits.exit is text and also holds "mia". */
export const exitTypeEnum = pgEnum("exit_type", [
  "extract",
  "dead",
  "timeout",
]);

export const users = pgTable(
  "users",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    email: text("email").notNull(),
    passwordHash: text("password_hash").notNull(),
    nickname: text("nickname").notNull(),
    /** Custodial market money (minor units). Market prices, fees and trades use the same unit. */
    balanceCents: bigint("balance_cents", { mode: "bigint" })
      .notNull()
      .default(sql`0`),
    depositAddress: text("deposit_address").notNull(),
    /**
     * Soft currency (CR): never converts to money. Every change after the 1000 start balance goes
     * through credit_ledger, so credits = 1000 + Σ ledger.delta (audit invariant).
     */
    credits: bigint("credits", { mode: "number" }).notNull().default(1000),
    xp: integer("xp").notNull().default(0),
    level: integer("level").notNull().default(1),
    /** Raids with a settled exit report (registered users only). */
    matchesPlayed: integer("matches_played").notNull().default(0),
    /** Set once by claimStarter: the giveaway kit is one per account. */
    starterClaimedAt: timestamp("starter_claimed_at", { withTimezone: true }),
    /**
     * Self-custody Solana wallet the player proved they own (Sign-In with Solana, lib/wallet/link.ts).
     * Identity only: nothing is ever sent to or signed by it. Unrelated to depositAddress (custodial).
     */
    walletPubkey: text("wallet_pubkey"),
    walletLinkedAt: timestamp("wallet_linked_at", { withTimezone: true }),
    /**
     * Staff role (lib/admin/guard.ts, migration 006): 'admin' opens /admin and /api/admin/**; NULL for
     * everyone else. Granted by hand with SQL (README "Админка"), never from the app.
     */
    role: text("role").$type<"admin">(),
    /**
     * Equipped earn-only cosmetics (lib/quests, migration 008): ids from @extract/shared COSMETICS,
     * NULL = none. Set only through POST /api/quests/equip, which checks cosmeticUnlocked.
     */
    title: text("title"),
    nameColor: text("name_color"),
    badgeFrame: text("badge_frame"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => ({
    emailIdx: uniqueIndex("users_email_idx").on(t.email),
    nickIdx: uniqueIndex("users_nickname_idx").on(t.nickname),
    /** Case-insensitive nickname lookup (lib/social/common.ts findUserByNickname; migration 010). */
    nickLowerIdx: index("users_nickname_lower_idx").on(sql`lower(${t.nickname})`),
    depositIdx: uniqueIndex("users_deposit_idx").on(t.depositAddress),
    /** One account per wallet (NULLs do not collide). */
    walletIdx: uniqueIndex("users_wallet_pubkey_idx").on(t.walletPubkey),
    /** WORLD v6 level board (xp desc). */
    xpIdx: index("users_xp_idx").on(t.xp.desc().nullsFirst()),
    creditsNonNeg: check("users_credits_non_negative", sql`${t.credits} >= 0`),
    /** A typo in the grant SQL ('Admin') fails loudly instead of silently granting nothing. */
    roleKnown: check("users_role_known", sql`${t.role} is null or ${t.role} = 'admin'`),
  }),
);

export const deposits = pgTable(
  "deposits",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    signature: text("signature").notNull(),
    amountCents: bigint("amount_cents", { mode: "bigint" }).notNull(),
    status: depositStatusEnum("status").notNull().default("pending"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    sweptAt: timestamp("swept_at", { withTimezone: true }),
  },
  (t) => ({
    sigIdx: uniqueIndex("deposits_sig_idx").on(t.signature),
    userIdx: index("deposits_user_idx").on(t.userId),
  }),
);

export const withdrawals = pgTable(
  "withdrawals",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    destination: text("destination").notNull(),
    amountCents: bigint("amount_cents", { mode: "bigint" }).notNull(),
    signature: text("signature"),
    status: withdrawalStatusEnum("status").notNull().default("pending"),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
  },
  (t) => ({
    userIdx: index("withdrawals_user_idx").on(t.userId),
  }),
);

/**
 * Sign-In with Solana challenges for linking users.wallet_pubkey (lib/wallet/link.ts): issued to one
 * signed-in user, valid 10 minutes, single use (used_at is set by the first verify attempt that
 * carries it, whatever its outcome). Rows an hour past expiry are pruned when new ones are issued.
 */
export const walletLinkNonces = pgTable(
  "wallet_link_nonces",
  {
    nonce: text("nonce").primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** SIWS domain (request Host) and URI (origin) the message must carry. */
    domain: text("domain").notNull(),
    uri: text("uri").notNull(),
    /** SIWS Chain ID: devnet | testnet | mainnet. */
    chainId: text("chain_id").notNull(),
    issuedAt: timestamp("issued_at", { withTimezone: true }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
  },
  (t) => ({
    userIdx: index("wallet_link_nonces_user_idx").on(t.userId),
    expiresIdx: index("wallet_link_nonces_expires_idx").on(t.expiresAt),
  }),
);

/*
 * `matches`, `match_instant_payouts` and `match_participants` belong to the old buy-in money flow.
 * Nothing writes them any more; they stay declared so `db:push` does not drop existing data.
 */
export const matches = pgTable("matches", {
  id: uuid("id").defaultRandom().primaryKey(),
  entryTierCents: bigint("entry_tier_cents", { mode: "bigint" }).notNull(),
  status: matchStatusEnum("status").notNull().default("lobby"),
  startedAt: timestamp("started_at", { withTimezone: true }),
  endedAt: timestamp("ended_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

export const matchInstantPayouts = pgTable(
  "match_instant_payouts",
  {
    matchId: uuid("match_id").notNull(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    payoutCents: bigint("payout_cents", { mode: "bigint" }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.matchId, t.userId] }),
  }),
);

export const matchParticipants = pgTable(
  "match_participants",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    matchId: uuid("match_id")
      .notNull()
      .references(() => matches.id, { onDelete: "cascade" }),
    userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
    isBot: boolean("is_bot").notNull().default(false),
    nickname: text("nickname").notNull(),
    entryCents: bigint("entry_cents", { mode: "bigint" }).notNull(),
    payoutCents: bigint("payout_cents", { mode: "bigint" })
      .notNull()
      .default(sql`0`),
    deltaCents: bigint("delta_cents", { mode: "bigint" })
      .notNull()
      .default(sql`0`),
    exitType: exitTypeEnum("exit_type").notNull(),
    exitOrder: integer("exit_order"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => ({
    matchIdx: index("mp_match_idx").on(t.matchId),
    userIdx: index("mp_user_idx").on(t.userId),
  }),
);

/**
 * Stored end report: MatchEndReport plus, per human, what their exit report extracted (the lobby
 * "recent raids" board reads `participants[].extracted`).
 */
export interface MatchResultPayload extends Omit<MatchEndReport, "participants"> {
  participants: Array<MatchEndParticipant & { extracted?: SettledItem[] }>;
}

/** One row per finished raid, written by applyEnd (POST /api/raids/end). */
export const matchResults = pgTable(
  "match_results",
  {
    matchId: uuid("match_id").primaryKey(),
    /** uint32 seed does not fit a signed int4. */
    mapSeed: bigint("map_seed", { mode: "number" }).notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    endedAt: timestamp("ended_at", { withTimezone: true }).notNull(),
    payload: jsonb("payload").$type<MatchResultPayload>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => ({
    endedIdx: index("match_results_ended_idx").on(t.endedAt),
  }),
);

// ============================================================================ items economy v2
//
// Item lifecycle (critique "Settlement and loadout flow", inventory memo §4.1):
//   in_stash → listed → in_stash            (market list / cancel)
//   in_stash → in_raid                      (loadout lock; match_id set by raids/enter)
//   in_raid  → in_stash                     (extract: owner = extractor | unlock / void: owner kept)
//   in_raid  → lost_pool                    (broke on death −8 dur, timeout, left on map, guest extract)
//   in_raid  → destroyed                    (durability 0, or a bound item that would enter the pool)
//   lost_pool → in_raid                     (raids/enter pool release / boss bag, owner NULL)
//   lost_pool → treasury                    (1% treasury tax)
// Every transition is a guarded UPDATE (WHERE state = expected …) plus an item_events row that is
// UNIQUE(item_id, reason, ref_id), so a replayed report can never apply twice.

export const itemStateEnum = pgEnum("item_state", [
  "in_stash",
  "listed",
  "in_raid",
  "lost_pool",
  "treasury",
  "destroyed",
]);

export const itemOriginEnum = pgEnum("item_origin", [
  "giveaway",
  "seed",
  "primary_sale",
  "trader",
]);

export const loadoutStatusEnum = pgEnum("loadout_status", [
  "locked",
  "in_raid",
  "settled",
  "cancelled",
  "voided",
]);

export const raidStatusEnum = pgEnum("raid_status", ["running", "settled", "voided"]);

export const listingStatusEnum = pgEnum("listing_status", [
  "pending",
  "active",
  "sold",
  "cancelled",
  "expired",
]);

export type ItemState = (typeof itemStateEnum.enumValues)[number];
export type ItemOrigin = (typeof itemOriginEnum.enumValues)[number];
export type LoadoutStatus = (typeof loadoutStatusEnum.enumValues)[number];
export type RaidStatus = (typeof raidStatusEnum.enumValues)[number];
export type ListingStatus = (typeof listingStatusEnum.enumValues)[number];

/** Unique items (weapons, armor, backpacks). Fungibles (ammo, meds) live in stash_stacks; junk is never stored. */
export const items = pgTable(
  "items",
  {
    /** = SettledItem.uid / InvItem.uid in a raid. */
    id: uuid("id").defaultRandom().primaryKey(),
    defId: text("def_id").notNull(),
    rarity: smallint("rarity").notNull().default(0),
    /** 0..100 %. Armor absorb points in a raid are converted with armorPoints / armorPct. */
    durability: doublePrecision("durability").notNull().default(100),
    /** Starts at 100 and only goes down (repairs, cut for v2). */
    maxDurability: doublePrecision("max_durability").notNull().default(100),
    state: itemStateEnum("state").notNull(),
    /** Pre-raid owner while in_raid (void restores it); NULL in lost_pool / treasury / pool allocations. */
    ownerId: uuid("owner_id").references(() => users.id, { onDelete: "set null" }),
    matchId: uuid("match_id"),
    /** Set while the item sits in a locked / in-raid loadout. */
    loadoutId: uuid("loadout_id"),
    origin: itemOriginEnum("origin").notNull(),
    /** Trader item bought for CR: never tradable, never enters the lost pool. */
    bound: boolean("bound").notNull().default(false),
    /** Giveaway lock: raids the item must still be extracted in (by anyone) before it can be listed. */
    lockRaids: smallint("lock_raids").notNull().default(0),
    version: integer("version").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    ownerState: index("items_owner_state_idx").on(t.ownerId, t.state),
    match: index("items_match_idx").on(t.matchId),
    loadout: index("items_loadout_idx").on(t.loadoutId),
    pool: index("items_state_def_idx").on(t.state, t.defId, t.rarity),
    /** Tradable giveaway kits issued (lib/inventory/starter.ts tradableKitsIssued; migration 010). */
    giveawayTradable: index("items_giveaway_tradable_idx")
      .on(t.id)
      .where(sql`origin = 'giveaway' and bound = false`),
    durRange: check(
      "items_durability_range",
      sql`${t.durability} >= 0 and ${t.durability} <= ${t.maxDurability} and ${t.maxDurability} <= 100`,
    ),
    lockNonNeg: check("items_lock_raids_non_negative", sql`${t.lockRaids} >= 0`),
  }),
);

/** Audit journal of every item transition; the unique key makes each transition idempotent. */
export const itemEvents = pgTable(
  "item_events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    itemId: uuid("item_id").notNull(),
    fromState: itemStateEnum("from_state"),
    toState: itemStateEnum("to_state").notNull(),
    fromOwner: uuid("from_owner"),
    toOwner: uuid("to_owner"),
    matchId: uuid("match_id"),
    /** grant|seed|lock|unlock|expire|start|alloc|extract|break|timeout|left|destroy|sweep|void|tax|list|delist|buy */
    reason: text("reason").notNull(),
    /** loadoutId | matchId | listingId … — with reason it makes the transition idempotent. */
    refId: text("ref_id").notNull(),
    /** Durability after the transition (pool entry wear, extract). */
    durability: doublePrecision("durability"),
    at: timestamp("at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    once: uniqueIndex("item_events_once").on(t.itemId, t.reason, t.refId),
    item: index("item_events_item_idx").on(t.itemId, t.at),
    /** Pool allocations of a match / an entry (raids.ts poolAllocatedIds, voidEntryTx; migration 010). */
    match: index("item_events_match_idx")
      .on(t.matchId, t.reason)
      .where(sql`match_id is not null`),
  }),
);

/** Fungible stash: ammo and meds by def. Junk is auto-sold at extraction and never stored. */
export const stashStacks = pgTable(
  "stash_stacks",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    defId: text("def_id").notNull(),
    qty: integer("qty").notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.userId, t.defId] }),
    qtyNonNeg: check("stash_stacks_qty_non_negative", sql`${t.qty} >= 0`),
  }),
);

/** Locked loadout entry: SettledItem with its slot; DB durability % (converted to armor points at raids/enter). */
export type LoadoutRowEntry = LoadoutSnapshot["entries"][number];

export const loadouts = pgTable(
  "loadouts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    status: loadoutStatusEnum("status").notNull(),
    entries: jsonb("entries").$type<LoadoutRowEntry[]>().notNull(),
    matchId: uuid("match_id"),
    lockedAt: timestamp("locked_at", { withTimezone: true }).defaultNow().notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    closedAt: timestamp("closed_at", { withTimezone: true }),
  },
  (t) => ({
    /** One active loadout per user: a second lock (two tabs) fails on this index. */
    oneActive: uniqueIndex("loadouts_one_active")
      .on(t.userId)
      .where(sql`status in ('locked', 'in_raid')`),
    match: index("loadouts_match_idx").on(t.matchId),
  }),
);

/** Loadout page autosave (not validated until lock). */
export const loadoutDrafts = pgTable("loadout_drafts", {
  userId: uuid("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  entries: jsonb("entries").$type<LoadoutEntry[]>().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

/** Body of the removed pre-v6 POST /api/raids/start, kept only to type old rows' `start_request`. */
export type LegacyStartRequest = { serverId?: string; instanceId?: string } & Record<string, unknown>;

/**
 * One row per raid: WORLD v6 shard-cycles (kind 'world', POST /api/raids/open by the game server's
 * WorldDirectory) and old rows of legacy roster matches (kind 'match'; also rows created lazily by an
 * end report whose raids/open never arrived). `ends_at` (= the wipe for world rows) drives the voids
 * (spec §4.5).
 */
export const raids = pgTable(
  "raids",
  {
    matchId: uuid("match_id").primaryKey(),
    mode: text("mode").$type<"live" | "demo">().notNull(),
    mapId: text("map_id").notNull(),
    matchSeed: bigint("match_seed", { mode: "number" }).notNull(),
    status: raidStatusEnum("status").notNull().default("running"),
    /** false when the row was created lazily by an end report (raids/open never reached us). */
    started: boolean("started").notNull().default(true),
    /** Legacy (pre-v6) raids/start body; the voids still read its serverId / instanceId for old rows. */
    startRequest: jsonb("start_request").$type<LegacyStartRequest>(),
    /** Legacy (pre-v6) raids/start response; no longer written. */
    startResponse: jsonb("start_response").$type<Record<string, unknown>>(),
    riskUnits: integer("risk_units").notNull().default(0),
    poolReleased: integer("pool_released").notNull().default(0),
    startedAt: timestamp("started_at", { withTimezone: true }).defaultNow().notNull(),
    settledAt: timestamp("settled_at", { withTimezone: true }),
    /** 'match' (legacy roster raid) | 'world' (WORLD v6 shard-cycle). */
    kind: text("kind").$type<"match" | "world">().notNull().default("match"),
    /** worldCycleOf cycle (world rows). */
    cycleId: integer("cycle_id"),
    shard: smallint("shard").notNull().default(0),
    /** Colyseus room id of the shard (the lobby's joinById target). */
    roomId: text("room_id"),
    /** GameServerBoot.serverId / instanceId of the process running the shard (void-orphans). */
    serverId: text("server_id"),
    instanceId: text("instance_id"),
    entryClosesAt: timestamp("entry_closes_at", { withTimezone: true }),
    /** Wipe (world) / started_at + MATCH.DURATION_MS (legacy): the void clocks run from here. */
    endsAt: timestamp("ends_at", { withTimezone: true }).notNull(),
    bossKind: text("boss_kind").$type<BossKind>(),
    /** MapData zone id of the event boss's spot. */
    bossZone: text("boss_zone"),
    nextBossKind: text("next_boss_kind").$type<BossKind>(),
    nextBossZone: text("next_boss_zone"),
    /** Killer nickname (POST /api/world/event). */
    bossKilledBy: text("boss_killed_by"),
    bossKilledAt: timestamp("boss_killed_at", { withTimezone: true }),
    /** The boss bag (D19) was filled for this shard-cycle. */
    bossBagFilled: boolean("boss_bag_filled").notNull().default(false),
  },
  (t) => ({
    statusStarted: index("raids_status_started_idx").on(t.status, t.startedAt),
    worldCycle: index("raids_world_cycle_idx").on(t.kind, t.cycleId),
    statusEnds: index("raids_status_ends_idx").on(t.status, t.endsAt),
  }),
);

/**
 * Applied PlayerExitReport, one per entry (WORLD v6: entry_id is the idempotency guard; a report
 * without entryId is refused as unknown_entry). Old pre-v6 rows got a generated entry_id.
 */
export const raidExits = pgTable(
  "raid_exits",
  {
    entryId: uuid("entry_id").defaultRandom().primaryKey(),
    matchId: uuid("match_id").notNull(),
    /** Not a FK: guests have no users row but still report. */
    userId: uuid("user_id").notNull(),
    exit: text("exit").$type<ExitType>().notNull(),
    report: jsonb("report").$type<PlayerExitReport>().notNull(),
    /** CR actually credited (0 for guests). */
    credits: bigint("credits", { mode: "number" }).notNull().default(0),
    /** Autosell receipt at the applied multiplier (guests: what it would have paid). */
    sold: jsonb("sold").$type<JunkSellLine[]>().notNull().default(sql`'[]'::jsonb`),
    xp: integer("xp").notNull().default(0),
    guest: boolean("guest").notNull().default(false),
    at: timestamp("at", { withTimezone: true }).defaultNow().notNull(),
    cycleId: integer("cycle_id"),
    /** xpForExit lines (receipt / last-raid card). */
    xpLines: jsonb("xp_lines").$type<XpLine[]>().notNull().default(sql`'[]'::jsonb`),
    /** The grind part of xp (counts toward XP.DAILY_SOFT_CAP of later exits that day). */
    xpGrind: integer("xp_grind").notNull().default(0),
    onMapMs: integer("on_map_ms").notNull().default(0),
    /** npcKillCount (marauders + guards) and boss kills of this exit (NPC board). */
    npcKills: integer("npc_kills").notNull().default(0),
    bossKills: integer("boss_kills").notNull().default(0),
    /** Ranked PvP kills of this exit (D24). */
    pvpRanked: integer("pvp_ranked").notNull().default(0),
  },
  (t) => ({
    user: index("raid_exits_user_idx").on(t.userId, t.at),
    matchUser: index("raid_exits_match_user_idx").on(t.matchId, t.userId),
    cycle: index("raid_exits_cycle_idx").on(t.cycleId),
    /**
     * Time ranges answered from the index alone (migration 010, replaces raid_exits_at_idx): the NPC
     * leaderboard and its /me rank (lib/world/leaderboards.ts), /economy raids 24 h, admin exits and
     * active players. The heap rows carry the jsonb report and are an order of magnitude wider.
     */
    atCover: index("raid_exits_at_cover_idx").on(t.at, t.userId, t.guest, t.exit, t.credits, t.npcKills, t.bossKills),
  }),
);

export type RaidEntryStatus = "active" | "exited" | "voided";

/**
 * WORLD v6 entry: one stay of one user on a shard (minted by /api/world/join, admitted by
 * POST /api/raids/enter, idempotent per entry_id with the stored response replayed). One active
 * entry per user (partial unique index).
 */
export const raidEntries = pgTable(
  "raid_entries",
  {
    entryId: uuid("entry_id").primaryKey(),
    matchId: uuid("match_id").notNull(),
    cycleId: integer("cycle_id").notNull(),
    /** Not a FK: guests. */
    userId: uuid("user_id").notNull(),
    loadoutId: uuid("loadout_id"),
    guest: boolean("guest").notNull().default(false),
    freeKit: boolean("free_kit").notNull().default(true),
    status: text("status").$type<RaidEntryStatus>().notNull().default("active"),
    riskUnits: smallint("risk_units").notNull().default(0),
    /** Max uniqueTierScore among this entry's risk items. */
    maxTier: smallint("max_tier").notNull().default(0),
    /** Lost-pool items released for this entry (boss fill not counted). */
    released: smallint("released").notNull().default(0),
    /** Cycle clock at admission. */
    atMs: integer("at_ms").notNull().default(0),
    response: jsonb("response").$type<EntryResponse>(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    settledAt: timestamp("settled_at", { withTimezone: true }),
  },
  (t) => ({
    oneActive: uniqueIndex("raid_entries_one_active").on(t.userId).where(sql`status = 'active'`),
    match: index("raid_entries_match_idx").on(t.matchId, t.status),
    cycleUser: index("raid_entries_cycle_user_idx").on(t.cycleId, t.userId),
    userDay: index("raid_entries_user_day_idx").on(t.userId, t.createdAt),
  }),
);

/** WORLD v6: one row per human kill by a registered user (D24 ranked rule; Kills board). */
export const pvpKills = pgTable(
  "pvp_kills",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    killerId: uuid("killer_id").notNull(),
    victimId: uuid("victim_id").notNull(),
    matchId: uuid("match_id").notNull(),
    entryId: uuid("entry_id").notNull(),
    cycleId: integer("cycle_id"),
    ranked: boolean("ranked").notNull(),
    at: timestamp("at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    pair: index("pvp_kills_pair_idx").on(t.killerId, t.victimId, t.at),
    board: index("pvp_kills_board_idx").on(t.ranked, t.at),
    cycle: index("pvp_kills_cycle_idx").on(t.cycleId),
  }),
);

/** Every CR change. UNIQUE(user, reason, ref) makes each credit idempotent. */
export const creditLedger = pgTable(
  "credit_ledger",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    delta: bigint("delta", { mode: "number" }).notNull(),
    /** autosell | giveaway | consumables | listing_fee | admin … */
    reason: text("reason").notNull(),
    refId: text("ref_id").notNull(),
    balanceAfter: bigint("balance_after", { mode: "number" }).notNull(),
    at: timestamp("at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    once: uniqueIndex("credit_ledger_once").on(t.userId, t.reason, t.refId),
    userAt: index("credit_ledger_user_at_idx").on(t.userId, t.at),
    reasonAt: index("credit_ledger_reason_at_idx").on(t.reason, t.at),
  }),
);

/**
 * Dog tags brought out, for the 24 h pair-repeat rule (same extractor + same victim: only the
 * first DOG_TAG.REPEAT_FREE are paid). victim_key = victim userId, or "nick:<label>" for guests.
 */
export const dogTagPayouts = pgTable(
  "dog_tag_payouts",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    extractorId: uuid("extractor_id").notNull(),
    victimKey: text("victim_key").notNull(),
    matchId: uuid("match_id").notNull(),
    paid: boolean("paid").notNull(),
    cr: integer("cr").notNull(),
    at: timestamp("at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    pair: index("dog_tag_payouts_pair_idx").on(t.extractorId, t.victimKey, t.at),
  }),
);

/** Tunable economy state: autosell_mult (number), tax_acc (number), seeded_at … */
export const economyParams = pgTable("economy_params", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

/** Daily KPI snapshot for /economy (economy memo §12). */
export const economyDaily = pgTable("economy_daily", {
  day: date("day").primaryKey(),
  data: jsonb("data").$type<Record<string, unknown>>().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

// ---------------------------------------------------------------------------- market (WP-W2)

/** Fixed-price listing. seller_id NULL = treasury / NPC lot. Prices in balance_cents minor units. */
export const listings = pgTable(
  "listings",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    itemId: uuid("item_id")
      .notNull()
      .references(() => items.id),
    sellerId: uuid("seller_id").references(() => users.id, { onDelete: "set null" }),
    /** templateKey(item) at listing time (index / filters). */
    template: text("template").notNull(),
    priceMinor: bigint("price_minor", { mode: "bigint" }).notNull(),
    /** CR listing fee paid (not refunded). */
    feeCr: integer("fee_cr").notNull().default(0),
    status: listingStatusEnum("status").notNull(),
    visibleAt: timestamp("visible_at", { withTimezone: true }).defaultNow().notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    closedAt: timestamp("closed_at", { withTimezone: true }),
  },
  (t) => ({
    /** An item can be in at most one open listing. */
    oneOpen: uniqueIndex("listings_one_open_item")
      .on(t.itemId)
      .where(sql`status in ('pending', 'active')`),
    browse: index("listings_status_template_price_idx").on(t.status, t.template, t.priceMinor),
    seller: index("listings_seller_status_idx").on(t.sellerId, t.status),
    pricePos: check("listings_price_positive", sql`${t.priceMinor} > 0`),
  }),
);

export const trades = pgTable(
  "trades",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    listingId: uuid("listing_id")
      .notNull()
      .references(() => listings.id),
    itemId: uuid("item_id").notNull(),
    template: text("template").notNull(),
    rarity: smallint("rarity").notNull(),
    durability: doublePrecision("durability").notNull(),
    sellerId: uuid("seller_id"),
    buyerId: uuid("buyer_id").notNull(),
    priceMinor: bigint("price_minor", { mode: "bigint" }).notNull(),
    feeMinor: bigint("fee_minor", { mode: "bigint" }).notNull(),
    /** False for trades excluded from the price index (pair repeats, low dur, linked accounts). */
    countedForIndex: boolean("counted_for_index").notNull().default(true),
    at: timestamp("at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    oneTradePerListing: uniqueIndex("trades_listing_once").on(t.listingId),
    templateAt: index("trades_template_at_idx").on(t.template, t.at),
    buyerAt: index("trades_buyer_at_idx").on(t.buyerId, t.at),
    /** Latest trades of every template (lib/market/market.ts marketHistory; migration 010). */
    at: index("trades_at_idx").on(t.at),
  }),
);

/**
 * Market money journal (balance_cents unit). account = user uuid or "house" (fees, treasury
 * sales). UNIQUE(account, reason, ref) makes each money move idempotent.
 */
export const moneyLedger = pgTable(
  "money_ledger",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    account: text("account").notNull(),
    deltaMinor: bigint("delta_minor", { mode: "bigint" }).notNull(),
    /** buy | sale | fee | treasury_sale | topup | withdraw … */
    reason: text("reason").notNull(),
    refId: text("ref_id").notNull(),
    at: timestamp("at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    once: uniqueIndex("money_ledger_once").on(t.account, t.reason, t.refId),
    accountAt: index("money_ledger_account_at_idx").on(t.account, t.at),
  }),
);

// ---------------------------------------------------------------------------- on-chain events

/**
 * Outbox of game results for the spoils_events program on Solana (lib/chain, README "On-chain").
 * Settlement enqueues a row in its own transaction (a savepoint: a failure here never breaks the
 * game flow); the cron worker /api/cron/chain-events sends due rows signed by the server authority.
 * kind: match | boss_kill | rare_extract. status: queued → sent, or failed after repeated program
 * rejections (transport errors keep a row queued). tx_sig / tx_valid_until: the last signed
 * transaction and the last block height its blockhash is valid for, so a retry first checks whether
 * that transaction landed instead of recording the event twice. payload holds internal ids; only
 * hashes of them go on chain.
 */
export const chainEvents = pgTable(
  "chain_events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    kind: text("kind").$type<"match" | "boss_kill" | "rare_extract">().notNull(),
    /** match:<matchId> | boss:<matchId> | rare:<entryId>:<itemId or def>. */
    dedupeKey: text("dedupe_key").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    status: text("status").$type<"queued" | "sent" | "failed">().notNull().default("queued"),
    attempts: integer("attempts").notNull().default(0),
    /** Program rejections only (queue.ts MAX_REJECTED_ATTEMPTS); attempts counts every claim. */
    rejections: integer("rejections").notNull().default(0),
    nextAt: timestamp("next_at", { withTimezone: true }).defaultNow().notNull(),
    txSig: text("tx_sig"),
    txValidUntil: bigint("tx_valid_until", { mode: "number" }),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    sentAt: timestamp("sent_at", { withTimezone: true }),
  },
  (t) => ({
    dedupe: uniqueIndex("chain_events_dedupe_idx").on(t.dedupeKey),
    due: index("chain_events_status_next_idx").on(t.status, t.nextAt),
    sent: index("chain_events_sent_at_idx").on(t.sentAt),
  }),
);

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type Match = typeof matches.$inferSelect;
export type MatchParticipant = typeof matchParticipants.$inferSelect;
export type Deposit = typeof deposits.$inferSelect;
export type Withdrawal = typeof withdrawals.$inferSelect;
export type MatchResult = typeof matchResults.$inferSelect;
export type Item = typeof items.$inferSelect;
export type NewItem = typeof items.$inferInsert;
export type ItemEvent = typeof itemEvents.$inferSelect;
export type Loadout = typeof loadouts.$inferSelect;
export type Raid = typeof raids.$inferSelect;
export type RaidExit = typeof raidExits.$inferSelect;
export type RaidEntry = typeof raidEntries.$inferSelect;
export type PvpKill = typeof pvpKills.$inferSelect;
export type CreditLedgerRow = typeof creditLedger.$inferSelect;
export type Listing = typeof listings.$inferSelect;
export type Trade = typeof trades.$inferSelect;
export type WalletLinkNonce = typeof walletLinkNonces.$inferSelect;
export type ChainEventRow = typeof chainEvents.$inferSelect;

// ---------------------------------------------------------------------------- friends and parties

/**
 * Friend pairs (lib/social/friends.ts, migration 005). One row per unordered pair: user_lo < user_hi,
 * so a pair cannot exist twice in either order. `pending` (requested_by sent it) → `accepted`; a
 * declined or cancelled request and a removed friend delete the row. Registered users only.
 */
export const friendships = pgTable(
  "friendships",
  {
    userLo: uuid("user_lo")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    userHi: uuid("user_hi")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    requestedBy: uuid("requested_by").notNull(),
    status: text("status").$type<"pending" | "accepted">().notNull().default("pending"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.userLo, t.userHi] }),
    hi: index("friendships_user_hi_idx").on(t.userHi),
    ordered: check("friendships_ordered_pair", sql`${t.userLo} < ${t.userHi}`),
    requester: check("friendships_requester_in_pair", sql`${t.requestedBy} = ${t.userLo} or ${t.requestedBy} = ${t.userHi}`),
    status: check("friendships_status", sql`${t.status} in ('pending', 'accepted')`),
  }),
);

/** Menu presence: the last social poll (GET /api/party, /api/friends), written at most every 20 s. */
export const userPresence = pgTable("user_presence", {
  userId: uuid("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  seenAt: timestamp("seen_at", { withTimezone: true }).notNull(),
});

/** A party of 2–4 (lib/social/party.ts). The leader is always one of its members. */
export const parties = pgTable("parties", {
  id: uuid("id").defaultRandom().primaryKey(),
  leaderId: uuid("leader_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

/** Party membership; the primary key on user_id is the one-party-per-user rule. */
export const partyMembers = pgTable(
  "party_members",
  {
    userId: uuid("user_id")
      .primaryKey()
      .references(() => users.id, { onDelete: "cascade" }),
    partyId: uuid("party_id")
      .notNull()
      .references(() => parties.id, { onDelete: "cascade" }),
    /** "Follow leader": the menu drops in on its own when the leader does (shown as ready). */
    follow: boolean("follow").notNull().default(false),
    joinedAt: timestamp("joined_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    party: index("party_members_party_idx").on(t.partyId),
  }),
);

/** Pending party invites (accept / decline / cancel / kick delete them); dead after expires_at. */
export const partyInvites = pgTable(
  "party_invites",
  {
    partyId: uuid("party_id")
      .notNull()
      .references(() => parties.id, { onDelete: "cascade" }),
    toId: uuid("to_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    fromId: uuid("from_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.partyId, t.toId] }),
    to: index("party_invites_to_idx").on(t.toId),
  }),
);

/**
 * Party drops (@extract/shared PartyDropInfo): the leader pressed PLAY; members may follow with this
 * drop_id (signed into their JoinTicket) until expires_at. members = userIds at drop time.
 */
export const partyDrops = pgTable(
  "party_drops",
  {
    dropId: uuid("drop_id").primaryKey(),
    partyId: uuid("party_id")
      .notNull()
      .references(() => parties.id, { onDelete: "cascade" }),
    cycle: integer("cycle").notNull(),
    matchId: uuid("match_id").notNull(),
    leaderId: uuid("leader_id").notNull(),
    members: jsonb("members").$type<string[]>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (t) => ({
    partyAt: index("party_drops_party_created_idx").on(t.partyId, t.createdAt),
  }),
);

export type Friendship = typeof friendships.$inferSelect;
export type Party = typeof parties.$inferSelect;
export type PartyMember = typeof partyMembers.$inferSelect;
export type PartyInvite = typeof partyInvites.$inferSelect;
export type PartyDropRow = typeof partyDrops.$inferSelect;

// ---------------------------------------------------------------------------- admin

/**
 * Admin audit (lib/admin/params.ts, migration 006): one row per admin change (who, when, old → new).
 * action 'param_set' with target = the economy_params key. admin_nickname is copied so the row
 * still reads after the account is gone (admin_id then becomes NULL).
 */
export const adminAudit = pgTable(
  "admin_audit",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    adminId: uuid("admin_id").references(() => users.id, { onDelete: "set null" }),
    adminNickname: text("admin_nickname").notNull(),
    action: text("action").notNull(),
    target: text("target").notNull(),
    oldValue: jsonb("old_value"),
    newValue: jsonb("new_value"),
    note: text("note"),
    at: timestamp("at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    at: index("admin_audit_at_idx").on(t.at),
  }),
);

export type AdminAuditRow = typeof adminAudit.$inferSelect;

// ---------------------------------------------------------------------------- daily tasks (quests)

/**
 * Daily tasks (lib/quests, @extract/shared quests.ts, migration 008): QUEST.SLOTS rows per player.
 * A finished slot (done_day set) gets a new task on the next UTC day; an open one carries over with
 * its progress. rerolled_day = the UTC day of the slot's free swap (one per player per day). Dates
 * are UTC days.
 */
export const questSlots = pgTable(
  "quest_slots",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    slot: smallint("slot").notNull(),
    questId: text("quest_id").notNull(),
    need: integer("need").notNull(),
    xp: integer("xp").notNull(),
    progress: integer("progress").notNull().default(0),
    issuedDay: date("issued_day").notNull(),
    doneDay: date("done_day"),
    rerolledDay: date("rerolled_day"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.userId, t.slot] }),
    slotRange: check("quest_slots_slot_range", sql`${t.slot} >= 0 and ${t.slot} < 3`),
    progressRange: check("quest_slots_progress_range", sql`${t.progress} >= 0 and ${t.progress} <= ${t.need}`),
  }),
);

/**
 * Completed tasks: one row per (player, UTC day, slot), written in the exit transaction that
 * finished it. Σ xp of a day ≤ QUEST.DAILY_XP_MAX; count(*) per player = task marks.
 */
export const questLog = pgTable(
  "quest_log",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    day: date("day").notNull(),
    slot: smallint("slot").notNull(),
    questId: text("quest_id").notNull(),
    xp: integer("xp").notNull(),
    /** The raid entry whose exit finished the task. */
    entryId: uuid("entry_id"),
    at: timestamp("at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    userDaySlot: uniqueIndex("quest_log_user_day_slot_idx").on(t.userId, t.day, t.slot),
  }),
);

export type QuestSlotRow = typeof questSlots.$inferSelect;
export type QuestLogRow = typeof questLog.$inferSelect;

// ---------------------------------------------------------------------------- admin replays

/** Postgres bytea as a Node Buffer (drizzle-orm 0.36 has no built-in bytea column). */
const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => "bytea",
});

/**
 * Admin replays (lib/admin/replay.ts, @extract/shared replay.ts, migration 007): one row per world
 * shard-cycle (match_id = raids.match_id, deliberately without FK). started_at = the cycle start;
 * ended_at is set by the final chunk (wipe / room closed); last_ms = cycle clock of the newest chunk
 * end; entries = human entries on the shard so far; bytes / raw_bytes = stored compressed /
 * uncompressed totals. The replays-retention cron deletes rows older than REPLAY.RETENTION_DAYS.
 */
export const replays = pgTable(
  "replays",
  {
    matchId: uuid("match_id").primaryKey(),
    cycleId: integer("cycle_id").notNull(),
    shard: smallint("shard").notNull(),
    mapId: text("map_id").notNull(),
    /** MAP_GEN_VERSION the shard's map was generated with (migration 009); null = unknown (older game server). */
    genVersion: smallint("gen_version"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    lastMs: integer("last_ms").notNull().default(0),
    entries: integer("entries").notNull().default(0),
    chunks: integer("chunks").notNull().default(0),
    bytes: bigint("bytes", { mode: "number" }).notNull().default(0),
    rawBytes: bigint("raw_bytes", { mode: "number" }).notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    startedAt: index("replays_started_at_idx").on(t.startedAt),
    cycle: index("replays_cycle_idx").on(t.cycleId),
  }),
);

/** One deflate-raw compressed replay chunk (about a minute of cycle clock); idempotent by (match_id, seq). */
export const replayChunks = pgTable(
  "replay_chunks",
  {
    matchId: uuid("match_id")
      .notNull()
      .references(() => replays.matchId, { onDelete: "cascade" }),
    seq: integer("seq").notNull(),
    startMs: integer("start_ms").notNull(),
    endMs: integer("end_ms").notNull(),
    frames: integer("frames").notNull(),
    events: integer("events").notNull(),
    bytes: integer("bytes").notNull(),
    rawBytes: integer("raw_bytes").notNull(),
    final: boolean("final").notNull().default(false),
    data: bytea("data").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.matchId, t.seq] }),
  }),
);

export type ReplayRow = typeof replays.$inferSelect;
export type ReplayChunkRow = typeof replayChunks.$inferSelect;
