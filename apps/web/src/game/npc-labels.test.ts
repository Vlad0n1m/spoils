/**
 * Run: apps/game-server/node_modules/.bin/tsx --test apps/web/src/game/npc-labels.test.ts
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BOSSES, NPC_ROLE, NPC_TAG } from "@extract/shared";
import {
  EMPTY_TALLY,
  NPC_RING_COLOR,
  bodyTitle,
  bossKindOfLabel,
  corpseNpcRole,
  cssHex,
  killFeedNames,
  killedByLine,
  npcDisplayName,
  npcKillsLine,
  npcLabels,
  npcLocale,
  npcNameOf,
  npcRoleName,
  npcRoleOfLabel,
  tallyKill,
  type NpcRoleName,
} from "./npc-labels";

describe("npc roles and names", () => {
  it("maps NPC_ROLE numbers, humans are null", () => {
    assert.equal(npcRoleName(NPC_ROLE.BOSS), "boss");
    assert.equal(npcRoleName(NPC_ROLE.GUARD), "guard");
    assert.equal(npcRoleName(NPC_ROLE.MARAUDER), "marauder");
    assert.equal(npcRoleName(NPC_ROLE.NONE), null);
    assert.equal(npcRoleName(undefined), null);
    assert.equal(npcRoleName(99), null);
  });

  it("recognises NPC display keys, never a player nickname", () => {
    assert.equal(npcRoleOfLabel("Marauder"), "marauder");
    assert.equal(npcRoleOfLabel(" мародёр "), "marauder");
    assert.equal(npcRoleOfLabel("Foreman"), "boss");
    assert.equal(npcRoleOfLabel(BOSSES.commander.guardName), "guard");
    assert.equal(npcRoleOfLabel("Vlad"), null);
    assert.equal(npcRoleOfLabel(""), null);
    assert.equal(bossKindOfLabel("Elevator thug"), "foreman");
    assert.equal(bossKindOfLabel("Marauder"), null);
  });

  it("displays NPCs by role in both locales", () => {
    assert.equal(npcDisplayName("marauder", null, "Ivan_88", "en"), NPC_TAG.marauder);
    assert.equal(npcDisplayName("marauder", null, "Ivan_88", "ru"), "Мародёр");
    assert.equal(npcDisplayName("guard", "foreman", "x", "en"), "Elevator thug");
    assert.equal(npcDisplayName("guard", "foreman", "x", "ru"), "Охранник");
    assert.equal(npcDisplayName("guard", null, "x", "en"), "Guard");
    assert.equal(npcDisplayName("boss", "commander", "x", "ru"), "COMMANDER");
    assert.equal(npcDisplayName(null, null, "Vlad", "en"), "Vlad");
    assert.equal(npcNameOf(NPC_ROLE.MARAUDER, "whatever", "en"), "Marauder");
    assert.equal(npcNameOf(undefined, "Warden", "en"), "WARDEN");
    assert.equal(npcNameOf(0, "Vlad", "en"), "Vlad");
  });

  it("picks the locale from the page language, English without a DOM", () => {
    assert.equal(npcLocale("ru-RU"), "ru");
    assert.equal(npcLocale("en"), "en");
    assert.equal(npcLocale(""), "en");
    assert.equal(npcLocale(), "en");
    assert.equal(npcLabels("ru").marauder, "Мародёр");
  });

  it("gives every role a distinct colour and formats CSS hex", () => {
    const roles: NpcRoleName[] = ["boss", "guard", "marauder"];
    assert.equal(new Set(roles.map((r) => NPC_RING_COLOR[r])).size, 3);
    assert.equal(NPC_RING_COLOR.marauder, 0x8f8a5a);
    assert.equal(cssHex(0x8f8a5a), "#8f8a5a");
    assert.equal(cssHex(0x00ff), "#0000ff");
  });
});

describe("kill feed", () => {
  it("a marauder kill by me is a personal row", () => {
    const n = killFeedNames({ killer: "Vlad", victim: "Marauder", killerRole: 0, victimRole: NPC_ROLE.MARAUDER }, "Vlad", "en");
    assert.equal(n.personal, true);
    assert.deepEqual(n.killer, { name: "You", npc: null });
    assert.deepEqual(n.victim, { name: "Marauder", npc: "marauder" });
  });

  it("an NPC killing a human names the NPC by role", () => {
    const n = killFeedNames({ killer: "Marauder", victim: "Vlad", killerRole: NPC_ROLE.MARAUDER, victimRole: 0 }, "Other", "en");
    assert.equal(n.personal, false);
    assert.deepEqual(n.killer, { name: "Marauder", npc: "marauder" });
    assert.deepEqual(n.victim, { name: "Vlad", npc: null });
  });

  it("boss deaths and human kills are regular rows; a suicide has no killer", () => {
    const b = killFeedNames({ killer: "Vlad", victim: "Foreman", victimRole: NPC_ROLE.BOSS }, "Vlad", "en");
    assert.equal(b.personal, false);
    assert.deepEqual(b.victim, { name: "FOREMAN", npc: "boss" });
    const h = killFeedNames({ killer: "A", victim: "B" }, "Vlad", "en");
    assert.deepEqual([h.killer?.npc, h.victim.npc, h.personal], [null, null, false]);
    const s = killFeedNames({ killer: "", victim: "Vlad" }, "Vlad", "en");
    assert.equal(s.killer, null);
  });
});

describe("kill tally", () => {
  const me = "s1";
  it("splits my kills into players, NPCs and bosses", () => {
    let t = { ...EMPTY_TALLY };
    t = tallyKill(t, { killerId: me, victimId: "p2" }, me);
    t = tallyKill(t, { killerId: me, victimId: "n1", victimRole: NPC_ROLE.MARAUDER }, me);
    t = tallyKill(t, { killerId: me, victimId: "n2", victimRole: NPC_ROLE.GUARD }, me);
    t = tallyKill(t, { killerId: me, victimId: "b", victimRole: NPC_ROLE.BOSS }, me);
    // Not mine / my own death / unknown self.
    t = tallyKill(t, { killerId: "p2", victimId: "n3", victimRole: NPC_ROLE.MARAUDER }, me);
    t = tallyKill(t, { killerId: me, victimId: me }, me);
    assert.equal(tallyKill(t, { killerId: "", victimId: "x" }, ""), t);
    assert.deepEqual(t, { players: 1, npcs: 2, bosses: 1 });
    assert.deepEqual(EMPTY_TALLY, { players: 0, npcs: 0, bosses: 0 });
  });

  it("formats the NPC kills line with bosses included", () => {
    assert.equal(npcKillsLine({ npcs: 4, bosses: 0 }, "en"), "4");
    assert.equal(npcKillsLine({ npcs: 4, bosses: 1 }, "en"), "5 (boss 1)");
    assert.equal(npcKillsLine({ npcs: 0, bosses: 1 }, "ru"), "1 (босс 1)");
  });
});

describe("death line and bodies", () => {
  it("names the NPC killer by role", () => {
    assert.equal(killedByLine("Marauder", "en"), "Killed by Marauder");
    assert.equal(killedByLine("Commander", "en"), "Killed by COMMANDER");
    assert.equal(killedByLine("Vlad", "en"), "Killed by Vlad");
  });

  it("titles NPC bodies by role and corpses resolve a seen role first", () => {
    assert.equal(bodyTitle("Vlad", "en"), "Vlad's body");
    assert.equal(bodyTitle("Marauder", "en"), "Marauder's body");
    assert.equal(bodyTitle("Foreman", "en"), "FOREMAN's body");
    assert.equal(bodyTitle("", "en"), "Body");
    assert.equal(bodyTitle(null, "en"), "Body");
    const seen = new Map<string, NpcRoleName>([["Odd name", "guard"]]);
    assert.equal(corpseNpcRole("Odd name", seen), "guard");
    assert.equal(corpseNpcRole("Marauder", seen), "marauder");
    assert.equal(corpseNpcRole("Vlad", seen), null);
  });
});
