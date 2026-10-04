/**
 * NPC MODEL v5 (humans + NPCs, no player-bots): marauder tables, spawn / loot / kit rolls, pool
 * carriers, the marauder posts of the Steppe generator and the humans-only side caps.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { SPAWN_RULES, WORLD, humanSideCap } from "./constants.js";
import {
  BOSSES,
  BOSS_AI,
  CONSUMABLES_CR,
  POOL,
  bossSlotCount,
  containerGuarded,
  effectiveHp,
  poolContainerEligible,
  poolContainerWeight,
  poolReleasePlanV4,
  raidBossSlots,
  rollBossSpawns,
  type ConsumableId,
} from "./economy.js";
import { ITEM_FLAG } from "./inventory.js";
import { itemDef } from "./item-defs.js";
import { WEAPONS } from "./items.js";
import { generateMap, generateMapWithReport } from "./map/generate.js";
import { zoneCamp } from "./map/spots.js";
import { ZONE_CAMPS } from "./map/steppe.js";
import { getWalkGrid, mapHash, reachedNear, floodWalk, terrainByteAt, zoneAt } from "./map/query.js";
import { TERRAIN, TERRAIN_INDOOR, TERRAIN_KIND_MASK, type NpcPost } from "./map/types.js";
import {
  MARAUDER,
  NPC,
  NPC_CAMPS,
  NPC_CARRIER,
  NPC_CLASSES,
  NPC_GEAR_FLAGS,
  NPC_KILL,
  NPC_LOOT,
  bossGroupNpcCount,
  expectedMarauders,
  npcCarrierEligible,
  npcCarrierKey,
  npcCarrierWeight,
  npcClassOfPost,
  npcClassOfTier,
  npcLeashPx,
  npcPostsOf,
  parseNpcCarrierKey,
  raidNpcCarriers,
  rollMarauderKit,
  rollNpcLoot,
  rollNpcSpawns,
  type NpcClass,
  type NpcLootDraw,
} from "./npc.js";
import { mulberry32 } from "./rng.js";
import { NPC_ROLE } from "./schema.js";
import { bossKindOfLootKey } from "./types.js";
import { VISION } from "./vision.js";

const m = generateMap("steppe");
const posts = npcPostsOf(m);
const near = (a: number, b: number, rel: number) => Math.abs(a - b) <= Math.abs(b) * rel;

/** CR-eq of one fungible: consumables at trader prices, junk at its autosell value. */
function crEq(def: string, qty: number): number {
  const c = CONSUMABLES_CR[def as ConsumableId];
  if (c) return (c.cr / c.qty) * qty;
  return (itemDef(def)?.value ?? 0) * qty;
}
function drawEv(d: NpcLootDraw): number {
  const tw = d.table.reduce((s, e) => s + e.weight, 0);
  return (1 - d.none) * d.table.reduce((s, e) => s + (e.weight / tw) * crEq(e.def, e.qty), 0);
}

test("roles, renamed constants and aliases", () => {
  assert.deepEqual(NPC_ROLE, { NONE: 0, BOSS: 1, GUARD: 2, MARAUDER: 3 });
  assert.equal(NPC.VIEW_RANGE_CAP, VISION.BOT_RANGE_CAP, "deprecated alias keeps the same cap");
  assert.equal(NPC.VIEW_RANGE_ALERT, VISION.RANGE, "an alerted NPC sees as far as a human");
  assert.equal(BOSS_AI.NO_BREAK, NPC.NO_BREAK);
  assert.equal(NPC_GEAR_FLAGS, ITEM_FLAG.FREE, "NPC gear is FREE: never in a corpse, never extracted, never valued");
  assert.equal(NPC.FRIENDLY_FIRE, false);
  assert.ok(!("WAVES" in NPC), "v6: WAVES replaced by RESPAWN");
  assert.deepEqual(NPC.RESPAWN, {
    ENABLED: true, AFTER_MS: 900_000, MAX_PER_POST: 1, MIN_HUMAN_DIST_PX: 3600,
    MIN_CYCLE_LEFT_MS: 600_000, CONSUMABLE_MULT: 0.5, SALT: 0x5e59a77,
  });
  assert.equal(NPC_KILL.TAG, false);
});

