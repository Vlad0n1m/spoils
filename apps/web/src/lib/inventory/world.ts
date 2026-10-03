import { and, eq, sql } from "drizzle-orm";
import {
  WORLD,
  riskUnitOf,
  uniqueTierScore,
  type BossKind,
  type EntryRejectReason,
  type EntryRequest,
  type EntryResponse,
  type LoadoutSnapshot,
  type ShardOpenRequest,
  type ShardOpenResponse,
  type WorldEventReport,
} from "@extract/shared";
import { loadouts, raidEntries, raids } from "../../db/schema";
import { PARAM, getNumberParam } from "../economy/params";
import { fillBossBag, releaseForEntry } from "../economy/pool";
import { toRaidDur } from "../economy/value";
import { LOADOUT_LOCK_TTL_MS, type Db, type Tx } from "./db";
import { releaseLoadout } from "./loadout";
import { applyMove, isUuid, lockItem } from "./transition";

/**
 * WORLD v6 web side of the game server's WorldDirectory (spec §4.2): a shard opens (raids/open),
 * each entry is admitted (raids/enter), the event boss's death is recorded (world/event). Exit and
 * end settlement stay in raids.ts (applyExit / applyEnd, entry-aware).
 */

// ============================================================================ open

/**
 * POST /api/raids/open: one raids row per shard-cycle (kind 'world'), idempotent on match_id — a
 * replay answers `exists` and changes nothing. Nothing is released here (D17: per entry).
 */
export async function openShard(db: Db, req: ShardOpenRequest, now = new Date()): Promise<ShardOpenResponse> {
  return db.transaction(async (tx) => {
    const ins = await tx
      .insert(raids)
      .values({
        matchId: req.matchId,
        kind: "world",
        mode: req.mode,
        mapId: req.mapId,
        matchSeed: req.matchSeed >>> 0,
        status: "running",
        started: true,
        cycleId: req.cycleId,
        shard: req.shard,
        roomId: req.roomId,
        serverId: req.serverId,
        instanceId: req.instanceId,
        startedAt: now,
        entryClosesAt: new Date(req.entryClosesAt),
        endsAt: new Date(req.endsAt),
        bossKind: req.boss?.kind ?? null,
        bossZone: req.boss?.zone ?? null,
        nextBossKind: req.nextBoss?.kind ?? null,
        nextBossZone: req.nextBoss?.zone ?? null,
      })
      .onConflictDoNothing()
      .returning({ matchId: raids.matchId });
    return { status: ins.length ? "opened" : "exists", autosellMult: await getNumberParam(tx, PARAM.AUTOSELL_MULT) };
  });
}

// ============================================================================ enter

type ShardRow = {
  match_id: string;
  kind: string;
  status: string;
  mode: "live" | "demo";
  cycle_id: number | null;
  boss_kind: string | null;
  boss_bag_filled: boolean;
};

type LoadoutCheck =
  | { ok: true; snapshot: LoadoutSnapshot; riskUnits: number; maxTier: number }
  | { ok: false; reason: "not_locked" | "wrong_user" | "expired" };

/**
 * The per-player block of the legacy startRaid for one entry: the loadout must be `locked`, belong
 * to the user and be younger than LOADOUT_LOCK_TTL_MS (expired → back to the stash); it moves
 * locked → in_raid (match_id set) and its items in_raid with match_id, journal `start` ref entryId.
 * Risk units = Σ riskUnitOf; maxTier = max uniqueTierScore among the risk items.
 */
