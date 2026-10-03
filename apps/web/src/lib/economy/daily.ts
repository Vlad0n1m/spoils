import { sql } from "drizzle-orm";
import { AUTOSELL, nextAutosellMult, type NpcCounts } from "@extract/shared";
import { economyDaily } from "../../db/schema";
import type { Db } from "../inventory/db";
import { PARAM, getNumberParam, setParam } from "./params";
import { TIER_SCORE_SQL } from "./pool";

/**
 * Veterans for the autosell regulator: accounts older than this that raided within the same window
 * with gear (a loadout holding at least one unique). v5 review: free-kit-only accounts (alt farms)
 * never spend on gear, so their hoards must not steer what junk pays everybody else.
 */
export const VETERAN_DAYS = 7;
const DAY_MS = 86_400_000;

export interface EconomyDailyResult {
  status: "applied" | "already";
  /** UTC day (YYYY-MM-DD). */
  day: string;
  autosell: { from: number; to: number };
  veterans: { sample: number; medianCr: number };
  /** Lost-pool stock by uniqueTierScore (the top tier is what the bosses hand out). */
  pool: { size: number; top: number; rare: number };
  /** Raids that ended in the last 24 h (match_results), humans only (NPC MODEL v5). */
  raids: RaidKpis;
}

export interface RaidKpis {
  count: number;
  /** Median humans per raid (participants with a userId that are not bots; NPCs never count). */
  medianHumans: number;
  /** Share of raids with exactly one human (a solo raid against NPCs). */
  soloShare: number;
  /** Σ npcSummary of those raids (v5 servers; older reports add nothing). */
  npc: { spawned: NpcCounts; killedByHumans: NpcCounts };
}

/** RaidKpis over match_results that ended in (now − 24 h, now]. Bots of pre-v5 reports are skipped. */
export async function raidKpis(db: Pick<Db, "execute">, now: Date): Promise<RaidKpis> {
  const since = new Date(now.getTime() - DAY_MS);
  const r = await db.execute<Record<string, number | null>>(sql`
    with r as (
      select m.payload,
        (select count(*) from jsonb_array_elements(coalesce(m.payload->'participants', '[]'::jsonb)) p
          where coalesce((p->>'isBot')::boolean, false) = false and coalesce(p->>'userId', '') <> '')::int as humans
      from match_results m
      where m.ended_at > ${since} and m.ended_at <= ${now}
    )
    select count(*)::int as n,
      percentile_cont(0.5) within group (order by humans)::float8 as median,
      count(*) filter (where humans = 1)::int as solo,
      coalesce(sum((payload#>>'{npcSummary,spawned,boss}')::int), 0)::int as sb,
      coalesce(sum((payload#>>'{npcSummary,spawned,guard}')::int), 0)::int as sg,
      coalesce(sum((payload#>>'{npcSummary,spawned,marauder}')::int), 0)::int as sm,
      coalesce(sum((payload#>>'{npcSummary,killedByHumans,boss}')::int), 0)::int as kb,
      coalesce(sum((payload#>>'{npcSummary,killedByHumans,guard}')::int), 0)::int as kg,
      coalesce(sum((payload#>>'{npcSummary,killedByHumans,marauder}')::int), 0)::int as km
    from r`);
  const row = r.rows[0] ?? {};
  const n = (k: string) => Number(row[k] ?? 0);
  const count = n("n");
  return {
    count,
    medianHumans: count ? n("median") : 0,
    soloShare: count ? Math.round((n("solo") / count) * 10_000) / 10_000 : 0,
    npc: {
      spawned: { boss: n("sb"), guard: n("sg"), marauder: n("sm") },
      killedByHumans: { boss: n("kb"), guard: n("kg"), marauder: n("km") },
    },
  };
}

/**
 * Daily economy controller (economy memo §3 / controller.ts; audit F3: the regulator was never
 * called). Once per UTC day, serialized by an advisory lock and the economy_params daily_ran_on
 * stamp: the veterans' (accounts older than VETERAN_DAYS with a raid exit in the last
 * VETERAN_DAYS) median CR balance steers the junk autosell multiplier with nextAutosellMult
 * (±3 %/day, 0.6..1.3, no change below AUTOSELL.MIN_SAMPLE veterans), and a KPI snapshot (autosell,
 * veterans, pool stock incl. top-tier count, raids of the last 24 h with humans-only lobby size,
 * solo share and NPC totals) goes to economy_daily. Meant for a daily cron.
 */
export async function runEconomyDaily(db: Db, now = new Date()): Promise<EconomyDailyResult> {
  const day = now.toISOString().slice(0, 10);
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('economy-daily'))`);
    const cur = await getNumberParam(tx, PARAM.AUTOSELL_MULT);
    const since = new Date(now.getTime() - VETERAN_DAYS * DAY_MS);
    const vet = await tx.execute<{ n: number; median: number | null }>(sql`
      select count(*)::int as n, percentile_cont(0.5) within group (order by u.credits)::float8 as median
      from users u
      where u.created_at < ${since}
        and exists (select 1 from raid_exits e where e.user_id = u.id and e.at > ${since})
        and exists (
          select 1 from loadouts l
          where l.user_id = u.id and l.started_at > ${since} and l.status in ('in_raid', 'settled')
            and exists (select 1 from jsonb_array_elements(l.entries) x where coalesce(x->>'uid', '') <> ''))`);
    const sample = Number(vet.rows[0]?.n ?? 0);
    const medianCr = Number(vet.rows[0]?.median ?? 0);
    const ps = await tx.execute<{ size: number; top: number; rare: number }>(sql`
      select count(*)::int as size,
             count(*) filter (where ${TIER_SCORE_SQL} = 2)::int as top,
             count(*) filter (where ${TIER_SCORE_SQL} = 1)::int as rare
      from items where state = 'lost_pool'`);
    const pool = { size: Number(ps.rows[0]?.size ?? 0), top: Number(ps.rows[0]?.top ?? 0), rare: Number(ps.rows[0]?.rare ?? 0) };
    const raids = await raidKpis(tx, now);

    const ran = await tx.execute<{ value: unknown }>(sql`select value from economy_params where key = ${PARAM.DAILY_RAN_ON}`);
    if (ran.rows[0]?.value === day) {
      return { status: "already", day, autosell: { from: cur, to: cur }, veterans: { sample, medianCr }, pool, raids };
    }
    const next = Math.round(nextAutosellMult(cur, medianCr, sample) * 10_000) / 10_000;
    await setParam(tx, PARAM.AUTOSELL_MULT, next);
    await setParam(tx, PARAM.DAILY_RAN_ON, day);
    const data = { autosell: { from: cur, to: next, minSample: AUTOSELL.MIN_SAMPLE }, veterans: { sample, medianCr }, pool, raids };
    await tx
      .insert(economyDaily)
      .values({ day, data })
      .onConflictDoUpdate({ target: economyDaily.day, set: { data } });
    return { status: "applied", day, autosell: { from: cur, to: next }, veterans: { sample, medianCr }, pool, raids };
  });
}
