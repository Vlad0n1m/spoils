import { and, eq, inArray, sql } from "drizzle-orm";
import {
  DOG_TAG,
  FREE_KIT,
  MATCH,
  NPC,
  PROGRESSION,
  dogTagCr,
  dogTagPairMult,
  itemDef,
  junkSellCr,
  levelForXp,
  riskUnitOf,
  type GameServerBoot,
  type JunkSellLine,
  type LoadoutSnapshot,
  type MatchEndReport,
  type PlayerExitReport,
  type RaidStartRequest,
  type RaidStartResponse,
  type SettledItem,
} from "@extract/shared";
import {
  dogTagPayouts,
  loadouts,
  matchResults,
  raidExits,
  raids,
  type MatchResultPayload,
} from "../../db/schema";
import { credit } from "../economy/ledger";
import { PARAM, getNumberParam, setParam } from "../economy/params";
import { allocatePool, enterPool, type PoolCandidate } from "../economy/pool";
import { fromRaidDur, toRaidDur } from "../economy/value";
import { LOADOUT_LOCK_TTL_MS, type Db, type Tx } from "./db";
import { releaseLoadout } from "./loadout";
import { applyMove, isUuid, lockItem, lockMatchItems, addStack } from "./transition";

/** A raid still `running` this long after it started never reported its end: void it. */
export const RAID_VOID_AFTER_MS = MATCH.DURATION_MS + 10 * 60_000;
/**
 * Lazy per-user void (lobby load, matches/join): the caller's own raid is voided sooner, so a
 * player whose game server crashed gets their gear back 5 min after the match would have ended.
 */
export const RAID_USER_VOID_AFTER_MS = MATCH.DURATION_MS + 5 * 60_000;
/** economy_params key of the last boot of a game server (GameServerBoot), per serverId. */
export const GS_BOOT_PARAM = (serverId: string) => `gs_boot:${serverId}`;

type RaidRow = {
  match_id: string;
  status: "running" | "settled" | "voided";
  mode: "live" | "demo";
  started: boolean;
  start_response: RaidStartResponse | null;
};

async function lockRaid(tx: Tx, matchId: string, mode: "share" | "update"): Promise<RaidRow | null> {
  const res = await tx.execute<RaidRow>(
    mode === "share"
      ? sql`select match_id, status, mode, started, start_response from raids where match_id = ${matchId} for share`
      : sql`select match_id, status, mode, started, start_response from raids where match_id = ${matchId} for update`,
  );
  return res.rows[0] ?? null;
}

/**
 * Did `userId` enter this LIVE raid on the free kit (no accepted loadout, or one without any unique)?
 * Demo raids (no raids/start, or the demo fallback) never count: everyone there is on free kits.
 */
export function freeKitRaid(raid: Pick<RaidRow, "mode" | "start_response">, userId: string): boolean {
  if (raid.mode !== "live" || !raid.start_response) return false;
  const acc = raid.start_response.accepted.find((a) => a.userId === userId);
  return !acc || !acc.entries.some((e) => !!e.uid);
}

/**
 * Did `userId` enter this LIVE raid without risking anything: the free kit, or only bound gear?
 * (Demo raids: false — they allocate no pool items.)
 */
async function riskFreeRaider(tx: Tx, raid: Pick<RaidRow, "mode" | "start_response">, userId: string): Promise<boolean> {
  if (raid.mode !== "live" || !raid.start_response) return false;
  const acc = raid.start_response.accepted.find((a) => a.userId === userId);
  const uids = (acc?.entries ?? []).map((e) => e.uid).filter((u): u is string => !!u && isUuid(u));
  if (uids.length === 0) return true;
  const r = await tx.execute<{ n: number }>(
    sql`select count(*)::int as n from items where id in (${sql.join(uids.map((u) => sql`${u}::uuid`), sql`, `)}) and bound = false`,
  );
  return Number(r.rows[0]?.n ?? 0) === 0;
}

/** Items the pool allocation put into this match (containers, bosses, carriers). */
async function poolAllocatedIds(tx: Tx, matchId: string): Promise<Set<string>> {
  const r = await tx.execute<{ item_id: string }>(
    sql`select item_id from item_events where ref_id = ${matchId} and reason in ('alloc', 'alloc_boss', 'alloc_npc')`,
  );
  return new Set(r.rows.map((x) => x.item_id));
}

