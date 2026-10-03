/**
 * Run: apps/game-server/node_modules/.bin/tsx --test apps/web/src/game/boss.test.ts
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BOSSES, BOSS_KINDS, NPC_ROLE, PLAYER, generateMap } from "@extract/shared";
import {
  BOSS_HINT_NEAR_PX,
  BossAlertTracker,
  RESIGHT_MS,
  STING_COOLDOWN_MS,
  bossTurfAt,
  easeBar,
  hpFraction,
  kindOfNickname,
  kindOfNpc,
  minimapBossHint,
  nearestBossKind,
  npcNameTag,
  npcRole,
  pickBarBoss,
  tensionKind,
  turfLine,
} from "./boss";
import { bossBarY } from "./boss-hud";
import { toastAlpha } from "./fullmap";
import { SFX } from "./audio/recipes";

const map = generateMap("steppe");

describe("npc identity", () => {
  it("maps Player.role to boss / guard / null", () => {
    assert.equal(npcRole(NPC_ROLE.BOSS), "boss");
    assert.equal(npcRole(NPC_ROLE.GUARD), "guard");
    assert.equal(npcRole(NPC_ROLE.NONE), null);
    assert.equal(npcRole(undefined), null);
    assert.equal(npcRole(7), null);
  });

  it("resolves the kind from boss and guard names, case-insensitively", () => {
    for (const k of BOSS_KINDS) {
      assert.equal(kindOfNickname(BOSSES[k].name), k);
      assert.equal(kindOfNickname(BOSSES[k].name.toUpperCase()), k);
      assert.equal(kindOfNickname(BOSSES[k].guardName), k);
    }
    assert.equal(kindOfNickname("Foreman #2"), "foreman");
    assert.equal(kindOfNickname("vlad"), null);
    assert.equal(kindOfNickname("  "), null);
  });

  it("falls back to the nearest boss spot", () => {
    assert.equal(map.bosses.length, 3);
    for (const b of map.bosses) {
      assert.equal(nearestBossKind(map.bosses, b.x + 300, b.y - 200), b.kind);
      assert.equal(kindOfNpc({ nickname: "Bot 7", x: b.guards[0]!.x, y: b.guards[0]!.y }, map.bosses), b.kind);
    }
    assert.equal(nearestBossKind(map.bosses, 0, 0, 1000), null);
    // The nickname wins over position.
    const radar = map.bosses.find((b) => b.kind === "commander")!;
    assert.equal(kindOfNpc({ nickname: "Foreman", x: radar.x, y: radar.y }, map.bosses), "foreman");
  });

  it("tags bosses in caps and guards by their guard name", () => {
    assert.equal(npcNameTag("boss", "foreman", "x"), "FOREMAN");
    assert.equal(npcNameTag("guard", "commander", "x"), BOSSES.commander.guardName);
    assert.equal(npcNameTag(null, null, "vlad"), "vlad");
    assert.equal(npcNameTag("boss", null, "Big"), "BIG");
    assert.equal(turfLine("foreman"), "Foreman's turf");
  });

  it("measures HP against the per-runtime maximum", () => {
    assert.equal(hpFraction(150, 300), 0.5);
    assert.equal(hpFraction(400, 400), 1);
    assert.equal(hpFraction(50, 0), 50 / PLAYER.MAX_HP);
    assert.equal(hpFraction(50, undefined), 50 / PLAYER.MAX_HP);
    assert.equal(hpFraction(-5, 300), 0);
    assert.equal(hpFraction(500, 300), 1);
  });
});

describe("boss turf", () => {
  it("each boss spot lies on its own boss zone", () => {
    for (const b of map.bosses) assert.equal(bossTurfAt(map, b.x, b.y), b.kind);
  });

  it("ordinary POIs and the wilds are no turf", () => {
    for (const z of map.zones.filter((z) => !z.boss)) {
      assert.equal(bossTurfAt(map, z.rect.x + z.rect.w / 2, z.rect.y + z.rect.h / 2), null, z.id);
    }
    assert.equal(bossTurfAt(map, 10, 10), null);
  });

  it("tension runs only alive, on turf, while that boss is not known dead", () => {
    const dead = new Set<"foreman" | "commander" | "warden">();
    assert.equal(tensionKind("foreman", true, dead), "foreman");
    assert.equal(tensionKind("foreman", false, dead), null);
    assert.equal(tensionKind(null, true, dead), null);
    dead.add("foreman");
    assert.equal(tensionKind("foreman", true, dead), null);
    assert.equal(tensionKind("warden", true, dead), "warden");
  });
});

describe("minimap boss hint", () => {
  const win = { x: 1000, y: 1000, w: 4096, h: 4096 };
  const size = 200;

  it("draws a spot inside the window at its position", () => {
    const h = minimapBossHint(win, { x: 1000 + 2048, y: 1000 + 1024 }, { x: 3048, y: 3048 }, size);
    assert.deepEqual(h, { x: 100, y: 50, edge: false });
  });

  it("clamps a near off-window spot to the edge, toward the spot", () => {
    const self = { x: 3048, y: 3048 };
    const h = minimapBossHint(win, { x: self.x + 3000, y: self.y }, self, size)!;
    assert.ok(h.edge);
    assert.ok(Math.abs(h.x - (size - 7)) < 1e-6, `x ${h.x}`);
    assert.ok(Math.abs(h.y - 100) < 1e-6, `y ${h.y}`);
    const d = minimapBossHint(win, { x: self.x - 2500, y: self.y - 2500 }, self, size)!;
    assert.ok(d.edge && Math.abs(d.x - 7) < 1e-6 && Math.abs(d.y - 7) < 1e-6);
  });

  it("hides far spots and spots without a player", () => {
    const self = { x: 3048, y: 3048 };
    assert.equal(minimapBossHint(win, { x: self.x + BOSS_HINT_NEAR_PX + 10, y: self.y }, self, size), null);
    assert.equal(minimapBossHint(win, { x: 20000, y: 20000 }, null, size), null);
  });
});

describe("alert sting", () => {
  it("stings on the first sighting, then respects the cooldown", () => {
    const a = new BossAlertTracker();
    assert.equal(a.sight("g1", "guard", "foreman", 0), "guard");
    assert.equal(a.sight("g1", "guard", "foreman", 150), null); // still in view
    assert.equal(a.sight("g2", "guard", "foreman", 1000), null); // cooldown
    assert.equal(a.sight("g3", "guard", "foreman", STING_COOLDOWN_MS + 10), "guard");
  });

  it("the boss itself breaks a guard cooldown once per boss", () => {
    const a = new BossAlertTracker();
    assert.equal(a.sight("g1", "guard", "commander", 0), "guard");
    assert.equal(a.sight("b", "boss", "commander", 500), "boss");
    assert.equal(a.sight("b", "boss", "commander", 500 + RESIGHT_MS + 1), null); // re-seen, cooldown
  });

  it("a re-sighting after RESIGHT_MS out of view counts again (after the cooldown)", () => {
    const a = new BossAlertTracker();
    assert.equal(a.sight("g1", "guard", "warden", 0), "guard");
    assert.equal(a.sight("g1", "guard", "warden", STING_COOLDOWN_MS + RESIGHT_MS), "guard");
  });

  it("being shot by an NPC stings, regular players never do", () => {
    const a = new BossAlertTracker();
    assert.equal(a.shotBy(null, 0), null);
    assert.equal(a.sight("p", null, null, 0), null);
    assert.equal(a.shotBy("guard", 10), "guard");
    assert.equal(a.shotBy("boss", 20), null);
    assert.equal(a.shotBy("boss", 20 + STING_COOLDOWN_MS), "boss");
  });
});

describe("screen boss bar", () => {
  it("drains damage smoothly and snaps heals up", () => {
    let v = 1;
    for (let i = 0; i < 5; i++) v = easeBar(v, 0.5, 16);
    assert.ok(v < 1 && v > 0.5, `${v}`);
    for (let i = 0; i < 200; i++) v = easeBar(v, 0.5, 16);
    assert.equal(v, 0.5);
    assert.equal(easeBar(0.3, 0.8, 16), 0.8);
    assert.equal(easeBar(Number.NaN, 0.4, 16), 0.4);
  });

  it("picks the closest boss within reach", () => {
    const bs = [
      { id: "a", x: 0, y: 0 },
      { id: "b", x: 500, y: 0 },
    ];
    assert.equal(pickBarBoss(bs, { x: 400, y: 0 }, 1000)?.id, "b");
    assert.equal(pickBarBoss(bs, { x: 5000, y: 0 }, 1000), null);
    assert.equal(pickBarBoss([], { x: 0, y: 0 }, 1000), null);
  });

  it("sits under the top HUD and above the zone toast", () => {
    for (const h of [500, 720, 900, 1440]) {
      const y = bossBarY(h);
      assert.ok(y >= 64 && y < h * 0.16, `${h} → ${y}`);
    }
  });
});

describe("boss toast + sounds", () => {
  it("a longer hold keeps the turf toast up longer", () => {
    assert.equal(toastAlpha(2400), 1);
    assert.ok(toastAlpha(3000) < 1);
    assert.equal(toastAlpha(3000, 3400), 1);
  });

  it("the bank has the boss sting and the tension swell", () => {
    assert.equal(SFX.boss_sting.bus, "ui");
    assert.ok(!SFX.boss_tension.loop, "tension is a one-shot swell, re-triggered");
    assert.ok(SFX.boss_tension.dur * 1000 <= 7000, "a swell fits inside TENSION_REPEAT_MS");
  });
});
