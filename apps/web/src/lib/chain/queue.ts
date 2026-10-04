import { desc, eq, sql } from "drizzle-orm";
import type { MatchEndReport, SettledItem, WorldEventReport } from "@extract/shared";
import { itemDef } from "@extract/shared";
import { chainEvents, type ChainEventRow } from "../../db/schema";
import type { Db, Tx } from "../inventory/db";
import {
  RARE_EXTRACT_MIN_RARITY,
  bossKillEvent,
  matchEvent,
  rareExtractEvent,
  rareJunk,
  type ChainEvent,
  type ChainEventKind,
} from "./events";

/**
 * The chain_events outbox (schema.ts chainEvents). Enqueueing never throws into a game flow: it
 * runs in its own savepoint (inside a settlement transaction) or transaction, and any error is
 * logged and swallowed, so a missing table or a bad row only costs the on-chain record.
 */

/** Backoff of retry n (1-based): 30 s, 1 min, 2 min … capped at 30 min. */
export const BACKOFF_BASE_MS = 30_000;
export const BACKOFF_MAX_MS = 30 * 60_000;
/** A claimed row is hidden from other workers this long (a crashed call frees it afterwards). */
export const CLAIM_LEASE_MS = 2 * 60_000;
/** A program rejection on the n-th attempt or later marks the row failed (transport errors never do). */
export const MAX_REJECTED_ATTEMPTS = 5;

export function backoffMs(attempts: number): number {
  const n = Math.max(1, Math.floor(attempts));
  return Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** Math.min(n - 1, 20));
}

type DbOrTx = Db | Tx;

/**
 * Runs `run` in a savepoint (inside a transaction) or its own transaction, so a failing statement
 * rolls back only the enqueue; the error is logged and 0 returned.
 */
async function inSavepoint(db: DbOrTx, what: string, run: (sp: Tx) => Promise<number>): Promise<number> {
  try {
    return await db.transaction(run);
  } catch (e) {
    console.warn(`[chain] ${what} not queued (game flow unaffected): ${(e as Error)?.message ?? e}`);
    return 0;
  }
}

async function insertEvents(db: DbOrTx, list: readonly ChainEvent[], now: Date): Promise<number> {
  if (list.length === 0) return 0;
  const rows = await db
    .insert(chainEvents)
    .values(list.map((e) => ({ kind: e.kind, dedupeKey: e.dedupeKey, payload: { ...e.payload }, nextAt: now, createdAt: now })))
    .onConflictDoNothing()
    .returning({ id: chainEvents.id });
  return rows.length;
}

/** Inserts the events (duplicates by dedupe key are ignored); returns how many rows were new. */
export function enqueueChainEvents(db: DbOrTx, events: ReadonlyArray<ChainEvent | null>, now = new Date()): Promise<number> {
  const list = events.filter((e): e is ChainEvent => e !== null);
  if (list.length === 0) return Promise.resolve(0);
  return inSavepoint(db, "enqueue", (sp) => insertEvents(sp, list, now));
}

/** raids/end settled a shard (applyEnd): the match record of a live world shard. */
export function enqueueMatchSettled(tx: Tx, report: MatchEndReport, mode: string, now = new Date()): Promise<number> {
  return inSavepoint(tx, "match", async (sp) => {
    const e = matchEvent(report, mode);
    return e ? insertEvents(sp, [e], now) : 0;
  });
}

