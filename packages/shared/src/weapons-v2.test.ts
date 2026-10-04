/**
 * Weapons v2 contract (docs/WEAPONS_V2.md): the item def registry (guns, bolts, grenade, icons),
 * the stats table, the "no new gun kills faster than the rifle" rule, inventory sizes, the loot
 * tables (weights replaced, not stacked: value per container tier within +5 %), NPC kits and
 * pockets, trader offers (CR only; no SOL anywhere) and the replay weapon codes.
 *
 * Run: apps/game-server/node_modules/.bin/tsx --test packages/shared/src/weapons-v2.test.ts
 */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  BOSSES,
  BOUND_OFFERS,
  CONSUMABLES_CR,
  CONTAINER,
  CONTAINER_LOOT,
  FLOOR_LOOT,
  UNPRICED_WEAPONS,
  containerLootFor,
  liveWeaponTemplates,
  templateKey,
  templateRefPriced,
  type ContainerLootEntry,
  type FloorLootEntry,
} from "./economy.js";
import { GRENADE_DEF, ITEM_DEFS, ammoDefOf, itemDef, weaponSlotIcon } from "./item-defs.js";
import { canMerge, countOf, planPlace, type ItemLike } from "./inventory.js";
import {
  AMMO,
  ARMOR,
  CHEST_TABLES,
  GRENADE,
  RARITY_DAMAGE_MULT,
  WEAPONS,
  WEAPON_IDS,
  applyDamage,
  weaponHasFlash,
  weaponRarityAllowed,
  type WeaponId,
} from "./items.js";
import { generateMap } from "./map/generate.js";
import { MARAUDER, NPC_LOOT, rollMarauderKit, type NpcLootEntry } from "./npc.js";
import { REPLAY, REPLAY_WEAPONS, decodeReplayChunk, encodeReplayChunk, weaponCode } from "./replay.js";
import { SoundKind, baseSoundRadius, weaponVariant } from "./sound.js";

const SPRITES = join(dirname(fileURLToPath(import.meta.url)), "../../../apps/web/public/sprites");
const NEW: readonly WeaponId[] = ["smg", "lmg", "revolver", "crossbow"];

// ------------------------------------------------------------------ registry & stats

test("registry: 8 guns in a fixed order (the v1 four first), bolts, the grenade, every icon on disk", () => {
  assert.deepEqual(WEAPON_IDS, ["pistol", "rifle", "shotgun", "sniper", "smg", "lmg", "revolver", "crossbow"]);
  for (const w of WEAPON_IDS) {
    const d = itemDef(w)!;
    assert.equal(d.cat, "weapon");
    assert.equal(d.unique, true);
    assert.equal(d.stack, 1, `${w}: one weapon slot, no stacking`);
    assert.ok(existsSync(join(SPRITES, `${d.icon}.png`)), `${w}: side sprite`);
    assert.ok(existsSync(join(SPRITES, `${weaponSlotIcon(d)}.png`)), `${w}: square inventory icon`);
    assert.equal(weaponSlotIcon(d), `icon_${w}`);
    assert.ok(itemDef(ammoDefOf(w)), `${w}: ammo def`);
  }
  assert.equal(ammoDefOf("crossbow"), "ammo_bolt");
  assert.equal(ammoDefOf("revolver"), "ammo_heavy");
  assert.equal(ammoDefOf("smg"), "ammo_light");
  assert.equal(ammoDefOf("lmg"), "ammo_light");
  const bolt = itemDef("ammo_bolt")!;
  assert.deepEqual([bolt.cat, bolt.stack, bolt.unique, bolt.ammo, bolt.icon], ["ammo", 10, false, "bolt", "ammo_bolt"]);
  const g = itemDef(GRENADE_DEF)!;
  assert.deepEqual([g.cat, g.stack, g.unique, g.rarity, g.throwable, g.icon], ["throwable", 2, false, 1, "grenade", "grenade"]);
  for (const t of ["light", "shell", "heavy", "bolt"] as const) assert.equal(itemDef(`ammo_${t}`)!.icon, `ammo_${t}`);
  assert.deepEqual(AMMO.bolt, { pickup: 5, maxCarry: 20 });
  // Every def has a unique id (no collisions with the junk / gear ids).
  assert.equal(new Set(Object.keys(ITEM_DEFS)).size, Object.keys(ITEM_DEFS).length);
});

