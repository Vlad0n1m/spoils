import { sql } from "drizzle-orm";
import { AUTOSELL, nextAutosellMult } from "@extract/shared";
import { economyDaily } from "../../db/schema";
import type { Db } from "../inventory/db";
import { PARAM, getNumberParam, setParam } from "./params";
import { TIER_SCORE_SQL } from "./pool";

/** Veterans for the autosell regulator: accounts older than this that raided within the same window. */
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
}

/**
 * Daily economy controller (economy memo §3 / controller.ts; audit F3: the regulator was never
 * called). Once per UTC day, serialized by an advisory lock and the economy_params daily_ran_on
 * stamp: the veterans' (accounts older than VETERAN_DAYS with a raid exit in the last
 * VETERAN_DAYS) median CR balance steers the junk autosell multiplier with nextAutosellMult
 * (±3 %/day, 0.6..1.3, no change below AUTOSELL.MIN_SAMPLE veterans), and a KPI snapshot (autosell,
 * veterans, pool stock incl. top-tier count) goes to economy_daily. Meant for a daily cron.
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
        and exists (select 1 from raid_exits e where e.user_id = u.id and e.at > ${since})`);
    const sample = Number(vet.rows[0]?.n ?? 0);
    const medianCr = Number(vet.rows[0]?.median ?? 0);
    const ps = await tx.execute<{ size: number; top: number; rare: number }>(sql`
      select count(*)::int as size,
             count(*) filter (where ${TIER_SCORE_SQL} = 2)::int as top,
             count(*) filter (where ${TIER_SCORE_SQL} = 1)::int as rare
      from items where state = 'lost_pool'`);
    const pool = { size: Number(ps.rows[0]?.size ?? 0), top: Number(ps.rows[0]?.top ?? 0), rare: Number(ps.rows[0]?.rare ?? 0) };

    const ran = await tx.execute<{ value: unknown }>(sql`select value from economy_params where key = ${PARAM.DAILY_RAN_ON}`);
    if (ran.rows[0]?.value === day) {
      return { status: "already", day, autosell: { from: cur, to: cur }, veterans: { sample, medianCr }, pool };
    }
    const next = Math.round(nextAutosellMult(cur, medianCr, sample) * 10_000) / 10_000;
    await setParam(tx, PARAM.AUTOSELL_MULT, next);
    await setParam(tx, PARAM.DAILY_RAN_ON, day);
    const data = { autosell: { from: cur, to: next, minSample: AUTOSELL.MIN_SAMPLE }, veterans: { sample, medianCr }, pool };
    await tx
      .insert(economyDaily)
      .values({ day, data })
      .onConflictDoUpdate({ target: economyDaily.day, set: { data } });
    return { status: "applied", day, autosell: { from: cur, to: next }, veterans: { sample, medianCr }, pool };
  });
}
