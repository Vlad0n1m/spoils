import { sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  text,
  bigint,
  timestamp,
  integer,
  boolean,
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

/** Credited on successful extract; match settlement adds (finalPayout - instantPayout) so totals stay fair. */
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

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type Match = typeof matches.$inferSelect;
export type MatchParticipant = typeof matchParticipants.$inferSelect;
export type Deposit = typeof deposits.$inferSelect;
export type Withdrawal = typeof withdrawals.$inferSelect;