test("stats: docs/WEAPONS_V2.md §3 table", () => {
  const want: Record<string, [number, number, number, number, number, number, number, number, number, number, string]> = {
    //       dmg, int, mag, reload, spread, range, speed, sound, muzzle, pellets, ammo
    smg: [9, 75, 25, 1600, 0.1, 600, 1700, 1800, 48, 1, "light"],
    lmg: [12, 110, 60, 5000, 0.07, 1000, 2000, 2800, 70, 1, "light"],
    revolver: [34, 450, 6, 2800, 0.025, 800, 2100, 2300, 46, 1, "heavy"],
    crossbow: [60, 400, 1, 2300, 0.008, 1100, 1100, 450, 52, 1, "bolt"],
  };
  for (const w of NEW) {
    const d = WEAPONS[w];
    assert.deepEqual(
      [d.damage, d.fireIntervalMs, d.magSize, d.reloadMs, d.spread, d.range, d.bulletSpeed, d.soundRadius, d.muzzle, d.pellets, d.ammo],
      want[w],
      w,
    );
    assert.equal(baseSoundRadius(SoundKind.shot, weaponVariant(w)), d.soundRadius);
  }
  assert.equal(WEAPONS.smg.auto, true);
  assert.equal(WEAPONS.lmg.auto, true);
  assert.equal(WEAPONS.revolver.auto, false);
  assert.equal(WEAPONS.crossbow.auto, false);
  // Only the crossbow has no flash; LMG and crossbow exist from rare up.
  assert.deepEqual(WEAPON_IDS.filter((w) => !weaponHasFlash(w)), ["crossbow"]);
  assert.deepEqual(WEAPON_IDS.filter((w) => !weaponRarityAllowed(w, 0)), ["lmg", "crossbow"]);
  for (const w of WEAPON_IDS) assert.equal(weaponRarityAllowed(w, 1), true);
  assert.equal(weaponRarityAllowed("smg", 4), false);
});

/** Seconds from the first shot to the killing one, all hits, magazine reloads included (WEAPONS_V2 §5). */
function ttk(w: WeaponId, rarity: 0 | 1 | 2 | 3, armor: 0 | 1 | 2 | 3): number {
  const d = WEAPONS[w];
  let hp = 100;
  let dur = armor ? ARMOR[armor].durability : 0;
  let t = 0;
  let mag = d.magSize;
  for (let shot = 0; shot < 1000; shot++) {
    if (shot > 0) {
      if (mag === 0) {
        t += d.reloadMs;
        mag = d.magSize;
      } else {
        t += d.fireIntervalMs;
      }
    }
    mag--;
    for (let p = 0; p < d.pellets; p++) {
      const r = applyDamage(d.damage * RARITY_DAMAGE_MULT[rarity], armor, dur);
      hp -= r.hpLoss;
      dur -= r.armorUsed;
    }
    if (hp <= 1e-9) return t / 1000;
  }
  return Infinity;
}