/** Junk lines (not dog tags) of a free-kit raid's sale at FREE_KIT.AUTOSELL_MULT. */
function freeKitSale(sale: { total: number; lines: JunkSellLine[] }): { total: number; lines: JunkSellLine[] } {
  const lines = sale.lines.map((l) => (l.def === "junk_dogtag" ? l : { ...l, cr: Math.floor(l.cr * FREE_KIT.AUTOSELL_MULT) }));
  return { total: lines.reduce((a, l) => a + l.cr, 0), lines };
}

/**
 * Exit/end reports for a match whose raids/start never reached the web (the game server fell back
 * to demo mode) still settle: the row is created lazily with started=false. No item of such a
 * match is in_raid in the DB, so only fungibles (junk CR, ammo, meds) and XP apply.
 */
async function ensureRaid(tx: Tx, matchId: string, mapId: string, matchSeed: number): Promise<void> {
  await tx
    .insert(raids)
    .values({ matchId, mode: "demo", mapId, matchSeed, status: "running", started: false })
    .onConflictDoNothing();
}

// ============================================================================ start

/**
 * POST /api/raids/start (MatchmakingRoom.launch, retried). Idempotent per matchId: the raids row
 * is inserted first (a concurrent retry blocks on the primary key), and a replay returns the
 * stored response unchanged. Per player: the loadout must be `locked`, belong to the user and be
 * younger than LOADOUT_LOCK_TTL_MS; accepted loadouts move locked → in_raid and their items get
 * match_id. Then the lost pool is released (live mode only, allocatePool, LOOT ECONOMY v4): risk
 * units of the accepted loadouts decide the count (round(k × risk), capped), the spawned bosses
 * (req.bosses) get the best items first plus a display top-up while someone risked gear, the rest
 * lands only in T3/T4 containers and, NPC MODEL v5, on spawned T3/T4 marauders (req.carriers, one
 * each). A lobby of free kits gets no uniques at all. v5 raids are humans only: `players` never
 * holds an NPC, and only accepted loadouts add risk units. Demo mode releases nothing (the server
 * never mints uniques onto NPCs).
 */
