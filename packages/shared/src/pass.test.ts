/**
 * Alpha Pass (GAME_DESIGN.md §18e): tiers, weekly task rolls and progress, tester tasks from exit
 * facts, survey parsing, granted cosmetics, and the ticket payload's alpha extras.
 * Run: apps/game-server/node_modules/.bin/tsx --test packages/shared/src/pass.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { COSMETICS, cosmeticDef, cosmeticUnlock, cosmeticUnlocked, unlockedCosmetics } from "./economy.js";
import {
  ALPHA_SKIN,
  ALPHA_TROPHY,
  FOUNDER_BADGE,
  INVITE_REWARD,
  PASS,
  PASS_TIERS,
  TESTER_TASKS,
  WEEKLY_POOL,
  applyWeeklyExit,
  nextPassTier,
  parseSurvey,
  passTierOf,
  passWeek,
  passWeekResetAt,
  rollWeekly,
  rollWeeklyTasks,
  testerDoneByExit,
  weeklyNext,
  type PassExitFacts,
  type WeeklySlotState,
} from "./pass.js";
import { joinTicketPayload } from "./types.js";

const MIN = 60_000;
const U1 = "8d3b1c1e-6a51-4c55-9a43-0d1f0e2f4a11";
const facts = (o: Partial<PassExitFacts> = {}): PassExitFacts => ({
  exit: "extract",
  onMapMs: 9 * MIN,
  containers: 0,
  bodies: 0,
  marauders: 0,
  guards: 0,
  bosses: 0,
  epicExtracted: false,
  party: false,
  touch: false,
  ...o,
});

test("the track: 10 tiers, AP ascending, the owner's rewards at tiers 1/3/5/8/10, all granted cosmetics", () => {
  assert.equal(PASS_TIERS.length, 10);
  assert.deepEqual(PASS_TIERS.map((t) => t.tier), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  for (let i = 1; i < PASS_TIERS.length; i++) assert.ok(PASS_TIERS[i]!.ap > PASS_TIERS[i - 1]!.ap);
  const at = (n: number) => cosmeticDef(PASS_TIERS[n - 1]!.reward)!;
  assert.equal(at(1).name, "Alpha Raider");
  assert.equal(at(1).kind, "title");
  assert.equal(at(3).name, "Founder");
  assert.equal(at(3).kind, "frame");
  assert.equal(at(5).kind, "color");
  assert.equal(at(8).id, ALPHA_SKIN);
  assert.equal(at(8).name, "Alpha Veteran");
  assert.equal(at(10).id, FOUNDER_BADGE);
  assert.equal(at(10).kind, "badge");
  for (const t of PASS_TIERS) assert.equal(cosmeticDef(t.reward)?.grant, "pass", t.reward);
  assert.equal(cosmeticDef(ALPHA_TROPHY.reward)?.grant, "trophy");
  assert.equal(cosmeticDef(INVITE_REWARD)?.grant, "invite");
  // The tutorial alone reaches tier 1.
  assert.equal(TESTER_TASKS.find((t) => t.id === "tutorial")!.ap, PASS_TIERS[0]!.ap);
});

test("tiers from AP", () => {
  assert.equal(passTierOf(0), 0);
  assert.equal(passTierOf(29), 0);
  assert.equal(passTierOf(30), 1);
  assert.equal(passTierOf(819), 9);
  assert.equal(passTierOf(10_000), 10);
  assert.equal(passTierOf(Number.NaN), 0);
  assert.deepEqual(nextPassTier(0), PASS_TIERS[0]);
  assert.deepEqual(nextPassTier(140), PASS_TIERS[3]);
  assert.equal(nextPassTier(820), null);
});

test("granted cosmetics are owned only through the granted set, never by level or marks", () => {
  assert.deepEqual(cosmeticUnlock("f-founder"), { by: "grant", at: 0 });
  assert.equal(cosmeticUnlocked("f-founder", 99, 999), false);
  assert.equal(cosmeticUnlocked("f-founder", 1, 0, new Set(["f-founder"])), true);
  assert.equal(cosmeticUnlocked("t-raider", 5, 0, new Set()), true, "level rewards unchanged");
  assert.deepEqual(unlockedCosmetics(1, 0, ["t-alpha-raider", "nope", "t-raider"]), ["t-alpha-raider"]);
  const all = Object.keys(COSMETICS).length;
  assert.equal(unlockedCosmetics(30, 100, Object.keys(COSMETICS)).length, all);
});

test("weeks turn at Monday 00:00 UTC", () => {
  assert.equal(passWeek(Date.UTC(2026, 9, 5, 0, 0, 0)), "2026-10-05"); // a Monday
  assert.equal(passWeek(Date.UTC(2026, 9, 11, 23, 59, 59)), "2026-10-05"); // Sunday
  assert.equal(passWeek(Date.UTC(2026, 9, 12, 0, 0, 0)), "2026-10-12");
  assert.equal(passWeek(Date.UTC(2026, 9, 4, 12)), "2026-09-28");
  assert.equal(passWeekResetAt(Date.UTC(2026, 9, 7, 8)), Date.UTC(2026, 9, 12));
});

test("weekly rolls: deterministic, three different tasks, change with the week", () => {
  const a = rollWeeklyTasks(U1, "2026-10-05");
  assert.deepEqual(a, rollWeeklyTasks(U1, "2026-10-05"));
  assert.equal(new Set(a).size, PASS.WEEKLY_SLOTS);
  assert.equal(rollWeekly(U1.toUpperCase(), "2026-10-05", 0), a[0]);
  let differs = false;
  for (let w = 0; w < 8; w++) {
    const wk = new Date(Date.UTC(2026, 9, 12 + 7 * w)).toISOString().slice(0, 10);
    if (rollWeeklyTasks(U1, wk).join() !== a.join()) differs = true;
  }
  assert.ok(differs);
  assert.equal(new Set(WEEKLY_POOL.map((q) => q.id)).size, WEEKLY_POOL.length);
});

test("weekly progress per task", () => {
  assert.equal(weeklyNext("w_boss", 0, facts({ exit: "dead", bosses: 1 })), 1, "a boss kill counts even on death");
  assert.equal(weeklyNext("w_epic", 0, facts({ epicExtracted: true })), 1);
  assert.equal(weeklyNext("w_epic", 0, facts({ exit: "dead", epicExtracted: true })), 0);
  assert.equal(weeklyNext("w_extract5", 2, facts()), 3);
  assert.equal(weeklyNext("w_extract5", 2, facts({ onMapMs: 7 * MIN })), 2, "short extract");
  assert.equal(weeklyNext("w_marauders15", 3, facts({ exit: "mia", marauders: 4 })), 7);
  assert.equal(weeklyNext("w_guards3", 0, facts({ guards: 2 })), 2);
  assert.equal(weeklyNext("w_containers40", 1, facts({ containers: 5 })), 6);
  assert.equal(weeklyNext("w_containers40", 1, facts({ exit: "mia", containers: 5 })), 1);
  assert.equal(weeklyNext("w_bodies8", 0, facts({ bodies: 2 })), 2);
});

test("survive 3 raids in a row: extracts build the streak, a death or MIA resets it, a short extract keeps it", () => {
  assert.equal(weeklyNext("w_streak3", 0, facts()), 1);
  assert.equal(weeklyNext("w_streak3", 2, facts({ exit: "dead" })), 0);
  assert.equal(weeklyNext("w_streak3", 2, facts({ exit: "mia" })), 0);
  assert.equal(weeklyNext("w_streak3", 2, facts({ onMapMs: 2 * MIN })), 2);
  const s: WeeklySlotState[] = [{ slot: 0, id: "w_streak3", need: 3, progress: 0, done: false }];
  let cur = s;
  const seq: PassExitFacts["exit"][] = ["extract", "extract", "dead", "extract", "extract", "extract"];
  const finished: number[] = [];
  seq.forEach((e, i) => {
    const r = applyWeeklyExit(cur, facts({ exit: e }));
    cur = r.slots;
    if (r.finished.length) finished.push(i);
  });
  assert.deepEqual(finished, [5]);
  assert.equal(cur[0]!.progress, 3);
  // A finished slot never moves again.
  assert.equal(applyWeeklyExit(cur, facts({ exit: "dead" })).slots[0]!.progress, 3);
});

test("weekly progress is capped at need and finishes once", () => {
  const s: WeeklySlotState[] = [
    { slot: 0, id: "w_marauders15", need: 15, progress: 13, done: false },
    { slot: 1, id: "w_guards3", need: 3, progress: 0, done: false },
  ];
  const r = applyWeeklyExit(s, facts({ marauders: 9, guards: 1 }));
  assert.equal(r.slots[0]!.progress, 15);
  assert.equal(r.slots[0]!.done, true);
  assert.equal(r.slots[1]!.progress, 1);
  assert.deepEqual(r.finished.map((x) => x.slot), [0]);
});

test("tester tasks from a settled exit", () => {
  assert.deepEqual(testerDoneByExit(facts()), []);
  assert.deepEqual(testerDoneByExit(facts({ containers: 1, marauders: 1 })), ["tutorial"]);
  assert.deepEqual(testerDoneByExit(facts({ exit: "dead", containers: 1, marauders: 1 })), [], "the tutorial ends with an extract");
  assert.deepEqual(testerDoneByExit(facts({ containers: 2, guards: 1, onMapMs: 1 * MIN })), ["tutorial"], "no minimum time");
  assert.deepEqual(testerDoneByExit(facts({ exit: "dead", party: true, touch: true, onMapMs: 4 * MIN })), ["party", "touch"]);
  assert.deepEqual(testerDoneByExit(facts({ party: true, touch: true, onMapMs: 2 * MIN })), [], "drop-and-leave does not count");
});

test("survey answers: every choice question answered with a listed choice, free text trimmed", () => {
  assert.equal(parseSurvey(null), null);
  assert.equal(parseSurvey({ device: "Phone", fun: "4" }), null);
  assert.equal(parseSurvey({ device: "Tablet", fun: "4", fix: "Loot" }), null);
  assert.deepEqual(parseSurvey({ device: "Phone", fun: "4", fix: "Loot", note: "  " }), { device: "Phone", fun: "4", fix: "Loot" });
  const long = parseSurvey({ device: "Both", fun: "5", fix: "Other", note: "x".repeat(900) })!;
  assert.equal(long.note!.length, 300);
});

test("join ticket payload: alpha extras are signed only when present", () => {
  const base = { userId: "u", nickname: "n", issuedAt: 5, loadoutId: "L", matchId: "m", entryId: "e" };
  assert.equal(joinTicketPayload(base), "u.n.5.L.m.e");
  assert.equal(joinTicketPayload({ ...base, tutorial: true }), "u.n.5.L.m.e|x.1.");
  assert.equal(joinTicketPayload({ ...base, skin: "s-alpha-veteran" }), "u.n.5.L.m.e|x.0.s-alpha-veteran");
  assert.equal(joinTicketPayload({ ...base, partyId: "p", dropId: "d", dropSize: 2, tutorial: true }), "u.n.5.L.m.e.d.p.2|x.1.");
  assert.notEqual(joinTicketPayload({ ...base, tutorial: true }), joinTicketPayload(base));
});
