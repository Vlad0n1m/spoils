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
 * - `boss_spawned`: a row with an event boss, at = its map's opening (worldCycleOf startAt; not
 *   before it has opened; a voided row counts too: the boss did spawn before the crash).
 * - `boss_killed`: the cycle's first boss_killed_at over its shards, by = the killer's nickname
 *   ("" = not killed by a raider).
 * - `wiped`: the cycle's settled rows (all its shards) summed, at = ends_at (the wipe).
 * Ids are `"<cycle>:<kind>"`, so a cycle with several rows (shards, or a restart mid-cycle) shows
 * each kind once. Newest first, at most `limit`.
 */
export async function worldEvents(db: Db, limit = WORLD_EVENTS_DEFAULT_LIMIT, now = worldNow()): Promise<WorldEventsDto> {
  const n = Math.max(1, Math.min(WORLD_EVENTS_MAX_LIMIT, Math.floor(limit) || WORLD_EVENTS_DEFAULT_LIMIT));
  const cycle = worldCycleAt(now).cycle;
  // One pass over each shard's exits (not one per exit type): docs/DB_REVIEW.md.
  const r = await db.execute<EventRow>(sql`
    select r.match_id, r.cycle_id, r.status, r.map_id, r.ends_at, r.boss_kind, r.boss_zone, r.boss_killed_by, r.boss_killed_at,
      e.entries, x.extracted, x.died, x.mia
    from raids r
    cross join lateral (select count(*)::int as entries from raid_entries e where e.match_id = r.match_id) e
    cross join lateral (
      select count(*) filter (where x.exit = 'extract')::int as extracted,
             count(*) filter (where x.exit = 'dead')::int as died,
             count(*) filter (where x.exit = 'mia')::int as mia
      from raid_exits x where x.match_id = r.match_id) x
    where r.kind = 'world' and r.cycle_id > ${cycle - WORLD_EVENTS_CYCLES} and r.cycle_id <= ${cycle}
    order by r.started_at desc`);

  const byId = new Map<string, WorldEventDto>();
  const put = (e: WorldEventDto) => {
    if (e.at <= now && !byId.has(e.id)) byId.set(e.id, e);
  };
  // Several shards per cycle (WORLD.MAX_SHARDS): one `wiped` per cycle summing its settled shards,
  // and the cycle's first boss kill (each shard runs its own instance of the cycle's boss).
  const settled = new Map<number, { at: number; entries: number; extracted: number; died: number; mia: number }>();
  for (const row of r.rows) {
    if (row.status !== "settled") continue;
    const c = Number(row.cycle_id);
    const s = settled.get(c) ?? { at: 0, entries: 0, extracted: 0, died: 0, mia: 0 };
    s.at = Math.max(s.at, new Date(row.ends_at).getTime());
    s.entries += Number(row.entries);
    s.extracted += Number(row.extracted);
    s.died += Number(row.died);
    s.mia += Number(row.mia);
    settled.set(c, s);
  }
  const rows = [...r.rows].sort((a, b) => {
    const ka = a.boss_killed_at ? new Date(a.boss_killed_at).getTime() : Infinity;
    const kb = b.boss_killed_at ? new Date(b.boss_killed_at).getTime() : Infinity;
    return ka - kb;
  });
  for (const row of rows) {
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
    const s = settled.get(c);
    if (s) put({ id: `${c}:wiped`, at: s.at, kind: "wiped", stats: { entries: s.entries, extracted: s.extracted, died: s.died, mia: s.mia }, ...base });
  }
  const events = [...byId.values()]
    .sort((a, b) => b.at - a.at || b.cycle - a.cycle || KIND_ORDER[a.kind] - KIND_ORDER[b.kind])
    .slice(0, n);
  return { events };
}
