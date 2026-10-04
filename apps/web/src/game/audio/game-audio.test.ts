/**
 * Run: apps/game-server/node_modules/.bin/tsx --test apps/web/src/game/audio/*.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { GRENADE_SOUND, SOUND, SOUND_KIND_COUNT, SoundKind, STEP_MATERIALS, WEAPONS, WEAPON_IDS, weaponVariant } from "@extract/shared";
import {
  LOW_HP,
  RANGE_SLACK,
  emptySnap,
  extractBeepIntervalMs,
  gunSfx,
  heartbeatFor,
  layersForSound,
  reloadCues,
  selfCues,
  sourceKey,
  visibleRange,
  type SelfSnap,
} from "./game-audio";
import { isSfxId } from "./recipes";

const snap = (p: Partial<SelfSnap>): SelfSnap => ({ ...emptySnap(), active: "w1", ...p });
const kinds = (prev: SelfSnap | null, next: SelfSnap, clock = 1000) => selfCues(prev, next, clock).map((c) => c.k);

describe("layersForSound", () => {
  it("every kind and variant maps to baked sounds", () => {
    for (let k = 0; k < SOUND_KIND_COUNT; k++) {
      for (let v = 0; v < 8; v++) {
        const l = layersForSound(k, v, 0.9);
        assert.ok(l.length > 0, `kind ${k}`);
        for (const x of l) assert.ok(isSfxId(x.id), `${k}/${v} → ${x.id}`);
      }
    }
    assert.deepEqual(layersForSound(99, 0), []);
  });

  it("shots use the weapon index from the shared contract", () => {
    for (const w of WEAPON_IDS) assert.equal(layersForSound(SoundKind.shot, weaponVariant(w))[0]!.id, gunSfx(w));
    assert.equal(gunSfx("nonsense"), "gun_pistol");
    // Weapons v2: every gun has its own take (the crossbow its twang).
    assert.equal(new Set(WEAPON_IDS.map(gunSfx)).size, WEAPON_IDS.length);
    assert.equal(gunSfx("crossbow"), "gun_crossbow");
  });

  it("Weapons v2: the blast and the grenade's pin / bounce", () => {
    assert.equal(layersForSound(SoundKind.explosion, 0)[0]!.id, "explosion");
    assert.equal(layersForSound(SoundKind.grenade, GRENADE_SOUND.THROW)[0]!.id, "grenade_pin");
    assert.equal(layersForSound(SoundKind.grenade, GRENADE_SOUND.BOUNCE)[0]!.id, "grenade_bounce");
  });

  it("steps decode the shared material index, with wet and bush layers", () => {
    const wood = STEP_MATERIALS.indexOf("wood");
    assert.equal(layersForSound(SoundKind.step, wood)[0]!.id, "step_wood");
    assert.equal(layersForSound(SoundKind.step, STEP_MATERIALS.indexOf("gravel"))[0]!.id, "step_dirt");
    assert.ok(layersForSound(SoundKind.step, 1, 0.9).some((l) => l.id === "step_water"));
    assert.ok(layersForSound(SoundKind.stepBush, 0).some((l) => l.id === "rustle"));
  });

  it("heal variant 1 is the medkit; reload is two parts", () => {
    assert.equal(layersForSound(SoundKind.heal, 1)[0]!.id, "heal_medkit");
    assert.equal(layersForSound(SoundKind.heal, 0)[0]!.id, "heal_bandage");
    const r = layersForSound(SoundKind.reload, 0);
    assert.equal(r.length, 2);
    assert.ok((r[1]!.at ?? 0) > 0);
  });
});

describe("visibleRange", () => {
  it("is the shared radius × hear × slack, with the surface only for steps", () => {
    assert.equal(visibleRange(SoundKind.shot, weaponVariant("sniper"), false, 1), WEAPONS.sniper.soundRadius * RANGE_SLACK);
    assert.equal(visibleRange(SoundKind.step, 0, false, 0.5, 1.3), SOUND.RADIUS.step * 0.5 * 1.3 * RANGE_SLACK);
    assert.equal(visibleRange(SoundKind.step, 0, true, 1, 1), SOUND.RADIUS.stepWalk * RANGE_SLACK);
    assert.equal(visibleRange(SoundKind.reload, 0, false, 1, 9), SOUND.RADIUS.reload * RANGE_SLACK);
  });
});

describe("heartbeat", () => {
  it("silent at and above the threshold, and when dead", () => {
    assert.equal(heartbeatFor(LOW_HP.threshold), null);
    assert.equal(heartbeatFor(100), null);
    assert.equal(heartbeatFor(0), null);
  });

  it("speeds up and gets louder as HP drops, clamped at the floor", () => {
    const a = heartbeatFor(34)!;
    const b = heartbeatFor(20)!;
    const c = heartbeatFor(LOW_HP.floor)!;
    const d = heartbeatFor(1)!;
    assert.ok(a.intervalMs > b.intervalMs && b.intervalMs > c.intervalMs);
    assert.ok(a.db < b.db && b.db < c.db);
    assert.equal(c.intervalMs, LOW_HP.fastMs);
    assert.deepEqual(d, c);
  });
});

describe("extract beeps and reload cues", () => {
  it("beeps twice as fast in the last 3 s", () => {
    assert.equal(extractBeepIntervalMs(9000), 1000);
    assert.equal(extractBeepIntervalMs(2500), 500);
  });

  it("reload cues land at 15/70/90%", () => {
    assert.deepEqual(
      reloadCues(2000).map((c) => [c.id, c.at]),
      [
        ["reload_out", 0.3],
        ["reload_in", 1.4],
        ["rack", 1.8],
      ],
    );
  });
});

describe("selfCues", () => {
  it("the first snapshot is silent (reconnect mid-reload)", () => {
    assert.deepEqual(kinds(null, snap({ reloadUntil: 3000, healUntil: 4000 })), []);
  });

  it("detects reload start with the remaining time, and cancel on switch", () => {
    const c = selfCues(snap({}), snap({ reloadUntil: 3000 }), 1000);
    assert.deepEqual(c, [{ k: "reload", ms: 2000 }]);
    assert.deepEqual(kinds(snap({ reloadUntil: 3000 }), snap({ reloadUntil: 3000, active: "w2" })), ["switch", "reloadCancel"]);
    assert.deepEqual(kinds(snap({ reloadUntil: 3000 }), snap({ reloadUntil: 0 })), ["reloadCancel"]);
    // A finished reload (reloadUntil in the past) is neither a start nor a cancel.
    assert.deepEqual(kinds(snap({ reloadUntil: 900 }), snap({ reloadUntil: 900 })), []);
  });

  it("heal, roll, search and extract edges", () => {
    assert.deepEqual(selfCues(snap({}), snap({ healUntil: 5000, healKind: "medkit" }), 1000), [{ k: "heal", kind: "medkit" }]);
    assert.deepEqual(kinds(snap({}), snap({ rollLeft: 10 })), ["roll"]);
    assert.deepEqual(kinds(snap({ rollLeft: 9 }), snap({ rollLeft: 8 })), []);
    assert.deepEqual(selfCues(snap({}), snap({ searching: "k3" }), 0), [{ k: "searchStart", key: "k3" }]);
    assert.deepEqual(kinds(snap({ searching: "k3" }), snap({ searching: "c7" })), ["searchStop", "searchStart"]);
    assert.deepEqual(kinds(snap({ searching: "c7" }), snap({})), ["searchStop"]);
    assert.deepEqual(kinds(snap({}), snap({ extractStartedAt: 900 })), ["extractStart"]);
    assert.deepEqual(kinds(snap({ extractStartedAt: 900 }), snap({})), ["extractStop"]);
    assert.deepEqual(kinds(snap({ extractStartedAt: 900 }), snap({ extractStartedAt: 900, extractedAt: 1000 })), ["extracted"]);
  });

  it("death stops everything else; revive is reported", () => {
    assert.deepEqual(kinds(snap({}), snap({ alive: false, reloadUntil: 3000 })), ["died"]);
    assert.deepEqual(kinds(snap({ alive: false }), snap({})), ["revived"]);
  });

  it("appends into a reused array", () => {
    const out: ReturnType<typeof selfCues> = [];
    selfCues(snap({}), snap({ rollLeft: 1 }), 0, out);
    selfCues(snap({}), snap({ active: "w2" }), 0, out);
    assert.deepEqual(
      out.map((c) => c.k),
      ["roll", "switch"],
    );
  });
});

describe("sourceKey", () => {
  it("separates hidden buckets and visible ids", () => {
    assert.equal(sourceKey({ kind: 0, hidden: true, a: 3, b: 1, occluded: false, variant: 0 }), "h3:1");
    assert.equal(sourceKey({ kind: 0, hidden: false, id: "abc", variant: 0 }), "vabc");
  });
});