test("marauder classes: tier mapping, effective HP and kits reference real weapons", () => {
  assert.deepEqual([0, 1, 2, 3, 4].map(npcClassOfTier), ["low", "low", "mid", "high", "top"]);
  assert.equal(npcClassOfPost({ kind: "road", tier: 4 }), "low", "road camps are always low");
  assert.equal(npcClassOfPost({ kind: "gate", tier: 3 }), "high");
  assert.equal(npcLeashPx({ kind: "poi", tier: 4 }), 900);
  assert.equal(effectiveHp(MARAUDER.low.hp, MARAUDER.low.armor), 80);
  assert.equal(effectiveHp(MARAUDER.mid.hp, MARAUDER.mid.armor), 125);
  assert.equal(effectiveHp(MARAUDER.high.hp, MARAUDER.high.armor), 125);
  assert.equal(Math.round(effectiveHp(MARAUDER.top.hp, MARAUDER.top.armor)), 169);
  for (const c of NPC_CLASSES) {
    const d = MARAUDER[c];
    assert.equal(d.name, "Marauder");
    for (const w of d.weapons) assert.ok(WEAPONS[w.weapon], `${c} ${w.weapon}`);
    assert.ok(d.reactMs[0] < d.reactMs[1] && d.leashPx > 0 && d.freeAmmo > 0);
    // Marauders are sloppier than guards, which are sloppier than bosses.
    assert.ok(d.sloppiness > BOSS_AI.GUARD_SLOPPINESS, c);
  }
});

test("NPC_LOOT: table EV matches the design and rolled EV converges (±10 %, 20k rolls)", () => {
  const want: Record<NpcClass, [number, number]> = { low: [11.4, 12.9], mid: [17.7, 30.8], high: [30.3, 48.8], top: [50.9, 58.8] };
  const killCost: Record<NpcClass, number> = { low: 32, mid: 54, high: 80, top: 126 };
  for (const c of NPC_CLASSES) {
    const t = NPC_LOOT[c];
    for (const e of [...t.cons.table, ...t.junk.table]) assert.ok(itemDef(e.def), e.def);
    for (const e of t.cons.table) assert.notEqual(itemDef(e.def)!.cat, "junk", `${c} cons ${e.def}`);
    for (const e of t.junk.table) assert.equal(itemDef(e.def)!.cat, "junk", `${c} junk ${e.def}`);
    for (const e of [...t.cons.table, ...t.junk.table]) assert.ok(!itemDef(e.def)!.unique, "never a unique");
    const [cons, junk] = [drawEv(t.cons), drawEv(t.junk)];
    assert.ok(near(cons, want[c][0], 0.02), `${c} cons EV ${cons.toFixed(1)}`);
    assert.ok(near(junk, want[c][1], 0.02), `${c} junk EV ${junk.toFixed(1)}`);
    // Scarcity: found consumables stay well below what the kill costs.
    assert.ok(cons <= 0.45 * killCost[c], `${c} cons ${cons.toFixed(1)} vs cost ${killCost[c]}`);
    // …and the whole bag (consumables + junk at autosell × 1) never pays more than the kill costs.
    assert.ok(cons + junk <= killCost[c], `${c} bag ${(cons + junk).toFixed(1)} CR vs cost ${killCost[c]}`);
    let rc = 0, rj = 0;
    const N = 20_000;
    for (let s = 0; s < N; s++) {
      for (const f of rollNpcLoot(s * 7919, s % 23, s % 3, c)) {
        if (itemDef(f.def)!.cat === "junk") rj += crEq(f.def, f.qty);
        else rc += crEq(f.def, f.qty);
      }
    }
    assert.ok(near(rc / N, cons, 0.1), `${c} rolled cons ${(rc / N).toFixed(1)} vs ${cons.toFixed(1)}`);
    assert.ok(near(rj / N, junk, 0.1), `${c} rolled junk ${(rj / N).toFixed(1)} vs ${junk.toFixed(1)}`);
  }
});

