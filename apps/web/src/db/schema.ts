import { sql } from "drizzle-orm";
import type { MatchSettlementPayload } from "@extract/shared";
import {
  pgTable,
  uuid,
  text,
  bigint,
  timestamp,
  integer,
  boolean,
  jsonb,
  pgEnum,
  uniqueIndex,
  index,
  primaryKey,
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
    balanceCents: bigint("balance_cents", { mode: "bigint" })
      .notNull()
      .default(sql`0`),
    depositAddress: text("deposit_address").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => ({
    emailIdx: uniqueIndex("users_email_idx").on(t.email),
    nickIdx: uniqueIndex("users_nickname_idx").on(t.nickname),
    depositIdx: uniqueIndex("users_deposit_idx").on(t.depositAddress),
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
 * One row per finished raid, written by POST /api/matches/settle (HMAC from the game server).
 * The whole settlement is kept as jsonb: the item economy will later replay it into stash/item
 * ledgers, so nothing from the server's report may be lost now.
 */
export const matchResults = pgTable(
  "match_results",
  {
    matchId: uuid("match_id").primaryKey(),
    /** uint32 seed does not fit a signed int4. */
    mapSeed: bigint("map_seed", { mode: "number" }).notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    endedAt: timestamp("ended_at", { withTimezone: true }).notNull(),
    payload: jsonb("payload").$type<MatchSettlementPayload>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => ({
    endedIdx: index("match_results_ended_idx").on(t.endedAt),
  }),
);

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type Match = typeof matches.$inferSelect;
export type MatchParticipant = typeof matchParticipants.$inferSelect;
export type Deposit = typeof deposits.$inferSelect;
export type Withdrawal = typeof withdrawals.$inferSelect;
export type MatchResult = typeof matchResults.$inferSelect;
