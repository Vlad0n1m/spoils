/**
 * POI garrison (2026-10, Vlad's playtest: a pistol-only run looted the T4 Radar and extracted without
 * meeting a single marauder). On the real Steppe world map every POI zone of tier ≥ 1 is held by
 * marauders on every map — with no boss event and with one — and the count follows the tier
 * (shared POI_GARRISON.BY_TIER). Members stand on free ground near their post, never at a spawn or
 * an extract.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  NPC,
  NPC_ROLE,
  PLAYER,
  POI_GARRISON,
  circleIsFree,
  generateMap,
  garrisonRange,
  npcClassOfTier,
  type BossKind,
} from "@extract/shared";
import { worldMatch } from "./test-utils.js";

const map = generateMap("steppe");

function garrisonOf(lootSeed: number, bossEvent: BossKind | null) {
  const { m } = worldMatch({ map, lootSeed, bossEvent, bosses: true, marauders: true, npcBrains: false });
  const per = new Map<string, number>();
  for (const sq of m.npcs.squads) {
    if (sq.type !== "marauder" || !sq.post?.zone) continue;
    const alive = sq.members.filter((r) => r.pub.alive);
    per.set(sq.post.zone, (per.get(sq.post.zone) ?? 0) + alive.length);
    for (const rt of alive) {
      const p = rt.pub;
      assert.equal(p.role, NPC_ROLE.MARAUDER);
      assert.ok(circleIsFree(m.idx, p.x, p.y, PLAYER.RADIUS), `${sq.post.zone} member inside a wall`);
      // memberSpot keeps a member within 140 px of its post, which keeps the post clearances.
      for (const s of map.spawns) assert.ok(Math.hypot(p.x - s.x, p.y - s.y) >= NPC.SPAWN_CLEAR_PX - 150, `${sq.post.zone} member at a spawn`);
      for (const e of map.extracts) assert.ok(Math.hypot(p.x - e.x, p.y - e.y) >= NPC.EXTRACT_CLEAR_PX - 150, `${sq.post.zone} member on extract ${e.id}`);
      assert.ok(Math.hypot(p.x - sq.post.x, p.y - sq.post.y) <= 150, "member stands at its post");
    }
  }
  return { m, per };
}

test("POI garrison: every POI zone of tier ≥ 1 is guarded on non-boss world maps, counts by tier", () => {
  const byTier = new Map<number, number[]>();
  for (let s = 0; s < 24; s++) {
    const lootSeed = (s * 2654435761 + 5) >>> 0;
    const { m, per } = garrisonOf(lootSeed, null);
    assert.equal(m.npcs.squads.filter((q) => q.type === "boss").length, 0, "no boss on a non-event map");
    for (const z of map.zones) {
      const n = per.get(z.id) ?? 0;
      const [lo] = garrisonRange(z.tier);
      assert.ok(n >= lo, `seed ${lootSeed}: ${z.id} (T${z.tier}) has ${n} marauders, garrison min ${lo}`);
      if (z.tier >= 1) assert.ok(n >= 1, `${z.id} T${z.tier} unguarded`);
      if (!byTier.has(z.tier)) byTier.set(z.tier, []);
      byTier.get(z.tier)!.push(n);
    }
    // Same seed, same garrison (deterministic from the match seed).
    assert.deepEqual(garrisonOf(lootSeed, null).per, per);
  }
  // Higher tiers hold more marauders on average: T4 Radar ≥ 4 always, and a T3 place more than a T1.
  const mean = (t: number) => byTier.get(t)!.reduce((a, b) => a + b, 0) / byTier.get(t)!.length;
  assert.ok(Math.min(...byTier.get(4)!) >= POI_GARRISON.BY_TIER[4][0]);
  assert.ok(mean(4) > mean(3) && mean(3) > mean(2) && mean(2) > mean(1), `means T1 ${mean(1)} T2 ${mean(2)} T3 ${mean(3)} T4 ${mean(4)}`);
  // Per-tier strength is the existing marauder class (MARAUDER low / mid / high / top).
  assert.equal(npcClassOfTier(4), "top");
});

test("POI garrison: boss maps keep the boss + guards and the garrison of every place, the boss's place included", () => {
  for (const kind of ["commander", "foreman", "warden"] as const) {
    const { m, per } = garrisonOf(77, kind);
    const groups = m.npcs.squads.filter((q) => q.type === "boss");
    assert.equal(groups.length, 1, `${kind}: one boss group`);
    assert.ok(groups[0]!.members.length >= 3, `${kind}: boss + guards`);
    const zone = m.eventBossSpot!.zone;
    for (const z of map.zones) assert.ok((per.get(z.id) ?? 0) >= garrisonRange(z.tier)[0], `${kind} map: ${z.id}`);
    assert.ok((per.get(zone) ?? 0) >= garrisonRange(map.zones.find((z) => z.id === zone)!.tier)[0], `${kind}'s own place keeps its marauders`);
    assert.ok(m.npcs.runtimes().length <= NPC.MAX_PER_RAID);
  }
});