test("rollNpcLoot: deterministic per (seed, post, member), at most one cons + one junk, never FREE / unique", () => {
  assert.deepEqual(rollNpcLoot(42, 7, 1, "top"), rollNpcLoot(42, 7, 1, "top"));
  let differs = 0;
  for (let s = 0; s < 200; s++) {
    const a = rollNpcLoot(s, 3, 0, "high");
    assert.ok(a.length <= 2);
    assert.ok(a.filter((f) => itemDef(f.def)!.cat === "junk").length <= 1);
    for (const f of a) assert.ok(f.qty >= 1 && !itemDef(f.def)!.unique);
    if (JSON.stringify(a) !== JSON.stringify(rollNpcLoot(s, 3, 1, "high"))) differs++;
  }
  assert.ok(differs > 50, "members of one squad get independent bags");
});

test("rollMarauderKit: deterministic, ≤ 1 sniper per top squad, armor by armorChance", () => {
  assert.deepEqual(rollMarauderKit(9, 15, 3, "top"), rollMarauderKit(9, 15, 3, "top"));
  let armored = 0, mid = 0, snipers = 0;
  for (let s = 0; s < 3000; s++) {
    const top = rollMarauderKit(s * 31, 15, 3, "top");
    assert.equal(top.length, 3);
    const n = top.filter((k) => k.weapon === "sniper").length;
    assert.ok(n <= 1, `seed ${s}: ${n} snipers`);
    snipers += n;
    for (const k of top) assert.equal(k.armor, 2);
    for (const k of rollMarauderKit(s, 4, 2, "low")) assert.ok(k.armor === 0 && (k.weapon === "pistol" || k.weapon === "shotgun"));
    for (const k of rollMarauderKit(s, 5, 2, "mid")) {
      mid++;
      if (k.armor === 1) armored++;
    }
  }
  assert.ok(Math.abs(armored / mid - 0.4) < 0.03, `mid armor ${(armored / mid).toFixed(3)}`);
  assert.ok(snipers > 1000, "the top class does field snipers");
});

