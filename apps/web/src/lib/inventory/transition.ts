import { sql } from "drizzle-orm";
import { itemEvents, type Item, type ItemState } from "../../db/schema";
import type { Tx } from "./db";

/** What the row must look like for the transition to apply (undefined = not checked). */
export interface ItemGuard {
  state: ItemState;
  matchId?: string | null;
  loadoutId?: string | null;
  ownerId?: string | null;
}

export interface ItemPatch {
  state: ItemState;
  ownerId?: string | null;
  matchId?: string | null;
  loadoutId?: string | null;
  durability?: number;
  /** Added to lock_raids, floored at 0 (extract decrements by 1). */
  lockRaidsDelta?: number;
  /** Make the item bound (never listable, destroyed instead of pooled). Never unbinds. */
  bind?: boolean;
}

export interface ItemEventInfo {
  reason: string;
  refId: string;
}

/** Raw row of `select * from items` (snake_case, numeric strings come back as numbers for float8/int). */
type ItemRow = {
  id: string;
  def_id: string;
  rarity: number;
  durability: number;
  max_durability: number;
  state: ItemState;
  owner_id: string | null;
  match_id: string | null;
  loadout_id: string | null;
  origin: Item["origin"];
  bound: boolean;
  lock_raids: number;
};

export interface LockedItem {
  id: string;
  defId: string;
  rarity: number;
  durability: number;
  maxDurability: number;
  state: ItemState;
  ownerId: string | null;
  matchId: string | null;
  loadoutId: string | null;
  bound: boolean;
  lockRaids: number;
}

