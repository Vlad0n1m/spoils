import { sql } from "drizzle-orm";
import {
  WORLD,
  mapNumber,
  worldCycleAt,
  worldCycleOf,
  worldPhase,
  type WorldBossDto,
  type WorldStatusDto,
} from "@extract/shared";
import type { Db } from "../inventory/db";
import { bossInfo } from "./boss-info";
import { worldNow } from "./clock";

type WorldRow = {
  match_id: string;
  cycle_id: number;
  shard: number | null;
  status: string;
  map_id: string;
  started_at: Date | string;
  boss_kind: string | null;
  boss_zone: string | null;
  boss_killed_by: string | null;
  boss_killed_at: Date | string | null;
};

/**
 * GET /api/world/status (spec §4.8, D26): the lobby's world card, from the web DB only (no game
 * server HTTP). Public and CDN-cached (s-maxage=5), so it carries nothing per user.
 * Overlapping maps: it always describes the open cycle (worldCycleAt — the one accepting entries, so
 * `phase` is "open"); the previous cycle shows up as `closing` while its map still runs.
 * - shards = the newest running world row of each shard index of the open cycle (a restart's newer
 *   row supersedes the older one, as in /api/world/join); none → `online: false`, 0 humans, no boss.
 * - humans = active entries over those shards; capacity = WORLD.CAPACITY × max(1, shards).
 * - boss = the cycle's event boss (every shard runs its own instance of the same kind): killed once
 *   it died on every shard, `killedBy` = the first killer. The boss is revealed when the map opens,
 *   which is when the previous map's entry closes (the old NEXT_BOSS_REVEAL_MS moment).
 * - closing = the previous cycle while now < its wipe: its active entries (raiders still on it).
 * - last = the newest wiped cycle (the previous one once it wiped, else the one before): exits by type
 *   over all its settled shards, top ranked PvP killer, the first boss killer.
 */
export async function worldStatus(db: Db, now = worldNow()): Promise<WorldStatusDto> {
  const wc = worldCycleAt(now);
  const prevWc = worldCycleOf(wc.cycle - 1);
  const closing = now < prevWc.wipeAt;
  const lastCycle = closing ? wc.cycle - 2 : wc.cycle - 1;
  const rowsRes = await db.execute<WorldRow>(sql`
    select match_id, cycle_id, shard, status, map_id, started_at, boss_kind, boss_zone,
           boss_killed_by, boss_killed_at
    from raids
    where kind = 'world' and cycle_id in (${wc.cycle}, ${wc.cycle - 1}, ${wc.cycle - 2})
    order by started_at desc`);
  const rows = rowsRes.rows;
  // Newest row per (cycle, shard) first (ordered by started_at desc).
  const newest = (cycle: number, status: string): WorldRow[] => {
    const seen = new Set<number>();
    const out: WorldRow[] = [];
    for (const r of rows) {
      if (Number(r.cycle_id) !== cycle || r.status !== status) continue;
      const s = Number(r.shard ?? 0);
      if (seen.has(s)) continue;
      seen.add(s);
      out.push(r);
    }
    return out.sort((a, b) => Number(a.shard ?? 0) - Number(b.shard ?? 0));
  };
  const cur = newest(wc.cycle, "running");
  const prevRunning = closing ? newest(wc.cycle - 1, "running") : [];
  const last = rows.filter((r) => Number(r.cycle_id) === lastCycle && r.status === "settled");

  const activeOf = async (ids: string[]): Promise<number> => {
    if (ids.length === 0) return 0;
    const h = await db.execute<{ n: number }>(sql`
      select count(*)::int as n from raid_entries
      where match_id in (${sql.join(ids.map((id) => sql`${id}`), sql`, `)}) and status = 'active'`);
    return Number(h.rows[0]?.n ?? 0);
  };
  const [humans, closingHumans] = await Promise.all([activeOf(cur.map((r) => r.match_id)), activeOf(prevRunning.map((r) => r.match_id))]);

  let boss: WorldBossDto | null = null;
  const head = cur[0];
  if (head) {
    const info = bossInfo(head.boss_kind, head.boss_zone, head.map_id);
    if (info) {
      const kills = cur
        .filter((r) => r.boss_killed_at)
        .sort((a, b) => new Date(a.boss_killed_at!).getTime() - new Date(b.boss_killed_at!).getTime());
      const killed = kills.length === cur.length;
      boss = { ...info, status: killed ? "killed" : "alive", killedBy: killed ? (kills[0]!.boss_killed_by ?? "") : null };
    }
  }
  const nextCycle = worldCycleOf(wc.cycle + 1);
  const next: WorldStatusDto["next"] = { cycle: nextCycle.cycle, mapNumber: mapNumber(nextCycle.cycle), openAt: nextCycle.openAt };

  let lastDto: WorldStatusDto["last"] = null;
  if (last.length > 0) {
    const ids = last.map((r) => r.match_id);
    const [ex, top] = await Promise.all([
      db.execute<{ extracted: number; died: number; mia: number }>(sql`
        select count(*) filter (where exit = 'extract')::int as extracted,
               count(*) filter (where exit = 'dead')::int as died,
               count(*) filter (where exit = 'mia')::int as mia
        from raid_exits where match_id in (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})`),
      db.execute<{ nickname: string; kills: number }>(sql`
        select u.nickname, count(*)::int as kills
        from pvp_kills k join users u on u.id = k.killer_id
        where k.ranked and k.cycle_id = ${lastCycle}
        group by u.id, u.nickname
        order by kills desc, min(k.at) asc
        limit 1`),
    ]);
    const e = ex.rows[0];
    const t = top.rows[0];
    const killer = last
      .filter((r) => r.boss_killed_at)
      .sort((a, b) => new Date(a.boss_killed_at!).getTime() - new Date(b.boss_killed_at!).getTime())[0];
    lastDto = {
      cycle: lastCycle,
      mapNumber: mapNumber(lastCycle),
      extracted: Number(e?.extracted ?? 0),
      died: Number(e?.died ?? 0),
      mia: Number(e?.mia ?? 0),
      topKiller: t ? { nickname: t.nickname, kills: Number(t.kills) } : null,
      bossKilledBy: killer ? (killer.boss_killed_by ?? "") : null,
    };
  }

  return {
    v: 1,
    serverTime: now,
    cycle: wc.cycle,
    mapNumber: mapNumber(wc.cycle),
    phase: worldPhase(wc, now),
    openAt: wc.openAt,
    entryClosesAt: wc.entryClosesAt,
    wipeAt: wc.wipeAt,
    online: cur.length > 0,
    humans,
    shards: cur.length,
    capacity: WORLD.CAPACITY * Math.max(1, Math.min(WORLD.MAX_SHARDS, cur.length)),
    boss,
    next,
    closing: closing && prevRunning.length > 0
      ? { cycle: prevWc.cycle, mapNumber: mapNumber(prevWc.cycle), wipeAt: prevWc.wipeAt, humans: closingHumans }
      : null,
    last: lastDto,
  };
}
