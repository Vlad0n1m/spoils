import { and, asc, eq, inArray, sql } from "drizzle-orm";
import {
  DOG_TAG,
  FREE_KIT,
  MATCH,
  NPC,
  WORLD,
  XP,
  dogTagCr,
  dogTagPairMult,
  itemDef,
  junkSellCr,
  levelForXp,
  xpForExit,
  type ExitType,
  type GameServerBoot,
  type JunkSellLine,
  type MatchEndReport,
  type PlayerExitReport,
  type SettledItem,
  type XpLine,
} from "@extract/shared";
import {
  dogTagPayouts,
  loadouts,
  matchResults,
  pvpKills,
  raidEntries,
  raidExits,
  raids,
  type MatchResultPayload,
} from "../../db/schema";
import { credit } from "../economy/ledger";
import { PARAM, getNumberParam, setParam } from "../economy/params";
import { enterPool, expireToTreasury, type PoolCandidate } from "../economy/pool";
import { fromRaidDur } from "../economy/value";
import type { Db, Tx } from "./db";
import { releaseLoadout } from "./loadout";
import { applyMove, isUuid, lockItem, lockLoadoutItems, lockMatchItems, addStack } from "./transition";
import { worldDate } from "../world/clock";

/**
 * A raid still `running` this long after its `ends_at` (the wipe of a world shard, start +
 * MATCH.DURATION_MS of a legacy match) never reported its end: void it (spec §4.5, D29).
 */
export const RAID_VOID_GRACE_MS = 10 * 60_000;
/**
 * Lazy per-user void (lobby load, world join): the caller's own raid is voided sooner, so a player
 * whose game server crashed gets their gear back 5 min after the map would have wiped.
 */
export const RAID_USER_VOID_GRACE_MS = 5 * 60_000;
/** @deprecated legacy matches (ends_at = start + DURATION): the void delay counted from the start. */
export const RAID_VOID_AFTER_MS = MATCH.DURATION_MS + RAID_VOID_GRACE_MS;
/** @deprecated legacy matches: see RAID_VOID_AFTER_MS. */
export const RAID_USER_VOID_AFTER_MS = MATCH.DURATION_MS + RAID_USER_VOID_GRACE_MS;
/** economy_params key of the last boot of a game server (GameServerBoot), per serverId. */
export const GS_BOOT_PARAM = (serverId: string) => `gs_boot:${serverId}`;

type RaidRow = {
  match_id: string;
  status: "running" | "settled" | "voided";
  mode: "live" | "demo";
  started: boolean;
};

async function lockRaid(tx: Tx, matchId: string, mode: "share" | "update"): Promise<RaidRow | null> {
  const res = await tx.execute<RaidRow>(
    mode === "share"
      ? sql`select match_id, status, mode, started from raids where match_id = ${matchId} for share`
      : sql`select match_id, status, mode, started from raids where match_id = ${matchId} for update`,
  );
  return res.rows[0] ?? null;
}

/**
 * Items the pool allocation put into this match (containers, bosses, carriers; WORLD v6 per-entry
 * releases and boss bags), queried by item_events.match_id (D21: the alloc refs are entry ids).
 */
export async function poolAllocatedIds(tx: Tx, matchId: string): Promise<Set<string>> {
  const r = await tx.execute<{ item_id: string }>(
    sql`select distinct item_id from item_events where match_id = ${matchId} and reason in ('alloc', 'alloc_boss', 'alloc_npc')`,
  );
  return new Set(r.rows.map((x) => x.item_id));
}

/** Junk lines (not dog tags) of a free-kit raid's sale at FREE_KIT.AUTOSELL_MULT. */
function freeKitSale(sale: { total: number; lines: JunkSellLine[] }): { total: number; lines: JunkSellLine[] } {
  const lines = sale.lines.map((l) => (l.def === "junk_dogtag" ? l : { ...l, cr: Math.floor(l.cr * FREE_KIT.AUTOSELL_MULT) }));
  return { total: lines.reduce((a, l) => a + l.cr, 0), lines };
}

/**
 * An end report for a match whose raids/open never reached the web still settles: the row is created
 * lazily as a demo row with started=false. No item of such a match is in_raid in the DB, and it has
 * no entries, so nothing but the scoreboard is stored.
 */
async function ensureRaid(tx: Tx, matchId: string, mapId: string, matchSeed: number, now: Date): Promise<void> {
  await tx
    .insert(raids)
    .values({
      matchId,
      mode: "demo",
      mapId,
      matchSeed,
      status: "running",
      started: false,
      startedAt: now,
      endsAt: new Date(now.getTime() + MATCH.DURATION_MS),
    })
    .onConflictDoNothing();
}

// ============================================================================ exit

export interface ExitResult {
  /** unknown_entry (HTTP 409): a world report whose entry the web does not hold for this user / match. */
  status: "applied" | "duplicate" | "voided" | "unknown_entry";
  guest: boolean;
  /** CR credited (registered) — 0 for guests. */
  credits: number;
  /** Receipt at the applied multiplier (guests: what it would have paid). */
  sold: JunkSellLine[];
  autosellMult: number;
  xp: number;
  /** Level after this exit (0 for guests). */
  level: number;
  /** Uniques the report named that the DB did not hold in_raid for this match. */
  skipped: string[];
  /** WORLD v6: xpForExit lines (empty for guests). */
  xpLines: XpLine[];
  levelBefore: number;
  levelUp: boolean;
}

