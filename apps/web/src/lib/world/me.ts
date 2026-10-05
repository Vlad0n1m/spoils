import { sql } from "drizzle-orm";
import {
  BOSS_KINDS,
  bossTrophyId,
  cosmeticDef,
  levelForXp,
  mapNumber,
  worldCycleAt,
  type ExitType,
  type LastRaidDto,
  type MeWorldDto,
  type PlayerExitReport,
  type XpLine,
} from "@extract/shared";
import type { Db } from "../inventory/db";
import { voidStaleForUser } from "../inventory/raids";
import { worldNow } from "./clock";

/**
 * GET /api/me/world (spec §4.9, private, no-store): the caller's world state for the lobby.
 * Runs the user's lazy void first (voidStaleForUser, as /api/world/join does), so an entry on the
 * shard of a crashed or restarted game server is voided here instead of showing as rejoinable.
 * - activeEntry: their active raid_entries row; `rejoinable` = its shard row is running and in the
 *   current cycle (then /api/world/join hands back a rejoin ticket for it).
 * - lastRaid: their newest raid_exits row that belongs to an entry (world exits; legacy exits have
 *   no raid_entries row). `levelBefore = levelForXp(users.xp − row.xp)` is valid because that exit is
 *   the newest XP change. `kills.npcs` counts every NPC (marauders, guards and bosses);
 *   `kills.bosses` is the boss part of it; `kills.players` = human kills of the report;
 *   `trophies` = the boss trophy titles of the report (bossTrophies), by name; `killedBy` /
 *   `killedByRole` = the report's killer on a death.
 * Guests (no users row) get level 0.
 */
export async function meWorld(db: Db, userId: string, now = worldNow()): Promise<MeWorldDto> {
  const wc = worldCycleAt(now);
  await voidStaleForUser(db, userId, new Date(now));
  const [act, last, user] = await Promise.all([
    db.execute<{ entry_id: string; match_id: string; cycle_id: number; ends_at: Date | string | null; status: string | null; raid_cycle: number | null }>(sql`
      select e.entry_id, e.match_id, e.cycle_id, r.ends_at, r.status, r.cycle_id as raid_cycle
      from raid_entries e left join raids r on r.match_id = e.match_id
      where e.user_id = ${userId} and e.status = 'active'
      order by e.created_at desc limit 1`),
    db.execute<{
      entry_id: string;
      cycle_id: number;
      exit: ExitType;
      at: Date | string;
      on_map_ms: number;
      xp: number;
      xp_lines: XpLine[] | null;
      credits: number;
      npc_kills: number;
      boss_kills: number;
      report: PlayerExitReport | null;
    }>(sql`
      select x.entry_id, e.cycle_id, x.exit, x.at, x.on_map_ms, x.xp, x.xp_lines, x.credits, x.npc_kills, x.boss_kills, x.report
      from raid_exits x join raid_entries e on e.entry_id = x.entry_id
      where x.user_id = ${userId}
      order by x.at desc limit 1`),
    db.execute<{ xp: number }>(sql`select xp from users where id = ${userId}`),
  ]);

  const a = act.rows[0];
  const activeEntry: MeWorldDto["activeEntry"] = a
    ? {
        matchId: a.match_id,
        entryId: a.entry_id,
        cycle: Number(a.cycle_id),
        wipeAt: a.ends_at ? new Date(a.ends_at).getTime() : 0,
        rejoinable: a.status === "running" && Number(a.raid_cycle) === wc.cycle,
      }
    : null;

  const l = last.rows[0];
  const xpNow = user.rows[0] ? Number(user.rows[0].xp) : null;
  let lastRaid: LastRaidDto | null = null;
  if (l) {
    const xp = Number(l.xp);
    const report = l.report;
    const players = Math.max(0, Math.floor(Number(report?.kills ?? report?.victims?.length ?? 0)) || 0);
    const npcs = Number(l.npc_kills);
    const bosses = Number(l.boss_kills);
    lastRaid = {
      entryId: l.entry_id,
      cycle: Number(l.cycle_id),
      mapNumber: mapNumber(Number(l.cycle_id)),
      exit: l.exit,
      at: new Date(l.at).getTime(),
      onMapMs: Number(l.on_map_ms),
      xp,
      xpLines: Array.isArray(l.xp_lines) ? l.xp_lines : [],
      credits: Number(l.credits),
      levelBefore: xpNow === null ? 0 : levelForXp(Math.max(0, xpNow - xp)),
      level: xpNow === null ? 0 : levelForXp(xpNow),
      kills: { players, npcs: npcs + bosses, bosses },
    };
    // Boss trophies earned this raid (the titles granted at settlement), by name.
    const trophies = (Array.isArray(report?.bossTrophies) ? report.bossTrophies : [])
      .map((k) => (BOSS_KINDS.includes(k) ? cosmeticDef(bossTrophyId(k))?.name : undefined))
      .filter((n): n is string => !!n);
    if (trophies.length > 0) lastRaid.trophies = trophies;
    // Death: who killed you (the report's killedBy, NPCs by role display key).
    if (l.exit === "dead" && typeof report?.killedBy === "string" && report.killedBy) {
      lastRaid.killedBy = report.killedBy.slice(0, 64);
      lastRaid.killedByRole = Number(report.killedByRole ?? 0) || 0;
    }
  }
  return { serverTime: now, activeEntry, lastRaid };
}