export async function acceptLoadout(
  tx: Tx,
  a: { loadoutId: string; userId: string; matchId: string; entryId: string; level: number; now: Date },
): Promise<LoadoutCheck> {
  if (!isUuid(a.loadoutId)) return { ok: false, reason: "not_locked" };
  const lr = await tx.execute<{ id: string; user_id: string; status: string; locked_at: Date; entries: LoadoutSnapshot["entries"] }>(
    sql`select id, user_id, status, locked_at, entries from loadouts where id = ${a.loadoutId} for update`,
  );
  const lo = lr.rows[0];
  if (!lo || lo.status !== "locked") return { ok: false, reason: "not_locked" };
  if (lo.user_id !== a.userId) return { ok: false, reason: "wrong_user" };
  if (new Date(lo.locked_at).getTime() < a.now.getTime() - LOADOUT_LOCK_TTL_MS) {
    await releaseLoadout(tx, lo.id, lo.user_id, "cancelled", "expire");
    return { ok: false, reason: "expired" };
  }
  await tx
    .update(loadouts)
    .set({ status: "in_raid", matchId: a.matchId, startedAt: a.now })
    .where(and(eq(loadouts.id, lo.id), eq(loadouts.status, "locked")));
  const entries: LoadoutSnapshot["entries"] = [];
  let riskUnits = 0;
  let maxTier = 0;
  for (const e of lo.entries) {
    if (!e.uid) {
      entries.push({ ...e, dur: toRaidDur(e.def, e.dur) });
      continue;
    }
    const it = await lockItem(tx, e.uid);
    // A locked item can only be in_raid with this loadout; anything else is dropped from the
    // snapshot so the server can never spawn an item the DB does not hold for it.
    if (!it || it.state !== "in_raid" || it.loadoutId !== lo.id || it.matchId !== null) continue;
    await applyMove(tx, it, { state: "in_raid", matchId: a.matchId }, { reason: "start", refId: a.entryId });
    entries.push({ key: e.key, uid: it.id, def: it.defId, qty: 1, rarity: it.rarity, dur: toRaidDur(it.defId, it.durability) });
    const r = riskUnitOf({ bound: it.bound, dur: it.durability });
    riskUnits += r;
    if (r) maxTier = Math.max(maxTier, uniqueTierScore(it.defId, it.rarity));
  }
  return { ok: true, snapshot: { loadoutId: lo.id, userId: lo.user_id, level: a.level, entries }, riskUnits, maxTier };
}

function rejected(reason: EntryRejectReason, autosellMult: number): EntryResponse {
  return { status: "rejected", reason, snapshot: null, level: 0, guest: false, pool: [], bossFill: [], autosellMult };
}

/**
 * POST /api/raids/enter (spec §4.2, D5/D6/D17/D19): admits one entry, in one transaction with
 * `lock_timeout = 2s`.
 * 1. Replay: a stored response for entry_id is returned unchanged (a lost reply heals itself).
 * 2. The shard row must be a running world row (`for key share`, so concurrent entries do not block
 *    each other until the release part) → else `shard_closed`.
 * 3. ≤ WORLD.MAX_ENTRIES_PER_CYCLE entries of this user this cycle → else `entry_limit`.
 * 4. The entry row (one active per user: a conflict is a concurrent replay or `already_active`).
 * 5. Registered user on a live shard with a loadout: acceptLoadout (a failure deletes the entry row:
 *    nothing stored, a replay re-evaluates). Guests and demo shards enter on the free kit.
 * 6. Live: the raids row is locked `for no key update` (only the release serializes per shard);
 *    registered users get releaseForEntry (D17).
 * 7. Live, event boss alive, bag not filled: fillBossBag (D19) → boss_bag_filled.
 * 8. raids.pool_released / risk_units and the entry's released / response are written.
 */
