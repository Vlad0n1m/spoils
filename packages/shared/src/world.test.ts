/**
 * WORLD v6 shared contract (spec §9 T1, T2): cycle clock math and the boss event schedule.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  WORLD,
  cycleEnvSeed,
  extractOpenAtFor,
  mapNumber,
  worldCycleAt,
  worldCycleOf,
  worldPhase,
} from "./constants.js";
import { BOSSES, BOSS_EVENT, bossEventOf } from "./economy.js";
import { BOSS_KINDS, type BossKind } from "./map/types.js";

const MIN = 60_000;

/** Deterministic test hash: FNV-1a over salt + label, then a murmur3 finalizer. */
function testHash(salt: string): (label: string) => number {
  return (label: string) => {
    let h = 0x811c9dc5;
    const s = `${salt}|${label}`;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    h ^= h >>> 16;
    h = Math.imul(h, 0x85ebca6b);
    h ^= h >>> 13;
    h = Math.imul(h, 0xc2b2ae35);
    h ^= h >>> 16;
    return h >>> 0;
  };
}

// ---------------------------------------------------------------- T1 cycle clock

test("T1 cycle config matches the decisions table", () => {
  assert.equal(WORLD.CYCLE_MS, 45 * MIN);
  assert.equal(WORLD.RESET_MS, 20_000);
  assert.equal(WORLD.ENTRY_CLOSE_MS, 10 * MIN);
  assert.deepEqual([...WORLD.WARN_AT_MS], [600_000, 300_000, 60_000]);
  assert.equal(WORLD.CAPACITY, 24);
  assert.equal(WORLD.MAX_SHARDS, 1);
  assert.equal(WORLD.MAX_RUNTIMES_PER_SHARD - WORLD.RUNTIME_HEADROOM, 232);
  assert.equal(WORLD.EXTRACT_ARM_MS, 3 * MIN);
  assert.equal(WORLD.EXTRACT_EARLY_CLOSE_MS, 5 * MIN);
  // A6: ground items 10 min, corpses 15 min, last-minute blink.
  assert.equal(WORLD.GROUND_EXPIRE_MS, 600_000);
  assert.equal(WORLD.CORPSE_EXPIRE_MS, 900_000);
  assert.equal(WORLD.EXPIRE_WARN_MS, 60_000);
  // Geometry is untouched by the cycle fields (one WORLD object).
  assert.equal(WORLD.WIDTH, 24 * 1024);
});

test("T1 worldCycleAt boundaries at k × 45 min; 32 cycles a day aligned to UTC midnight", () => {
  for (const k of [0, 1, 7, 650_000, 657_408]) {
    const at = k * WORLD.CYCLE_MS;
    const c = worldCycleAt(at);
    assert.equal(c.cycle, k);
    assert.equal(c.startAt, at);
    assert.equal(c.wipeAt, at + WORLD.CYCLE_MS);
    assert.equal(worldCycleAt(at - 1).cycle, k - 1, "1 ms before the boundary is the previous cycle");
    assert.equal(worldCycleAt(at + WORLD.CYCLE_MS - 1).cycle, k, "the last ms is still this cycle");
    assert.deepEqual(worldCycleOf(k), c);
  }
  assert.equal(86_400_000 % WORLD.CYCLE_MS, 0);
  assert.equal(86_400_000 / WORLD.CYCLE_MS, 32);
  const day = Date.UTC(2026, 9, 10);
  const first = worldCycleAt(day), last = worldCycleAt(day + 86_400_000 - 1);
  assert.equal(first.startAt, day, "a cycle starts at UTC midnight");
  assert.equal(last.cycle - first.cycle + 1, 32);
  // Wipes at :00 :45 :30 :15.
  const mins = new Set<number>();
  for (let k = first.cycle; k <= last.cycle; k++) mins.add(new Date(worldCycleOf(k).wipeAt).getUTCMinutes());
  assert.deepEqual([...mins].sort((a, b) => a - b), [0, 15, 30, 45]);
});

test("T1 openAt = start + 20 s; entryClosesAt = wipe − 10 min", () => {
  const c = worldCycleAt(Date.UTC(2026, 9, 10, 15, 7, 31));
  assert.equal(c.openAt, c.startAt + 20_000);
  assert.equal(c.entryClosesAt, c.wipeAt - 10 * MIN);
  assert.equal(c.entryClosesAt - c.startAt, 35 * MIN);
  assert.equal(new Date(c.startAt).toISOString(), "2026-10-10T15:00:00.000Z");
});

test("T1 worldPhase edges", () => {
  const c = worldCycleOf(657_000);
  assert.equal(worldPhase(c, c.startAt), "resetting");
  assert.equal(worldPhase(c, c.openAt - 1), "resetting");
  assert.equal(worldPhase(c, c.openAt), "open");
  assert.equal(worldPhase(c, c.entryClosesAt - 1), "open");
  assert.equal(worldPhase(c, c.entryClosesAt), "closing");
  assert.equal(worldPhase(c, c.wipeAt - 1), "closing");
});