export async function startRaid(db: Db, req: RaidStartRequest, now = new Date()): Promise<RaidStartResponse> {
  return db.transaction(async (tx) => {
    const ins = await tx
      .insert(raids)
      .values({
        matchId: req.matchId,
        mode: req.mode,
        mapId: req.mapId,
        matchSeed: req.matchSeed,
        status: "running",
        started: true,
        startRequest: req,
        startedAt: now,
      })
      .onConflictDoNothing()
      .returning({ matchId: raids.matchId });
    if (ins.length === 0) {
      const existing = await lockRaid(tx, req.matchId, "share");
      if (existing?.start_response) return existing.start_response;
      // Row created lazily by an early exit report, or a start that crashed mid-way cannot
      // exist (same tx). Answer with nothing allocated rather than double-allocating.
      return { accepted: [], rejected: [], containerLoot: {}, autosellMult: await getNumberParam(tx, PARAM.AUTOSELL_MULT) };
    }

    const accepted: LoadoutSnapshot[] = [];
    const rejected: RaidStartResponse["rejected"] = [];
    let riskUnits = 0;
    const seen = new Set<string>();
    for (const p of req.players) {
      if (!p.loadoutId || seen.has(p.userId)) continue;
      seen.add(p.userId);
      if (!isUuid(p.loadoutId) || !isUuid(p.userId)) {
        rejected.push({ userId: p.userId, reason: "not_locked" });
        continue;
      }
      const lr = await tx.execute<{ id: string; user_id: string; status: string; locked_at: Date; entries: LoadoutSnapshot["entries"] }>(
        sql`select id, user_id, status, locked_at, entries from loadouts where id = ${p.loadoutId} for update`,
      );
      const lo = lr.rows[0];
      if (!lo || lo.status !== "locked") {
        rejected.push({ userId: p.userId, reason: "not_locked" });
        continue;
      }
      if (lo.user_id !== p.userId) {
        rejected.push({ userId: p.userId, reason: "wrong_user" });
        continue;
      }
      if (new Date(lo.locked_at).getTime() < now.getTime() - LOADOUT_LOCK_TTL_MS) {
        await releaseLoadout(tx, lo.id, lo.user_id, "cancelled", "expire");
        rejected.push({ userId: p.userId, reason: "expired" });
        continue;
      }
      await tx
        .update(loadouts)
        .set({ status: "in_raid", matchId: req.matchId, startedAt: now })
        .where(and(eq(loadouts.id, lo.id), eq(loadouts.status, "locked")));
      const entries: LoadoutSnapshot["entries"] = [];
      for (const e of lo.entries) {
        if (!e.uid) {
          entries.push({ ...e, dur: toRaidDur(e.def, e.dur) });
          continue;
        }
        const it = await lockItem(tx, e.uid);
        // A locked item can only be in_raid with this loadout; anything else is dropped from
        // the snapshot so the server can never spawn an item the DB does not hold for it.
        if (!it || it.state !== "in_raid" || it.loadoutId !== lo.id || it.matchId !== null) continue;
        await applyMove(tx, it, { state: "in_raid", matchId: req.matchId }, { reason: "start", refId: req.matchId });
        entries.push({ key: e.key, uid: it.id, def: it.defId, qty: 1, rarity: it.rarity, dur: toRaidDur(it.defId, it.durability) });
        // Bound or worn-out (< POOL.RISK_MIN_DUR_PCT) gear rides along but risks nothing for the pool.
        riskUnits += riskUnitOf({ bound: it.bound, dur: it.durability });
      }
      const lv = await tx.execute<{ level: number }>(sql`select level from users where id = ${lo.user_id}`);
      accepted.push({ loadoutId: lo.id, userId: lo.user_id, level: Number(lv.rows[0]?.level ?? 1), entries });
    }

    const alloc =
      req.mode === "live"
        ? await allocatePool(tx, {
            matchId: req.matchId,
            matchSeed: req.matchSeed,
            allocSeed: req.allocSeed,
            containers: req.containers,
            bosses: req.bosses,
            carriers: req.carriers,
            riskUnits,
          })
        : { containerLoot: {}, released: 0, boss: 0, carrier: 0, risk: 0 };
    const response: RaidStartResponse = {
      accepted,
      rejected,
      containerLoot: alloc.containerLoot,
      autosellMult: await getNumberParam(tx, PARAM.AUTOSELL_MULT),
    };
    await tx
      .update(raids)
      .set({ startResponse: response, riskUnits, poolReleased: alloc.released })
      .where(eq(raids.matchId, req.matchId));
    return response;
  });
}

// ============================================================================ exit

export interface ExitResult {
  status: "applied" | "duplicate" | "voided";
  guest: boolean;
  /** CR credited (registered) — 0 for guests. */
  credits: number;
  /** Receipt at the applied multiplier (guests: what it would have paid). */
  sold: JunkSellLine[];
  autosellMult: number;
  xp: number;
  level: number;
  /** Uniques the report named that the DB did not hold in_raid for this match. */
  skipped: string[];
}

/**
 * POST /api/raids/exit: one human left the map (extract, death, timeout). Idempotent on the
 * raid_exits primary key: a replay returns the stored result and changes nothing.
 * - extracted uniques: in_raid → in_stash, owner = extractor, lock_raids − 1 (anyone extracting
 *   counts, closing the twink-kills-twink loop); guests: → lost pool (they keep nothing).
 * - extracted ammo/meds: stash_stacks; junk: autosell junkSellCr × autosell_mult, dog tags with
 *   the 24 h pair-repeat rule, one credit_ledger row (autosell, exit:<matchId>).
 * - lost: death = broke (−8 dur into the pool), timeout = no wear; destroyed: → destroyed.
 * - XP / level / matches_played (raid + extract + human kills + bosses + NPC MODEL v5 npcKills at
 *   XP_NPC, capped at NPC.MAX_PER_RAID); the user's loadout of this match → settled.
 * Refused (status voided → HTTP 409) once the raid was voided, so the server stops retrying.
 */