test("§22: no new gun kills an unarmoured player faster than today's rifle of the same rarity (all hits)", () => {
  for (const rarity of [0, 1, 2, 3] as const) {
    const rifle = ttk("rifle", rarity, 0);
    for (const w of NEW) assert.ok(ttk(w, rarity, 0) >= rifle - 1e-9, `${w} r${rarity}: ${ttk(w, rarity, 0)} < rifle ${rifle}`);
  }
  // Against armor the SMG edges the rifle by one 25 ms step at most (doc §5.1: 0.97 vs 1.00 at armor 1).
  for (const rarity of [0, 1, 2, 3] as const) {
    for (const armor of [1, 2, 3] as const) {
      const rifle = ttk("rifle", rarity, armor);
      for (const w of NEW) assert.ok(ttk(w, rarity, armor) >= rifle - 0.05, `${w} r${rarity} a${armor}: ${ttk(w, rarity, armor)} vs rifle ${rifle}`);
    }
  }
  // The doc's headline numbers.
  assert.equal(ttk("smg", 0, 0), 0.825);
  assert.equal(ttk("lmg", 0, 0), 0.88);
  assert.equal(ttk("revolver", 0, 0), 0.9);
  assert.equal(ttk("crossbow", 0, 0), 2.3);
  // Even a legendary revolver needs three hits.
  assert.ok(WEAPONS.revolver.damage * RARITY_DAMAGE_MULT[3] * 2 < 100);
});

// ------------------------------------------------------------------ inventory

const it = (def: string, qty = 1): ItemLike => ({ uid: "", def, qty, rarity: 0, dur: 0, mag: 0, flags: 0, label: "" });

test("inventory: guns take a weapon slot, grenades stack by 2 and bolts by 10 in pockets / backpack, never in a weapon slot", () => {
  for (const w of NEW) {
    const p = planPlace(new Map<string, ItemLike>(), { ...it(w), uid: `u-${w}` });
    assert.ok(p.ok && p.steps.length === 1 && p.steps[0]!.key === "w1" && p.steps[0]!.qty === 1, w);
  }
  const s = new Map<string, ItemLike>([["w1", { ...it("smg"), uid: "a" }], ["w2", { ...it("lmg"), uid: "b" }]]);
  const g = planPlace(s, it(GRENADE_DEF, 3));
  assert.ok(g.ok);
  assert.deepEqual(g.steps.map((x) => [x.key, x.qty]), [["p0", 2], ["p1", 1]]);
  assert.equal(planPlace(s, it(GRENADE_DEF), 1, "w1").ok, false, "no grenade in a weapon slot");
  const b = planPlace(s, it("ammo_bolt", 25));
  assert.ok(b.ok);
  assert.deepEqual(b.steps.map((x) => x.qty), [10, 10, 5]);
  assert.equal(canMerge(it(GRENADE_DEF, 1), it(GRENADE_DEF, 1)), true);
  s.set("p0", it(GRENADE_DEF, 2));
  s.set("p1", it(GRENADE_DEF, 1));
  assert.equal(countOf(s, GRENADE_DEF), 3);
});

// ------------------------------------------------------------------ loot tables

