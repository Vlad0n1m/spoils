/**
 * POI garrison (2026-10, Vlad's playtest: a pistol-only run looted the T4 Radar and extracted without
 * meeting a single marauder). Garrison v2: every building of every POI has its own guard group, and
 * every place holds at least its POI minimum by tier (shared POI_GARRISON: T4 ≥ 20). Checked on the
 * real Steppe world map, with no boss event and with each one: members stand on free ground at their
 * post (a building's door yard or inside it), never at a spawn or an extract; the cap never cuts it.
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
  rollGarrisons,
  type BossKind,
} from "@extract/shared";
import { worldMatch } from "./test-utils.js";

const map = generateMap("steppe");
const posts = map.npcPosts!;

function garrisonOf(lootSeed: number, bossEvent: BossKind | null) {
  const { m } = worldMatch({ map, lootSeed, bossEvent, bosses: true, marauders: true, npcBrains: false });
  const perZone = new Map<string, number>();
  const perBuilding = new Map<number, number>();
  for (const sq of m.npcs.squads) {
    if (sq.type !== "marauder" || !sq.post?.zone) continue;
    const post = sq.post;
    const alive = sq.members.filter((r) => r.pub.alive);
    perZone.set(post.zone!, (perZone.get(post.zone!) ?? 0) + alive.length);
    if (post.kind === "bld") perBuilding.set(post.building!, (perBuilding.get(post.building!) ?? 0) + alive.length);
    const spawnClear = post.kind === "bld" ? POI_GARRISON.SPAWN_CLEAR_PX : NPC.SPAWN_CLEAR_PX;
    for (const rt of alive) {
      const p = rt.pub;
      assert.equal(p.role, NPC_ROLE.MARAUDER);
      assert.ok(circleIsFree(m.idx, p.x, p.y, PLAYER.RADIUS), `${post.zone} post ${post.id} member inside a wall`);
      // memberSpot keeps a member within 140 px of its post, which keeps the post clearances.
      for (const s of map.spawns) assert.ok(Math.hypot(p.x - s.x, p.y - s.y) >= spawnClear - 150, `${post.zone} member at a spawn`);
      for (const e of map.extracts) assert.ok(Math.hypot(p.x - e.x, p.y - e.y) >= NPC.EXTRACT_CLEAR_PX - 150, `${post.zone} member on extract ${e.id}`);
      assert.ok(Math.hypot(p.x - post.x, p.y - post.y) <= 150, "member stands at its post");
    }
  }
  return { m, perZone, perBuilding };
}

test("POI garrison: every building of every POI is held on non-boss world maps; POI minimum by tier, Radar (T4) ≥ 20", () => {
  const byTier = new Map<number, number[]>();
  for (let s = 0; s < 12; s++) {
    const lootSeed = (s * 2654435761 + 5) >>> 0;
    const { m, perZone, perBuilding } = garrisonOf(lootSeed, null);
    assert.equal(m.npcs.squads.filter((q) => q.type === "boss").length, 0, "no boss on a non-event map");
    const g = rollGarrisons(lootSeed, posts);
    map.buildings.forEach((b, bi) => {
      if (!b.zone) return;
      const tier = map.zones.find((z) => z.id === b.zone)!.tier;
      if (tier >= 1) assert.ok((perBuilding.get(bi) ?? 0) >= 1, `seed ${lootSeed}: building ${bi} (${b.zone}) unguarded`);
    });
    for (const p of posts) if (p.kind === "bld") assert.ok((perBuilding.get(p.building!) ?? 0) >= g.buildings.get(p.id)!, `building ${p.building} below its group`);
    for (const z of map.zones) {
      const n = perZone.get(z.id) ?? 0;
      assert.ok(n >= g.zones.get(z.id)!, `seed ${lootSeed}: ${z.id} (T${z.tier}) ${n} < minimum ${g.zones.get(z.id)}`);
      assert.ok(n >= POI_GARRISON.POI_MIN[z.tier][0], `${z.id} T${z.tier}: ${n}`);
      if (!byTier.has(z.tier)) byTier.set(z.tier, []);
      byTier.get(z.tier)!.push(n);
    }
    assert.ok((perZone.get("radar") ?? 0) >= 20, `Radar ${perZone.get("radar")}`);
    assert.ok(m.npcs.runtimes().length <= NPC.MAX_PER_RAID);
    // Same seed, same garrison (deterministic from the match seed).
    assert.deepEqual(garrisonOf(lootSeed, null).perZone, perZone);
  }
  const mean = (t: number) => byTier.get(t)!.reduce((a, b) => a + b, 0) / byTier.get(t)!.length;
  assert.ok(mean(4) > mean(3) && mean(3) > mean(2) && mean(2) > mean(1), `means T1 ${mean(1)} T2 ${mean(2)} T3 ${mean(3)} T4 ${mean(4)}`);
});

test("POI garrison: boss maps keep the boss + guards and every building / place garrison, the boss's place included", () => {
  for (const kind of ["commander", "foreman", "warden"] as const) {
    const { m, perZone, perBuilding } = garrisonOf(77, kind);
    const groups = m.npcs.squads.filter((q) => q.type === "boss");
    assert.equal(groups.length, 1, `${kind}: one boss group`);
    assert.ok(groups[0]!.members.length >= 3, `${kind}: boss + guards`);
    const g = rollGarrisons(77, posts);
    for (const z of map.zones) assert.ok((perZone.get(z.id) ?? 0) >= g.zones.get(z.id)!, `${kind} map: ${z.id}`);
    const zone = m.eventBossSpot!.zone;
    map.buildings.forEach((b, bi) => {
      if (b.zone === zone) assert.ok((perBuilding.get(bi) ?? 0) >= 1, `${kind}'s place: building ${bi} held`);
    });
    assert.ok(m.npcs.runtimes().length <= NPC.MAX_PER_RAID);
  }
});