type EntryRow = {
  entry_id: string;
  match_id: string;
  cycle_id: number;
  user_id: string;
  loadout_id: string | null;
  guest: boolean;
  free_kit: boolean;
  status: "active" | "exited" | "voided";
  risk_units: number;
};

const LOST_REASON: Record<ExitType, string> = { dead: "break", mia: "mia", timeout: "timeout", extract: "timeout" };

function utcDayStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/**
 * POST /api/raids/exit: one human left the map (extract, death, MIA at the wipe).
 * WORLD v6 reports carry `entryId` (spec §4.3): the entry row must exist for this user and match
 * (else `unknown_entry`, HTTP 409, the server stops retrying); raid_exits is keyed by entry_id, so
 * two exits of one user in one match both settle, and a replay returns the stored result.
 * - extracted uniques: in_raid → in_stash, owner = extractor; lock_raids − 1 only when the entry
 *   stayed ≥ WORLD.MIN_EXPOSURE_MS on the map (D21); a pool allocation of this match (any alloc*
 *   event, queried by item_events.match_id) extracted by an entry that risked nothing arrives
 *   BOUND. Guests keep nothing (→ lost pool).
 * - lost: dead = broke (−8 dur, reason break), mia = no wear (reason mia), timeout = no wear;
 *   `unplaced` pool items → pool untaxed (reason return, D20); destroyed → destroyed. Ref entryId.
 * - junk: autosell × autosell_mult; dog tags with the 24 h pair rule and × DOG_TAG.NON_KILLER_MULT
 *   unless `by` is this user (D22); free-kit entries of live shards × FREE_KIT.AUTOSELL_MULT; one
 *   credit_ledger row (autosell, exit:<entryId>).
 * - XP (registered): xpForExit with ranked PvP victims (D24, pvp_kills rows), the daily soft cap
 *   and the first extract of the UTC day; users.xp / level / matches_played; the entry's loadout →
 *   settled; the entry → exited.
 * A report without entryId (pre-v6 roster matches, removed in S8) is `unknown_entry` (HTTP 409).
 * Refused (status voided → HTTP 409) once the raid was voided.
 */