test("rollNpcSpawns: deterministic, exactly 2 draws per post, frequency ≈ chance, E ≈ 47 NPCs with bosses", () => {
  assert.deepEqual(rollNpcSpawns(1234, posts, 7), rollNpcSpawns(1234, posts, 7));
  // Reference implementation of the draw contract.
  for (const seed of [1, 99, 123456]) {
    const rng = mulberry32((seed ^ NPC.SALT) >>> 0);
    const ref: Array<{ postId: number; members: number }> = [];
    for (const p of posts) {
      const a = rng(), b = rng();
      if (a < p.chance) ref.push({ postId: p.id, members: p.size[0] + Math.floor(b * (p.size[1] - p.size[0] + 1)) });
    }
    assert.deepEqual(rollNpcSpawns(seed, posts, 0), ref);
  }
  // A post that never spawns still consumes its draws: zeroing post 0 does not shift the others.
  const zeroed = posts.map((p, i) => (i === 0 ? { ...p, chance: 0 } : p));
  for (let s = 0; s < 50; s++) {
    assert.deepEqual(rollNpcSpawns(s, zeroed).filter((x) => x.postId !== 0), rollNpcSpawns(s, posts).filter((x) => x.postId !== 0));
  }
  const N = 20_000;
  const hits = new Map<number, number>();
  let total = 0, maxSeen = 0, capped = 0;
  for (let s = 0; s < N; s++) {
    const seed = (s * 2654435761) >>> 0;
    const bosses = rollBossSpawns(seed, m.bosses);
    const bossNpcs = bossGroupNpcCount(bosses);
    const sp = rollNpcSpawns(seed, posts, bossNpcs);
    // Frequencies from the uncapped roll: on the map v2 the boss groups + marauders pass
    // NPC.MAX_PER_RAID in ≈ 1.6 % of raids, and the cap then drops road camps first (next test).
    for (const x of rollNpcSpawns(seed, posts, 0)) hits.set(x.postId, (hits.get(x.postId) ?? 0) + 1);
    for (const x of sp) {
      const p = posts[x.postId]!;
      assert.ok(x.members >= p.size[0] && x.members <= p.size[1]);
    }
    const n = bossNpcs + sp.reduce((a, x) => a + x.members, 0);
    assert.ok(n <= NPC.MAX_PER_RAID);
    if (rollNpcSpawns(seed, posts, 0).length !== sp.length) capped++;
    total += n;
    maxSeen = Math.max(maxSeen, n);
  }
  for (const p of posts) assert.ok(Math.abs((hits.get(p.id) ?? 0) / N - p.chance) < 0.015, `post ${p.id}`);
  // v5 iteration 2 (C4): NPC_CAMPS.radar.squads 2 → 1 (E marauders 33.4 → 30.9, E NPCs 40 → ≈ 38).
  // Map v2 (MAP_GEN_VERSION 4): 36 % more area and five new places with squads by tier
  // (steppe.ts ZONE_CAMPS): E marauders 30.9 → 40.4 (+31 % for +36 % area), E NPCs ≈ 47.3; the
  // MAX_PER_RAID cap (60) trims a squad in ≈ 1.6 % of raids.
  assert.ok(Math.abs(total / N - 47.3) < 1.5, `E NPCs per raid ${(total / N).toFixed(2)}`);
  assert.ok(near(expectedMarauders(posts), 40.4, 0.03), `E marauders ${expectedMarauders(posts).toFixed(2)}`);
  assert.ok(capped / N < 0.03, `capped raids ${(capped / N).toFixed(3)}`);
});

test("rollNpcSpawns cap: drops whole squads — road camps first, then T1, then T2 …", () => {
  const P = (id: number, kind: NpcPost["kind"], tier: NpcPost["tier"], size: number): NpcPost => ({
    id, zone: kind === "road" ? null : "z", tier, kind, x: 0, y: 0, patrol: [], size: [size, size], chance: 1,
  });
  const list = [P(0, "poi", 4, 3), P(1, "road", 0, 2), P(2, "poi", 1, 2), P(3, "poi", 2, 3), P(4, "road", 0, 2), P(5, "gate", 3, 3)];
  // 15 marauders: room for all with 45 boss-group NPCs.
  assert.equal(rollNpcSpawns(5, list, 45).length, 6);
  // Over by 2: the LAST road camp goes first.
  assert.deepEqual(rollNpcSpawns(5, list, 47).map((s) => s.postId), [0, 1, 2, 3, 5]);
  // Over by 4: both road camps.
  assert.deepEqual(rollNpcSpawns(5, list, 49).map((s) => s.postId), [0, 2, 3, 5]);
  // Over by 5: road camps, then the T1 squad.
  assert.deepEqual(rollNpcSpawns(5, list, 50).map((s) => s.postId), [0, 3, 5]);
  // Over by 7: then T2.
  assert.deepEqual(rollNpcSpawns(5, list, 52).map((s) => s.postId), [0, 5]);
  assert.deepEqual(rollNpcSpawns(5, list, 60), []);
  assert.deepEqual(rollNpcSpawns(5, [], 0), []);
});

test("bossGroupNpcCount: boss + its guard posts (capped at BOSSES[kind].guards)", () => {
  assert.equal(bossGroupNpcCount([]), 0);
  assert.equal(bossGroupNpcCount(m.bosses), 3 + 2 + 3 + 2);
  assert.equal(bossGroupNpcCount([{ kind: "commander", guards: [1, 2, 3, 4, 5] }]), 1 + BOSSES.commander.guards.length);
});

