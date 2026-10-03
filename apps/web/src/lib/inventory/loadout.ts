import { and, eq, inArray, sql } from "drizzle-orm";
import {
  itemDef,
  validateLoadout,
  type LoadoutEntry,
  type LoadoutErrCode,
  type StashUnique,
} from "@extract/shared";
import { items, loadoutDrafts, loadouts, stashStacks, type LoadoutRowEntry } from "../../db/schema";
import { LOADOUT_LOCK_TTL_MS, type Db, type Tx } from "./db";
import { addStack, applyMove, isUuid, lockLoadoutItems, takeStack } from "./transition";

/** Max entries in a loadout: 4 equipment + 4 pockets + 16 backpack slots. */
export const MAX_LOADOUT_ENTRIES = 24;

export async function getDraft(db: Db, userId: string): Promise<LoadoutEntry[] | null> {
  const rows = await db.select().from(loadoutDrafts).where(eq(loadoutDrafts.userId, userId));
  return rows[0]?.entries ?? null;
}

/** Autosave of the loadout page. Shape is validated by the route; contents only at lock. */
export async function saveDraft(db: Db, userId: string, entries: LoadoutEntry[]): Promise<void> {
  const now = new Date();
  await db
    .insert(loadoutDrafts)
    .values({ userId, entries, updatedAt: now })
    .onConflictDoUpdate({ target: loadoutDrafts.userId, set: { entries, updatedAt: now } });
}

export type LockResult =
  | { ok: true; loadoutId: string; entries: LoadoutRowEntry[]; reused: boolean }
  | { ok: false; code: LoadoutErrCode | "in_raid" | "conflict" | "no_user"; key?: string; matchId?: string };

/**
 * Locks a loadout for the next raid (inventory memo §4.2): validates with the shared
 * validateLoadout against the user's own in_stash uniques and stash stacks, then in one
 * transaction moves the uniques in_stash → in_raid (loadout_id set, match_id still NULL) and
 * takes the fungibles out of stash_stacks. An empty loadout is the free kit (loadoutId "").
 * Locking while a loadout is already `locked` re-issues that one (the ticket may be re-signed);
 * while `in_raid` it is refused with the match id so the UI can offer Reconnect.
 */
export async function lockLoadout(db: Db, userId: string, entries: readonly LoadoutEntry[], now = new Date()): Promise<LockResult> {
  if (entries.length > MAX_LOADOUT_ENTRIES) return { ok: false, code: "bad_slot" };
  try {
    return await db.transaction(async (tx) => {
      const u = await tx.execute(sql`select id from users where id = ${userId} for update`);
      if (!u.rows[0]) return { ok: false, code: "no_user" } as const;
      await expireStaleLocks(tx, now, userId);

      const active = await tx
        .select()
        .from(loadouts)
        .where(and(eq(loadouts.userId, userId), inArray(loadouts.status, ["locked", "in_raid"])));
      const cur = active[0];
      if (cur?.status === "in_raid") return { ok: false, code: "in_raid", matchId: cur.matchId ?? undefined } as const;
      if (cur?.status === "locked") return { ok: true, loadoutId: cur.id, entries: cur.entries, reused: true } as const;
      if (entries.length === 0) return { ok: true, loadoutId: "", entries: [], reused: false } as const;

      const ids = entries.map((e) => e.itemId).filter((x): x is string => !!x && isUuid(x));
      const owned = ids.length
        ? await tx
            .select()
            .from(items)
            .where(and(inArray(items.id, ids), eq(items.ownerId, userId)))
            .for("update")
        : [];
      const uniques = new Map<string, StashUnique>(
        owned.map((r) => [r.id, { id: r.id, def: r.defId, state: r.state, dur: r.durability }]),
      );
      const stackRows = await tx.select().from(stashStacks).where(eq(stashStacks.userId, userId));
      const stacks: Record<string, number> = Object.fromEntries(stackRows.map((s) => [s.defId, s.qty]));
      const v = validateLoadout(entries, uniques, stacks);
      if (!v.ok) return { ok: false, code: v.code, key: v.key } as const;

      const byId = new Map(owned.map((r) => [r.id, r]));
      const snapshot: LoadoutRowEntry[] = entries.map((e) => {
        const d = itemDef(e.def)!;
        const row = d.unique && e.itemId ? byId.get(e.itemId) : undefined;
        return row
          ? { key: e.key, uid: row.id, def: row.defId, qty: 1, rarity: row.rarity, dur: row.durability }
          : { key: e.key, uid: "", def: e.def, qty: e.qty, rarity: d.rarity, dur: 100 };
      });
      const [lo] = await tx
        .insert(loadouts)
        .values({ userId, status: "locked", entries: snapshot, lockedAt: now })
        .returning({ id: loadouts.id });
      const loadoutId = lo!.id;

      for (const row of owned) {
        if (!ids.includes(row.id)) continue;
        await applyMove(
          tx,
          {
            id: row.id,
            defId: row.defId,
            rarity: row.rarity,
            durability: row.durability,
            maxDurability: row.maxDurability,
            state: row.state,
            ownerId: row.ownerId,
            matchId: row.matchId,
            loadoutId: row.loadoutId,
            bound: row.bound,
            lockRaids: row.lockRaids,
          },
          { state: "in_raid", loadoutId, matchId: null },
          { reason: "lock", refId: loadoutId },
        );
      }
      const need = new Map<string, number>();
      for (const e of snapshot) if (!e.uid) need.set(e.def, (need.get(e.def) ?? 0) + e.qty);
      for (const [def, qty] of need) {
        // validateLoadout already checked the amounts under the user lock; this is the DB guard.
        if (!(await takeStack(tx, userId, def, qty))) throw new LockAbort("not_enough", def);
      }
      return { ok: true, loadoutId, entries: snapshot, reused: false } as const;
    });
  } catch (e) {
    if (e instanceof LockAbort) return { ok: false, code: e.code, key: e.key };
    // Two concurrent locks for one user: the partial unique index loadouts_one_active fires.
    if (isUniqueViolation(e)) return { ok: false, code: "conflict" };
    throw e;
  }
}