export async function enterRaid(db: Db, req: EntryRequest, now = new Date()): Promise<EntryResponse> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`set local lock_timeout = '2s'`);
    const autosellMult = await getNumberParam(tx, PARAM.AUTOSELL_MULT);

    const replay = await storedResponse(tx, req);
    if (replay) return replay;

    const sr = await tx.execute<ShardRow>(sql`
      select match_id, kind, status, mode, cycle_id, boss_kind, boss_bag_filled
      from raids where match_id = ${req.matchId} for key share`);
    const shard = sr.rows[0];
    if (!shard || shard.kind !== "world" || shard.status !== "running" || shard.cycle_id === null) {
      return rejected("shard_closed", autosellMult);
    }
    const cycleId = Number(shard.cycle_id);

    const cnt = await tx.execute<{ n: number }>(
      sql`select count(*)::int as n from raid_entries where cycle_id = ${cycleId} and user_id = ${req.userId}`,
    );
    if (Number(cnt.rows[0]?.n ?? 0) >= WORLD.MAX_ENTRIES_PER_CYCLE) return rejected("entry_limit", autosellMult);

    const atMs = Math.max(0, Math.min(WORLD.CYCLE_MS, Math.floor(req.atMs) || 0));
    const ins = await tx
      .insert(raidEntries)
      .values({
        entryId: req.entryId,
        matchId: req.matchId,
        cycleId,
        userId: req.userId,
        loadoutId: req.loadoutId && isUuid(req.loadoutId) ? req.loadoutId : null,
        atMs,
        createdAt: now,
      })
      .onConflictDoNothing()
      .returning({ entryId: raidEntries.entryId });
    if (ins.length === 0) {
      // Same entry committed by a concurrent call (the conflict waited for it), or another active entry.
      const again = await storedResponse(tx, req);
      return again ?? rejected("already_active", autosellMult);
    }

    const ur = await tx.execute<{ id: string; level: number }>(sql`select id, level from users where id = ${req.userId}`);
    const user = ur.rows[0] ?? null;
    const guest = !user;
    const level = user ? Number(user.level) : 0;
    const live = shard.mode === "live";

    let snapshot: LoadoutSnapshot | null = null;
    let riskUnits = 0;
    let maxTier = 0;
    if (!guest && live && req.loadoutId) {
      const acc = await acceptLoadout(tx, { loadoutId: req.loadoutId, userId: req.userId, matchId: req.matchId, entryId: req.entryId, level, now });
      if (!acc.ok) {
        await tx.delete(raidEntries).where(eq(raidEntries.entryId, req.entryId));
        return rejected(acc.reason, autosellMult);
      }
      snapshot = acc.snapshot;
      riskUnits = acc.riskUnits;
      maxTier = acc.maxTier;
    }
    const freeKit = !snapshot || !snapshot.entries.some((e) => !!e.uid);
    await tx
      .update(raidEntries)
      .set({ guest, freeKit, riskUnits, maxTier, loadoutId: snapshot ? snapshot.loadoutId : null })
      .where(eq(raidEntries.entryId, req.entryId));

    let pool: EntryResponse["pool"] = [];
    let bossFill: EntryResponse["bossFill"] = [];
    if (live) {
      const lk = await tx.execute<{ boss_bag_filled: boolean; boss_kind: string | null }>(
        sql`select boss_bag_filled, boss_kind from raids where match_id = ${req.matchId} for no key update`,
      );
      const row = lk.rows[0]!;
      if (!guest) {
        const rel = await releaseForEntry(tx, {
          matchId: req.matchId,
          cycleId,
          entryId: req.entryId,
          userId: req.userId,
          riskUnits,
          maxTier,
          atMs,
          targets: req.targets,
          now,
        });
        pool = rel.items;
      }
      if (row.boss_kind && !row.boss_bag_filled && req.bossAlive) {
        bossFill = await fillBossBag(tx, {
          matchId: req.matchId,
          entryId: req.entryId,
          boss: row.boss_kind as BossKind,
          filled: row.boss_bag_filled,
        });
      }
      const sum = await tx.execute<{ risk: number }>(sql`
        select coalesce(sum(m), 0)::int as risk from (
          select max(risk_units) as m from raid_entries
          where match_id = ${req.matchId} and status <> 'voided' group by user_id) x`);
      await tx.execute(sql`
        update raids set
          pool_released = pool_released + ${pool.length},
          risk_units = ${Number(sum.rows[0]?.risk ?? 0)},
          boss_bag_filled = boss_bag_filled or ${bossFill.length > 0}
        where match_id = ${req.matchId}`);
    }

    const response: EntryResponse = { status: "accepted", snapshot, level, guest, pool, bossFill, autosellMult };
    await tx
      .update(raidEntries)
      .set({ released: pool.length, response })
      .where(eq(raidEntries.entryId, req.entryId));
    return response;
  });
}

/** The stored response of an entry (replay); a row of another user / shard is never replayed. */
async function storedResponse(tx: Tx, req: EntryRequest): Promise<EntryResponse | null> {
  const r = await tx.execute<{ user_id: string; match_id: string; response: EntryResponse | null }>(
    sql`select user_id, match_id, response from raid_entries where entry_id = ${req.entryId}`,
  );
  const row = r.rows[0];
  if (!row?.response) return null;
  if (row.user_id !== req.userId || row.match_id !== req.matchId) {
    return rejected("wrong_user", row.response.autosellMult);
  }
  return row.response;
}

// ============================================================================ world event

export interface WorldEventResult {
  status: "applied" | "duplicate" | "unknown";
}

/**
 * POST /api/world/event (boss_killed): the lobby's "killed by" line and the News feed. Idempotent:
 * only the first report sets boss_killed_by / boss_killed_at.
 */
export async function recordWorldEvent(db: Db, ev: WorldEventReport, now = new Date()): Promise<WorldEventResult> {
  const up = await db.execute(sql`
    update raids set boss_killed_by = ${ev.by}, boss_killed_at = ${now}
    where match_id = ${ev.matchId} and kind = 'world' and boss_killed_at is null`);
  if ((up.rowCount ?? 0) > 0) return { status: "applied" };
  const r = await db.execute<{ n: number }>(sql`select count(*)::int as n from raids where match_id = ${ev.matchId} and kind = 'world'`);
  return { status: Number(r.rows[0]?.n ?? 0) > 0 ? "duplicate" : "unknown" };
}