test("carriers: keys, eligibility, weights, raidNpcCarriers only from spawned T3/T4 POI squads", () => {
  assert.equal(npcCarrierKey(12, 2), "npc:12.2");
  assert.deepEqual(parseNpcCarrierKey("npc:12.2"), { postId: 12, member: 2 });
  for (const bad of ["npc:", "npc:1", "npc:a.b", "boss:foreman", "12", "npc:1.2.3", " npc:1.2"]) assert.equal(parseNpcCarrierKey(bad), null, bad);
  assert.equal(bossKindOfLootKey("npc:1.0"), null);
  assert.equal(npcCarrierWeight(3), 80);
  assert.equal(npcCarrierWeight(4), 125);
  assert.ok(!npcCarrierEligible(2) && npcCarrierEligible(3) && npcCarrierEligible(4));
  assert.equal(NPC_CARRIER.MAX_PER_NPC, 1);
  for (let s = 0; s < 300; s++) {
    const sp = rollNpcSpawns(s, posts);
    const c = raidNpcCarriers(sp, posts);
    const want = sp.filter((x) => posts[x.postId]!.kind !== "road" && posts[x.postId]!.tier >= 3).reduce((n, x) => n + x.members, 0);
    assert.equal(c.length, want);
    assert.equal(new Set(c.map((x) => x.key)).size, c.length, "one key per NPC");
    for (const x of c) {
      const k = parseNpcCarrierKey(x.key)!;
      assert.equal(x.tier, posts[k.postId]!.tier);
      assert.ok(x.tier >= NPC_CARRIER.MIN_TIER);
    }
  }
});

test("pool release with carriers (model of planAllocation): R 0 → 0; R 3 → bosses first (carriers only when bosses need fewer); R 24 → carriers ≈ 15–32 % of the non-boss share (model)", () => {
  /** Weighted picks without replacement over containers + carriers, one item each (v4 planAllocation rounds). */
  function allocate(seed: number, R: number) {
    const bosses = rollBossSpawns(seed, m.bosses);
    const need = bossSlotCount(raidBossSlots(bosses));
    const plan = poolReleasePlanV4(1000, R, need);
    const bossItems = Math.min(need, plan.total);
    const rest = plan.total - bossItems;
    const carriers = raidNpcCarriers(rollNpcSpawns(seed, posts, bossGroupNpcCount(bosses)), posts);
    const dest = [
      ...m.containers.filter(poolContainerEligible).map((c) => ({ w: poolContainerWeight({ tier: c.tier, guarded: containerGuarded(c, bosses) }), tier: c.tier, carrier: false })),
      ...carriers.map((c) => ({ w: npcCarrierWeight(c.tier), tier: c.tier, carrier: true })),
    ];
    const rng = mulberry32(seed ^ 0x51ed270b);
    const used = new Set<number>();
    let toCarriers = 0;
    for (let i = 0; i < rest; i++) {
      const un = dest.map((_, j) => j).filter((j) => !used.has(j));
      let roll = rng() * un.reduce((a, j) => a + dest[j]!.w, 0);
      let pick = un[un.length - 1]!;
      for (const j of un) if ((roll -= dest[j]!.w) <= 0) { pick = j; break; }
      used.add(pick);
      assert.ok(dest[pick]!.tier >= POOL.CONTAINER_MIN_TIER, "never below T3");
      if (dest[pick]!.carrier) toCarriers++;
    }
    return { total: plan.total, bossItems, rest, toCarriers };
  }
  let restSum = 0, carrierSum = 0, r3Carriers = 0;
  const N = 2000;
  for (let s = 0; s < N; s++) {
    const seed = (s * 2654435761) >>> 0;
    assert.equal(allocate(seed, 0).total, 0, "R = 0 releases nothing");
    const r3 = allocate(seed, 3);
    // Boss slots fill first: only the part of R = 3 the spawned bosses do not need reaches containers / carriers.
    if (r3.bossItems >= 3) assert.equal(r3.toCarriers, 0, "R = 3 with bosses: no carrier item");
    r3Carriers += r3.toCarriers;
    const r24 = allocate(seed, 24);
    assert.equal(r24.total, POOL.MAX_PER_MATCH);
    restSum += r24.rest;
    carrierSum += r24.toCarriers;
  }
  const share = carrierSum / restSum;
  console.log(`[npc] R=24: non-boss ${(restSum / N).toFixed(2)}/raid, carriers ${(carrierSum / N).toFixed(2)}/raid, share ${(share * 100).toFixed(1)} %`);
  // NPC_CARRIER.WEIGHT_MULT 5 (v5 review, after the radar squads went 2 → 1): the real planAllocation
  // (loot-yield harness, 200 seeds at R 24) measures 0.61/raid ≈ 17 % of the non-boss release, inside
  // the 0.6–0.7 target. This one-item-per-destination model over-weights carriers a little
  // (containers are never refilled here).
  assert.ok(share >= 0.15 && share <= 0.32, `carrier share ${share.toFixed(3)}`);
  assert.ok(r3Carriers / N < 0.1, `R = 3 carriers ${(r3Carriers / N).toFixed(3)}/raid`);
});