/** v1 tables the new entries were folded into (WEAPONS_V2 §6–7: weights replaced, not stacked). */
const V1: {
  crate: readonly ContainerLootEntry[];
  weapon_box: readonly ContainerLootEntry[];
  MID: readonly FloorLootEntry[];
  HIGH: readonly FloorLootEntry[];
  high: readonly NpcLootEntry[];
  top: readonly NpcLootEntry[];
} = {
  crate: CONTAINER_LOOT.crate.filter((e) => e.def !== "ammo_bolt").map((e) => (e.def === "ammo_light" ? { ...e, weight: 40 } : e)),
  weapon_box: CONTAINER_LOOT.weapon_box
    .filter((e) => e.def !== "ammo_bolt" && e.def !== GRENADE_DEF)
    .map((e) => (e.def === "ammo_light" ? { ...e, weight: 40 } : e.def === "ammo_shell" ? { ...e, weight: 25 } : e)),
  MID: FLOOR_LOOT.MID.filter((e) => e.def !== "ammo_bolt").map((e) => (e.def === "ammo_light" ? { ...e, weight: 40 } : e)),
  HIGH: FLOOR_LOOT.HIGH.filter((e) => e.def !== "ammo_bolt" && e.def !== GRENADE_DEF).map((e) =>
    e.def === "ammo_light" ? { ...e, weight: 35 } : e.def === "ammo_shell" ? { ...e, weight: 18 } : e,
  ),
  high: NPC_LOOT.high.cons.table.filter((e) => e.def !== GRENADE_DEF).map((e) =>
    e.def === "ammo_light" ? { ...e, weight: 40 } : e.def === "medkit" ? { ...e, weight: 5 } : e,
  ),
  top: NPC_LOOT.top.cons.table.filter((e) => e.def !== GRENADE_DEF).map((e) =>
    e.def === "ammo_light" ? { ...e, weight: 35 } : e.def === "medkit" ? { ...e, weight: 10 } : e,
  ),
};
const sumW = (t: ReadonlyArray<{ weight: number }>) => t.reduce((a, e) => a + e.weight, 0);
/** CR-eq of one unit: junk value, consumables at the junker's price. */
const unitCr = (def: string): number => {
  const d = itemDef(def);
  if (!d) return 0;
  if (d.cat === "junk") return d.value ?? 0;
  const c = (CONSUMABLES_CR as Record<string, { qty: number; cr: number }>)[def];
  return c ? c.cr / c.qty : 0;
};
/** containerLootFor's filter and ammo scaling, for any table. */
function effective(table: readonly ContainerLootEntry[], tier: number): ContainerLootEntry[] {
  const out: ContainerLootEntry[] = [];
  for (const e of table) {
    const d = itemDef(e.def)!;
    if (d.cat === "junk" && (d.value ?? 0) > CONTAINER.JUNK_VALUE_CAP[tier]!) continue;
    if (e.def === "medkit" && tier < CONTAINER.MEDKIT_MIN_TIER) continue;
    if (d.cat === "throwable" && tier < CONTAINER.GRENADE_MIN_TIER) continue;
    const qty = d.cat === "ammo" ? Math.max(1, Math.round(e.qty * CONTAINER.AMMO_QTY_MULT[tier]!)) : e.qty;
    out.push({ ...e, qty: Math.min(qty, d.stack) });
  }
  return out;
}
const evPick = (t: ReadonlyArray<{ def: string; qty: number; weight: number }>) =>
  t.length ? t.reduce((a, e) => a + e.weight * e.qty * unitCr(e.def), 0) / sumW(t) : 0;

test("loot weights were replaced, not stacked: table weights unchanged, grenades only in T2+ containers", () => {
  assert.equal(sumW(CONTAINER_LOOT.crate), sumW(V1.crate));
  assert.equal(sumW(CONTAINER_LOOT.crate), 537);
  assert.equal(sumW(CONTAINER_LOOT.weapon_box), 148);
  assert.equal(sumW(FLOOR_LOOT.MID), 92);
  assert.equal(sumW(FLOOR_LOOT.HIGH), 80);
  assert.equal(sumW(NPC_LOOT.high.cons.table), 100);
  assert.equal(sumW(NPC_LOOT.top.cons.table), 100);
  for (let tier = 0; tier <= 4; tier++) {
    const wb = containerLootFor({ kind: "weapon_box", tier });
    assert.equal(wb.some((e) => e.def === GRENADE_DEF), tier >= CONTAINER.GRENADE_MIN_TIER, `weapon_box T${tier}`);
    const bolts = containerLootFor({ kind: "crate", tier }).find((e) => e.def === "ammo_bolt")!;
    assert.equal(bolts.qty, Math.max(1, Math.round(6 * CONTAINER.AMMO_QTY_MULT[tier]!)), `crate bolts T${tier}`);
  }
  // Grenades never in the low NPC classes, never on the low floor; bolts never on NPCs.
  for (const cls of ["low", "mid"] as const) assert.equal(NPC_LOOT[cls].cons.table.some((e) => e.def === GRENADE_DEF), false);
  for (const cls of ["low", "mid", "high", "top"] as const) assert.equal(NPC_LOOT[cls].cons.table.some((e) => e.def === "ammo_bolt"), false);
  assert.equal(FLOOR_LOOT.LOW.some((e) => e.def === GRENADE_DEF || e.def === "ammo_bolt"), false);
  assert.equal(FLOOR_LOOT.MID.some((e) => e.def === GRENADE_DEF), false);
});