test("T1 mapNumber: the epoch cycle is map #1; cycleEnvSeed is a pure uint32", () => {
  const epochCycle = worldCycleAt(WORLD.NUMBER_EPOCH_MS).cycle;
  assert.equal(worldCycleOf(epochCycle).startAt, WORLD.NUMBER_EPOCH_MS, "the epoch is a cycle start");
  assert.equal(mapNumber(epochCycle), 1);
  assert.equal(mapNumber(epochCycle + 31), 32);
  assert.equal(mapNumber(epochCycle - 1), 0, "may be ≤ 0 before the epoch");
  for (const k of [0, 1, epochCycle, 2 ** 31 + 5]) {
    const s = cycleEnvSeed(k);
    assert.ok(Number.isInteger(s) && s >= 0 && s < 2 ** 32);
    assert.equal(s, cycleEnvSeed(k));
    assert.equal(s, (Math.imul(k, 0x9e3779b1) ^ 0x5f0f1a2b) >>> 0);
  }
  assert.notEqual(cycleEnvSeed(1), cycleEnvSeed(2));
});

test("T1 extractOpenAtFor: the later of the map's open time and the personal arm time", () => {
  assert.equal(extractOpenAtFor({ openAt: 0 }, { extractArmAt: 200_000 }), 200_000);
  assert.equal(extractOpenAtFor({ openAt: 300_000 }, { extractArmAt: 200_000 }), 300_000);
  assert.equal(extractOpenAtFor({ openAt: 180_000 }, null), 180_000);
  assert.equal(extractOpenAtFor({ openAt: 180_000 }, undefined), 180_000);
  assert.equal(extractOpenAtFor({ openAt: 0 }, {}), 0);
});

// ---------------------------------------------------------------- T2 boss events

function schedule(hash: (l: string) => number, from: number, n: number): Array<BossKind | null> {
  const out: Array<BossKind | null> = [];
  for (let c = from; c < from + n; c++) out.push(bossEventOf(c, hash));
  return out;
}

function checkProperties(s: Array<BossKind | null>, from: number, kinds: readonly BossKind[]): void {
  const B = BOSS_EVENT.BLOCK_CYCLES;
  assert.equal(((from % B) + B) % B, 0, "start on a block boundary");
  for (let i = 0; i < s.length; i += B) {
    const block = s.slice(i, i + B);
    assert.equal(block.filter((k) => k !== null).length, 1, `exactly one boss map in block at cycle ${from + i}`);
  }
  let prevIdx = -1;
  let prevKind: BossKind | null = null;
  for (let i = 0; i < s.length; i++) {
    const k = s[i];
    if (k === null || k === undefined) continue;
    assert.ok(kinds.includes(k), `only enabled kinds (${k})`);
    if (prevIdx >= 0) {
      const gap = i - prevIdx;
      assert.ok(gap >= 2 && gap <= 5, `gap ${gap} at cycle ${from + i}`);
      if (kinds.length >= 2) assert.notEqual(k, prevKind, `same kind twice in a row at cycle ${from + i}`);
    }
    prevIdx = i;
    prevKind = k;
  }
}

test("T2 bossEventOf over 10 000 cycles: one per block, never adjacent, no repeats, each kind ≈ 1/3", () => {
  const kinds = BOSS_KINDS.filter((k) => BOSSES[k].enabled);
  assert.equal(kinds.length, 3, "all three bosses enabled at launch");
  for (const salt of ["a", "b", "world-secret"]) {
    const from = 657_000; // a block boundary near 2026
    const s = schedule(testHash(salt), from, 10_002);
    checkProperties(s, from, kinds);
    const bosses = s.filter((k): k is BossKind => k !== null);
    for (const k of kinds) {
      const share = bosses.filter((b) => b === k).length / bosses.length;
      assert.ok(share >= 0.3 && share <= 0.37, `${k} share ${share.toFixed(3)} (salt ${salt})`);
    }
  }
});

test("T2 bossEventOf works across cycle 0 and negative cycles", () => {
  const kinds = BOSS_KINDS.filter((k) => BOSSES[k].enabled);
  const s = schedule(testHash("neg"), -300, 600);
  checkProperties(s, -300, kinds);
});

test("T2 deterministic per hash; different hashes give different schedules", () => {
  const a1 = schedule(testHash("x"), 657_000, 300);
  const a2 = schedule(testHash("x"), 657_000, 300);
  const b = schedule(testHash("y"), 657_000, 300);
  assert.deepEqual(a1, a2);
  assert.notDeepEqual(a1, b);
  // Pure in (cycle, hash): asking in any order gives the same answer.
  const h = testHash("x");
  assert.equal(bossEventOf(657_123, h), a1[123]);
});

test("T2 disabled kinds are skipped (two kinds alternate, one kind every boss map, none → null)", () => {
  const mut = BOSSES as unknown as Record<BossKind, { enabled: boolean }>;
  const saved = BOSS_KINDS.map((k) => mut[k].enabled);
  try {
    mut.warden.enabled = false;
    const two = schedule(testHash("two"), 657_000, 3_000);
    checkProperties(two, 657_000, ["foreman", "commander"]);
    assert.ok(!two.includes("warden"));
    const bosses2 = two.filter((k) => k !== null);
    const f = bosses2.filter((k) => k === "foreman").length / bosses2.length;
    assert.ok(f >= 0.45 && f <= 0.55, `foreman share ${f}`);

    mut.commander.enabled = false;
    const one = schedule(testHash("one"), 657_000, 300);
    checkProperties(one, 657_000, ["foreman"]);
    assert.deepEqual([...new Set(one.filter((k) => k !== null))], ["foreman"]);

    mut.foreman.enabled = false;
    assert.ok(schedule(testHash("none"), 657_000, 30).every((k) => k === null));
  } finally {
    BOSS_KINDS.forEach((k, i) => (mut[k].enabled = saved[i]!));
  }
});
