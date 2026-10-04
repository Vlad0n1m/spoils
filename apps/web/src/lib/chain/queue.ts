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
/**
 * The n-th program rejection of a row marks it failed. Only rejections count (column rejections):
 * transport errors, pending re-checks and blocked sends never do, however many attempts they cost.
 */
export const MAX_REJECTED_ATTEMPTS = 5;
/** A blocked send (fee payer refused, operator problem) is retried after this long, uncounted. */
export const BLOCKED_RETRY_MS = BACKOFF_BASE_MS;

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

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * world/event stored a boss kill (recordWorldEvent): live world shards only. The killer counts as a
 * registered user only when this shard admitted them as a non-guest entry: the report's byUserId
 * (game server, the killer's own entry), else (an older game server) the shard's registered entry
 * whose user has that nickname. Never a global nickname lookup, which a guest could hijack by
 * picking a registered player's name. Anyone else is a guest by nickname; no killer → NO_KILLER.
 */
export function enqueueBossKill(db: DbOrTx, ev: WorldEventReport, now = new Date()): Promise<number> {
  return inSavepoint(db, "boss_kill", async (sp) => {
    const byUserId = ev.byUserId && UUID_RE.test(ev.byUserId) ? ev.byUserId : null;
    const killer = byUserId
      ? sql`(select re.user_id::text from raid_entries re
          where re.match_id = r.match_id and not re.guest and re.user_id = ${byUserId}::uuid limit 1)`
      : ev.by
        ? sql`(select re.user_id::text from raid_entries re join users u on u.id = re.user_id
            where re.match_id = r.match_id and not re.guest and u.nickname = ${ev.by}
            order by re.created_at limit 1)`
        : sql`null::text`;
    const r = await sp.execute<{ mode: string; killer: string | null }>(sql`
      select r.mode, ${killer} as killer
      from raids r where r.match_id = ${ev.matchId} and r.kind = 'world'`);
    const row = r.rows[0];
    if (!row || row.mode !== "live") return 0;
    const e = bossKillEvent(ev, row.killer);
    return e ? insertEvents(sp, [e], now) : 0;
  });
}

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
 * Not recorded this time. A rejection by the program counts in `rejections`, and the
 * MAX_REJECTED_ATTEMPTS-th one fails the row, as does a payload that cannot be encoded (permanent);
 * anything else waits backoffMs(attempts) and never fails it. keepTx keeps tx_sig when the
 * transaction may still land (the next attempt checks it first).
 */
export async function markRetry(
  db: Db,
  row: Pick<ChainEventRow, "id" | "attempts" | "rejections">,
  o: { error: string; now: Date; rejected?: boolean; permanent?: boolean; keepTx?: boolean; delayMs?: number },
): Promise<"queued" | "failed"> {
  const rejections = (row.rejections ?? 0) + (o.rejected ? 1 : 0);
  const fail = o.permanent || (o.rejected && rejections >= MAX_REJECTED_ATTEMPTS);
  const next = new Date(o.now.getTime() + (o.delayMs ?? backoffMs(row.attempts)));
  await db
    .update(chainEvents)
    .set({
      status: fail ? "failed" : "queued",
      nextAt: fail ? o.now : next,
      error: o.error.slice(0, 500),
      ...(o.rejected ? { rejections: sql`${chainEvents.rejections} + 1` } : {}),
      ...(o.keepTx ? {} : { txSig: null, txValidUntil: null }),
    })
    .where(eq(chainEvents.id, row.id));
  return fail ? "failed" : "queued";
}

/**
 * The cluster refused the fee payer before the transaction left preflight (operator problem): back
 * to the queue after BLOCKED_RETRY_MS, the attempt not counted and the unsent signature dropped.
 */
export async function markBlocked(db: Db, id: number, error: string, now: Date): Promise<void> {
  await db
    .update(chainEvents)
    .set({
      status: "queued",
      nextAt: new Date(now.getTime() + BLOCKED_RETRY_MS),
      attempts: sql`greatest(${chainEvents.attempts} - 1, 0)`,
      error: error.slice(0, 500),
      txSig: null,
      txValidUntil: null,
    })
    .where(eq(chainEvents.id, id));
}

/**
 * chain-admin send-test-events (test database only): every queued row is set aside as failed, so the
 * worker pass that follows sends only the sample events queued after it. Returns how many.
 */
export async function parkQueued(db: Db, reason: string): Promise<number> {
  const r = await db.execute(sql`update chain_events set status = 'failed', error = ${reason.slice(0, 500)} where status = 'queued'`);
  return r.rowCount ?? 0;
}

/**
 * Operator command (programs/scripts/chain-admin.ts requeue-failed): failed rows back to the queue,
 * due now, with fresh attempt and rejection counts. Optionally only some ids. Returns how many.
 */
export async function requeueFailed(db: Db, o: { now?: Date; ids?: readonly number[] } = {}): Promise<number> {
  const now = o.now ?? new Date();
  if (o.ids && o.ids.length === 0) return 0;
  const only = o.ids ? sql` and id in (${sql.join(o.ids.map((i) => sql`${Math.floor(i)}`), sql`, `)})` : sql``;
  const r = await db.execute(sql`
    update chain_events set status = 'queued', attempts = 0, rejections = 0, next_at = ${now},
      error = 'requeued: ' || coalesce(error, ''), tx_sig = null, tx_valid_until = null
    where status = 'failed'${only}`);
  return r.rowCount ?? 0;
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