class LockAbort extends Error {
  constructor(
    readonly code: LoadoutErrCode,
    readonly key?: string,
  ) {
    super(code);
  }
}

function isUniqueViolation(e: unknown): boolean {
  const code = (e as { code?: string; cause?: { code?: string } })?.code ?? (e as { cause?: { code?: string } })?.cause?.code;
  return code === "23505";
}

export type UnlockResult = { ok: true; unlocked: boolean } | { ok: false; code: "in_raid"; matchId?: string };

/** Queue cancelled: a `locked` loadout returns to the stash. No-op when nothing is locked. */
export async function unlockLoadout(db: Db, userId: string): Promise<UnlockResult> {
  return db.transaction(async (tx) => {
    const rows = await tx.execute<{ id: string; status: string; match_id: string | null }>(
      sql`select id, status, match_id from loadouts where user_id = ${userId} and status in ('locked', 'in_raid') for update`,
    );
    const lo = rows.rows[0];
    if (!lo) return { ok: true, unlocked: false } as const;
    if (lo.status === "in_raid") return { ok: false, code: "in_raid", matchId: lo.match_id ?? undefined } as const;
    await releaseLoadout(tx, lo.id, userId, "cancelled", "unlock");
    return { ok: true, unlocked: true } as const;
  });
}

/**
 * Returns a not-started loadout to the stash: its uniques in_raid → in_stash (owner unchanged),
 * its fungible entries back into stash_stacks, status → `status`. Guarded on match_id IS NULL:
 * an item that already entered a match is the raid's business, not the lock's.
 */
export async function releaseLoadout(
  tx: Tx,
  loadoutId: string,
  userId: string,
  status: "cancelled" | "voided",
  reason: "unlock" | "expire" | "void",
): Promise<void> {
  const lo = await tx
    .update(loadouts)
    .set({ status, closedAt: new Date() })
    .where(and(eq(loadouts.id, loadoutId), inArray(loadouts.status, ["locked", "in_raid"])))
    .returning({ entries: loadouts.entries });
  if (!lo[0]) return;
  for (const it of await lockLoadoutItems(tx, loadoutId)) {
    if (reason !== "void" && it.matchId !== null) continue;
    await applyMove(tx, it, { state: "in_stash", matchId: null, loadoutId: null }, { reason, refId: loadoutId });
  }
  for (const e of lo[0].entries) if (!e.uid && e.qty > 0) await addStack(tx, userId, e.def, e.qty);
}

/**
 * Lazy expiry (inventory memo §4.2): loadouts locked longer than LOADOUT_LOCK_TTL_MS without a
 * raids/enter go back to the stash. Called on lock, on stash reads, and by the void cron.
 */
export async function expireStaleLocks(tx: Tx, now = new Date(), userId?: string): Promise<number> {
  const cutoff = new Date(now.getTime() - LOADOUT_LOCK_TTL_MS);
  const rows = await tx.execute<{ id: string; user_id: string }>(
    userId
      ? sql`select id, user_id from loadouts where status = 'locked' and locked_at < ${cutoff} and user_id = ${userId} for update skip locked`
      : sql`select id, user_id from loadouts where status = 'locked' and locked_at < ${cutoff} for update skip locked`,
  );
  for (const r of rows.rows) await releaseLoadout(tx, r.id, r.user_id, "cancelled", "expire");
  return rows.rows.length;
}