export async function applyExit(db: Db, report: PlayerExitReport, now = new Date()): Promise<ExitResult> {
  return db.transaction(async (tx) => {
    const autosellMult = await getNumberParam(tx, PARAM.AUTOSELL_MULT);
    const base: ExitResult = {
      status: "voided",
      guest: false,
      credits: 0,
      sold: [],
      autosellMult,
      xp: 0,
      level: 0,
      skipped: [],
      xpLines: [],
      levelBefore: 0,
      levelUp: false,
    };

    if (!report.entryId) {
      console.warn(`[raids/exit] ${report.matchId} ${report.userId}: report without entryId (pre-v6 server)`);
      return { ...base, status: "unknown_entry" };
    }
    const entryId = report.entryId;
    const er = await tx.execute<EntryRow>(sql`
      select entry_id, match_id, cycle_id, user_id, loadout_id, guest, free_kit, status, risk_units
      from raid_entries where entry_id = ${entryId} for update`);
    const entry = er.rows[0] ?? null;
    if (!entry || entry.user_id !== report.userId || entry.match_id !== report.matchId) {
      console.warn(`[raids/exit] ${report.matchId} ${report.userId}: unknown entry ${entryId}`);
      return { ...base, status: "unknown_entry" };
    }
    const raid = await lockRaid(tx, report.matchId, "share");
    if (!raid) return { ...base, status: "unknown_entry" };
    if (raid.status === "voided") return base;
    // Voided entries (never materialized, or a voided shard) take no exit.
    if (entry.status === "voided") return base;
    // Settled items and the credit are referenced by the entry (D30).
    const ref = entryId;

    const userRes = await tx.execute<{ id: string; xp: number; level: number }>(
      sql`select id, xp, level from users where id = ${report.userId} for update`,
    );
    const user = userRes.rows[0] ?? null;
    const guest = !user;

    const ins = await tx
      .insert(raidExits)
      .values({
        entryId,
        matchId: report.matchId,
        userId: report.userId,
        exit: report.exit,
        report,
        guest,
        at: now,
        cycleId: Number(entry.cycle_id),
      })
      .onConflictDoNothing()
      .returning({ entryId: raidExits.entryId });
    if (ins.length === 0) {
      const prev = await tx.select().from(raidExits).where(eq(raidExits.entryId, entryId));
      const r = prev[0]!;
      const level = Number(user?.level ?? 0);
      const levelBefore = user ? levelForXp(Math.max(0, Number(user.xp) - r.xp)) : 0;
      return {
        status: "duplicate",
        guest: r.guest,
        credits: r.credits,
        sold: r.sold,
        autosellMult,
        xp: r.xp,
        level,
        skipped: [],
        xpLines: r.xpLines ?? [],
        levelBefore,
        levelUp: !!user && level > levelBefore,
      };
    }
    const skipped: string[] = [];
    const pool: PoolCandidate[] = [];
    const junk: SettledItem[] = [];
    const live = raid.mode === "live";
    // D21: a pool unique released into this match that an entry with no risk extracts arrives BOUND.
    const bindPool = !guest && live && Number(entry.risk_units) === 0;
    const allocated = bindPool ? await poolAllocatedIds(tx, report.matchId) : new Set<string>();
    const onMapMs = Number.isFinite(report.enteredAtMs) ? Math.max(0, Math.floor(report.atMs - Number(report.enteredAtMs))) : 0;
    const lockRaidsDelta = onMapMs >= WORLD.MIN_EXPOSURE_MS ? -1 : 0;

    for (const s of report.extracted) {
      const d = itemDef(s.def);
      if (!d) continue;
      if (d.unique) {
        if (!s.uid) continue;
        if (guest) {
          pool.push({ id: s.uid, reportedPct: fromRaidDur(s.def, s.dur), broke: false, reason: "guest", refId: ref });
          continue;
        }
        const it = await lockItem(tx, s.uid);
        if (!it || it.state !== "in_raid" || it.matchId !== report.matchId) {
          skipped.push(s.uid);
          continue;
        }
        await applyMove(
          tx,
          it,
          {
            state: "in_stash",
            ownerId: user!.id,
            matchId: null,
            loadoutId: null,
            durability: Math.min(it.durability, fromRaidDur(s.def, s.dur)),
            lockRaidsDelta,
            bind: allocated.has(it.id),
          },
          { reason: "extract", refId: ref },
        );
      } else if (d.cat === "junk") {
        junk.push(s);
      } else if (!guest && s.qty > 0 && Number.isSafeInteger(s.qty)) {
        await addStack(tx, user!.id, d.id, s.qty);
      }
    }
    for (const s of report.lost) {
      if (!s.uid || !itemDef(s.def)?.unique) continue;
      pool.push({
        id: s.uid,
        reportedPct: fromRaidDur(s.def, s.dur),
        broke: report.exit === "dead",
        reason: LOST_REASON[report.exit] ?? "timeout",
        refId: ref,
      });
    }
    for (const s of report.unplaced ?? []) {
      if (!s.uid || !itemDef(s.def)?.unique) continue;
      pool.push({ id: s.uid, reportedPct: fromRaidDur(s.def, s.dur), broke: false, reason: "return", refId: ref, taxable: false });
    }
    const poolRes = await enterPool(tx, report.matchId, pool);
    skipped.push(...poolRes.skipped);
    for (const s of report.destroyed) {
      if (!s.uid) continue;
      const it = await lockItem(tx, s.uid);
      if (!it || it.state !== "in_raid" || it.matchId !== report.matchId) {
        skipped.push(s.uid);
        continue;
      }
      await applyMove(
        tx,
        it,
        { state: "destroyed", ownerId: null, matchId: null, loadoutId: null, durability: 0 },
        { reason: "destroy", refId: ref },
      );
    }

    // Junk autosell with the dog-tag rules (registered extractors only; guests see the plain amount).
    let sale: { total: number; lines: JunkSellLine[] };
    if (guest) {
      sale = junkSellCr(junk, autosellMult);
    } else {
      const mults = await dogTagMults(tx, user!.id, report.matchId, junk, now);
      sale = junkSellCr(junk, autosellMult, 0, (i) => mults[i] ?? 1);
    }
    // A live entry with no unique (the free kit): junk sells at FREE_KIT.AUTOSELL_MULT (dog tags keep their price).
    if (live && entry.free_kit) sale = freeKitSale(sale);
    let credited = 0;
    if (!guest && sale.total > 0) {
      const c = await credit(tx, user!.id, sale.total, "autosell", `exit:${ref}`);
      if (c.ok && c.applied) credited = sale.total;
    }

    const npcKills = npcKillCount(report);
    const guardKills = Math.min(npcKills, Math.max(0, Math.floor(Number(report.stats?.guardKills ?? 0)) || 0));
    const bossKills = Math.max(0, Math.min(16, Math.floor(Number(report.stats?.bossKills ?? 0)) || 0));
    let xp = 0;
    let level = 0;
    let levelBefore = 0;
    let xpLines: XpLine[] = [];
    let xpGrind = 0;
    let pvpRanked = 0;
    if (!guest) {
      levelBefore = levelForXp(Number(user!.xp));
      pvpRanked = await recordPvpKills(tx, {
        killerId: user!.id,
        victims: report.victims ?? [],
        matchId: report.matchId,
        entryId,
        cycleId: Number(entry.cycle_id),
        now,
      });
      const dayStart = utcDayStart(now);
      const g = await tx.execute<{ grind: number; first: number }>(sql`
        select coalesce(sum(xp_grind), 0)::int as grind,
               count(*) filter (where exit = 'extract' and on_map_ms >= ${XP.MIN_ONMAP_MS})::int as first
        from raid_exits where user_id = ${user!.id} and at >= ${dayStart} and entry_id <> ${entryId}`);
      const r = xpForExit({
        exit: report.exit,
        onMapMs,
        haulCr: sale.lines.filter((l) => l.def !== "junk_dogtag").reduce((a, l) => a + l.cr, 0),
        containers: Number(report.stats?.containersSearched ?? 0),
        marauders: npcKills - guardKills,
        guards: guardKills,
        bosses: bossKills,
        rankedPvp: pvpRanked,
        grindToday: Number(g.rows[0]?.grind ?? 0),
        firstExtractToday: Number(g.rows[0]?.first ?? 0) === 0,
      });
      xp = r.total;
      xpLines = r.lines;
      xpGrind = r.grind;
      const total = Number(user!.xp) + xp;
      level = levelForXp(total);
      await tx.execute(
        sql`update users set xp = ${total}, level = ${level}, matches_played = matches_played + 1 where id = ${user!.id}`,
      );
      if (entry.loadout_id) {
        await tx
          .update(loadouts)
          .set({ status: "settled", closedAt: now })
          .where(and(eq(loadouts.id, entry.loadout_id), eq(loadouts.status, "in_raid")));
      }
    }
    await tx
      .update(raidEntries)
      .set({ status: "exited", settledAt: now })
      .where(and(eq(raidEntries.entryId, entryId), eq(raidEntries.status, "active")));
    await tx
      .update(raidExits)
      .set({
        credits: credited,
        sold: sale.lines,
        xp,
        xpLines,
        xpGrind,
        onMapMs: Math.min(onMapMs, 2_000_000_000),
        npcKills,
        bossKills,
        pvpRanked,
      })
      .where(eq(raidExits.entryId, entryId));
    if (skipped.length) console.warn(`[raids/exit] ${report.matchId} ${report.userId}: skipped uids ${skipped.join(",")}`);
    return {
      status: "applied",
      guest,
      credits: credited,
      sold: sale.lines,
      autosellMult,
      xp,
      level,
      skipped,
      xpLines,
      levelBefore,
      levelUp: !guest && level > levelBefore,
    };
  });
}

