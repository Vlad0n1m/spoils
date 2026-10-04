import { sql } from "drizzle-orm";
import { AUTOSELL, mapNumber, worldCycleAt } from "@extract/shared";
import { PARAM, getNumberParam } from "../economy/params";
import type { Db } from "../inventory/db";
import { MARKET_CURRENCY } from "../market/config";
import { worldNow } from "../world/clock";
import {
  EXIT_KINDS,
  type AdminCreditReason,
  type AdminDay,
  type AdminHouseReason,
  type AdminKpi,
  type AdminMetrics,
  type ExitKind,
  type KpiStatus,
} from "./types";

/**
 * /admin metrics over a 7-day window: seven UTC days, today included (since = UTC midnight six days
 * ago). Every query is either on an index or bounded to the window (spec of the admin step):
 * - online: raids_world_cycle_idx + raid_entries_match_idx; stale actives via the one-active partial index;
 * - entries: raid_entries_cycle_user_idx (cycle_id >= the window's first cycle) + created_at;
 * - exits: raid_exits_at_idx; PvP kills: pvp_kills_board_idx (ranked = any, at >= since);
 * - CR: credit_ledger_reason_at_idx: a loose index scan of the reasons (recursive CTE), then one
 *   (reason, at >= since) range per reason (LATERAL, so the plan does not depend on table stats);
 * - treasury: money_ledger_account_at_idx (account 'house'); all-time house totals on the same index;
 * - items by state: items_state_def_idx (a handful of states);
 * - prices: trades_template_at_idx, the same loose scan + LATERAL range per template;
 * - newbies / D1 retention: users registered inside the window (small table), raid_entries_user_day_idx.
 * KPIs follow docs/ALPHA_PLAN.md §4 (plus three of GAME_DESIGN §22); what the DB cannot answer is
 * `value: null` («нет данных») with the reason in `note`.
 */

const DAY_MS = 86_400_000;
export const WINDOW_DAYS = 7;

export interface MetricsClock {
  /** Wall clock for DB timestamps. */
  now: Date;
  /** World clock (lib/world/clock.ts worldNow: the dev offset applies) for the current cycle. */
  worldNowMs: number;
}

