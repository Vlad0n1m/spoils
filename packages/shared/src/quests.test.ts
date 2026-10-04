/**
 * Daily tasks (RETENTION.md §5.1) and the level reward table (§3): roll determinism per (user, day),
 * progress from exit facts, the daily XP cap, and the cosmetic tables.
 * Run: apps/game-server/node_modules/.bin/tsx --test packages/shared/src/quests.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  COSMETICS,
  LEVEL_REWARDS,
  MARK_REWARDS,
  XP,
  XP_LINE_LABEL,
  cosmeticDef,
  cosmeticUnlock,
  cosmeticUnlocked,
  levelRewardIds,
  nextLevelReward,
  nextMarkReward,
  unlockedCosmetics,
} from "./economy.js";
import {
  QUEST,
  QUEST_POOL,
  applyQuestExit,
  fillQuestSlots,
  questDay,
  questDef,
  questResetAt,
  questStep,
  questXpRoom,
  rollDailyQuests,
  rollQuest,
  type QuestExitFacts,
  type QuestSlotState,
} from "./quests.js";

const MIN = 60_000;
const U1 = "8d3b1c1e-6a51-4c55-9a43-0d1f0e2f4a11";
const U2 = "0b7f6f0a-2c1e-4d7b-8f55-3e1a9c4d5e22";
const facts = (o: Partial<QuestExitFacts> = {}): QuestExitFacts => ({
  exit: "extract",
  onMapMs: 9 * MIN,
  haulCr: 0,
  containers: 0,
  marauders: 0,
  bodies: 0,
  ...o,
});

test("the pool follows RETENTION.md §5.1: six tasks, 100 XP each, weights 3/3/3/2/2/2", () => {
  assert.equal(QUEST_POOL.length, 6);
  assert.equal(new Set(QUEST_POOL.map((q) => q.id)).size, 6);
  for (const q of QUEST_POOL) {
    assert.equal(q.xp, QUEST.XP, q.id);
    assert.ok(q.need >= 1 && q.label.length > 0 && q.short.length > 0 && q.hint.length > 0, q.id);
  }
  assert.deepEqual(
    Object.fromEntries(QUEST_POOL.map((q) => [q.id, [q.need, q.weight]])),
    {
      extract_twice: [2, 3],
      containers_10: [10, 3],
      marauders_3: [3, 3],
      junk_300: [1, 2],
      bodies_2: [2, 2],
      long_stay: [1, 2],
    },
  );
  assert.equal(QUEST.SLOTS * QUEST.XP, QUEST.DAILY_XP_MAX);
  assert.equal(questDef("nope"), null);
  assert.equal(XP_LINE_LABEL.quest, "Daily task");
});

test("rolls are deterministic per (user, day, slot) and three slots never repeat a task", () => {
  const day = "2026-10-04";
  const a = rollDailyQuests(U1, day);
  assert.deepEqual(rollDailyQuests(U1, day), a, "same user, same day → same tasks");
  assert.deepEqual(rollDailyQuests(U1.toUpperCase(), day), a, "the user id is case-insensitive");
  assert.equal(a.length, QUEST.SLOTS);
  assert.equal(new Set(a).size, QUEST.SLOTS, "no duplicates");
  for (const id of a) assert.ok(questDef(id));
  // Over many users and days every task shows up, and the sets vary.
  const seen = new Set<string>();
  const sets = new Set<string>();
  for (let d = 1; d <= 20; d++) {
    for (let u = 0; u < 30; u++) {
      const q = rollDailyQuests(`user-${u}`, `2026-10-${String(d).padStart(2, "0")}`);
      assert.equal(new Set(q).size, QUEST.SLOTS);
      q.forEach((id) => seen.add(id));
      sets.add([...q].sort().join(","));
    }
  }
  assert.equal(seen.size, QUEST_POOL.length);
  assert.ok(sets.size > 5, `${sets.size} distinct task sets`);
  // A different user or day is a different seed.
  let differs = 0;
  for (let d = 1; d <= 10; d++) {
    const day2 = `2026-11-${String(d).padStart(2, "0")}`;
    if (rollDailyQuests(U1, day2).join() !== rollDailyQuests(U2, day2).join()) differs++;
  }
  assert.ok(differs >= 5, `${differs}/10 days differ between two users`);
});

test("weights: the weight-3 tasks come up more often than the weight-2 ones", () => {
  const n: Record<string, number> = {};
  for (let u = 0; u < 4_000; u++) {
    const id = rollQuest(`w-${u}`, "2026-10-04", 0);
    n[id] = (n[id] ?? 0) + 1;
  }
  const heavy = (n.extract_twice! + n.containers_10! + n.marauders_3!) / 3;
  const light = (n.junk_300! + n.bodies_2! + n.long_stay!) / 3;
  assert.ok(heavy / light > 1.25 && heavy / light < 1.8, `ratio ${heavy / light}`);
});

test("fill keeps carried tasks and fills only empty slots; a swap excludes every current task", () => {
  const day = "2026-10-05";
  const filled = fillQuestSlots(U1, day, ["bodies_2", null, "long_stay"]);
  assert.equal(filled[0], "bodies_2");
  assert.equal(filled[2], "long_stay");
  assert.ok(!["bodies_2", "long_stay"].includes(filled[1]!));
  assert.deepEqual(fillQuestSlots(U1, day, ["bodies_2", null, "long_stay"]), filled);
  const swap = rollQuest(U1, day, 1, filled, 1);
  assert.ok(!filled.includes(swap), "a swap never gives a task already on the board");
  assert.equal(rollQuest(U1, day, 1, filled, 1), swap);
  // Only one task left outside the exclusion → that one.
  const others = QUEST_POOL.map((q) => q.id).filter((id) => id !== "junk_300");
  assert.equal(rollQuest(U2, day, 0, others, 1), "junk_300");
});

test("days turn at 00:00 UTC", () => {
  const t = Date.UTC(2026, 9, 4, 23, 59, 59, 999);
  assert.equal(questDay(t), "2026-10-04");
  assert.equal(questDay(t + 1), "2026-10-05");
  assert.equal(questResetAt(t), Date.UTC(2026, 9, 5));
  assert.equal(questResetAt(Date.UTC(2026, 9, 5)), Date.UTC(2026, 9, 6));
});

test("progress from exit facts uses the XP counters", () => {
  // Extracts count after 8 minutes only.
  assert.equal(questStep("extract_twice", facts({ onMapMs: XP.MIN_ONMAP_MS - 1 })), 0);
  assert.equal(questStep("extract_twice", facts({ onMapMs: XP.MIN_ONMAP_MS })), 1);
  assert.equal(questStep("extract_twice", facts({ exit: "dead", onMapMs: 20 * MIN })), 0);
  // 12+ minutes.
  assert.equal(questStep("long_stay", facts({ onMapMs: 12 * MIN - 1 })), 0);
  assert.equal(questStep("long_stay", facts({ onMapMs: 12 * MIN })), 1);
  assert.equal(questStep("long_stay", facts({ exit: "mia", onMapMs: 30 * MIN })), 0);
  // Junk: a qualifying extract with ≥ 300 CR.
  assert.equal(questStep("junk_300", facts({ haulCr: 299 })), 0);
  assert.equal(questStep("junk_300", facts({ haulCr: 300 })), 1);
  assert.equal(questStep("junk_300", facts({ haulCr: 900, onMapMs: 7 * MIN })), 0, "before 8 min");
  assert.equal(questStep("junk_300", facts({ haulCr: 900, exit: "dead" })), 0);
  // Containers: capped like XP, nothing for MIA, deaths count.
  assert.equal(questStep("containers_10", facts({ containers: 4 })), 4);
  assert.equal(questStep("containers_10", facts({ containers: 99 })), XP.CONTAINER_MAX);
  assert.equal(questStep("containers_10", facts({ exit: "dead", containers: 4 })), 4);
  assert.equal(questStep("containers_10", facts({ exit: "mia", containers: 4 })), 0);
  assert.equal(questStep("bodies_2", facts({ exit: "dead", bodies: 1 })), 1);
  assert.equal(questStep("bodies_2", facts({ exit: "mia", bodies: 3 })), 0);
  // Kills count on any exit, MIA included (as in XP).
  assert.equal(questStep("marauders_3", facts({ exit: "mia", marauders: 2 })), 2);
  // Junk input never breaks the math.
  assert.equal(questStep("marauders_3", facts({ marauders: Number.NaN })), 0);
  assert.equal(questStep("containers_10", facts({ containers: -5 })), 0);
  assert.equal(questStep("extract_twice", facts({ onMapMs: Number.POSITIVE_INFINITY })), 0);
});

test("applyQuestExit: progress caps at need, done slots stay, awards pay XP once", () => {
  const slots: QuestSlotState[] = [
    { slot: 0, id: "containers_10", need: 10, xp: 100, progress: 7, done: false },
    { slot: 1, id: "marauders_3", need: 3, xp: 100, progress: 0, done: false },
    { slot: 2, id: "long_stay", need: 1, xp: 100, progress: 1, done: true },
  ];
  const r = applyQuestExit(slots, facts({ containers: 8, marauders: 1, onMapMs: 15 * MIN }), 0);
  assert.deepEqual(r.slots.map((s) => [s.progress, s.done]), [[10, true], [1, false], [1, true]]);
  assert.deepEqual(r.awards, [{ slot: 0, id: "containers_10", xp: 100 }]);
  assert.equal(r.xp, 100);
  assert.equal(slots[0]!.progress, 7, "input untouched");
  // Nothing new: no awards.
  const again = applyQuestExit(r.slots, facts({ marauders: 1 }), 100);
  assert.equal(again.xp, 0);
  assert.equal(again.awards.length, 0);
  assert.equal(again.slots[1]!.progress, 2);
});

test("task XP never passes QUEST.DAILY_XP_MAX a day", () => {
  assert.equal(questXpRoom(0), 100);
  assert.equal(questXpRoom(200), 100);
  assert.equal(questXpRoom(250), 50);
  assert.equal(questXpRoom(300), 0);
  assert.equal(questXpRoom(999), 0);
  assert.equal(questXpRoom(Number.NaN), 100);
  assert.equal(questXpRoom(0, 500), QUEST.DAILY_XP_MAX, "even a larger task stays under the day's max");
  // Three tasks done by one exit after 250 XP today: 50, then 0, 0.
  const slots: QuestSlotState[] = [
    { slot: 0, id: "extract_twice", need: 2, xp: 100, progress: 1, done: false },
    { slot: 1, id: "long_stay", need: 1, xp: 100, progress: 0, done: false },
    { slot: 2, id: "junk_300", need: 1, xp: 100, progress: 0, done: false },
  ];
  const r = applyQuestExit(slots, facts({ onMapMs: 20 * MIN, haulCr: 500 }), 250);
  assert.deepEqual(r.awards.map((a) => a.xp), [50, 0, 0]);
  assert.equal(r.xp, 50);
  assert.ok(r.slots.every((s) => s.done));
  // A full fresh day: 3 tasks pay exactly 300.
  const full = applyQuestExit(slots, facts({ onMapMs: 20 * MIN, haulCr: 500 }), 0);
  assert.equal(full.xp, QUEST.DAILY_XP_MAX);
});

test("level reward table (RETENTION.md §3): every cosmetic listed once, ids known, kinds sane", () => {
  const listed = [...LEVEL_REWARDS.flatMap((r) => r.ids), ...MARK_REWARDS.flatMap((r) => r.ids)];
  assert.equal(new Set(listed).size, listed.length, "no id twice");
  const granted = Object.values(COSMETICS).filter((c) => c.grant).map((c) => c.id);
  assert.deepEqual(new Set([...listed, ...granted]), new Set(Object.keys(COSMETICS)), "every cosmetic has an unlock");
  assert.ok(listed.every((id) => !granted.includes(id)), "a granted cosmetic is never also reached");
  for (const id of listed) {
    const d = cosmeticDef(id)!;
    assert.ok(d, id);
    assert.equal(d.id, id);
    if (d.kind === "color") assert.match(d.hex ?? "", /^#[0-9a-f]{6}$/, id);
    if (d.kind === "frame") assert.ok(d.hex && d.style, id);
  }
  const lv = LEVEL_REWARDS.map((r) => r.level);
  assert.deepEqual(lv, [...lv].sort((a, b) => a - b), "levels ascending");
  assert.deepEqual(lv, [2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 14, 15, 17, 20, 25, 30]);
  assert.deepEqual(MARK_REWARDS.map((r) => r.marks), [10, 25, 50, 100]);
  assert.deepEqual(levelRewardIds(5), ["t-raider", "c-lime"]);
  assert.deepEqual(levelRewardIds(20), ["t-legend", "c-gold", "f-gilded"]);
  assert.deepEqual(levelRewardIds(11), []);
  assert.equal(cosmeticDef("t-legend")!.name, "Legend of the Outskirts");
  assert.equal(cosmeticDef("__proto__"), null);
  assert.equal(cosmeticDef(42), null);
});

test("unlocks by level and by marks", () => {
  assert.deepEqual(cosmeticUnlock("f-rope"), { by: "level", at: 3 });
  assert.deepEqual(cosmeticUnlock("t-fixer"), { by: "marks", at: 50 });
  assert.equal(cosmeticUnlock("nope"), null);
  assert.equal(cosmeticUnlocked("t-raider", 4, 999), false, "marks never unlock level rewards");
  assert.equal(cosmeticUnlocked("t-raider", 5, 0), true);
  assert.equal(cosmeticUnlocked("c-contract", 30, 9), false, "levels never unlock mark rewards");
  assert.equal(cosmeticUnlocked("c-contract", 1, 10), true);
  assert.equal(cosmeticUnlocked("unknown", 99, 999), false);
  assert.equal(cosmeticUnlocked("t-raider", Number.NaN, 0), false);
  assert.deepEqual(unlockedCosmetics(1, 0), []);
  assert.deepEqual(unlockedCosmetics(4, 10), ["t-scavenger", "f-rope", "c-sand", "c-contract"]);
  assert.equal(unlockedCosmetics(30, 100).length, Object.values(COSMETICS).filter((c) => !c.grant).length);
  assert.deepEqual(nextLevelReward(1), { level: 2, ids: ["t-scavenger"] });
  assert.deepEqual(nextLevelReward(10), { level: 12, ids: ["f-steel"] });
  assert.equal(nextLevelReward(30), null);
  assert.deepEqual(nextMarkReward(0), { marks: 10, ids: ["c-contract"] });
  assert.equal(nextMarkReward(100), null);
});