/**
 * D24: one pvp_kills row per registered victim of this entry (guests and self are skipped). A kill
 * is ranked while the (killer, victim) pair has fewer than XP.PVP_PAIR_PER_DAY ranked kills in the
 * last 24 h, earlier victims of this report included. Idempotent through the raid_exits insert of
 * the same transaction. Returns the ranked count.
 */
async function recordPvpKills(
  tx: Tx,
  a: { killerId: string; victims: readonly string[]; matchId: string; entryId: string; cycleId: number; now: Date },
): Promise<number> {
  const ids = [...new Set(a.victims.filter((v) => isUuid(v) && v !== a.killerId))];
  if (ids.length === 0) return 0;
  const reg = await tx.execute<{ id: string }>(
    sql`select id from users where id in (${sql.join(ids.map((v) => sql`${v}::uuid`), sql`, `)})`,
  );
  const registered = new Set(reg.rows.map((r) => r.id));
  const since = new Date(a.now.getTime() - 24 * 3600_000);
  let ranked = 0;
  for (const v of a.victims) {
    if (!registered.has(v)) continue;
    // Rows of this report are inserted as we go, so the count already includes earlier victims here.
    const prior = await tx.execute<{ n: number }>(sql`
      select count(*)::int as n from pvp_kills
      where killer_id = ${a.killerId} and victim_id = ${v} and ranked and at > ${since}`);
    const isRanked = Number(prior.rows[0]?.n ?? 0) < XP.PVP_PAIR_PER_DAY;
    if (isRanked) ranked++;
    await tx.insert(pvpKills).values({
      killerId: a.killerId,
      victimId: v,
      matchId: a.matchId,
      entryId: a.entryId,
      cycleId: a.cycleId,
      ranked: isRanked,
      at: a.now,
    });
  }
  return ranked;
}

/**
 * NPC MODEL v5: marauders + guards this human killed (RaidStats.npcKills; bosses count in
 * bossKills), capped at NPC.MAX_PER_RAID so an NPC sweep's XP stays bounded.
 */
export function npcKillCount(report: Pick<PlayerExitReport, "stats">): number {
  const n = Math.floor(Number(report.stats?.npcKills ?? 0));
  return Number.isFinite(n) ? Math.max(0, Math.min(NPC.MAX_PER_RAID, n)) : 0;
}

/**
 * Per-line dog-tag multiplier (index = position in `junk`): tags of the same victim extracted by the
 * same user inside DOG_TAG.REPEAT_WINDOW_MS are paid for the first REPEAT_FREE only; WORLD v6 (D22):
 * a tag whose killer (`by`) is not this user pays DOG_TAG.NON_KILLER_MULT. Records every
 * tag in dog_tag_payouts so later raids see it.
 */
