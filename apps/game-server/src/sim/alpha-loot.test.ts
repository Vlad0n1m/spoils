/**
 * ALPHA LOOT (packages/shared alpha-loot.ts): generous containers, weapons / gear, supply-drop and
 * floor guns, minted with ledger origin "alpha" and reported in PlayerExitReport.alphaFound.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ALPHA_LOOT,
  LOOT_TRIM,
  CONTAINER,
  generateMap,
  itemDef,
  mulberry32,
  rollAlphaContainerUniques,
  rollAlphaDropUniques,
  rollAlphaFloorGun,
  rollContainerFungibles,
  type ContainerSpot,
  type LootTier,
  type MapData,
} from "@extract/shared";
import { takeAll } from "./containers.js";
import { killPlayer } from "./death.js";
import { extractPlayer } from "./extraction.js";
import { groundUniques } from "./inventory.js";
import type { Match } from "./match.js";
import { alphaLootEnabled } from "../world/directory.js";
import { enter, ids, jump, place, rtOf, run, testMap, testMatch, worldMatch } from "./test-utils.js";

const steppe = generateMap("steppe");
const isWeapon = (def: string) => itemDef(def)?.cat === "weapon";

/** FNV digest of every Steppe container's fungibles for 20 seeds (computed on the v4 code before ALPHA LOOT). */
function fungibleDigest(roll: (seed: number, i: number, c: ContainerSpot) => ReturnType<typeof rollContainerFungibles>): { digest: string; empty: number } {
  let h = 0x811c9dc5;
  let empty = 0;
  let n = 0;
  for (let seed = 1; seed <= 20; seed++) {
    steppe.containers.forEach((c, i) => {
      const r = roll(seed * 7919, i, c);
      n++;
      if (r.length === 0) empty++;
      const s = `${seed}:${i}:` + r.map((f) => `${f.def}x${f.qty}r${f.rarity}`).join(",");
      for (let k = 0; k < s.length; k++) {
        h ^= s.charCodeAt(k);
        h = Math.imul(h, 0x01000193);
      }
    });
  }
  return { digest: (h >>> 0).toString(16).padStart(8, "0"), empty: empty / n };
}

test("ALPHA_LOOT off keeps the v4 container rolls (golden digest; LOOT_TRIM × 0.9 fill since 2026-10); on, ≈ 35 % of containers stay empty", () => {
  const v4 = fungibleDigest((s, i, c) => rollContainerFungibles(s, i, c));
  // "813938d9" / empty 0.538 before LOOT_TRIM (the pure v4 rolls); the same draws with fill × 0.9.
  assert.equal(v4.digest, "f2c1749f", "v4 fungibles unchanged");
  assert.ok(Math.abs(v4.empty - (1 - LOOT_TRIM.DROP_MULT * (1 - 0.538))) < 0.01, `v4 empty share ${v4.empty.toFixed(3)}`);
  assert.equal(fungibleDigest((s, i, c) => rollContainerFungibles(s, i, c, { alpha: false })).digest, v4.digest);
  // Alpha: a container is empty when it rolls no fungible and no alpha unique.
  let empty = 0;
  let n = 0;
  for (let seed = 1; seed <= 20; seed++) {
    steppe.containers.forEach((c, i) => {
      n++;
      if (rollContainerFungibles(seed * 7919, i, c, { alpha: true }).length === 0 && rollAlphaContainerUniques(seed * 7919, i, c).length === 0) empty++;
    });
  }
  // LOOT_TRIM: ≈ 30 % → ≈ 35 % (fill, weapon and gear chances × 0.9).
  assert.ok(empty / n > 0.29 && empty / n < 0.39, `alpha empty share ${(empty / n).toFixed(3)} (target ≈ 35 %)`);
  assert.equal(ALPHA_LOOT.EMPTY_CHANCE, 0.08);
  for (let t = 3; t <= 4; t++) assert.ok(ALPHA_LOOT.FILL_CHANCE[t]! >= CONTAINER.FILL_CHANCE[t]!, "T3/T4 fill never drops");
});

