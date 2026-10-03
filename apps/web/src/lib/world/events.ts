import { sql } from "drizzle-orm";
import { mapNumber, worldCycleAt, worldCycleOf, type WorldEventDto, type WorldEventsDto } from "@extract/shared";
import type { Db } from "../inventory/db";
import { bossInfo } from "./boss-info";
import { worldNow } from "./clock";

/** World rows of the last WORLD_EVENTS_CYCLES cycles feed the News feed (≈ 18 h). */
export const WORLD_EVENTS_CYCLES = 24;
export const WORLD_EVENTS_DEFAULT_LIMIT = 20;
export const WORLD_EVENTS_MAX_LIMIT = 50;

/** Same instant and cycle (never in practice): wipe before kill before spawn, newest first. */
const KIND_ORDER: Readonly<Record<WorldEventDto["kind"], number>> = { wiped: 0, boss_killed: 1, boss_spawned: 2 };

type EventRow = {
  match_id: string;
  cycle_id: number;
  status: string;
  map_id: string;
  ends_at: Date | string;
  boss_kind: string | null;
  boss_zone: string | null;
  boss_killed_by: string | null;
  boss_killed_at: Date | string | null;
  entries: number;
  extracted: number;
  died: number;
  mia: number;
};

/**
 * GET /api/world/events (spec §4.9, D27): News derived from world raids rows, no news table.
 * - `boss_spawned`: a row with an event boss, at = its cycle start (not before it has started; a
 *   voided row counts too: the boss did spawn before the crash).
 * - `boss_killed`: boss_killed_at, by = the killer's nickname ("" = not killed by a raider).
 * - `wiped`: settled rows, at = ends_at (the wipe), with entries and exits by type.
 * Ids are `"<cycle>:<kind>"`, so a cycle that had two rows (a restart mid-cycle) shows each kind
 * once (the newest row wins). Newest first, at most `limit`.
 */
export async function worldEvents(db: Db, limit = WORLD_EVENTS_DEFAULT_LIMIT, now = worldNow()): Promise<WorldEventsDto> {
  const n = Math.max(1, Math.min(WORLD_EVENTS_MAX_LIMIT, Math.floor(limit) || WORLD_EVENTS_DEFAULT_LIMIT));
  const cycle = worldCycleAt(now).cycle;
  const r = await db.execute<EventRow>(sql`
    select r.match_id, r.cycle_id, r.status, r.map_id, r.ends_at, r.boss_kind, r.boss_zone, r.boss_killed_by, r.boss_killed_at,
      (select count(*)::int from raid_entries e where e.match_id = r.match_id) as entries,
      (select count(*)::int from raid_exits x where x.match_id = r.match_id and x.exit = 'extract') as extracted,
      (select count(*)::int from raid_exits x where x.match_id = r.match_id and x.exit = 'dead') as died,
      (select count(*)::int from raid_exits x where x.match_id = r.match_id and x.exit = 'mia') as mia
    from raids r
    where r.kind = 'world' and r.cycle_id > ${cycle - WORLD_EVENTS_CYCLES} and r.cycle_id <= ${cycle}
    order by r.started_at desc`);

  const byId = new Map<string, WorldEventDto>();
  const put = (e: WorldEventDto) => {
    if (e.at <= now && !byId.has(e.id)) byId.set(e.id, e);
  };
  for (const row of r.rows) {
    const c = Number(row.cycle_id);
    const base = { cycle: c, mapNumber: mapNumber(c) };
    const info = bossInfo(row.boss_kind, row.boss_zone, row.map_id);
    const boss = info ? { kind: info.kind, name: info.name, zoneName: info.zoneName } : undefined;
    if (boss) {
      put({ id: `${c}:boss_spawned`, at: worldCycleOf(c).startAt, kind: "boss_spawned", boss, ...base });
    }
    if (boss && row.boss_killed_at) {
      put({
        id: `${c}:boss_killed`,
        at: new Date(row.boss_killed_at).getTime(),
        kind: "boss_killed",
        boss,
        by: row.boss_killed_by ?? "",
        ...base,
      });
    }
    if (row.status === "settled") {
      put({
        id: `${c}:wiped`,
        at: new Date(row.ends_at).getTime(),
        kind: "wiped",
        stats: { entries: Number(row.entries), extracted: Number(row.extracted), died: Number(row.died), mia: Number(row.mia) },
        ...base,
      });
    }
  }
  const events = [...byId.values()]
    .sort((a, b) => b.at - a.at || b.cycle - a.cycle || KIND_ORDER[a.kind] - KIND_ORDER[b.kind])
    .slice(0, n);
  return { events };
}
