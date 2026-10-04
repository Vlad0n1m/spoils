/**
 * Alpha first-raid tutorial on the game server: pickTutorialSpawn (spawn.ts) lands a first-time
 * raider next to a quiet T1 container with a living T1 marauder squad nearby (a normal map NPC, no
 * bots), prefers the weakest squad, avoids other humans, and falls back to the normal entry spawn.
 * Also: the touch flag reaches the exit report, the skin reaches Player.skin.
 * Run: apps/game-server/node_modules/.bin/tsx --test apps/game-server/src/sim/tutorial-spawn.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { ContainerSpot, LootTier } from "@extract/shared";
import { TUTORIAL_BACK_PX, TUTORIAL_POST_MAX_PX, TUTORIAL_POST_MIN_PX, pickTutorialSpawn } from "./spawn.js";
import { enter, npcOpts, testMap, testPost, worldMatch } from "./test-utils.js";

const crate = (x: number, y: number, tier: LootTier = 1): ContainerSpot => ({ x, y, kind: "crate", tier, zone: null });

function world(containers: ContainerSpot[], posts: ReturnType<typeof testPost>[], sizes?: number[]) {
  const o = npcOpts(posts);
  if (sizes) o.npcSpawns = posts.map((p, i) => ({ postId: p.id, members: sizes[i]! }));
  return worldMatch({ map: testMap({ containers }), ...o });
}

test("lands behind the container, away from the marauder post, within reach of both", () => {
  const { m } = world([crate(2400, 1800)], [testPost(0, 2400, 2500)]);
  const s = pickTutorialSpawn(m, "newbie");
  assert.ok(s, "a spot");
  const dc = Math.hypot(s.x - 2400, s.y - 1800);
  assert.ok(Math.abs(dc - TUTORIAL_BACK_PX) <= 64, `~${TUTORIAL_BACK_PX} px from the crate (${dc.toFixed(0)})`);
  assert.ok(s.y < 1800, "on the far side from the post");
  const dp = Math.hypot(s.x - 2400, s.y - 2500);
  assert.ok(dp >= TUTORIAL_POST_MIN_PX, "not on top of the marauder");
});

test("prefers the squad with the fewest living members; ignores T2+ containers and far posts", () => {
  const { m } = world(
    [crate(1400, 1600), crate(3400, 1600), crate(2400, 3600, 3)],
    [testPost(0, 1400, 2300, { size: [3, 3] }), testPost(1, 3400, 2300, { size: [1, 1] }), testPost(2, 2400, 4300)],
    [3, 1, 1],
  );
  const s = pickTutorialSpawn(m, "newbie")!;
  assert.ok(Math.hypot(s.x - 3400, s.y - 1600) < 300, `the lone marauder's crate (${s.x}, ${s.y})`);
  const far = world([crate(1400, 1600)], [testPost(0, 1400, 1600 + TUTORIAL_POST_MAX_PX + 200)]);
  assert.equal(pickTutorialSpawn(far.m, "newbie"), null, "post too far");
  const t2 = world([crate(1400, 1600, 2)], [testPost(0, 1400, 2300)]);
  assert.equal(pickTutorialSpawn(t2.m, "newbie"), null, "a T2 container is not a tutorial spot");
});

test("quiet only: a spot with another raider in view is skipped", () => {
  const { m } = world([crate(1400, 1600), crate(3400, 1600)], [testPost(0, 1400, 2300), testPost(1, 3400, 2300)]);
  const other = enter(m, "veteran");
  other.pub.x = 1400;
  other.pub.y = 1300;
  const s = pickTutorialSpawn(m, "newbie")!;
  assert.ok(Math.hypot(s.x - 3400, s.y - 1600) < 300, "the other crate");
});

test("admission: a tutorial ticket uses the tutorial spot, a party drop or no candidate falls back", () => {
  const { m } = world([crate(2400, 1800)], [testPost(0, 2400, 2500)]);
  const rt = enter(m, "newbie", { tutorial: true });
  assert.equal(rt.tutorial, true);
  assert.ok(Math.hypot(rt.pub.x - 2400, rt.pub.y - 1800) < 300);
  const none = worldMatch({ map: testMap() });
  const r2 = enter(none.m, "newbie", { tutorial: true });
  assert.equal(r2.tutorial, false, "no T1 container with a marauder: a normal entry spawn");
});

test("touch flag → exit report; skin → Player.skin", () => {
  const { m, wall } = worldMatch({ map: testMap() });
  const a = enter(m, "phone", { skin: "s-alpha-veteran" });
  const b = enter(m, "desk");
  assert.equal(a.pub.skin, 1);
  assert.equal(b.pub.skin, 0);
  a.touch = true;
  wall.t += 1;
  m.wipe();
  assert.equal(m.exitReports.find((r) => r.userId === "phone")?.touch, true);
  assert.equal(m.exitReports.find((r) => r.userId === "desk")?.touch, undefined);
});