test("alpha container uniques: weapon chance and rarity mix per tier, weapon boxes at T2+ always armed, tier-matched gear; deterministic", () => {
  const N = 40_000;
  for (const tier of [0, 1, 2, 3, 4] as LootTier[]) {
    const spot = { kind: "crate" as const, tier };
    let weapons = 0;
    let gear = 0;
    const rar = [0, 0, 0, 0];
    for (let i = 0; i < N; i++) {
      for (const u of rollAlphaContainerUniques(99, i, spot)) {
        if (isWeapon(u.def)) {
          weapons++;
          rar[u.rarity]!++;
        } else {
          gear++;
          const d = itemDef(u.def)!;
          assert.equal(d.armorLevel ?? d.bpLevel, ALPHA_LOOT.GEAR_LEVEL[tier], `T${tier} gear level`);
          assert.equal(u.rarity, d.rarity);
        }
      }
    }
    // LOOT_TRIM: weapon and gear chances × DROP_MULT.
    assert.ok(Math.abs(weapons / N - ALPHA_LOOT.WEAPON_CHANCE[tier]! * LOOT_TRIM.DROP_MULT) < 0.01, `T${tier} weapons ${(weapons / N).toFixed(3)}`);
    assert.ok(Math.abs(gear / N - ALPHA_LOOT.GEAR_CHANCE[tier]! * LOOT_TRIM.DROP_MULT) < 0.01, `T${tier} gear ${(gear / N).toFixed(3)}`);
    const mix = ALPHA_LOOT.WEAPON_RARITY[tier]!;
    const tw = mix.reduce((s, r) => s + r.weight, 0);
    if (weapons > 0) for (const r of mix) assert.ok(Math.abs(rar[r.rarity]! / weapons - r.weight / tw) < 0.03, `T${tier} rarity ${r.rarity}`);
    for (let r = 0; r < 4; r++) if (!mix.some((x) => x.rarity === r)) assert.equal(rar[r], 0, `T${tier} never rarity ${r}`);
  }
  // T1 rolls only the light guns, common.
  for (let i = 0; i < 5000; i++) {
    for (const u of rollAlphaContainerUniques(7, i, { kind: "crate", tier: 1 })) {
      assert.ok(ALPHA_LOOT.WEAPON_TYPES_LOW.some((w) => w.weapon === u.def), u.def);
      assert.equal(u.rarity, 0);
    }
  }
  // Weapon boxes at T2+: one weapon in DROP_MULT of them (LOOT_TRIM; was always), never two.
  for (const tier of [2, 3, 4] as LootTier[]) {
    let armed = 0;
    for (let i = 0; i < 4000; i++) {
      const w = rollAlphaContainerUniques(5, i, { kind: "weapon_box", tier }).filter((u) => isWeapon(u.def)).length;
      assert.ok(w <= 1, `T${tier} weapon box`);
      armed += w;
    }
    assert.ok(Math.abs(armed / 4000 - LOOT_TRIM.DROP_MULT) < 0.02, `T${tier} weapon boxes armed ${(armed / 4000).toFixed(3)}`);
  }
  assert.deepEqual(rollAlphaContainerUniques(123, 45, { kind: "safe", tier: 4 }), rollAlphaContainerUniques(123, 45, { kind: "safe", tier: 4 }));
});

