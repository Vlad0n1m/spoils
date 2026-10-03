import { and, eq, inArray } from "drizzle-orm";
import type { LoadoutEntry } from "@extract/shared";
import { items, loadoutDrafts, loadouts, stashStacks, users, type ItemState, type LoadoutRowEntry } from "../../db/schema";
import type { Db } from "./db";
import { expireStaleLocks } from "./loadout";
import { voidStale, voidStaleForUser } from "./raids";
import { worldClockOffsetMs } from "../world/clock";

/** One unique as the lobby shows it. dur is the DB percentage. */
export interface StashItemDto {
  id: string;
  def: string;
  rarity: number;
  dur: number;
  maxDur: number;
  /** in_stash | listed | in_raid (locked in the active loadout or a running raid). */
  state: ItemState;
  bound: boolean;
  lockRaids: number;
  origin: string;
  loadoutId: string | null;
}

export interface StashDto {
  credits: number;
  xp: number;
  level: number;
  matchesPlayed: number;
  starterClaimed: boolean;
  uniques: StashItemDto[];
  /** def → qty (ammo, meds). Zero stacks are omitted. */
  stacks: Record<string, number>;
  active: { loadoutId: string; status: "locked" | "in_raid"; matchId: string | null; entries: LoadoutRowEntry[] } | null;
  draft: LoadoutEntry[] | null;
}

/**
 * Everything the lobby needs for one registered user. Runs lazy maintenance first (stale locks
 * expire, crashed raids void) so a user is never stuck with gear locked by a dead match.
 * Returns null for unknown users (guests have no stash).
 */
export async function getStash(db: Db, userId: string, now = new Date()): Promise<StashDto | null> {
  await lazyMaintenance(db, userId, now);
  const u = await db.select().from(users).where(eq(users.id, userId));
  const user = u[0];
  if (!user) return null;
  const [rows, stackRows, active, draft] = await Promise.all([
    db
      .select()
      .from(items)
      .where(and(eq(items.ownerId, userId), inArray(items.state, ["in_stash", "listed", "in_raid"]))),
    db.select().from(stashStacks).where(eq(stashStacks.userId, userId)),
    db
      .select()
      .from(loadouts)
      .where(and(eq(loadouts.userId, userId), inArray(loadouts.status, ["locked", "in_raid"]))),
    db.select().from(loadoutDrafts).where(eq(loadoutDrafts.userId, userId)),
  ]);
  const a = active[0];
  return {
    credits: user.credits,
    xp: user.xp,
    level: user.level,
    matchesPlayed: user.matchesPlayed,
    starterClaimed: user.starterClaimedAt !== null,
    uniques: rows
      .map((r) => ({
        id: r.id,
        def: r.defId,
        rarity: r.rarity,
        dur: r.durability,
        maxDur: r.maxDurability,
        state: r.state,
        bound: r.bound,
        lockRaids: r.lockRaids,
        origin: r.origin,
        loadoutId: r.loadoutId,
      }))
      .sort((x, y) => y.rarity - x.rarity || x.def.localeCompare(y.def) || x.id.localeCompare(y.id)),
    stacks: Object.fromEntries(stackRows.filter((s) => s.qty > 0).map((s) => [s.defId, s.qty])),
    active: a
      ? { loadoutId: a.id, status: a.status as "locked" | "in_raid", matchId: a.matchId, entries: a.entries }
      : null,
    draft: draft[0]?.entries ?? null,
  };
}

/**
 * Expire this user's stale locks and void crashed raids (cheap: index lookups): first the raid
 * holding this user's gear when it is past its ends_at + 5 min or its game server is gone
 * (voidStaleForUser), then every raid past the global stale timeout. Lock TTLs run on `now` (real
 * time, like locked_at); the voids compare against ends_at, which is world time, so they get `now`
 * plus the dev clock offset (addendum A1; 0 in production).
 */
export async function lazyMaintenance(db: Db, userId: string, now = new Date()): Promise<void> {
  await db.transaction((tx) => expireStaleLocks(tx, now, userId));
  const worldAt = new Date(now.getTime() + worldClockOffsetMs());
  await voidStaleForUser(db, userId, worldAt);
  await voidStale(db, worldAt);
}
