import { BOSSES, BOSS_KINDS, generateMap, type BossKind, type MapId } from "@extract/shared";

/**
 * Display data of a world row's event boss for the lobby (status card, News). The zone name, its
 * loot tier and the spot's guard count come from the generated map (memoized per map id in shared,
 * ~60 ms once per process), so they always match what the game server spawns.
 */
export interface BossInfo {
  kind: BossKind;
  name: string;
  zone: string;
  zoneName: string;
  tier: number;
  guards: number;
}

export function isBossKind(v: unknown): v is BossKind {
  return typeof v === "string" && (BOSS_KINDS as readonly string[]).includes(v);
}

/** null when `kind` is not a known boss (a row written by a newer server). */
export function bossInfo(kind: string | null | undefined, zone: string | null | undefined, mapId: string = "steppe"): BossInfo | null {
  if (!isBossKind(kind)) return null;
  const def = BOSSES[kind];
  let zoneName = zone ?? "";
  let tier = 0;
  let guards = def.guards.length;
  try {
    const map = generateMap(mapId as MapId);
    const spot = map.bosses.find((b) => b.kind === kind && (!zone || b.zone === zone)) ?? map.bosses.find((b) => b.kind === kind);
    const zid = zone || spot?.zone || "";
    const z = map.zones.find((q) => q.id === zid);
    if (z) {
      zoneName = z.name;
      tier = z.tier;
    }
    if (spot) guards = spot.guards.length;
    return { kind, name: def.name, zone: zid, zoneName, tier, guards };
  } catch {
    // Unknown map id: show what the row has.
    return { kind, name: def.name, zone: zone ?? "", zoneName, tier, guards };
  }
}
