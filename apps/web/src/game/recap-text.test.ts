/**
 * Run: apps/game-server/node_modules/.bin/tsx --test apps/web/src/game/recap-text.test.ts
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { NPC_ROLE, type DeathRecap } from "@extract/shared";
import {
  killedByText,
  recapBadges,
  recapKillerHp,
  recapKillerName,
  recapKillerSub,
  recapSourceLine,
  recapSourceWho,
  recapWeaponLabel,
} from "./recap-text";

const base: DeathRecap = {
  killer: { kind: "human", name: "Viper", role: 0, weapon: "rifle", rarity: 2, distM: 34, hp: 37, hpMax: 100, party: true },
  sources: [
    { who: "killer", name: "Viper", role: 0, weapon: "rifle", rarity: 2, dmg: 64, hits: 3 },
    { who: "party", name: "", role: 0, weapon: "grenade", rarity: -1, dmg: 40, hits: 1 },
    { who: "raider", name: "", role: 0, weapon: "pistol", rarity: 0, dmg: 5, hits: 1 },
    { who: "other", name: "", role: 0, weapon: "", rarity: -1, dmg: 9, hits: 3 },
  ],
  total: 118,
  windowMs: 10_000,
};

describe("recap text", () => {
  it("names the killer, the weapon with rarity and the distance", () => {
    assert.equal(recapKillerName(base), "Viper");
    assert.match(recapKillerSub(base), /\(epic\) · 34 m$/);
    assert.equal(recapKillerHp(base), "37 / 100 HP left");
    assert.deepEqual(recapBadges(base), ["In a squad"]);
    assert.equal(recapWeaponLabel("grenade", -1), "Grenade");
  });

  it("reads the damage lines as 'Weapon (rarity) — N dmg, K hits'", () => {
    assert.match(recapSourceLine(base.sources[0]!), /^.+ \(epic\) — 64 dmg, 3 hits$/);
    assert.equal(recapSourceLine(base.sources[1]!), "Grenade — 40 dmg");
    assert.equal(recapSourceLine(base.sources[3]!), "Other hits — 9 dmg, 3 hits");
    assert.deepEqual(base.sources.map((s) => recapSourceWho(s, base)), ["Viper", "Their squad", "Another raider", "Others"]);
  });

  it("fog: no distance → 'unseen', no HP line without a trade; NPCs and own grenades by role", () => {
    const unseen: DeathRecap = { ...base, killer: { ...base.killer, distM: undefined, hp: undefined, hpMax: undefined, party: false, guest: true } };
    assert.match(recapKillerSub(unseen), /unseen$/);
    assert.equal(recapKillerHp(unseen), null);
    assert.deepEqual(recapBadges(unseen), ["Guest"]);
    const npc: DeathRecap = { ...base, killer: { kind: "npc", name: "Marauder", role: NPC_ROLE.MARAUDER, weapon: "smg", rarity: 0, party: false } };
    assert.equal(recapKillerName(npc), "Marauder");
    const boss: DeathRecap = { ...base, killer: { kind: "npc", name: "Foreman", role: NPC_ROLE.BOSS, boss: "foreman", weapon: "shotgun", rarity: 3, party: false } };
    assert.equal(recapKillerName(boss), "FOREMAN");
    const self: DeathRecap = { ...base, killer: { kind: "self", name: "", role: 0, weapon: "grenade", rarity: -1, party: false } };
    assert.equal(recapKillerName(self), "Your own grenade");
  });

  it("the after-raid card's killed-by line", () => {
    assert.equal(killedByText("Viper", 0), "Killed by Viper");
    assert.equal(killedByText("Marauder", NPC_ROLE.MARAUDER), "Killed by Marauder");
    assert.equal(killedByText(undefined, undefined), null);
  });
});