test("Steppe npc posts: counts per zone, sizes / chances from NPC_CAMPS (map v2 places: ZONE_CAMPS), ids = index, golden digest", () => {
  assert.ok(Array.isArray(m.npcPosts));
  posts.forEach((p, i) => assert.equal(p.id, i));
  for (const z of m.zones) {
    const camp = zoneCamp(z);
    // The ten places of the 24-block layout keep their NPC_CAMPS rows; new places use ZONE_CAMPS.
    assert.equal(camp, NPC_CAMPS[z.id] ?? ZONE_CAMPS[z.id], `${z.id} camp row`);
    const zp = posts.filter((p) => p.zone === z.id);
    assert.equal(zp.length, camp.squads, `${z.id} posts`);
    for (const p of zp) {
      assert.equal(p.tier, z.tier);
      assert.notEqual(p.kind, "road");
      assert.deepEqual(p.size, [...camp.size]);
      assert.equal(p.chance, camp.chance);
    }
    // At most half the posts of a zone sit on its gates.
    assert.ok(zp.filter((p) => p.kind === "gate").length <= Math.ceil(camp.squads / 2));
  }
  const roads = posts.filter((p) => p.kind === "road");
  assert.equal(roads.length, NPC_CAMPS.road!.squads, "5 road camps on the Steppe");
  for (const p of roads) {
    assert.equal(p.zone, null);
    assert.equal(p.tier, 0);
    assert.deepEqual(p.patrol, [], "road camps hold");
    assert.deepEqual(p.size, [...NPC_CAMPS.road!.size]);
  }
  const poi = posts.filter((p) => p.kind !== "road");
  const patrolling = poi.filter((p) => p.patrol.length > 0).length;
  assert.ok(patrolling >= poi.length / 2 - 2 && patrolling <= poi.length / 2 + 1, `patrolling ${patrolling} / ${poi.length}`);
  // Golden digest: placement is deterministic and changes only on purpose.
  let h = 0x811c9dc5;
  const mix = (v: number) => { h ^= v | 0; h = Math.imul(h, 0x01000193); };
  for (const p of posts) {
    mix(p.id); mix(["poi", "gate", "road"].indexOf(p.kind)); mix(p.tier); mix(p.x); mix(p.y); mix(p.size[0]); mix(p.size[1]); mix(Math.round(p.chance * 100));
    mix(p.patrol.length);
    for (const q of p.patrol) { mix(q.x); mix(q.y); }
  }
  assert.equal((h >>> 0).toString(16).padStart(8, "0"), GOLDEN_POSTS, "npc posts digest");
});

/** Golden digest of MapData.npcPosts (MAP_GEN_VERSION 4). Update only for an intended placement change. */
const GOLDEN_POSTS = "8fcf3adf"; // map v2: 28 blocks, 15 places (v5 iteration 2 on MAP_GEN_VERSION 2–3: "8b0d6862")

