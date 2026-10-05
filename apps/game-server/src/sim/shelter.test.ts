/**
 * Disconnect shelter (page reload protection, Match.detach): out of combat a dropped raider is hidden
 * and invulnerable for up to WORLD.DISCONNECT_SHELTER_MS; in combat it stays visible and killable.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { GRENADE, NPC, PLAYER, SERVER_TICK_MS, SoundKind, WORLD } from "@extract/shared";
import { damagePlayer } from "./combat.js";
import { throwGrenade } from "./grenade.js";
import type { Match } from "./match.js";
import type { PlayerRuntime } from "./types.js";
import { addExtract, enter, giveStack, giveWeapon, jump, npcOpts, npcsOf, place, rtOf, run, testMatch, testPost, worldMatch } from "./test-utils.js";

/** Two attached humans 300 px apart on one line, A (sess-a) aiming at B (sess-b). */
function duel(opts: Parameters<typeof testMatch>[1] = {}): { m: Match; a: PlayerRuntime; b: PlayerRuntime } {
  const m = testMatch(2, opts);
  const a = m.attachHuman("user0", "sess-a")!;
  const b = m.attachHuman("user1", "sess-b")!;
  place(m, "sess-a", 1000, 2000);
  place(m, "sess-b", 1300, 2000);
  a.pub.aim = 0;
  b.pub.aim = Math.PI;
  giveWeapon(m, "sess-a", "w1", "rifle");
  giveStack(m, "sess-a", "ammo_light", 60);
  run(m, 500);
  return { m, a, b };
}

const sees = (m: Match, v: PlayerRuntime, t: PlayerRuntime) => m.vision.sees(v.rosterIndex, t.rosterIndex);

test("out of combat: a dropped raider vanishes from every view, bullets and grenades pass it by, until it rejoins on the same spot", () => {
  const { m, a, b } = duel();
  assert.ok(sees(m, a, b), "B is in A's view before the drop");
  assert.equal(m.inCombat(b), false);
  m.detach("sess-b");
  assert.ok(m.isSheltered(b));
  run(m, SERVER_TICK_MS);
  assert.ok(!sees(m, a, b), "hidden at once, no hysteresis");
  const hp = b.pub.hp;
  // A fires straight through B's spot: no hit, no damage.
  const ev = run(m, 1500, { "sess-a": { aim: 0, fire: true } });
  assert.ok(ev.some((e) => e.type === "shot"), "A fired");
  assert.ok(!ev.some((e) => e.type === "hit" && e.target === b.rosterIndex), "the bullets pass the hidden raider");
  damagePlayer(m, b, 50, a, "rifle", b.pub.x, b.pub.y);
  giveStack(m, "sess-a", "grenade", 1);
  run(m, 1000);
  const g = throwGrenade(m, a, 0, (300 - GRENADE.MIN_PX) / (GRENADE.MAX_PX - GRENADE.MIN_PX));
  assert.equal(typeof g, "object", `thrown (${String(g)})`);
  const blast = run(m, 4000);
  assert.ok(blast.some((e) => e.type === "sound" && e.kind === SoundKind.explosion), "it went off");
  assert.equal(b.pub.hp, hp, "no damage from any source");
  assert.ok(b.pub.alive);
  // A's own combat does not drag the sheltered raider back.
  assert.ok(m.isSheltered(b));
  // Rejoin within the window: back on the same spot, visible and vulnerable again.
  const x = b.pub.x, y = b.pub.y;
  assert.equal(m.attachHuman("user1", "sess-b2"), b);
  assert.equal(m.isSheltered(b), false);
  run(m, 200);
  assert.deepEqual([b.pub.x, b.pub.y], [x, y]);
  assert.ok(sees(m, a, b), "visible again");
  damagePlayer(m, b, 10, a, "rifle", b.pub.x, b.pub.y);
  assert.ok(b.pub.hp < hp, "vulnerable again");
});