export function utcDayStart(ms: number): number {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

const dayKey = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
const num = (v: unknown): number => {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
};

function emptyDay(day: string): AdminDay {
  return {
    day,
    entries: 0,
    entriesGuest: 0,
    entriesGear: 0,
    exits: { extract: 0, dead: 0, mia: 0, timeout: 0 },
    deaths: 0,
    pvpKills: 0,
    pvpRanked: 0,
    crIn: 0,
    crOut: 0,
    houseMinor: "0",
  };
}

const isExitKind = (s: string): s is ExitKind => (EXIT_KINDS as readonly string[]).includes(s);
const addMinor = (a: string, b: unknown): string => (BigInt(a) + BigInt(String(b ?? "0"))).toString();

export async function adminMetrics(
  db: Db,
  clock: MetricsClock = { now: new Date(), worldNowMs: worldNow() },
): Promise<AdminMetrics> {
  const nowMs = clock.now.getTime();
  const todayMs = utcDayStart(nowMs);
  const sinceMs = todayMs - (WINDOW_DAYS - 1) * DAY_MS;
  const now = new Date(nowMs);
  const since = new Date(sinceMs);
  const dayAgo = new Date(nowMs - DAY_MS);
  const yesterdayStart = new Date(todayMs - DAY_MS);
  const wc = worldCycleAt(clock.worldNowMs);
  // First world cycle of the window on the world clock (one cycle of slack for minting before admission).
  const c0 = worldCycleAt(clock.worldNowMs - (nowMs - sinceMs)).cycle - 1;

  const [online, stale, entries, exits, pvp, credits, items, house, houseAll, active, prices, newbies, d1, autosell] =
    await Promise.all([
      db.execute<{ shard: number; match_id: string; registered: number; guests: number }>(sql`
        select r.shard::int as shard, r.match_id,
          count(e.entry_id) filter (where not e.guest)::int as registered,
          count(e.entry_id) filter (where e.guest)::int as guests
        from raids r
        left join raid_entries e on e.match_id = r.match_id and e.status = 'active'
        where r.kind = 'world' and r.cycle_id = ${wc.cycle} and r.status = 'running'
        group by r.shard, r.match_id
        order by r.shard`),
      db.execute<{ n: number }>(sql`
        select count(*)::int as n from raid_entries where status = 'active' and cycle_id < ${wc.cycle}`),
      db.execute<{ day: string; n: number; guests: number; reg: number; gear: number }>(sql`
        select to_char(created_at at time zone 'UTC', 'YYYY-MM-DD') as day, count(*)::int as n,
          count(*) filter (where guest)::int as guests,
          count(*) filter (where not guest)::int as reg,
          count(*) filter (where not guest and not free_kit)::int as gear
        from raid_entries
        where cycle_id >= ${c0} and created_at >= ${since} and created_at <= ${now}
        group by 1`),
      db.execute<{ day: string; exit: string; n: number; reg: number; cr: number }>(sql`
        select to_char(at at time zone 'UTC', 'YYYY-MM-DD') as day, exit, count(*)::int as n,
          count(*) filter (where not guest)::int as reg,
          coalesce(sum(credits) filter (where not guest), 0)::float8 as cr
        from raid_exits where at >= ${since} and at <= ${now}
        group by 1, 2`),
      db.execute<{ day: string; n: number; ranked: number }>(sql`
        select to_char(at at time zone 'UTC', 'YYYY-MM-DD') as day, count(*)::int as n,
          count(*) filter (where ranked)::int as ranked
        from pvp_kills where ranked in (true, false) and at >= ${since} and at <= ${now}
        group by 1`),
      db.execute<{ reason: string; day: string; cin: number; cout: number }>(sql`
        with recursive r(reason) as (
          (select reason from credit_ledger order by reason limit 1)
          union all
          select (select c.reason from credit_ledger c where c.reason > r.reason order by c.reason limit 1)
          from r where r.reason is not null
        )
        select r.reason, x.day, x.cin, x.cout
        from r cross join lateral (
          select to_char(c.at at time zone 'UTC', 'YYYY-MM-DD') as day,
            coalesce(sum(c.delta) filter (where c.delta > 0), 0)::float8 as cin,
            coalesce(-sum(c.delta) filter (where c.delta < 0), 0)::float8 as cout
          from credit_ledger c
          where c.reason = r.reason and c.at >= ${since} and c.at <= ${now}
          group by 1
        ) x
        where r.reason is not null`),
      db.execute<{ state: string; n: number }>(sql`
        select state::text as state, count(*)::int as n from items group by state order by state`),
      db.execute<{ reason: string; day: string; v: string }>(sql`
        select reason, to_char(at at time zone 'UTC', 'YYYY-MM-DD') as day, sum(delta_minor)::text as v
        from money_ledger where account = 'house' and at >= ${since} and at <= ${now}
        group by 1, 2`),
      db.execute<{ reason: string; v: string }>(sql`
        select reason, sum(delta_minor)::text as v from money_ledger where account = 'house' group by 1`),
      db.execute<{ players: number; tradable: number; median_cr: number | null }>(sql`
        with active as (
          select distinct user_id from raid_exits where at >= ${since} and at <= ${now} and not guest
        )
        select (select count(*) from active)::int as players,
          (select count(*) from items i join active a on a.user_id = i.owner_id
            where i.state in ('in_stash', 'listed', 'in_raid') and not i.bound)::int as tradable,
          (select percentile_cont(0.5) within group (order by u.credits)
            from users u join active a on a.user_id = u.id)::float8 as median_cr`),
      db.execute<{ template: string; n24: number; m24: number | null; n7: number; m7: number | null }>(sql`
        with recursive t(template) as (
          (select template from trades order by template limit 1)
          union all
          select (select x.template from trades x where x.template > t.template order by x.template limit 1)
          from t where t.template is not null
        )
        select t.template, p.n24, p.m24, p.n7, p.m7
        from t cross join lateral (
          select count(*) filter (where x.at >= ${dayAgo})::int as n24,
            percentile_cont(0.5) within group (order by x.price_minor::float8) filter (where x.at >= ${dayAgo}) as m24,
            count(*)::int as n7,
            percentile_cont(0.5) within group (order by x.price_minor::float8) as m7
          from trades x
          where x.template = t.template and x.at >= ${since} and x.at <= ${now} and x.counted_for_index
        ) p
        where t.template is not null and p.n7 > 0`),
      db.execute<{ extracted: number; decided: number; newbies: number }>(sql`
        with x as (
          select e.user_id, e.exit, row_number() over (partition by e.user_id order by e.at, e.entry_id) as k
          from raid_exits e join users u on u.id = e.user_id
          where e.at >= ${since} and e.at <= ${now} and not e.guest and u.created_at >= ${since}
        ), s as (
          select user_id, count(*)::int as n, bool_or(exit = 'extract') as ex from x where k <= 3 group by user_id
        )
        select count(*) filter (where ex)::int as extracted,
          count(*) filter (where ex or n >= 3)::int as decided,
          count(*)::int as newbies
        from s`),
      db.execute<{ cohort: number; back: number }>(sql`
        select count(*)::int as cohort, count(*) filter (where back)::int as back
        from (
          select exists (
            select 1 from raid_entries e
            where e.user_id = u.id
              and e.created_at >= (date_trunc('day', u.created_at at time zone 'UTC') + interval '1 day') at time zone 'UTC'
              and e.created_at < (date_trunc('day', u.created_at at time zone 'UTC') + interval '2 days') at time zone 'UTC'
          ) as back
          from users u
          where u.created_at >= ${since} and u.created_at < ${yesterdayStart}
        ) s`),
      getNumberParam(db, PARAM.AUTOSELL_MULT),
    ]);

  // ---- days
  const days: AdminDay[] = [];
  const byDay = new Map<string, AdminDay>();
  for (let i = 0; i < WINDOW_DAYS; i++) {
    const d = emptyDay(dayKey(sinceMs + i * DAY_MS));
    days.push(d);
    byDay.set(d.day, d);
  }
  let regEntries = 0;
  let gearEntries = 0;
  for (const r of entries.rows) {
    const d = byDay.get(r.day);
    if (!d) continue;
    d.entries += num(r.n);
    d.entriesGuest += num(r.guests);
    d.entriesGear += num(r.gear);
    regEntries += num(r.reg);
    gearEntries += num(r.gear);
  }
  let regExits = 0;
  let regExitCr = 0;
  for (const r of exits.rows) {
    const d = byDay.get(r.day);
    if (!d || !isExitKind(r.exit)) continue;
    d.exits[r.exit] += num(r.n);
    regExits += num(r.reg);
    regExitCr += num(r.cr);
  }
  for (const d of days) d.deaths = d.exits.dead;
  for (const r of pvp.rows) {
    const d = byDay.get(r.day);
    if (!d) continue;
    d.pvpKills += num(r.n);
    d.pvpRanked += num(r.ranked);
  }

  // ---- credits by reason
  const todayKey = dayKey(todayMs);
  const reasons = new Map<string, AdminCreditReason>();
  for (const r of credits.rows) {
    const cin = num(r.cin);
    const cout = num(r.cout);
    const rr = reasons.get(r.reason) ?? { reason: r.reason, in7d: 0, out7d: 0, inToday: 0, outToday: 0 };
    rr.in7d += cin;
    rr.out7d += cout;
    if (r.day === todayKey) {
      rr.inToday += cin;
      rr.outToday += cout;
    }
    reasons.set(r.reason, rr);
    const d = byDay.get(r.day);
    if (d) {
      d.crIn += cin;
      d.crOut += cout;
    }
  }
  const byReason = [...reasons.values()].sort((a, b) => b.in7d + b.out7d - (a.in7d + a.out7d) || a.reason.localeCompare(b.reason));
  const in7d = byReason.reduce((s, r) => s + r.in7d, 0);
  const out7d = byReason.reduce((s, r) => s + r.out7d, 0);

  // ---- treasury (house)
  const houseReasons = new Map<string, AdminHouseReason>();
  const hr = (reason: string) => {
    let x = houseReasons.get(reason);
    if (!x) {
      x = { reason, today: "0", d7: "0", all: "0" };
      houseReasons.set(reason, x);
    }
    return x;
  };
  for (const r of house.rows) {
    const x = hr(r.reason);
    x.d7 = addMinor(x.d7, r.v);
    if (r.day === todayKey) x.today = addMinor(x.today, r.v);
    const d = byDay.get(r.day);
    if (d) d.houseMinor = addMinor(d.houseMinor, r.v);
  }
  for (const r of houseAll.rows) hr(r.reason).all = String(r.v ?? "0");
  const houseList = [...houseReasons.values()].sort((a, b) => (BigInt(b.all) > BigInt(a.all) ? 1 : BigInt(b.all) < BigInt(a.all) ? -1 : 0));

  // ---- online
  const shards = online.rows.map((r) => ({
    shard: num(r.shard),
    matchId: r.match_id,
    registered: num(r.registered),
    guests: num(r.guests),
  }));
  const registered = shards.reduce((s, x) => s + x.registered, 0);
  const guests = shards.reduce((s, x) => s + x.guests, 0);

  // ---- KPIs
  const exitsAll = days.reduce((s, d) => s + d.exits.extract + d.exits.dead + d.exits.mia + d.exits.timeout, 0);
  const extracts = days.reduce((s, d) => s + d.exits.extract, 0);
  const mia = days.reduce((s, d) => s + d.exits.mia, 0);
  const act = active.rows[0];
  const nb = newbies.rows[0];
  const ret = d1.rows[0];
  const kpis = buildKpis({
    crIn7: in7d,
    crOut7: out7d,
    // the last three complete days: today − 3 … today − 1
    crLast3: days.slice(WINDOW_DAYS - 4, WINDOW_DAYS - 1).map((d) => ({ cin: d.crIn, cout: d.crOut })),
    regExits,
    regExitCr,
    players: num(act?.players),
    tradable: num(act?.tradable),
    medianCr: act?.median_cr === null || act?.median_cr === undefined ? null : num(act.median_cr),
    autosell,
    prices: prices.rows.map((p) => ({ n24: num(p.n24), m24: p.m24 === null ? null : num(p.m24), n7: num(p.n7), m7: p.m7 === null ? null : num(p.m7) })),
    exitsAll,
    extracts,
    mia,
    regEntries,
    gearEntries,
    newbies: { extracted: num(nb?.extracted), decided: num(nb?.decided), total: num(nb?.newbies) },
    d1: { cohort: num(ret?.cohort), back: num(ret?.back) },
  });

  const itemRows = items.rows.map((r) => ({ state: r.state, n: num(r.n) }));
  return {
    generatedAt: nowMs,
    since: sinceMs,
    online: {
      cycle: wc.cycle,
      mapNumber: mapNumber(wc.cycle),
      shards,
      total: registered + guests,
      registered,
      guests,
      staleActive: num(stale.rows[0]?.n),
    },
    days,
    credits: { byReason, in7d, out7d },
    items: { byState: itemRows, total: itemRows.reduce((s, r) => s + r.n, 0) },
    house: {
      currency: MARKET_CURRENCY.code,
      byReason: houseList,
      d7: houseList.reduce((s, r) => addMinor(s, r.d7), "0"),
      all: houseList.reduce((s, r) => addMinor(s, r.all), "0"),
    },
    kpis,
  };
}

// ------------------------------------------------------------------------------------- KPIs

export interface KpiInputs {
  crIn7: number;
  crOut7: number;
  crLast3: Array<{ cin: number; cout: number }>;
  regExits: number;
  regExitCr: number;
  players: number;
  tradable: number;
  medianCr: number | null;
  autosell: number;
  prices: Array<{ n24: number; m24: number | null; n7: number; m7: number | null }>;
  exitsAll: number;
  extracts: number;
  mia: number;
  regEntries: number;
  gearEntries: number;
  newbies: { extracted: number; decided: number; total: number };
  d1: { cohort: number; back: number };
}

/** Price KPI sample: templates with at least this many counted trades in 24 h / in the window. */
export const PRICE_MIN_24H = 2;
export const PRICE_MIN_7D = 4;

const pct = (v: number): string => `${Math.round(v * 100)}%`;
const signedPct = (v: number): string => `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(Math.round(v * 100))}%`;
const fix2 = (v: number): string => v.toFixed(2);
const int = (v: number): string => Math.round(v).toLocaleString("ru-RU");

function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

/** ok inside [lo, hi], alarm outside [alarmLo, alarmHi], warn in between. */
function bandStatus(v: number, lo: number, hi: number, alarmLo = -Infinity, alarmHi = Infinity): KpiStatus {
  if (v < alarmLo || v > alarmHi) return "alarm";
  if (v < lo || v > hi) return "warn";
  return "ok";
}

function noData(id: string, label: string, norm: string, alarm: string, note: string, source: "§4" | "§22" = "§4"): AdminKpi {
  return { id, label, value: null, norm, alarm, status: "none", note, source };
}

/** Pure: KPI rows from the aggregates (unit-tested without a DB). */
export function buildKpis(i: KpiInputs): AdminKpi[] {
  const out: AdminKpi[] = [];

  // 1. CR faucet / sink
  {
    const id = "cr_ratio";
    const label = "Приток / сток CR";
    const norm = "1.05–1.20";
    const alarm = "> 1.4 три дня";
    if (i.crOut7 <= 0) {
      out.push(noData(id, label, norm, alarm, "Стока CR за 7 дней не было."));
    } else {
      const v = i.crIn7 / i.crOut7;
      const three = i.crLast3.length === 3 && i.crLast3.every((d) => d.cout > 0 && d.cin / d.cout > 1.4);
      out.push({
        id,
        label,
        value: fix2(v),
        norm,
        alarm,
        status: three ? "alarm" : bandStatus(v, 1.05, 1.2),
        note: `7 дней: ${int(i.crIn7)} CR пришло / ${int(i.crOut7)} CR ушло (credit_ledger, все причины). Тревога — если каждый из трёх последних полных дней > 1.4.`,
        source: "§4",
      });
    }
  }

  // 2. CR per entry
  {
    const id = "cr_per_entry";
    const label = "CR за вход";
    const norm = "350–450";
    const alarm = "< 250 или > 600";
    if (i.regExits <= 0) out.push(noData(id, label, norm, alarm, "Выходов зарегистрированных игроков за 7 дней нет."));
    else {
      const v = i.regExitCr / i.regExits;
      out.push({
        id,
        label,
        value: int(v),
        norm,
        alarm,
        status: bandStatus(v, 350, 450, 250, 600),
        note: `Среднее CR выхода (хлам + жетоны, raid_exits.credits) по ${int(i.regExits)} выходам зарегистрированных за 7 дней; гости не считаются.`,
        source: "§4",
      });
    }
  }

  // 3. tradable items per player
  {
    const id = "tradable_per_player";
    const label = "Продаваемых вещей на игрока";
    const norm = "0.4–0.6";
    const alarm = "< 0.25 или > 1.5";
    if (i.players <= 0) out.push(noData(id, label, norm, alarm, "Активных игроков (с выходом за 7 дней) нет."));
    else {
      const v = i.tradable / i.players;
      out.push({
        id,
        label,
        value: fix2(v),
        norm,
        alarm,
        status: bandStatus(v, 0.4, 0.6, 0.25, 1.5),
        note: `${int(i.tradable)} непривязанных вещей (склад, лоты, рейд) у ${int(i.players)} игроков с выходом за 7 дней.`,
        source: "§4",
      });
    }
  }

  // 4. price vs median
  {
    const id = "price_vs_median";
    const label = "Цена к медиане";
    const norm = "± 25%";
    const alarm = "−40% три дня";
    const devs = i.prices
      .filter((p) => p.n24 >= PRICE_MIN_24H && p.n7 >= PRICE_MIN_7D && p.m24 !== null && p.m7 !== null && p.m7 > 0)
      .map((p) => p.m24! / p.m7! - 1);
    const v = median(devs);
    if (v === null) {
      out.push(
        noData(
          id,
          label,
          norm,
          alarm,
          `Мало сделок: нужен шаблон с ≥ ${PRICE_MIN_24H} сделками за 24 ч и ≥ ${PRICE_MIN_7D} за 7 дней (сделки индекса).`,
        ),
      );
    } else {
      out.push({
        id,
        label,
        value: signedPct(v),
        norm,
        alarm,
        status: v <= -0.4 ? "alarm" : Math.abs(v) > 0.25 ? "warn" : "ok",
        note: `Медиана по ${devs.length} шаблонам: медиана цены за 24 ч к медиане за 7 дней (окно админки 7 дней, не 14). Тревога здесь — за один день, не за три.`,
        source: "§4",
      });
    }
  }

  // 5. invariants
  out.push(noData("invariants", "Сверка инвариантов", "0 расхождений", "любое", "Нет данных: ночная сверка инвариантов (ALPHA_PLAN B6) ещё не построена."));

  // 6. extract share
  {
    const id = "extract_share";
    const label = "Доля выходов";
    const norm = "35–45%";
    const alarm = "< 25%";
    if (i.exitsAll <= 0) out.push(noData(id, label, norm, alarm, "Завершённых входов за 7 дней нет."));
    else {
      const v = i.extracts / i.exitsAll;
      out.push({
        id,
        label,
        value: pct(v),
        norm,
        alarm,
        status: bandStatus(v, 0.35, 0.45, 0.25),
        note: `${int(i.extracts)} выходов с картой из ${int(i.exitsAll)} завершённых входов за 7 дней (гости тоже).`,
        source: "§4",
      });
    }
  }

  // 7. newbie extracted within 3 entries
  {
    const id = "newbie_3";
    const label = "Новичок вышел за 3 входа";
    const norm = "≥ 70%";
    const alarm = "< 50%";
    if (i.newbies.decided <= 0) {
      out.push(noData(id, label, norm, alarm, `Новичков с итогом нет (зарегистрированы за 7 дней: ${int(i.newbies.total)} с выходами).`));
    } else {
      const v = i.newbies.extracted / i.newbies.decided;
      out.push({
        id,
        label,
        value: pct(v),
        norm,
        alarm,
        status: v < 0.5 ? "alarm" : v < 0.7 ? "warn" : "ok",
        note: `Зарегистрированы за 7 дней: ${int(i.newbies.extracted)} из ${int(i.newbies.decided)} вышли с карты за первые 3 входа. Кто сыграл меньше 3 и ещё не выходил — не считается (${int(i.newbies.total - i.newbies.decided)}).`,
        source: "§4",
      });
    }
  }

  // 8. retention
  {
    const id = "retention_d1";
    const label = "Удержание 1 дня";
    if (i.d1.cohort <= 0) out.push(noData(id, label, "35%", "—", "Нет регистраций за окно (до позавчера включительно)."));
    else {
      const v = i.d1.back / i.d1.cohort;
      out.push({
        id,
        label,
        value: pct(v),
        norm: "35%",
        alarm: "—",
        status: v < 0.35 ? "warn" : "ok",
        note: `${int(i.d1.back)} из ${int(i.d1.cohort)} зарегистрированных за окно (кроме вчера и сегодня) вошли на карту на следующий UTC-день.`,
        source: "§4",
      });
    }
  }
  out.push(noData("retention_d7", "Удержание 7 дней", "15%", "—", "Нет данных: нужна когорта старше 7 дней, а окно админки — 7 дней."));
  out.push(noData("retention_d30", "Удержание 30 дней", "6%", "—", "Нет данных: нужна когорта старше 30 дней."));

  // 9. bug reports
  out.push(noData("bug_response", "Ответ на баг-репорт", "< 24 ч", "> 48 ч", "Нет данных: баг-репорты в базу не пишутся (ALPHA_PLAN B13)."));

  // GAME_DESIGN §22 extras
  {
    const id = "mia_share";
    const label = "MIA (застал вайп)";
    if (i.exitsAll <= 0) out.push(noData(id, label, "≤ 5% входов", "> 10%", "Завершённых входов за 7 дней нет.", "§22"));
    else {
      const v = i.mia / i.exitsAll;
      out.push({
        id,
        label,
        value: pct(v),
        norm: "≤ 5% входов",
        alarm: "> 10%",
        status: v > 0.1 ? "alarm" : v > 0.05 ? "warn" : "ok",
        note: `${int(i.mia)} MIA из ${int(i.exitsAll)} завершённых входов за 7 дней.`,
        source: "§22",
      });
    }
  }
  {
    const id = "gear_share";
    const label = "Входы со снаряжением";
    if (i.regEntries <= 0) out.push(noData(id, label, "≥ 40%", "< 25%", "Входов зарегистрированных за 7 дней нет.", "§22"));
    else {
      const v = i.gearEntries / i.regEntries;
      out.push({
        id,
        label,
        value: pct(v),
        norm: "≥ 40%",
        alarm: "< 25%",
        status: v < 0.25 ? "alarm" : v < 0.4 ? "warn" : "ok",
        note: `${int(i.gearEntries)} из ${int(i.regEntries)} входов зарегистрированных за 7 дней — со своим снаряжением, не с бесплатным набором.`,
        source: "§22",
      });
    }
  }
  {
    const id = "median_cr";
    const label = "Медиана CR активных";
    const edge = i.autosell <= AUTOSELL.MIN || i.autosell >= AUTOSELL.MAX;
    if (i.medianCr === null) out.push(noData(id, label, "2 000–8 000", "регулятор на краю", "Активных игроков нет.", "§22"));
    else {
      out.push({
        id,
        label,
        value: int(i.medianCr),
        norm: "2 000–8 000",
        alarm: "регулятор на краю",
        status: edge ? "alarm" : bandStatus(i.medianCr, 2_000, 8_000),
        note: `Медиана баланса CR у ${int(i.players)} игроков с выходом за 7 дней. Множитель автопродажи сейчас ${i.autosell} (полоса ${AUTOSELL.MIN}–${AUTOSELL.MAX}).`,
        source: "§22",
      });
    }
  }

  return out;
}