function fromRow(r: ItemRow): LockedItem {
  return {
    id: r.id,
    defId: r.def_id,
    rarity: Number(r.rarity),
    durability: Number(r.durability),
    maxDurability: Number(r.max_durability),
    state: r.state,
    ownerId: r.owner_id,
    matchId: r.match_id,
    loadoutId: r.loadout_id,
    bound: r.bound,
    lockRaids: Number(r.lock_raids),
  };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function isUuid(s: string): boolean {
  return UUID_RE.test(s);
}

/** SELECT … FOR UPDATE one item; null when the id is not a uuid or does not exist. */
export async function lockItem(tx: Tx, id: string): Promise<LockedItem | null> {
  if (!isUuid(id)) return null;
  const res = await tx.execute<ItemRow>(sql`select * from items where id = ${id} for update`);
  const r = res.rows[0];
  return r ? fromRow(r) : null;
}

function guardOk(it: LockedItem, g: ItemGuard): boolean {
  if (it.state !== g.state) return false;
  if (g.matchId !== undefined && it.matchId !== g.matchId) return false;
  if (g.loadoutId !== undefined && it.loadoutId !== g.loadoutId) return false;
  if (g.ownerId !== undefined && it.ownerId !== g.ownerId) return false;
  return true;
}

/**
 * The one way an item changes state: lock the row, check the guard (expected state, match,
 * loadout, owner), update, journal. A failed guard returns null and writes nothing, so replaying
 * a report or racing two callers can never move an item twice (inventory memo §4.1). The
 * item_events unique key (item, reason, ref) is a second fence: a duplicate event is ignored.
 */
export async function moveItem(
  tx: Tx,
  id: string,
  guard: ItemGuard,
  patch: ItemPatch,
  ev: ItemEventInfo,
): Promise<LockedItem | null> {
  const it = await lockItem(tx, id);
  if (!it || !guardOk(it, guard)) return null;
  return applyMove(tx, it, patch, ev);
}

/** The row after `patch` (pure: applyMove and applyMoves write exactly this). */
export function nextOf(it: LockedItem, patch: ItemPatch): LockedItem {
  return {
    ...it,
    state: patch.state,
    ownerId: patch.ownerId !== undefined ? patch.ownerId : it.ownerId,
    matchId: patch.matchId !== undefined ? patch.matchId : it.matchId,
    loadoutId: patch.loadoutId !== undefined ? patch.loadoutId : it.loadoutId,
    durability:
      patch.durability !== undefined
        ? Math.max(0, Math.min(it.maxDurability, patch.durability))
        : it.durability,
    lockRaids: Math.max(0, it.lockRaids + (patch.lockRaidsDelta ?? 0)),
    bound: it.bound || patch.bind === true,
  };
}

/** The item_events row of a move (applyMove and applyMoves journal exactly this). */
function eventRow(it: LockedItem, next: LockedItem, ev: ItemEventInfo): typeof itemEvents.$inferInsert {
  return {
    itemId: it.id,
    fromState: it.state,
    toState: next.state,
    fromOwner: it.ownerId,
    toOwner: next.ownerId,
    matchId: next.matchId ?? it.matchId,
    reason: ev.reason,
    refId: ev.refId,
    durability: next.durability,
  };
}

/** moveItem for a row the caller already locked and checked. */
export async function applyMove(tx: Tx, it: LockedItem, patch: ItemPatch, ev: ItemEventInfo): Promise<LockedItem> {
  const next = nextOf(it, patch);
  await tx.execute(sql`
    update items set
      state = ${next.state},
      owner_id = ${next.ownerId},
      match_id = ${next.matchId},
      loadout_id = ${next.loadoutId},
      durability = ${next.durability},
      lock_raids = ${next.lockRaids},
      bound = ${next.bound},
      version = version + 1,
      updated_at = now()
    where id = ${it.id}`);
  await tx.insert(itemEvents).values(eventRow(it, next, ev)).onConflictDoNothing();
  return next;
}

/**
 * lockItem for many ids in one statement (`FOR UPDATE` in id order, so two batch lockers never
 * deadlock). Keyed by the lowercase id; ids that are not uuids or do not exist are absent.
 */
export async function lockItems(tx: Tx, ids: readonly string[]): Promise<Map<string, LockedItem>> {
  const uniq = [...new Set(ids.filter(isUuid).map((id) => id.toLowerCase()))];
  const out = new Map<string, LockedItem>();
  for (let i = 0; i < uniq.length; i += MOVE_BATCH) {
    const part = uniq.slice(i, i + MOVE_BATCH);
    const res = await tx.execute<ItemRow>(sql`
      select * from items where id in (${sql.join(part.map((id) => sql`${id}::uuid`), sql`, `)}) order by id for update`);
    for (const r of res.rows) out.set(String(r.id).toLowerCase(), fromRow(r));
  }
  return out;
}

/** Rows per statement of lockItems / applyMoves (well under Postgres' 65 535 bind parameters). */
const MOVE_BATCH = 500;

export interface PlannedMove {
  /** The locked row as it is now (lockItems / lockMatchItems), already checked by the caller. */
  it: LockedItem;
  patch: ItemPatch;
  ev: ItemEventInfo;
}

/**
 * applyMove for many locked, checked rows of distinct items: one UPDATE … FROM (VALUES …) and one
 * multi-row journal insert per MOVE_BATCH moves instead of two statements per item (the shard-end
 * N+1, docs/DB_REVIEW.md). Writes exactly what applyMove writes, journal rows in `moves` order.
 * Returns the rows after the moves, in order.
 */
export async function applyMoves(tx: Tx, moves: readonly PlannedMove[]): Promise<LockedItem[]> {
  const nexts = moves.map((m) => nextOf(m.it, m.patch));
  if (new Set(nexts.map((n) => n.id)).size !== nexts.length) throw new Error("applyMoves: an item moves twice in one batch");
  for (let i = 0; i < moves.length; i += MOVE_BATCH) {
    const part = nexts.slice(i, i + MOVE_BATCH);
    const rows = part.map(
      (n) =>
        sql`(${n.id}::uuid, ${n.state}::item_state, ${n.ownerId}::uuid, ${n.matchId}::uuid, ${n.loadoutId}::uuid, ${n.durability}::float8, ${n.lockRaids}::smallint, ${n.bound}::boolean)`,
    );
    // The id list lets the planner fetch the rows by primary key instead of hashing all of items.
    await tx.execute(sql`
      update items set
        state = v.state,
        owner_id = v.owner_id,
        match_id = v.match_id,
        loadout_id = v.loadout_id,
        durability = v.durability,
        lock_raids = v.lock_raids,
        bound = v.bound,
        version = version + 1,
        updated_at = now()
      from (values ${sql.join(rows, sql`, `)}) as v(id, state, owner_id, match_id, loadout_id, durability, lock_raids, bound)
      where items.id = v.id and items.id in (${sql.join(part.map((n) => sql`${n.id}::uuid`), sql`, `)})`);
    await tx
      .insert(itemEvents)
      .values(moves.slice(i, i + MOVE_BATCH).map((m, k) => eventRow(m.it, part[k]!, m.ev)))
      .onConflictDoNothing();
  }
  return nexts;
}

/** Locks every item of a match still in_raid (end sweep, void). Ordered by id to avoid deadlocks. */
export async function lockMatchItems(tx: Tx, matchId: string): Promise<LockedItem[]> {
  const res = await tx.execute<ItemRow>(
    sql`select * from items where match_id = ${matchId} and state = 'in_raid' order by id for update`,
  );
  return res.rows.map(fromRow);
}

/** Locks the items of a loadout that has not started a match (unlock / lock expiry). */
export async function lockLoadoutItems(tx: Tx, loadoutId: string): Promise<LockedItem[]> {
  const res = await tx.execute<ItemRow>(
    sql`select * from items where loadout_id = ${loadoutId} and state = 'in_raid' order by id for update`,
  );
  return res.rows.map(fromRow);
}

/** Adds qty to a stash stack (upsert). Negative qty is refused by the CHECK (qty >= 0). */
export async function addStack(tx: Tx, userId: string, defId: string, qty: number): Promise<void> {
  if (qty === 0) return;
  await tx.execute(sql`
    insert into stash_stacks (user_id, def_id, qty) values (${userId}, ${defId}, ${qty})
    on conflict (user_id, def_id) do update set qty = stash_stacks.qty + excluded.qty`);
}

/** Takes qty from a stash stack; false (nothing written) when the stack is short. */
export async function takeStack(tx: Tx, userId: string, defId: string, qty: number): Promise<boolean> {
  const res = await tx.execute(sql`
    update stash_stacks set qty = qty - ${qty}
    where user_id = ${userId} and def_id = ${defId} and qty >= ${qty}`);
  return (res.rowCount ?? 0) === 1;
}