async function dogTagMults(
  tx: Tx,
  userId: string,
  matchId: string,
  junk: SettledItem[],
  now: Date,
): Promise<number[]> {
  const out: number[] = [];
  const since = new Date(now.getTime() - DOG_TAG.REPEAT_WINDOW_MS);
  const paidHere = new Map<string, number>();
  for (let i = 0; i < junk.length; i++) {
    const s = junk[i]!;
    if (s.def !== "junk_dogtag") {
      out.push(1);
      continue;
    }
    const key = s.victim ? s.victim : `nick:${s.label ?? ""}`;
    const prior = await tx.execute<{ n: number }>(sql`
      select count(*)::int as n from dog_tag_payouts
      where extractor_id = ${userId} and victim_key = ${key} and paid and at > ${since}`);
    const already = Number(prior.rows[0]?.n ?? 0) + (paidHere.get(key) ?? 0);
    const pair = dogTagPairMult(already);
    const m = pair * (s.by !== userId ? DOG_TAG.NON_KILLER_MULT : 1);
    out.push(m);
    if (pair) paidHere.set(key, (paidHere.get(key) ?? 0) + 1);
    await tx
      .insert(dogTagPayouts)
      .values({ extractorId: userId, victimKey: key, matchId, paid: pair === 1, cr: Math.floor(dogTagCr(s.lvl ?? 0) * m), at: now });
  }
  return out;
}

// ============================================================================ end

export interface EndResult {
  status: "applied" | "duplicate" | "voided";
  pooled: number;
  destroyed: number;
  /** Items still in_raid after leftOnMap (missing from every report): swept into the pool. */
  swept: number;
  skipped: string[];
  /** WORLD v6: active entries the report did not list (never materialized): voided, gear back. */
  voidedEntries: string[];
  /** A6: uniques that expired on the map and went to the treasury. */
  treasury: number;
}

/**
 * Voids one never-materialized entry (raids/end, spec §4.4 step 2): its loadout items still in_raid
 * go back to the owner's stash (reason void, ref entryId), its pool allocations still in_raid return
 * to the pool untaxed (reason return), its loadout is voided (fungibles refunded), the entry → voided.
 */
async function voidEntryTx(
  tx: Tx,
  matchId: string,
  e: { entry_id: string; user_id: string; loadout_id: string | null },
  now: Date,
): Promise<void> {
  if (e.loadout_id) {
    for (const it of await lockLoadoutItems(tx, e.loadout_id)) {
      if (it.matchId !== matchId) continue;
      await applyMove(tx, it, { state: "in_stash", matchId: null, loadoutId: null }, { reason: "void", refId: e.entry_id });
    }
  }
  const al = await tx.execute<{ item_id: string }>(sql`
    select distinct item_id from item_events
    where ref_id = ${e.entry_id} and match_id = ${matchId} and reason in ('alloc', 'alloc_boss', 'alloc_npc')`);
  await enterPool(
    tx,
    matchId,
    al.rows.map((r) => ({ id: r.item_id, broke: false, reason: "return", refId: e.entry_id, taxable: false })),
  );
  if (e.loadout_id) await releaseLoadout(tx, e.loadout_id, e.user_id, "voided", "void");
  await tx
    .update(raidEntries)
    .set({ status: "voided", settledAt: now })
    .where(and(eq(raidEntries.entryId, e.entry_id), eq(raidEntries.status, "active")));
}

/**
 * POST /api/raids/end (WORLD v6 wipe; running rows of pre-v6 matches settle the same way). Idempotent on raids.status:
 * 1. WORLD v6: active entries not in `report.entries` never materialized → voided first (gear back,
 *    allocations to the pool untaxed).
 * 2. A6 expiry: `expired` (player corpse / ground uniques) → treasury, no wear, no tax step (reason
 *    expire, ref matchId); `expiredToPool` (NPC-corpse pool items) → lost pool untaxed.
 * 3. leftOnMap uniques → pool with no wear (reason left); pool allocations of this match re-enter
 *    untaxed (D20). Then a defensive sweep of anything still in_raid (logged), taxed likewise.
 * 4. Listed entries still active (no exit report: an anomaly) → voided so the one-active index frees.
 * 5. Remaining in_raid loadouts settle, the raid becomes `settled`, the humans-only scoreboard goes
 *    to match_results (one participant row per entry).
 * Contract for the game server: post every exit report BEFORE the end report.
 */
