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
  status: string;
  map_id: string;
  started_at: Date | string;
  boss_kind: string | null;
  boss_zone: string | null;
  next_boss_kind: string | null;
  next_boss_zone: string | null;
  boss_killed_by: string | null;
  boss_killed_at: Date | string | null;
};

/**
 * GET /api/world/status (spec §4.8, D26): the lobby's world card, from the web DB only (no game
 * server HTTP). Public and CDN-cached (s-maxage=5), so it carries nothing per user.
 * - cur = the newest running world row of the current cycle; none → `online: false`, 0 humans, no boss.
 * - humans = active entries of cur.
 * - boss = cur's event boss (alive / killed by).
 * - next.boss appears only NEXT_BOSS_REVEAL_MS before the wipe (from cur.next_boss_*): absent before,
 *   null when the next map has no boss.
 * - last = the previous cycle's settled row: exits by type, top ranked PvP killer, boss killer.
 */
export async function worldStatus(db: Db, now = worldNow()): Promise<WorldStatusDto> {
  const wc = worldCycleAt(now);
  const rowsRes = await db.execute<WorldRow>(sql`
    select match_id, cycle_id, status, map_id, started_at, boss_kind, boss_zone, next_boss_kind, next_boss_zone,
           boss_killed_by, boss_killed_at
    from raids
    where kind = 'world' and cycle_id in (${wc.cycle}, ${wc.cycle - 1})
    order by started_at desc`);
  const rows = rowsRes.rows;
  const cur = rows.find((r) => Number(r.cycle_id) === wc.cycle && r.status === "running") ?? null;
  const prev = rows.find((r) => Number(r.cycle_id) === wc.cycle - 1 && r.status === "settled") ?? null;

  let humans = 0;
  let boss: WorldBossDto | null = null;
  const nextCycle = worldCycleOf(wc.cycle + 1);
  const next: WorldStatusDto["next"] = { cycle: nextCycle.cycle, mapNumber: mapNumber(nextCycle.cycle), openAt: nextCycle.openAt };
  if (cur) {
    const h = await db.execute<{ n: number }>(sql`
      select count(*)::int as n from raid_entries where match_id = ${cur.match_id} and status = 'active'`);
    humans = Number(h.rows[0]?.n ?? 0);
    const info = bossInfo(cur.boss_kind, cur.boss_zone, cur.map_id);
    if (info) {
      boss = {
        ...info,
        status: cur.boss_killed_at ? "killed" : "alive",
        killedBy: cur.boss_killed_at ? (cur.boss_killed_by ?? "") : null,
      };
    }
    if (now >= wc.wipeAt - WORLD.NEXT_BOSS_REVEAL_MS) {
      const nb = bossInfo(cur.next_boss_kind, cur.next_boss_zone, cur.map_id);
      next.boss = nb ? { kind: nb.kind, name: nb.name, zoneName: nb.zoneName } : null;
    }
  }

  let last: WorldStatusDto["last"] = null;
  if (prev) {
    const [ex, top] = await Promise.all([
      db.execute<{ extracted: number; died: number; mia: number }>(sql`
        select count(*) filter (where exit = 'extract')::int as extracted,
               count(*) filter (where exit = 'dead')::int as died,
               count(*) filter (where exit = 'mia')::int as mia
        from raid_exits where match_id = ${prev.match_id}`),
      db.execute<{ nickname: string; kills: number }>(sql`
        select u.nickname, count(*)::int as kills
        from pvp_kills k join users u on u.id = k.killer_id
        where k.ranked and k.cycle_id = ${wc.cycle - 1}
        group by u.id, u.nickname
        order by kills desc, min(k.at) asc
        limit 1`),
    ]);
    const e = ex.rows[0];
    const t = top.rows[0];
    last = {
      cycle: wc.cycle - 1,
      mapNumber: mapNumber(wc.cycle - 1),
      extracted: Number(e?.extracted ?? 0),
      died: Number(e?.died ?? 0),
      mia: Number(e?.mia ?? 0),
      topKiller: t ? { nickname: t.nickname, kills: Number(t.kills) } : null,
      bossKilledBy: prev.boss_killed_at ? (prev.boss_killed_by ?? "") : null,
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
    online: cur !== null,
    humans,
    capacity: WORLD.CAPACITY * WORLD.MAX_SHARDS,
    boss,
    next,
    last,
  };
}