export async function applyExit(db: Db, report: PlayerExitReport, now = new Date()): Promise<ExitResult> {
  return db.transaction(async (tx) => {
    await ensureRaid(tx, report.matchId, "steppe", 0);
    const raid = (await lockRaid(tx, report.matchId, "share"))!;
    const autosellMult = await getNumberParam(tx, PARAM.AUTOSELL_MULT);
    const base: ExitResult = { status: "voided", guest: false, credits: 0, sold: [], autosellMult, xp: 0, level: 0, skipped: [] };
    if (raid.status === "voided") return base;

    const userRes = await tx.execute<{ id: string; xp: number; level: number }>(
      sql`select id, xp, level from users where id = ${report.userId} for update`,
    );
    const user = userRes.rows[0] ?? null;
    const guest = !user;

    const ins = await tx
      .insert(raidExits)
      .values({ matchId: report.matchId, userId: report.userId, exit: report.exit, report, guest, at: now })
      .onConflictDoNothing()
      .returning({ userId: raidExits.userId });
    if (ins.length === 0) {
      const prev = await tx
        .select()
        .from(raidExits)
        .where(and(eq(raidExits.matchId, report.matchId), eq(raidExits.userId, report.userId)));
      const r = prev[0]!;
      return {
        status: "duplicate",
        guest: r.guest,
        credits: r.credits,
        sold: r.sold,
        autosellMult,
        xp: r.xp,
        level: Number(user?.level ?? 0),
        skipped: [],
      };
    }

    const skipped: string[] = [];
    const pool: PoolCandidate[] = [];
    const junk: SettledItem[] = [];
    // v5 review (risk ties reward per player): a pool unique released into this match (container,
    // boss or carrier allocation) that a player who risked nothing extracts arrives BOUND — usable,
    // never sellable. Alt farms on free / bound kits cannot turn other players' risk into SOL.
    const bindPool = !guest && (await riskFreeRaider(tx, raid, report.userId));
    const allocated = bindPool ? await poolAllocatedIds(tx, report.matchId) : new Set<string>();

    for (const s of report.extracted) {
      const d = itemDef(s.def);
      if (!d) continue;
      if (d.unique) {
        if (!s.uid) continue;
        if (guest) {
          pool.push({ id: s.uid, reportedPct: fromRaidDur(s.def, s.dur), broke: false, reason: "guest" });
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
            lockRaidsDelta: -1,
            bind: allocated.has(it.id),
          },
          { reason: "extract", refId: report.matchId },
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
        reason: report.exit === "dead" ? "break" : "timeout",
      });
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
        { reason: "destroy", refId: report.matchId },
      );
    }

    // Junk autosell with the dog-tag pair rule (registered extractors only pay attention to it;
    // guests see the plain "would sell for" amount).
    let sale: { total: number; lines: JunkSellLine[] };
    if (guest) {
      sale = junkSellCr(junk, autosellMult);
    } else {
      const mults = await dogTagMults(tx, user!.id, report.matchId, junk, now);
      sale = junkSellCr(junk, autosellMult, 0, (i) => mults[i] ?? 1);
    }
    // A live raid entered with no unique (the free kit): its junk sells at FREE_KIT.AUTOSELL_MULT
    // (dog tags keep their price — they reward fights, not hauls).
    if (freeKitRaid(raid, report.userId)) sale = freeKitSale(sale);
    let credited = 0;
    if (!guest && sale.total > 0) {
      const c = await credit(tx, user!.id, sale.total, "autosell", `exit:${report.matchId}`);
      if (c.ok && c.applied) credited = sale.total;
    }

    let xp = 0;
    let level = 0;
    if (!guest) {
      xp =
        PROGRESSION.XP_RAID +
        (report.exit === "extract" ? PROGRESSION.XP_EXTRACT : 0) +
        Math.max(0, report.kills) * PROGRESSION.XP_KILL +
        Math.max(0, report.stats?.bossKills ?? 0) * PROGRESSION.XP_BOSS +
        npcKillXp(report);
      const total = Number(user!.xp) + xp;
      level = levelForXp(total);
      await tx.execute(
        sql`update users set xp = ${total}, level = ${level}, matches_played = matches_played + 1 where id = ${user!.id}`,
      );
      await tx
        .update(loadouts)
        .set({ status: "settled", closedAt: now })
        .where(and(eq(loadouts.userId, user!.id), eq(loadouts.matchId, report.matchId), eq(loadouts.status, "in_raid")));
    }
    await tx
      .update(raidExits)
      .set({ credits: credited, sold: sale.lines, xp })
      .where(and(eq(raidExits.matchId, report.matchId), eq(raidExits.userId, report.userId)));
    if (skipped.length) console.warn(`[raids/exit] ${report.matchId} ${report.userId}: skipped uids ${skipped.join(",")}`);
    return { status: "applied", guest, credits: credited, sold: sale.lines, autosellMult, xp, level, skipped };
  });
}