test("expected weapons per raid from 20 containers: the early-alpha route lands at 1–2 (map-proportional and POI routes are higher, see the note)", () => {
  // Weapons per container by tier on the real Steppe containers (weapon boxes included).
  const per = [0, 1, 2, 3, 4].map(() => ({ n: 0, w: 0 }));
  for (let seed = 1; seed <= 40; seed++) {
    steppe.containers.forEach((c, i) => {
      per[c.tier]!.n++;
      per[c.tier]!.w += rollAlphaContainerUniques(seed * 104_729, i, c).filter((u) => isWeapon(u.def)).length;
    });
  }
  const rate = per.map((p) => p.w / p.n);
  const expected = (route: readonly number[]) => route.reduce((s, k, t) => s + k * rate[t]!, 0);
  // Early alpha: wild stashes, a dacha / fuel stop, one ordinary POI, a look into the elevator.
  const early = [8, 6, 5, 1, 0];
  assert.equal(early.reduce((a, b) => a + b, 0), 20);
  const e = expected(early);
  assert.ok(e >= 1 && e <= 2, `early-alpha route: ${e.toFixed(2)} weapons per 20 containers`);
  // Note for tuning: with the owner's per-tier chances a player who clears an ordinary POI
  // (2 / 2 / 14 / 2 / 0) finds ≈ 3.7 and a map-proportional route (Steppe shares) ≈ 4.9 weapons
  // per 20 containers. Pinned loosely so a change to these figures is noticed.
  const poi = expected([2, 2, 14, 2, 0]);
  const shares = per.map((p) => (20 * p.n) / per.reduce((s, q) => s + q.n, 0));
  const mapWide = expected(shares);
  assert.ok(poi > 3 && poi < 4.5, `POI route ${poi.toFixed(2)}`);
  assert.ok(mapWide > 4.2 && mapWide < 5.6, `map-proportional ${mapWide.toFixed(2)}`);
});

test("supply drop and floor gun rolls: rare+ weapon and an armor per crate; floor guns 25 % on T2+ spots, common / rare", () => {
  const rar = [0, 0, 0, 0];
  const N = 20_000;
  for (let i = 0; i < N; i++) {
    const [w, a] = rollAlphaDropUniques(mulberry32(i));
    assert.ok(isWeapon(w!.def) && w!.rarity >= 1, "rare+ weapon");
    assert.ok(a!.def === "armor_2" || a!.def === "armor_3", a!.def);
    rar[w!.rarity]!++;
  }
  assert.ok(Math.abs(rar[1]! / N - 0.5) < 0.015 && Math.abs(rar[2]! / N - 0.35) < 0.015 && Math.abs(rar[3]! / N - 0.15) < 0.015, rar.join("/"));
  for (const tier of [0, 1]) {
    const rng = mulberry32(3);
    for (let i = 0; i < 1000; i++) assert.equal(rollAlphaFloorGun(rng, tier), null);
  }
  let guns = 0;
  const rng = mulberry32(4);
  for (let i = 0; i < N; i++) {
    const g = rollAlphaFloorGun(rng, 2);
    if (!g) continue;
    guns++;
    assert.ok(isWeapon(g.def) && g.rarity <= 1);
  }
  assert.ok(Math.abs(guns / N - ALPHA_LOOT.FLOOR_GUN_CHANCE) < 0.01, `floor guns ${(guns / N).toFixed(3)}`);
});

// ---------------------------------------------------------------- the match

const BOX: ContainerSpot = { x: 1100, y: 1500, kind: "weapon_box", tier: 3, zone: null };

function openAndTakeAll(m: Match, id: string): void {
  place(m, id, 1040, 1500);
  assert.ok(m.interact(id));
  run(m, 15_000);
  assert.equal(takeAll(m, rtOf(m, id)).code, null);
}

test("match: an alpha weapon box mints a weapon with ledger origin alpha; the extract report lists it in alphaFound", () => {
  const m = testMatch(2, { map: testMap({ containers: [BOX] }), mode: "live", alphaLoot: true });
  const [a] = ids(m);
  const rt = rtOf(m, a!);
  for (const k of ["w1", "w2"]) rt.self.slots.delete(k);
  openAndTakeAll(m, a!);
  const found = [...rt.self.slots.values()].filter((it) => isWeapon(it.def));
  assert.equal(found.length, 1, "one weapon from the T3 weapon box");
  assert.equal(m.ledger.known.get(found[0]!.uid)?.origin, "alpha");
  extractPlayer(m, rt);
  const rep = rt.exitReport!;
  assert.ok(rep.extracted.some((s) => s.uid === found[0]!.uid));
  assert.deepEqual(rep.alphaFound, [found[0]!.uid]);
});