export async function applyEnd(db: Db, report: MatchEndReport, now = new Date()): Promise<EndResult> {
  return db.transaction(async (tx) => {
    await ensureRaid(tx, report.matchId, report.mapId, report.matchSeed, now);
    const raid = (await lockRaid(tx, report.matchId, "update"))!;
    const empty = { pooled: 0, destroyed: 0, swept: 0, skipped: [] as string[], voidedEntries: [] as string[], treasury: 0 };
    if (raid.status === "voided") return { status: "voided", ...empty };
    if (raid.status === "settled") return { status: "duplicate", ...empty };

    if (report.minted.length && raid.mode === "live") {
      console.warn(`[raids/end] ${report.matchId}: live match reported ${report.minted.length} minted uniques (ignored)`);
    }

    const voidedEntries: string[] = [];
    if (report.entries) {
      const listed = new Set(report.entries);
      const act = await tx.execute<{ entry_id: string; user_id: string; loadout_id: string | null }>(sql`
        select entry_id, user_id, loadout_id from raid_entries
        where match_id = ${report.matchId} and status = 'active' order by entry_id for update`);
      for (const e of act.rows) {
        if (listed.has(e.entry_id)) continue;
        await voidEntryTx(tx, report.matchId, e, now);
        voidedEntries.push(e.entry_id);
      }
      if (voidedEntries.length) console.warn(`[raids/end] ${report.matchId}: voided unlisted entries ${voidedEntries.join(", ")}`);
    }

    const allocated = await poolAllocatedIds(tx, report.matchId);
    const uniques = (xs: readonly SettledItem[] | undefined) => (xs ?? []).filter((s) => s.uid && itemDef(s.def)?.unique);
    const exp = await expireToTreasury(
      tx,
      report.matchId,
      uniques(report.expired).map((s) => ({ id: s.uid, reportedPct: fromRaidDur(s.def, s.dur) })),
    );
    const expPool = await enterPool(
      tx,
      report.matchId,
      uniques(report.expiredToPool).map((s) => ({
        id: s.uid,
        reportedPct: fromRaidDur(s.def, s.dur),
        broke: false,
        reason: "expire",
        taxable: false,
      })),
    );
    const left = await enterPool(
      tx,
      report.matchId,
      uniques(report.leftOnMap).map((s) => ({
        id: s.uid,
        reportedPct: fromRaidDur(s.def, s.dur),
        broke: false,
        reason: "left",
        taxable: !allocated.has(s.uid),
      })),
    );
    // @deprecated (one release, NPC MODEL v5): only pre-v5 servers with player-bots send botLost /
    // botDestroyed (in-flight and orphan reports). v5 NPCs never break (noBreak) nor wear pool
    // gear, so a v5 report has neither and settles through leftOnMap alone.
    const botLost = await enterPool(
      tx,
      report.matchId,
      uniques(report.botLost).map((s) => ({ id: s.uid, reportedPct: fromRaidDur(s.def, s.dur), broke: true, reason: "bot_break" })),
    );
    const botDestroyed: string[] = [];
    for (const s of report.botDestroyed ?? []) {
      if (!s.uid) continue;
      const it = await lockItem(tx, s.uid);
      if (!it || it.state !== "in_raid" || it.matchId !== report.matchId) continue;
      await applyMove(
        tx,
        it,
        { state: "destroyed", ownerId: null, matchId: null, loadoutId: null, durability: 0 },
        { reason: "destroy", refId: report.matchId },
      );
      botDestroyed.push(it.id);
    }
    const rest = await lockMatchItems(tx, report.matchId);
    if (rest.length) {
      console.warn(
        `[raids/end] ${report.matchId}: sweeping ${rest.length} unreported items into the pool (${rest
          .slice(0, 8)
          .map((it) => `${it.defId}:${it.id}`)
          .join(", ")})`,
      );
    }
    const sweep = await enterPool(
      tx,
      report.matchId,
      rest.map((it) => ({ id: it.id, broke: false, reason: "sweep", taxable: !allocated.has(it.id) })),
    );

    const stray = await tx
      .update(raidEntries)
      .set({ status: "voided", settledAt: now })
      .where(and(eq(raidEntries.matchId, report.matchId), eq(raidEntries.status, "active")))
      .returning({ entryId: raidEntries.entryId });
    if (stray.length) {
      console.warn(`[raids/end] ${report.matchId}: listed entries without an exit report voided: ${stray.map((e) => e.entryId).join(", ")}`);
    }

    await tx
      .update(loadouts)
      .set({ status: "settled", closedAt: now })
      .where(and(eq(loadouts.matchId, report.matchId), eq(loadouts.status, "in_raid")));
    await tx.update(raids).set({ status: "settled", settledAt: now }).where(eq(raids.matchId, report.matchId));

    // One participant row per entry: a user's rows take that user's exits in time order.
    const exits = await tx.select().from(raidExits).where(eq(raidExits.matchId, report.matchId)).orderBy(asc(raidExits.at));
    const queue = new Map<string, SettledItem[][]>();
    for (const e of exits) queue.set(e.userId, [...(queue.get(e.userId) ?? []), e.report.extracted ?? []]);
    // The deprecated bot fields are settlement input only, never part of the stored scoreboard.
    const stored: MatchEndReport = { ...report };
    delete stored.botLost;
    delete stored.botDestroyed;
    const payload: MatchResultPayload = {
      ...stored,
      participants: humanParticipants(report.participants).map((p) => {
        const ex = p.userId ? queue.get(p.userId)?.shift() : undefined;
        return ex ? { ...p, extracted: ex } : p;
      }),
    };
    await tx
      .insert(matchResults)
      .values({
        matchId: report.matchId,
        mapSeed: report.matchSeed >>> 0,
        startedAt: new Date(report.startedAt),
        endedAt: new Date(report.endedAt),
        payload,
      })
      .onConflictDoNothing();
    return {
      status: "applied",
      pooled: left.pooled.length + botLost.pooled.length + sweep.pooled.length + expPool.pooled.length,
      destroyed:
        left.destroyed.length + botLost.destroyed.length + botDestroyed.length + sweep.destroyed.length + expPool.destroyed.length + exp.destroyed.length,
      swept: rest.length,
      skipped: [...left.skipped, ...botLost.skipped, ...exp.skipped, ...expPool.skipped],
      voidedEntries,
      treasury: exp.treasury.length,
    };
  });
}