/**
 * XP for NPC kills (v5): marauders at XP_NPC, guards (RaidStats.guardKills, a subset of npcKills)
 * at XP_GUARD; bosses are paid via bossKills. npcKillCount caps the total at NPC.MAX_PER_RAID.
 */
export function npcKillXp(report: Pick<PlayerExitReport, "stats">): number {
  const n = npcKillCount(report);
  const g = Math.min(n, Math.max(0, Math.floor(Number(report.stats?.guardKills ?? 0)) || 0));
  return (n - g) * PROGRESSION.XP_NPC + g * PROGRESSION.XP_GUARD;
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
 * Per-line dog-tag multiplier (0 or 1, index = position in `junk`): tags of the same victim
 * extracted by the same user inside DOG_TAG.REPEAT_WINDOW_MS are paid for the first REPEAT_FREE
 * only. Records every tag in dog_tag_payouts so later raids see it.
 */
async function dogTagMults(tx: Tx, userId: string, matchId: string, junk: SettledItem[], now: Date): Promise<number[]> {
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
    const m = dogTagPairMult(already);
    out.push(m);
    if (m) paidHere.set(key, (paidHere.get(key) ?? 0) + 1);
    await tx.insert(dogTagPayouts).values({ extractorId: userId, victimKey: key, matchId, paid: m === 1, cr: dogTagCr(s.lvl ?? 0) * m, at: now });
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
}

/**
 * POST /api/raids/end. leftOnMap uniques enter the pool with no wear (NPC MODEL v5: also pool
 * uniques on living or unlooted NPCs, boss bags and carrier marauders), then a defensive sweep moves
 * anything of this match still in_raid into the pool (logged as an anomaly — every uid should
 * have been reported exactly once), remaining in_raid loadouts settle, the raid becomes `settled`
 * and the scoreboard goes to match_results with humans only (humanParticipants; NPC totals ride in
 * npcSummary). Idempotent on raids.status.
 * Contract for the game server: post every exit report BEFORE the end report, otherwise a late
 * exit finds its items already swept.
 */
export async function applyEnd(db: Db, report: MatchEndReport, now = new Date()): Promise<EndResult> {
  return db.transaction(async (tx) => {
    await ensureRaid(tx, report.matchId, report.mapId, report.matchSeed);
    const raid = (await lockRaid(tx, report.matchId, "update"))!;
    const empty = { pooled: 0, destroyed: 0, swept: 0, skipped: [] as string[] };
    if (raid.status === "voided") return { status: "voided", ...empty };
    if (raid.status === "settled") return { status: "duplicate", ...empty };

    if (report.minted.length && raid.mode === "live") {
      console.warn(`[raids/end] ${report.matchId}: live match reported ${report.minted.length} minted uniques (ignored)`);
    }
    const left = await enterPool(
      tx,
      report.matchId,
      report.leftOnMap
        .filter((s) => s.uid && itemDef(s.def)?.unique)
        .map((s) => ({ id: s.uid, reportedPct: fromRaidDur(s.def, s.dur), broke: false, reason: "left" })),
    );
    // @deprecated (one release, NPC MODEL v5): only pre-v5 servers with player-bots send botLost /
    // botDestroyed (in-flight and orphan reports). v5 NPCs never break (noBreak) nor wear pool
    // gear, so a v5 report has neither and settles through leftOnMap alone.
    const botLost = await enterPool(
      tx,
      report.matchId,
      (report.botLost ?? [])
        .filter((s) => s.uid && itemDef(s.def)?.unique)
        .map((s) => ({ id: s.uid, reportedPct: fromRaidDur(s.def, s.dur), broke: true, reason: "bot_break" })),
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
      rest.map((it) => ({ id: it.id, broke: false, reason: "sweep" })),
    );

    await tx
      .update(loadouts)
      .set({ status: "settled", closedAt: now })
      .where(and(eq(loadouts.matchId, report.matchId), eq(loadouts.status, "in_raid")));
    await tx.update(raids).set({ status: "settled", settledAt: now }).where(eq(raids.matchId, report.matchId));

    const exits = await tx.select().from(raidExits).where(eq(raidExits.matchId, report.matchId));
    const extractedBy = new Map(exits.map((e) => [e.userId, e.report.extracted]));
    // The deprecated bot fields are settlement input only, never part of the stored scoreboard.
    const stored: MatchEndReport = { ...report };
    delete stored.botLost;
    delete stored.botDestroyed;
    const payload: MatchResultPayload = {
      ...stored,
      participants: humanParticipants(report.participants).map((p) => {
        const ex = p.userId ? extractedBy.get(p.userId) : undefined;
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
      pooled: left.pooled.length + botLost.pooled.length + sweep.pooled.length,
      destroyed: left.destroyed.length + botLost.destroyed.length + botDestroyed.length + sweep.destroyed.length,
      swept: rest.length,
      skipped: [...left.skipped, ...botLost.skipped],
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
 * Raids that never reported their end (server crash, GDD §13), voided RAID_VOID_AFTER_MS after
 * start: items still in_raid go back to their pre-raid owner when they came from a loadout, pool
 * allocations go back to the pool; loadouts still in_raid are voided and their fungibles refunded.
 * Exits already applied stay applied ("void restores what is unresolved"). Each raid is its own
 * transaction with SKIP LOCKED, so the cron and a lazy call never fight.
 */
export async function voidStale(db: Db, now = new Date()): Promise<string[]> {
  const cutoff = new Date(now.getTime() - RAID_VOID_AFTER_MS);
  const cand = await db
    .select({ matchId: raids.matchId })
    .from(raids)
    .where(and(eq(raids.status, "running"), sql`${raids.startedAt} < ${cutoff}`));
  const voided: string[] = [];
  for (const { matchId } of cand) {
    if (await voidIf(db, matchId, now, (row) => new Date(row.started_at) < cutoff)) voided.push(matchId);
  }
  return voided;
}

type RunningRaid = { status: string; started_at: Date; server_id: string; instance_id: string | null };

/** Void one raid in its own transaction if it is still running and `check` holds under the lock. */
async function voidIf(db: Db, matchId: string, now: Date, check: (row: RunningRaid) => boolean): Promise<boolean> {
  return db.transaction(async (tx) => {
    const r = await tx.execute<RunningRaid>(sql`
      select status, started_at,
             coalesce(start_request->>'serverId', 'default') as server_id,
             start_request->>'instanceId' as instance_id
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
 * Lazy void for one user (lobby load, POST /api/matches/join): the raid holding this user's
 * loadout is voided when it started more than RAID_USER_VOID_AFTER_MS ago, or its game server is
 * gone (orphanedBy the last boot of that serverId), so the gear comes back without waiting for
 * the global cron. Returns the voided match ids.
 */
export async function voidStaleForUser(db: Db, userId: string, now = new Date()): Promise<string[]> {
  const cand = await db.execute<{ match_id: string; server_id: string }>(sql`
    select r.match_id, coalesce(r.start_request->>'serverId', 'default') as server_id
    from loadouts l join raids r on r.match_id = l.match_id
    where l.user_id = ${userId} and l.status = 'in_raid' and r.status = 'running'`);
  const cutoff = now.getTime() - RAID_USER_VOID_AFTER_MS;
  const voided: string[] = [];
  for (const { match_id: matchId, server_id: serverId } of cand.rows) {
    const boot = await lastBoot(db, serverId);
    const done = await voidIf(db, matchId, now, (row) => new Date(row.started_at).getTime() < cutoff || orphanedBy(boot, row));
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
      and coalesce(start_request->>'serverId', 'default') = ${boot.serverId}
      and coalesce(start_request->>'instanceId', '') <> ${boot.instanceId}`);
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
  await tx.update(raids).set({ status: "voided", settledAt: now }).where(eq(raids.matchId, matchId));
}
