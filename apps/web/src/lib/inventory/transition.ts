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

/** moveItem for a row the caller already locked and checked. */
export async function applyMove(tx: Tx, it: LockedItem, patch: ItemPatch, ev: ItemEventInfo): Promise<LockedItem> {
  const next: LockedItem = {
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
  await tx
    .insert(itemEvents)
    .values({
      itemId: it.id,
      fromState: it.state,
      toState: next.state,
      fromOwner: it.ownerId,
      toOwner: next.ownerId,
      matchId: next.matchId ?? it.matchId,
      reason: ev.reason,
      refId: ev.refId,
      durability: next.durability,
    })
    .onConflictDoNothing();
  return next;
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
