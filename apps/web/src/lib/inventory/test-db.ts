import { randomUUID } from "node:crypto";
import { drizzle } from "drizzle-orm/node-postgres";
import { sql } from "drizzle-orm";
import { Pool } from "pg";
import * as schema from "../../db/schema";
import { items, users, type ItemState } from "../../db/schema";
import type { Db } from "./db";

/**
 * Test harness for the DB services. Uses an isolated database (default `extract_test`, override
 * with TEST_DATABASE_URL) and refuses to run against the dev database `extract`: resetDb()
 * truncates every economy table.
 * Schema setup: `DATABASE_URL=postgresql://localhost:5432/extract_test pnpm --filter web db:push:ci`.
 */
export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? "postgresql://localhost:5432/extract_test";

export function openTestDb(): { db: Db; pool: Pool } {
  const name = new URL(TEST_DATABASE_URL).pathname.replace(/^\//, "");
  if (!/test/i.test(name)) throw new Error(`refusing to run DB tests against "${name}" (name must contain "test")`);
  const pool = new Pool({ connectionString: TEST_DATABASE_URL, max: 8 });
  return { db: drizzle(pool, { schema }), pool };
}

/**
 * node --test runs every test file in its own process at the same time, and every DB test file
 * truncates the same database in beforeEach — two files interleaving deadlock or wipe each other's
 * rows. Each file therefore holds a session advisory lock for its whole run (call in `before`), so
 * DB files run one after another while the pure tests stay parallel.
 */
const TEST_DB_LOCK_KEY = 727_001;
let lockClient: import("pg").PoolClient | null = null;

export async function lockTestDb(pool: Pool): Promise<void> {
  lockClient = await pool.connect();
  await lockClient.query("select pg_advisory_lock($1)", [TEST_DB_LOCK_KEY]);
}

/** Releases the file lock and closes the pool; use as the file's `after` hook. */
export async function closeTestDb(pool: Pool): Promise<void> {
  if (lockClient) {
    await lockClient.query("select pg_advisory_unlock($1)", [TEST_DB_LOCK_KEY]).catch(() => undefined);
    lockClient.release();
    lockClient = null;
  }
  await pool.end();
}

export async function resetDb(db: Db): Promise<void> {
  await db.execute(sql`truncate table
    users, items, item_events, stash_stacks, loadouts, loadout_drafts, raids, raid_exits, raid_entries, pvp_kills,
    credit_ledger, dog_tag_payouts, economy_params, economy_daily, listings, trades, money_ledger,
    match_results, deposits, withdrawals
    restart identity cascade`);
}

export async function makeUser(db: Db, nick = `u${randomUUID().slice(0, 8)}`): Promise<string> {
  const [u] = await db
    .insert(users)
    .values({ email: `${nick}@test.local`, passwordHash: "x", nickname: nick, depositAddress: `dep-${nick}` })
    .returning({ id: users.id });
  return u!.id;
}

export async function makeItem(
  db: Db,
  v: { def: string; rarity?: number; dur?: number; state?: ItemState; ownerId?: string | null; lockRaids?: number; bound?: boolean },
): Promise<string> {
  const [r] = await db
    .insert(items)
    .values({
      defId: v.def,
      rarity: v.rarity ?? 0,
      durability: v.dur ?? 100,
      state: v.state ?? "in_stash",
      ownerId: v.ownerId ?? null,
      origin: "seed",
      lockRaids: v.lockRaids ?? 0,
      bound: v.bound ?? false,
    })
    .returning({ id: items.id });
  return r!.id;
}