/**
 * The humans of an end report (NPC MODEL v5: participants are humans only). Drops entries of
 * pre-v5 servers that still listed bots (isBot, or no userId), so match_results, the outcome
 * screen and the recent-raids list never show an NPC or a bot.
 */
export function humanParticipants<P extends { userId: string | null; isBot: boolean }>(ps: readonly P[]): P[] {
  return ps.filter((p) => !p.isBot && !!p.userId);
}

// ============================================================================ void

/**
 * Raids that never reported their end (server crash, lost end report; GDD §13), voided
 * RAID_VOID_GRACE_MS after `ends_at` (the wipe of a world shard; start + MATCH.DURATION_MS of a
 * legacy match): items still in_raid go back to their pre-raid owner when they came from a loadout,
 * pool allocations go back to the pool; loadouts still in_raid are voided and their fungibles
 * refunded; active entries are voided. Exits already applied stay applied ("void restores what is
 * unresolved"). Each raid is its own transaction with SKIP LOCKED, so the cron and a lazy call never
 * fight. `now` defaults to the world clock (ends_at is world time, addendum A1).
 */
export async function voidStale(db: Db, now = worldDate()): Promise<string[]> {
  const cutoff = new Date(now.getTime() - RAID_VOID_GRACE_MS);
  const cand = await db
    .select({ matchId: raids.matchId })
    .from(raids)
    .where(and(eq(raids.status, "running"), sql`${raids.endsAt} < ${cutoff}`));
  const voided: string[] = [];
  for (const { matchId } of cand) {
    if (await voidIf(db, matchId, now, (row) => new Date(row.ends_at) < cutoff)) voided.push(matchId);
  }
  return voided;
}

type RunningRaid = { status: string; started_at: Date; ends_at: Date; server_id: string; instance_id: string | null };

/** serverId / instanceId of a raids row: the v6 columns, else the legacy start request. */
const SERVER_ID_SQL = sql`coalesce(server_id, start_request->>'serverId', 'default')`;
const INSTANCE_ID_SQL = sql`coalesce(instance_id, start_request->>'instanceId')`;

/** Void one raid in its own transaction if it is still running and `check` holds under the lock. */
async function voidIf(db: Db, matchId: string, now: Date, check: (row: RunningRaid) => boolean): Promise<boolean> {
  return db.transaction(async (tx) => {
    const r = await tx.execute<RunningRaid>(sql`
      select status, started_at, ends_at,
             ${SERVER_ID_SQL} as server_id,
             ${INSTANCE_ID_SQL} as instance_id
      from raids where match_id = ${matchId} for update skip locked`);
    const row = r.rows[0];
    if (!row || row.status !== "running" || !check(row)) return false;
    await voidRaidTx(tx, matchId, now);
    return true;
  });
}

/** Stored per serverId: the boot as the web saw it (bootedAt = web clock, sentAt = server clock). */
type BootRecord = GameServerBoot & { sentAt: number };

async function lastBoot(db: Db | Tx, serverId: string): Promise<BootRecord | null> {
  const r = await db.execute<{ value: unknown }>(sql`select value from economy_params where key = ${GS_BOOT_PARAM(serverId)}`);
  const v = r.rows[0]?.value as Partial<BootRecord> | undefined;
  return v && typeof v.instanceId === "string" && typeof v.bootedAt === "number"
    ? { serverId, instanceId: v.instanceId, bootedAt: v.bootedAt, sentAt: typeof v.sentAt === "number" ? v.sentAt : 0 }
    : null;
}

/**
 * serverId of a game server that did not set GAME_SERVER_ID (and of raids started before server ids
 * existed). Several processes may share it at once (regional servers, a rolling deploy), so a newer
 * boot under it does NOT prove the older process is gone: its raids are only voided by timeout.
 */
export const DEFAULT_GAME_SERVER_ID = "default";

/**
 * A raid whose game server is gone: a newer process of the same (explicit) serverId has booted
 * since it started (the raid carries another instanceId, or none — started before instance ids
 * existed). Never true for DEFAULT_GAME_SERVER_ID, whose processes are not unique.
 */
function orphanedBy(boot: GameServerBoot | null, row: RunningRaid): boolean {
  return (
    !!boot &&
    boot.serverId !== DEFAULT_GAME_SERVER_ID &&
    row.server_id === boot.serverId &&
    row.instance_id !== boot.instanceId &&
    new Date(row.started_at).getTime() <= boot.bootedAt
  );
}