/** world/event stored a boss kill (recordWorldEvent): live world shards only, killer resolved by nickname. */
export function enqueueBossKill(db: DbOrTx, ev: WorldEventReport, now = new Date()): Promise<number> {
  return inSavepoint(db, "boss_kill", async (sp) => {
    const r = await sp.execute<{ mode: string; killer: string | null }>(sql`
      select r.mode, (select u.id::text from users u where u.nickname = ${ev.by}) as killer
      from raids r where r.match_id = ${ev.matchId} and r.kind = 'world'`);
    const row = r.rows[0];
    if (!row || row.mode !== "live") return 0;
    const e = bossKillEvent(ev, row.killer);
    return e ? insertEvents(sp, [e], now) : 0;
  });
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * raids/exit (applyExit, after the extracted items moved): rare finds a registered user brought out
 * of a live shard. Uniques count when the DB holds them in this user's stash at epic+ rarity and the
 * entry did not bring them in (its loadout snapshot); rare junk counts one event per def.
 */
export function enqueueRareExtracts(
  tx: Tx,
  a: { entryId: string; matchId: string; cycleId: number; userId: string | null; live: boolean; extracted: readonly SettledItem[] },
  now = new Date(),
): Promise<number> {
  if (!a.userId || !a.live) return Promise.resolve(0);
  const ownerId = a.userId;
  return inSavepoint(tx, "rare_extract", async (sp) => {
    const e = { entryId: a.entryId, matchId: a.matchId, cycleId: a.cycleId, ownerId };
    const events: ChainEvent[] = rareJunk(a.extracted).map((j) => rareExtractEvent(e, { itemId: null, ...j }));
    const uids = [...new Set(a.extracted.filter((s) => s.uid && UUID_RE.test(s.uid) && itemDef(s.def)?.unique).map((s) => s.uid))];
    if (uids.length) {
      const r = await sp.execute<{ id: string; def_id: string; rarity: number }>(sql`
        select i.id::text as id, i.def_id, i.rarity from items i
        where i.id in (${sql.join(
          uids.map((u) => sql`${u}::uuid`),
          sql`, `,
        )})
          and i.owner_id = ${ownerId} and i.state = 'in_stash' and i.rarity >= ${RARE_EXTRACT_MIN_RARITY}
          and not exists (
            select 1 from raid_entries re,
              jsonb_array_elements(coalesce(re.response #> '{snapshot,entries}', '[]'::jsonb)) x
            where re.entry_id = ${a.entryId} and x->>'uid' = i.id::text)
        order by i.id`);
      for (const it of r.rows) events.push(rareExtractEvent(e, { itemId: it.id, def: it.def_id, rarity: Number(it.rarity), qty: 1 }));
    }
    return insertEvents(sp, events, now);
  });
}

// ---------------------------------------------------------------------------- worker side

/** Takes up to `limit` due rows: attempts + 1 and next_at pushed by the lease (SKIP LOCKED). */
export async function claimDue(db: Db, limit: number, now: Date): Promise<ChainEventRow[]> {
  const lease = new Date(now.getTime() + CLAIM_LEASE_MS);
  const r = await db.execute<{ id: number }>(sql`
    update chain_events set attempts = attempts + 1, next_at = ${lease}
    where id in (
      select id from chain_events
      where status = 'queued' and next_at <= ${now}
      order by next_at, id
      limit ${Math.max(1, Math.floor(limit))}
      for update skip locked)
    returning id`);
  const ids = r.rows.map((x) => Number(x.id));
  if (ids.length === 0) return [];
  const rows = await db
    .select()
    .from(chainEvents)
    .where(sql`${chainEvents.id} in (${sql.join(ids.map((i) => sql`${i}`), sql`, `)})`);
  return rows.sort((x, y) => x.nextAt.getTime() - y.nextAt.getTime() || x.id - y.id);
}

/** The transaction the worker is about to send (stored first, so a retry can check whether it landed). */
export async function rememberTx(db: Db, id: number, sig: string, validUntil: number): Promise<void> {
  await db.update(chainEvents).set({ txSig: sig, txValidUntil: validUntil }).where(eq(chainEvents.id, id));
}

export async function markSent(db: Db, id: number, sig: string, now: Date): Promise<void> {
  await db
    .update(chainEvents)
    .set({ status: "sent", txSig: sig, sentAt: now, error: null, nextAt: now })
    .where(eq(chainEvents.id, id));
}

/**
 * Not recorded this time. A rejection by the program (or a payload that cannot be encoded) on the
 * MAX_REJECTED_ATTEMPTS-th attempt or later fails the row; anything else waits backoffMs(attempts).
 * keepTx keeps tx_sig when the transaction may still land (the next attempt checks it first).
 */
export async function markRetry(
  db: Db,
  row: Pick<ChainEventRow, "id" | "attempts">,
  o: { error: string; now: Date; rejected?: boolean; permanent?: boolean; keepTx?: boolean; delayMs?: number },
): Promise<"queued" | "failed"> {
  const fail = o.permanent || (o.rejected && row.attempts >= MAX_REJECTED_ATTEMPTS);
  const next = new Date(o.now.getTime() + (o.delayMs ?? backoffMs(row.attempts)));
  await db
    .update(chainEvents)
    .set({
      status: fail ? "failed" : "queued",
      nextAt: fail ? o.now : next,
      error: o.error.slice(0, 500),
      ...(o.keepTx ? {} : { txSig: null, txValidUntil: null }),
    })
    .where(eq(chainEvents.id, row.id));
  return fail ? "failed" : "queued";
}

/** A claimed row the worker did not get to (time budget): back to due now, the claim not counted. */
export async function releaseClaim(db: Db, id: number, now: Date): Promise<void> {
  await db
    .update(chainEvents)
    .set({ nextAt: now, attempts: sql`greatest(${chainEvents.attempts} - 1, 0)` })
    .where(eq(chainEvents.id, id));
}

// ---------------------------------------------------------------------------- read side (/economy)

export interface ChainSummary {
  counts: Record<ChainEventKind, { sent: number; queued: number; failed: number }>;
  recent: Array<{ kind: ChainEventKind; txSig: string; sentAt: Date }>;
}

export async function getChainSummary(db: Db, recentLimit = 5): Promise<ChainSummary> {
  const counts: ChainSummary["counts"] = {
    match: { sent: 0, queued: 0, failed: 0 },
    boss_kill: { sent: 0, queued: 0, failed: 0 },
    rare_extract: { sent: 0, queued: 0, failed: 0 },
  };
  const c = await db.execute<{ kind: string; status: string; n: number }>(
    sql`select kind, status, count(*)::int as n from chain_events group by kind, status`,
  );
  for (const r of c.rows) {
    const k = counts[r.kind as ChainEventKind];
    if (k && (r.status === "sent" || r.status === "queued" || r.status === "failed")) k[r.status] = Number(r.n);
  }
  const recent = await db
    .select({ kind: chainEvents.kind, txSig: chainEvents.txSig, sentAt: chainEvents.sentAt })
    .from(chainEvents)
    .where(eq(chainEvents.status, "sent"))
    .orderBy(desc(chainEvents.sentAt), desc(chainEvents.id))
    .limit(recentLimit);
  return {
    counts,
    recent: recent
      .filter((r) => r.txSig && r.sentAt)
      .map((r) => ({ kind: r.kind as ChainEventKind, txSig: r.txSig!, sentAt: r.sentAt! })),
  };
}
