import { sql, type SQL } from "drizzle-orm";
import {
  worldCycleAt,
  type LeaderboardBoard,
  type LeaderboardDto,
  type LeaderboardMeDto,
  type LeaderboardPeriod,
} from "@extract/shared";
import type { Db } from "../inventory/db";
import { worldNow } from "./clock";

/**
 * Leaderboards (spec §4.9, D24/D25): Level (all time, users.xp), Kills (ranked PvP, pvp_kills),
 * NPC (marauders + guards + bosses, raid_exits of registered users). Periods: `map` = the current
 * cycle, `week` = since Monday 00:00 UTC, `all`. The level board is all-time only (its period is
 * reported as "all"). Top LEADERBOARD_LIMIT rows; ties share a rank (1, 2, 2, 4). Boards pay
 * nothing: no CR, items or SOL (binding rule).
 */
export const LEADERBOARD_LIMIT = 100;
export const LEADERBOARD_BOARDS: readonly LeaderboardBoard[] = ["level", "kills", "npc"];
export const LEADERBOARD_PERIODS: readonly LeaderboardPeriod[] = ["map", "week", "all"];

export function isBoard(v: unknown): v is LeaderboardBoard {
  return typeof v === "string" && (LEADERBOARD_BOARDS as readonly string[]).includes(v);
}
export function isPeriod(v: unknown): v is LeaderboardPeriod {
  return typeof v === "string" && (LEADERBOARD_PERIODS as readonly string[]).includes(v);
}

/** Monday 00:00 UTC of the week holding `nowMs`. */
export function weekStartUtc(nowMs: number): number {
  const d = new Date(nowMs);
  const back = (d.getUTCDay() + 6) % 7;
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - back);
}

/** The time / cycle filter of a period: week → at ≥ Monday, map → cycle_id = the current cycle. */
function periodFilter(period: LeaderboardPeriod, nowMs: number, at: SQL, cycleCol: SQL): { where: SQL; cycle: number | null } {
  if (period === "map") {
    const cycle = worldCycleAt(nowMs).cycle;
    return { where: sql`${cycleCol} = ${cycle}`, cycle };
  }
  if (period === "week") return { where: sql`${at} >= ${new Date(weekStartUtc(nowMs))}`, cycle: null };
  return { where: sql`true`, cycle: null };
}

/**
 * Per-user values of a board as a SQL subquery with columns (uid, nickname, level, value, first),
 * registered users only, value > 0. `first` breaks ties for the display order (earliest wins).
 */
function boardValues(board: LeaderboardBoard, period: LeaderboardPeriod, nowMs: number): { q: SQL; cycle: number | null } {
  if (board === "level") {
    return {
      q: sql`select u.id as uid, u.nickname, u.level, u.xp as value, u.created_at as first from users u where u.xp > 0`,
      cycle: null,
    };
  }
  if (board === "kills") {
    const f = periodFilter(period, nowMs, sql`k.at`, sql`k.cycle_id`);
    return {
      q: sql`select u.id as uid, u.nickname, u.level, t.value, t.first
             from (select killer_id, count(*)::int as value, min(at) as first
                   from pvp_kills k where k.ranked and ${f.where} group by killer_id) t
             join users u on u.id = t.killer_id`,
      cycle: f.cycle,
    };
  }
  const f = periodFilter(period, nowMs, sql`x.at`, sql`x.cycle_id`);
  return {
    q: sql`select u.id as uid, u.nickname, u.level, t.value, t.first
           from (select user_id, sum(npc_kills + boss_kills)::int as value, min(at) as first
                 from raid_exits x where not x.guest and ${f.where} group by user_id) t
           join users u on u.id = t.user_id
           where t.value > 0`,
    cycle: f.cycle,
  };
}

export async function leaderboard(
  db: Db,
  board: LeaderboardBoard,
  period: LeaderboardPeriod,
  now = worldNow(),
): Promise<LeaderboardDto> {
  const p: LeaderboardPeriod = board === "level" ? "all" : period;
  const { q, cycle } = boardValues(board, p, now);
  const r = await db.execute<{ rank: number; nickname: string; level: number; value: number }>(sql`
    select rank() over (order by b.value desc)::int as rank, b.nickname, b.level, b.value::int as value
    from (${q}) b
    order by b.value desc, b.first asc, b.nickname asc
    limit ${LEADERBOARD_LIMIT}`);
  return {
    board,
    period: p,
    cycle,
    updatedAt: now,
    rows: r.rows.map((x) => ({ rank: Number(x.rank), nickname: x.nickname, level: Number(x.level), value: Number(x.value) })),
  };
}

/** The caller's own rank (`count(*) + 1` of values above theirs); null when they are not on the board. */
export async function leaderboardMe(
  db: Db,
  userId: string,
  board: LeaderboardBoard,
  period: LeaderboardPeriod,
  now = worldNow(),
): Promise<LeaderboardMeDto> {
  const p: LeaderboardPeriod = board === "level" ? "all" : period;
  const { q } = boardValues(board, p, now);
  const r = await db.execute<{ value: number | null; rank: number }>(sql`
    with b as (${q}),
         me as (select value from b where uid = ${userId}::uuid)
    select (select value from me)::int as value,
           ((select count(*) from b where b.value > (select value from me)) + 1)::int as rank`);
  const row = r.rows[0];
  if (!row || row.value === null || row.value === undefined) return null;
  return { rank: Number(row.rank), value: Number(row.value) };
}