/**
 * Lazy void for one user (lobby load, world join): the raid holding this user's loadout or active
 * entry (free-kit entries of a crashed process too) is voided RAID_USER_VOID_GRACE_MS after its
 * `ends_at`, or at once when its game server is gone (orphanedBy the last boot of that serverId), so
 * the gear comes back without waiting for the global cron. Returns the voided match ids.
 */
export async function voidStaleForUser(db: Db, userId: string, now = worldDate()): Promise<string[]> {
  const cand = await db.execute<{ match_id: string; server_id: string }>(sql`
    select distinct r.match_id, coalesce(r.server_id, r.start_request->>'serverId', 'default') as server_id
    from raids r
    where r.status = 'running' and r.match_id in (
      select l.match_id from loadouts l where l.user_id = ${userId} and l.status = 'in_raid' and l.match_id is not null
      union
      select e.match_id from raid_entries e where e.user_id = ${userId} and e.status = 'active')`);
  const cutoff = now.getTime() - RAID_USER_VOID_GRACE_MS;
  const voided: string[] = [];
  for (const { match_id: matchId, server_id: serverId } of cand.rows) {
    const boot = await lastBoot(db, serverId);
    const done = await voidIf(db, matchId, now, (row) => new Date(row.ends_at).getTime() < cutoff || orphanedBy(boot, row));
    if (done) {
      console.warn(`[raids/void] ${matchId}: voided lazily for user ${userId}`);
      voided.push(matchId);
    }
  }
  return voided;
}

export interface VoidOrphansResult {
  status: "applied" | "stale";
  voided: string[];
}

/**
 * POST /api/raids/void-orphans (game server boot): records the boot of `boot.serverId` and voids
 * every running raid that serverId started under another instanceId — its process is gone, so
 * those raids can never report. Only for an explicit serverId: DEFAULT_GAME_SERVER_ID may be
 * shared by live processes, so nothing is voided for it. An announcement older than the recorded
 * one (a delayed retry of a previous boot) changes nothing. Idempotent.
 */
export async function voidOrphans(db: Db, boot: GameServerBoot, now = new Date()): Promise<VoidOrphansResult> {
  // The web's clock decides "started before this boot" (game server and web clocks may differ).
  const rec: BootRecord = { serverId: boot.serverId, instanceId: boot.instanceId, bootedAt: now.getTime(), sentAt: boot.bootedAt };
  const fresh = await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${GS_BOOT_PARAM(boot.serverId)}))`);
    const prev = await lastBoot(tx, boot.serverId);
    if (prev && prev.instanceId === boot.instanceId) return prev; // retry of this boot
    if (prev && prev.sentAt > boot.bootedAt) return null; // a delayed retry of an older boot
    await setParam(tx, GS_BOOT_PARAM(boot.serverId), rec);
    return rec;
  });
  if (!fresh) return { status: "stale", voided: [] };
  if (boot.serverId === DEFAULT_GAME_SERVER_ID) {
    // Another live process may share this serverId: its raids would be voided under it (409 on
    // every later exit). Recorded only; orphans of the default id fall to voidStale / the lazy void.
    console.warn(
      `[raids/void-orphans] ${boot.serverId}/${boot.instanceId}: serverId is not unique, orphans left to the stale timeout (set GAME_SERVER_ID per game server process group)`,
    );
    return { status: "applied", voided: [] };
  }
  const cand = await db.execute<{ match_id: string }>(sql`
    select match_id from raids
    where status = 'running' and started
      and ${SERVER_ID_SQL} = ${boot.serverId}
      and coalesce(${INSTANCE_ID_SQL}, '') <> ${boot.instanceId}`);
  const voided: string[] = [];
  for (const { match_id: matchId } of cand.rows) {
    if (await voidIf(db, matchId, now, (row) => orphanedBy(fresh, row))) voided.push(matchId);
  }
  if (voided.length) console.warn(`[raids/void-orphans] ${boot.serverId}/${boot.instanceId}: voided ${voided.join(", ")}`);
  return { status: "applied", voided };
}

async function voidRaidTx(tx: Tx, matchId: string, now: Date): Promise<void> {
  for (const it of await lockMatchItems(tx, matchId)) {
    if (it.loadoutId && it.ownerId) {
      await applyMove(tx, it, { state: "in_stash", matchId: null, loadoutId: null }, { reason: "void", refId: matchId });
    } else {
      await applyMove(
        tx,
        it,
        { state: "lost_pool", ownerId: null, matchId: null, loadoutId: null },
        { reason: "void", refId: matchId },
      );
    }
  }
  const los = await tx
    .select({ id: loadouts.id, userId: loadouts.userId })
    .from(loadouts)
    .where(and(eq(loadouts.matchId, matchId), inArray(loadouts.status, ["in_raid"])));
  for (const lo of los) await releaseLoadout(tx, lo.id, lo.userId, "voided", "void");
  await tx
    .update(raidEntries)
    .set({ status: "voided", settledAt: now })
    .where(and(eq(raidEntries.matchId, matchId), eq(raidEntries.status, "active")));
  await tx.update(raids).set({ status: "voided", settledAt: now }).where(eq(raids.matchId, matchId));
}
