import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type * as schema from "../../db/schema";

/**
 * Services take the database as a parameter instead of importing `@/db/client`, so tests can
 * point them at the isolated `extract_test` database and routes pass the app pool.
 */
export type Db = NodePgDatabase<typeof schema>;
/** A drizzle transaction on Db. Every money/item mutation runs inside exactly one. */
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/** Locked loadouts that never reach raids/enter are returned to the stash after this. */
export const LOADOUT_LOCK_TTL_MS = 10 * 60_000;