test("in combat at the drop (fired, hit or got hit within SHELTER_COMBAT_MS): stays visible and killable", () => {
  // B got hit 5 s before dropping.
  {
    const { m, a, b } = duel();
    damagePlayer(m, b, 5, a, "rifle", b.pub.x, b.pub.y);
    run(m, 5000);
    assert.ok(m.inCombat(b));
    m.detach("sess-b");
    assert.equal(m.isSheltered(b), false);
    run(m, 200);
    assert.ok(sees(m, a, b));
    const hp = b.pub.hp;
    damagePlayer(m, b, 10, a, "rifle", b.pub.x, b.pub.y);
    assert.ok(b.pub.hp < hp);
  }
  // A fired 3 s before dropping (nobody hit): still in combat.
  {
    const { m, a } = duel();
    run(m, 300, { "sess-a": { aim: Math.PI / 2, fire: true } });
    run(m, 3000);
    assert.ok(m.inCombat(a));
    m.detach("sess-a");
    assert.equal(m.isSheltered(a), false);
  }
  // The combat window: just past SHELTER_COMBAT_MS since the last hit dealt, the drop is sheltered.
  {
    const { m, a, b } = duel();
    damagePlayer(m, b, 5, a, "rifle", b.pub.x, b.pub.y);
    run(m, WORLD.SHELTER_COMBAT_MS + 100);
    assert.equal(m.inCombat(a), false);
    m.detach("sess-a");
    assert.ok(m.isSheltered(a), "dealing damage counts too, and it wears off");
  }
});

test("the shelter runs out after DISCONNECT_SHELTER_MS: the still-disconnected raider reappears in place, vulnerable", () => {
  const { m, a, b } = duel();
  m.detach("sess-b");
  const x = b.pub.x, y = b.pub.y;
  run(m, WORLD.DISCONNECT_SHELTER_MS - 1000);
  assert.ok(m.isSheltered(b) && !sees(m, a, b));
  run(m, 2000);
  assert.equal(m.isSheltered(b), false);
  assert.equal(b.connected, false);
  assert.deepEqual([b.pub.x, b.pub.y], [x, y]);
  assert.ok(sees(m, a, b), "visible again");
  const hp = b.pub.hp;
  damagePlayer(m, b, 10, a, "rifle", b.pub.x, b.pub.y);
  assert.ok(b.pub.hp < hp);
});

test("NPCs ignore a sheltered raider: never seen, never shot, even inside the post", () => {
  const m = testMatch(1, { envSeed: 2, ...npcOpts([testPost(0, 1500, 1500)]) });
  const h = m.attachHuman("user0", "sess-h")!;
  const npc = npcsOf(m)[0]!;
  // Inside the post's leash: an intruder is fought even in the peace window — unless it is hidden.
  place(m, "sess-h", 1700, 1500);
  h.pub.aim = Math.PI;
  m.detach("sess-h");
  assert.ok(m.isSheltered(h));
  const ev = run(m, 8000);
  assert.ok(m.clock < NPC.PEACE_MS);
  assert.ok(!m.vision.sees(npc.rosterIndex, h.rosterIndex));
  assert.ok(!ev.some((e) => e.type === "shot" && e.src === npc.rosterIndex), "the NPC never fires");
  assert.equal(h.pub.hp, PLAYER.MAX_HP);
  // Back: the NPC sees and fights it.
  m.attachHuman("user0", "sess-h2");
  run(m, 4000);
  assert.ok(m.vision.sees(npc.rosterIndex, h.rosterIndex));
});

test("a sheltered raider's extraction pauses (no channel, no extract sound) and restarts from zero once back", () => {
  const { m, b } = duel();
  addExtract(m, b.pub.x, b.pub.y);
  run(m, 2000);
  assert.ok(b.self.extractId !== "", "channelling");
  m.detach("sess-b");
  const ev = run(m, 30_000);
  assert.ok(b.pub.alive, "never extracted while hidden");
  assert.equal(b.self.extractId, "");
  assert.ok(!ev.some((e) => e.type === "sound" && e.x === b.pub.x && e.y === b.pub.y), "no sound from the hidden spot");
  m.attachHuman("user1", "sess-b2");
  run(m, 500);
  assert.ok(b.self.extractId !== "" && m.clock - b.self.extractStartedAt < 1000, "a fresh channel");
});

test("world: a sheltered raider still holds its place for the wipe (MIA as usual)", () => {
  const { m, wall } = worldMatch();
  const rt = enter(m, "alice");
  m.attachHuman("alice", "sess-alice");
  jump(m, wall, 60_000);
  m.detach("sess-alice");
  assert.ok(m.isSheltered(rt));
  assert.equal(m.humansOnMap(), 1);
  jump(m, wall, WORLD.CYCLE_MS);
  assert.ok(m.ended);
  assert.equal(rt.exitReport?.exit, "mia");
});
