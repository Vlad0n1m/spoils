import { sql } from "drizzle-orm";
import type { Db } from "../inventory/db";
import { PARAM, getNumberParam } from "../economy/params";
import { MARKET_CURRENCY } from "../market/config";
import type { EconomyStatsDto } from "./api-types";

/**
 * Public /economy numbers (critique cut 11: a numbers table, no charts): CR faucets and sinks
 * from credit_ledger, items by lifecycle state, lost-pool and treasury size, market trades and
 * fees, plus the stored economy_daily snapshots. All aggregates over indexed columns; the route
 * caches the result for 60 s.
 */
export async function getEconomyStats(db: Db, now = new Date()): Promise<EconomyStatsDto> {
  const dayAgo = new Date(now.getTime() - 86_400_000);
  const [byReason, circulating, states, market, listingsOpen, players, raids, daily, autosellMult] = await Promise.all([
    db.execute<{ reason: string; in24: string; out24: string; in_all: string; out_all: string }>(sql`
      select reason,
        coalesce(sum(delta) filter (where delta > 0 and at > ${dayAgo}), 0) as in24,
        coalesce(-sum(delta) filter (where delta < 0 and at > ${dayAgo}), 0) as out24,
        coalesce(sum(delta) filter (where delta > 0), 0) as in_all,
        coalesce(-sum(delta) filter (where delta < 0), 0) as out_all
      from credit_ledger group by reason order by reason`),
    db.execute<{ total: string | null }>(sql`select sum(credits) as total from users`),
    db.execute<{ state: string; n: number }>(sql`select state, count(*)::int as n from items group by state`),
    db.execute<{ t24: number; t_all: number; v24: string; v_all: string; f24: string; f_all: string }>(sql`
      select
        count(*) filter (where at > ${dayAgo})::int as t24,
        count(*)::int as t_all,
        coalesce(sum(price_minor) filter (where at > ${dayAgo}), 0) as v24,
        coalesce(sum(price_minor), 0) as v_all,
        coalesce(sum(fee_minor) filter (where at > ${dayAgo}), 0) as f24,
        coalesce(sum(fee_minor), 0) as f_all
      from trades`),
    db.execute<{ n: number }>(sql`
      select count(*)::int as n from listings where status in ('pending', 'active') and expires_at > ${now}`),
    db.execute<{ registered: number }>(sql`select count(*)::int as registered from users`),
    db.execute<{ raids24: number; exits24: number; extracts24: number; active24: number }>(sql`
      select
        (select count(*)::int from raids where started_at > ${dayAgo}) as raids24,
        count(*)::int as exits24,
        count(*) filter (where exit = 'extract')::int as extracts24,
        count(distinct user_id) filter (where not guest)::int as active24
      from raid_exits where at > ${dayAgo}`),
    db.execute<{ day: string; data: Record<string, unknown> }>(sql`
      select to_char(day, 'YYYY-MM-DD') as day, data from economy_daily order by day desc limit 14`),
    getNumberParam(db, PARAM.AUTOSELL_MULT),
  ]);

  const reasons = byReason.rows.map((r) => ({
    reason: r.reason,
    in24h: Number(r.in24),
    out24h: Number(r.out24),
    inAll: Number(r.in_all),
    outAll: Number(r.out_all),
  }));
  const byState: Record<string, number> = {};
  for (const s of states.rows) byState[s.state] = Number(s.n);
  const m = market.rows[0];
  const rd = raids.rows[0];
  const exits = Number(rd?.exits24 ?? 0);
  return {
    generatedAt: now.getTime(),
    currency: MARKET_CURRENCY.code,
    players: {
      registered: Number(players.rows[0]?.registered ?? 0),
      active24h: Number(rd?.active24 ?? 0),
      raids24h: Number(rd?.raids24 ?? 0),
      extractRate24h: exits > 0 ? Number(rd?.extracts24 ?? 0) / exits : null,
    },
    credits: {
      circulating: Number(circulating.rows[0]?.total ?? 0),
      in24h: sum(reasons, "in24h"),
      out24h: sum(reasons, "out24h"),
      inAll: sum(reasons, "inAll"),
      outAll: sum(reasons, "outAll"),
      byReason: reasons,
    },
    items: {
      byState,
      circulating: (byState.in_stash ?? 0) + (byState.listed ?? 0) + (byState.in_raid ?? 0),
      poolSize: byState.lost_pool ?? 0,
      treasury: byState.treasury ?? 0,
      destroyed: byState.destroyed ?? 0,
    },
    market: {
      activeListings: Number(listingsOpen.rows[0]?.n ?? 0),
      trades24h: Number(m?.t24 ?? 0),
      tradesAll: Number(m?.t_all ?? 0),
      volume24h: String(m?.v24 ?? "0"),
      volumeAll: String(m?.v_all ?? "0"),
      fees24h: String(m?.f24 ?? "0"),
      feesAll: String(m?.f_all ?? "0"),
    },
    autosellMult,
    daily: daily.rows.map((d) => ({ day: d.day, data: d.data ?? {} })),
  };
}

function sum<K extends "in24h" | "out24h" | "inAll" | "outAll">(rows: Array<Record<K, number>>, k: K): number {
  return rows.reduce((s, r) => s + r[k], 0);
}