test("loot value per container tier on the Steppe moves less than +5 % (v1 → v2 tables)", () => {
  const map = generateMap("steppe");
  const before = [0, 0, 0, 0, 0];
  const after = [0, 0, 0, 0, 0];
  for (const c of map.containers) {
    const t = Math.max(0, Math.min(4, c.tier));
    const k = CONTAINER.FILL_CHANCE[t]! * CONTAINER.ROLLS[t]! * (1 - CONTAINER.EMPTY_CHANCE);
    const v1 = c.kind === "crate" ? V1.crate : c.kind === "weapon_box" ? V1.weapon_box : CONTAINER_LOOT[c.kind];
    before[t]! += k * evPick(effective(v1, t));
    after[t]! += k * evPick(containerLootFor({ kind: c.kind, tier: t }));
  }
  for (let t = 0; t <= 4; t++) {
    const r = after[t]! / before[t]!;
    assert.ok(r >= 1 && r <= 1.05, `T${t}: ${before[t]!.toFixed(0)} → ${after[t]!.toFixed(0)} CR-eq (×${r.toFixed(3)})`);
  }
  // Floor tables and NPC pockets: within +5 % per draw too.
  for (const [now, v1] of [[FLOOR_LOOT.MID, V1.MID], [FLOOR_LOOT.HIGH, V1.HIGH], [NPC_LOOT.high.cons.table, V1.high], [NPC_LOOT.top.cons.table, V1.top]] as const) {
    const r = evPick(now) / evPick(v1);
    assert.ok(r >= 1 && r <= 1.05, `×${r.toFixed(3)}`);
  }
});

test("NPC kits: SMG / LMG shares per WEAPONS_V2 §8, at most one LMG per top squad, no crossbow, guards FREE-armed", () => {
  const share = (cls: keyof typeof MARAUDER, w: WeaponId) => {
    const t = MARAUDER[cls].weapons;
    return (t.find((x) => x.weapon === w)?.w ?? 0) / t.reduce((a, x) => a + x.w, 0);
  };
  assert.equal(share("low", "smg"), 0);
  assert.equal(share("mid", "smg"), 0.15);
  assert.equal(share("high", "smg"), 0.2);
  assert.equal(share("top", "lmg"), 0.15);
  for (const cls of ["low", "mid", "high", "top"] as const) {
    assert.equal(MARAUDER[cls].weapons.reduce((a, x) => a + x.w, 0), 100, cls);
    assert.equal(share(cls, "crossbow"), 0, `${cls}: no crossbow`);
  }
  let lmgSquads = 0;
  for (let seed = 1; seed <= 400; seed++) {
    const kit = rollMarauderKit(seed, 3, 3, "top");
    const lmgs = kit.filter((k) => k.weapon === "lmg").length;
    assert.ok(lmgs <= 1, `seed ${seed}: ${lmgs} LMGs`);
    assert.ok(kit.filter((k) => k.weapon === "sniper").length <= 1);
    if (lmgs) lmgSquads++;
  }
  assert.ok(lmgSquads > 50, `LMG squads ${lmgSquads}/400`);
  assert.deepEqual(BOSSES.commander.guards.map((g) => g.weapon), ["rifle", "rifle", "lmg"]);
  assert.deepEqual(BOSSES.foreman.guards.map((g) => g.weapon), ["rifle", "revolver"]);
  for (const b of Object.values(BOSSES)) assert.ok(b.guards.every((g) => g.weapon !== "crossbow"));
});

// ------------------------------------------------------------------ market templates (no SOL prices)

