import { sql } from "drizzle-orm";
import type {
  ExitType,
  JunkSellLine,
  LoadoutEntry,
  LoadoutSnapshot,
  MatchEndParticipant,
  MatchEndReport,
  PlayerExitReport,
  RaidStartRequest,
  RaidStartResponse,
  SettledItem,
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
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => ({
    emailIdx: uniqueIndex("users_email_idx").on(t.email),
    nickIdx: uniqueIndex("users_nickname_idx").on(t.nickname),
    depositIdx: uniqueIndex("users_deposit_idx").on(t.depositAddress),
    creditsNonNeg: check("users_credits_non_negative", sql`${t.credits} >= 0`),
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
//   in_stash → in_raid                      (loadout lock; match_id set by raids/start)
//   in_raid  → in_stash                     (extract: owner = extractor | unlock / void: owner kept)
//   in_raid  → lost_pool                    (broke on death −8 dur, timeout, left on map, guest extract)
//   in_raid  → destroyed                    (durability 0, or a bound item that would enter the pool)
//   lost_pool → in_raid                     (raids/start pool allocation, owner NULL)
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

/** Locked loadout entry: SettledItem with its slot; DB durability % (converted to armor points at raids/start). */
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

/** One row per raid started through POST /api/raids/start; the stored response makes start retry-safe. */
export const raids = pgTable(
  "raids",
  {
    matchId: uuid("match_id").primaryKey(),
    mode: text("mode").$type<"live" | "demo">().notNull(),
    mapId: text("map_id").notNull(),
    matchSeed: bigint("match_seed", { mode: "number" }).notNull(),
    status: raidStatusEnum("status").notNull().default("running"),
    /** false when the row was created lazily by an exit/end report (raids/start never reached us). */
    started: boolean("started").notNull().default(true),
    startRequest: jsonb("start_request").$type<RaidStartRequest>(),
    startResponse: jsonb("start_response").$type<RaidStartResponse>(),
    riskUnits: integer("risk_units").notNull().default(0),
    poolReleased: integer("pool_released").notNull().default(0),
    startedAt: timestamp("started_at", { withTimezone: true }).defaultNow().notNull(),
    settledAt: timestamp("settled_at", { withTimezone: true }),
  },
  (t) => ({
    statusStarted: index("raids_status_started_idx").on(t.status, t.startedAt),
  }),
);

/** Applied PlayerExitReport, one per (match, user): the primary key is the idempotency guard. */
export const raidExits = pgTable(
  "raid_exits",
  {
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
  },
  (t) => ({
    pk: primaryKey({ columns: [t.matchId, t.userId] }),
    user: index("raid_exits_user_idx").on(t.userId, t.at),
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
export type CreditLedgerRow = typeof creditLedger.$inferSelect;
export type Listing = typeof listings.$inferSelect;
export type Trade = typeof trades.$inferSelect;