test("Steppe npc posts: clearances, terrain, reachability, patrol radius", () => {
  const g = getWalkGrid(m);
  const reached = floodWalk(g, m.extracts[0]!.x, m.extracts[0]!.y);
  const d = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.sqrt((a.x - b.x) * (a.x - b.x) + (a.y - b.y) * (a.y - b.y));
  const points = posts.flatMap((p) => [{ p, q: { x: p.x, y: p.y } }, ...p.patrol.map((q) => ({ p, q }))]);
  for (const { p, q } of points) {
    for (const s of m.spawns) assert.ok(d(q, s) >= NPC.SPAWN_CLEAR_PX, `post ${p.id} near a spawn`);
    for (const e of m.extracts) assert.ok(d(q, e) >= NPC.EXTRACT_CLEAR_PX, `post ${p.id} near extract ${e.id}`);
    for (const b of m.bosses) assert.ok(d(q, b) >= NPC.BOSS_CLEAR_PX, `post ${p.id} near boss ${b.kind}`);
    const byte = terrainByteAt(m, q.x, q.y);
    assert.equal(byte & TERRAIN_INDOOR, 0, `post ${p.id} indoors`);
    const kind = byte & TERRAIN_KIND_MASK;
    for (const bad of [TERRAIN.FOREST, TERRAIN.WATER, TERRAIN.SHALLOW, TERRAIN.BRIDGE]) assert.notEqual(kind, bad, `post ${p.id} terrain ${kind}`);
    assert.ok(reachedNear(g, reached, q.x, q.y, 48), `post ${p.id} unreachable`);
    if (p.zone) assert.equal(zoneAt(m, q.x, q.y)?.id, p.zone, `post ${p.id} left its zone`);
  }
  for (const p of posts) {
    for (const o of posts) if (o !== p) assert.ok(d(p, o) >= NPC.POST_MIN_SEP_PX, `posts ${p.id}/${o.id}`);
    for (const q of p.patrol) assert.ok(d(p, q) <= npcLeashPx(p) / 2 + 1, `post ${p.id} patrol beyond leash/2`);
    assert.ok(p.patrol.length <= 3);
    if (p.kind === "road") {
      for (const z of m.zones) {
        const dx = Math.max(z.rect.x - p.x, 0, p.x - (z.rect.x + z.rect.w));
        const dy = Math.max(z.rect.y - p.y, 0, p.y - (z.rect.y + z.rect.h));
        assert.ok(Math.sqrt(dx * dx + dy * dy) >= NPC.ROAD_CAMP_ZONE_CLEAR_PX, `camp ${p.id} near zone ${z.id}`);
      }
      for (const o of posts) if (o !== p && o.kind === "road") assert.ok(d(p, o) >= NPC.ROAD_CAMP_SEP_PX, `camps ${p.id}/${o.id}`);
    }
  }
});

test("npc posts never touch the layout: mapHash unchanged without them; fallback map validates", () => {
  const { map, report } = generateMapWithReport("steppe");
  assert.equal(mapHash({ ...map, npcPosts: [] }), mapHash(map));
  assert.equal(mapHash(map), mapHash(m));
  assert.equal(report.counts.npcPosts, posts.length);
  assert.equal(report.validation.droppedNpcPosts, 0);
  const small = generateMapWithReport("steppe", { block: 853 });
  assert.deepEqual(small.report.validation.errors, []);
  assert.ok(small.map.npcPosts!.filter((p) => p.kind === "road").length >= NPC.ROAD_CAMPS_MIN);
  assert.deepEqual(npcPostsOf({}), []);
});

test("humans per map and side caps (humans only, no queue)", () => {
  assert.equal(WORLD.CAPACITY, 24);
  assert.equal(humanSideCap(1), 2);
  assert.equal(humanSideCap(12), 4);
  assert.equal(humanSideCap(24), 7);
  assert.equal(SPAWN_RULES.HUMAN_MIN_SEP_PX, 3000);
});