test("match: an alpha find lost on death is not reported as found; with alphaLoot off a live weapon box mints nothing", () => {
  const m = testMatch(2, { map: testMap({ containers: [BOX] }), mode: "live", alphaLoot: true });
  const [a] = ids(m);
  const rt = rtOf(m, a!);
  for (const k of ["w1", "w2"]) rt.self.slots.delete(k);
  openAndTakeAll(m, a!);
  killPlayer(m, rt, null, "");
  assert.equal(rt.exitReport!.alphaFound, undefined);

  const off = testMatch(2, { map: testMap({ containers: [BOX] }), mode: "live" });
  assert.equal(off.alphaLoot, false, "sim default: off");
  const [b] = ids(off);
  place(off, b!, 1040, 1500);
  assert.ok(off.interact(b!));
  run(off, 15_000);
  const items = off.containers.targets.get("c0")!.items;
  assert.ok(items.every((it) => !it.uid), "v4 live: no unique in a container");
});

test("match: Steppe floor with alpha loot has guns on ≈ 25 % of the T2+ spots and none below; off, a live floor has no uniques", () => {
  const base = { map: steppe, emptyWorld: false, bosses: false, marauders: false, mode: "live" as const };
  const m = testMatch(1, { ...base, alphaLoot: true });
  const guns = groundUniques(m);
  const hi = steppe.lootSpots.filter((s) => s.tier >= ALPHA_LOOT.FLOOR_GUN_MIN_TIER).length;
  assert.ok(guns.every((g) => isWeapon(g.def) && g.rarity <= 1 && m.ledger.known.get(g.uid)?.origin === "alpha"));
  assert.ok(Math.abs(guns.length / hi - ALPHA_LOOT.FLOOR_GUN_CHANCE) < 0.06, `${guns.length} guns on ${hi} T2+ spots`);
  const off = testMatch(1, base);
  assert.equal(groundUniques(off).length, 0);
});

test("world: a supply crate with alpha loot holds a rare+ weapon and an armor on top of its fungibles", () => {
  // The world-events test arena: one T3 POI with a building, an extract east of it.
  const map = testMap();
  map.zones = [{ id: "z1", name: "Test Yard", kind: "industrial", tier: 3, rect: { x: 2600, y: 400, w: 1800, h: 1800 } } as MapData["zones"][number]];
  map.buildings = [{ floor: { x: 3300, y: 1000, w: 400, h: 400 } } as MapData["buildings"][number]];
  map.extracts = [{ id: "E1", name: "East", x: 4500, y: 2600, r: 150, side: 1 } as MapData["extracts"][number]];
  const { m, wall } = worldMatch({ map, mode: "live", alphaLoot: true, worldEvents: true, worldEventsOverride: { drops: [{ n: 1, announceAt: 0, landAt: 1_000 }], hots: [] } });
  enter(m, "alice");
  jump(m, wall, 2_000);
  const t = m.containers.targets.get("ksd1");
  assert.ok(t, "the crate landed");
  const uniques = t.items.filter((it) => it.uid);
  assert.equal(uniques.length, 2);
  assert.ok(uniques.some((it) => isWeapon(it.def) && it.rarity >= 1));
  assert.ok(uniques.some((it) => it.def.startsWith("armor_")));
  for (const it of uniques) assert.equal(m.ledger.known.get(it.uid)?.origin, "alpha");
});

test("ALPHA_LOOT env flag: on unless 0 / false / off / no", () => {
  assert.equal(alphaLootEnabled({}), true);
  assert.equal(alphaLootEnabled({ ALPHA_LOOT: "1" }), true);
  assert.equal(alphaLootEnabled({ ALPHA_LOOT: "true" }), true);
  for (const v of ["0", "false", "OFF", " no "]) assert.equal(alphaLootEnabled({ ALPHA_LOOT: v }), false, v);
});