test("market templates: every new gun has templates, none has a reference price yet; no common LMG / crossbow", () => {
  assert.deepEqual([...UNPRICED_WEAPONS].sort(), [...NEW].sort());
  for (const w of NEW) {
    for (const r of [0, 1, 2, 3] as const) {
      const t = templateKey({ def: w, rarity: r });
      assert.equal(t, `weapon:${w}:${r}`);
      assert.equal(templateRefPriced(t!), false, `${t} must stay unpriced (Vlad decides)`);
    }
  }
  for (const t of ["weapon:rifle:2", "weapon:pistol:0", "armor:3", "backpack:1"]) assert.equal(templateRefPriced(t), true, t);
  const live = liveWeaponTemplates();
  assert.equal(live.length, 4 * 4 + 2 * 4 + 2 * 3, "v1 guns 4×4, SMG and revolver 4 each, LMG and crossbow rare+ only");
  assert.ok(!live.some((x) => x.template === "weapon:lmg:0" || x.template === "weapon:crossbow:0"));
  assert.deepEqual(live.filter((x) => !x.priced).map((x) => x.weapon).filter((w, i, a) => a.indexOf(w) === i), NEW);
});

// ------------------------------------------------------------------ offers, demo chests, replay

test("trader offers are CR only and respect minRarity; consumables include bolts and the grenade", () => {
  for (const o of BOUND_OFFERS) {
    const w = itemDef(o.def)?.weapon;
    if (w) assert.ok(weaponRarityAllowed(w, o.rarity), `${o.def} r${o.rarity}`);
    assert.ok(o.cr > 0 && Number.isInteger(o.cr));
  }
  assert.deepEqual(
    BOUND_OFFERS.filter((o) => NEW.includes(o.def as WeaponId)).map((o) => [o.def, o.rarity, o.traderLevel]),
    [["smg", 0, 2], ["revolver", 0, 3], ["crossbow", 1, 4], ["lmg", 1, 4]],
  );
  assert.deepEqual(CONSUMABLES_CR.ammo_bolt, { qty: 5, cr: 90 });
  assert.deepEqual(CONSUMABLES_CR.grenade, { qty: 1, cr: 180 });
  for (const t of Object.values(CHEST_TABLES)) {
    for (const r of t.loot) if (r.kind === "weapon") assert.ok(weaponRarityAllowed(r.weapon, r.rarity), `demo ${r.weapon} r${r.rarity}`);
  }
  assert.ok(GRENADE.FUSE_MS > GRENADE.FLIGHT_MS);
});

test("replay: weapon codes are WEAPON_IDS then grenade (version 2); a chunk with the new weapons round-trips", () => {
  assert.equal(REPLAY.VERSION, 2);
  assert.deepEqual(REPLAY_WEAPONS, [...WEAPON_IDS, "grenade"]);
  for (const w of WEAPON_IDS) assert.equal(weaponCode(w), weaponVariant(w), `${w}: replay code = sound variant`);
  const chunk = {
    v: REPLAY.VERSION, seq: 1, startMs: 0, endMs: 1000, final: true, roster: [], frames: [{ t: 0, ents: [] }],
    events: [
      { t: 10, type: "shot" as const, r: 0, weapon: "crossbow" as const, x: 100, y: 100, angles: [0] },
      { t: 20, type: "kill" as const, victim: 1, killer: 0, weapon: "grenade" as const },
      { t: 30, type: "kill" as const, victim: 2, killer: 0, weapon: "lmg" as const },
    ],
  };
  const back = decodeReplayChunk(encodeReplayChunk(chunk));
  assert.deepEqual(back.events.map((e) => ("weapon" in e ? e.weapon : "")), ["crossbow", "grenade", "lmg"]);
  // A version 1 chunk (stored before Weapons v2) still decodes.
  const v1 = encodeReplayChunk({ ...chunk, events: [] });
  v1[4] = 1;
  assert.equal(decodeReplayChunk(v1).v, 1);
});
