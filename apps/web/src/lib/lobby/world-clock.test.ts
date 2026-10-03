/**
 * T23 lobby clock (WORLD v6 spec §6.4–§6.5): server offset with the CDN Age header, the phase
 * fallback from the cycle clock, countdown and local-time formatting; plus the menu's small pure
 * helpers (level colours and unlocks, the News dot).
 * Run: apps/game-server/node_modules/.bin/tsx --test apps/web/src/lib/lobby/world-clock.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BOUND_OFFERS, MARKET, WORLD, boundTraderLevel, worldCycleOf, type WorldStatusDto } from "@extract/shared";
import { clockOffsetMs, fmtClockS, fmtLocalHm, parseAgeSec, secsUntil, worldView } from "./world-clock";
import { levelColor, levelUnlocks, unlocksBetween } from "./levels";
import { hasUnseenNews, parseNewsSeen } from "./news-seen";

const K = 650_000;
const C = worldCycleOf(K);
const at = (min: number, sec = 0) => C.startAt + min * 60_000 + sec * 1000;

function status(over: Partial<WorldStatusDto> = {}): WorldStatusDto {
  return {
    v: 1,
    serverTime: at(5),
    cycle: K,
    mapNumber: 1,
    phase: "open",
    openAt: C.openAt,
    entryClosesAt: C.entryClosesAt,
    wipeAt: C.wipeAt,
    online: true,
    humans: 17,
    capacity: 24,
    boss: null,
    next: { cycle: K + 1, mapNumber: 2, openAt: worldCycleOf(K + 1).openAt },
    last: null,
    ...over,
  };
}

describe("clock offset", () => {
  it("serverTime + Age − local now", () => {
    assert.equal(clockOffsetMs(1_000_000, null, 1_000_000), 0);
    assert.equal(clockOffsetMs(1_000_000, "3", 990_000), 13_000);
    assert.equal(clockOffsetMs(1_000_000, 4, 1_010_000), -6_000);
  });
  it("a missing or garbage Age counts as 0; a bogus serverTime gives no offset", () => {
    assert.equal(parseAgeSec(undefined), 0);
    assert.equal(parseAgeSec(""), 0);
    assert.equal(parseAgeSec("abc"), 0);
    assert.equal(parseAgeSec("-5"), 0);
    assert.equal(parseAgeSec(" 7 "), 7);
    assert.equal(clockOffsetMs(1_000_000, "x", 999_000), 1_000);
    assert.equal(clockOffsetMs(0, "3", 999_000), 0);
    assert.equal(clockOffsetMs(Number.NaN, null, 999_000), 0);
  });
});

describe("worldView", () => {
  it("without a status the phase and countdowns come from the cycle clock", () => {
    const v = worldView(null, at(0, 5));
    assert.equal(v.cycle, K);
    assert.equal(v.phase, "resetting");
    assert.equal(v.entryOpensAt, C.openAt);
    assert.equal(v.armCycle, K);
    assert.equal(v.online, null);
    assert.equal(v.humans, null);
    assert.equal(v.fresh, false);
    assert.equal(v.capacity, WORLD.CAPACITY * WORLD.MAX_SHARDS);

    const open = worldView(null, at(12));
    assert.equal(open.phase, "open");
    assert.equal(open.wipeAt, C.wipeAt);

    const closing = worldView(null, at(36));
    assert.equal(closing.phase, "closing");
    assert.equal(closing.entryOpensAt, worldCycleOf(K + 1).openAt);
    assert.equal(closing.armCycle, K + 1);
  });

  it("a status of the current cycle adds online and humans; a stale one is ignored", () => {
    const v = worldView(status(), at(12));
    assert.equal(v.fresh, true);
    assert.equal(v.online, true);
    assert.equal(v.humans, 17);
    const stale = worldView(status({ cycle: K - 1, online: false }), at(12));
    assert.equal(stale.fresh, false);
    assert.equal(stale.online, null);
    assert.equal(stale.humans, null);
    // The clock wins over the status phase (a cached status from just before the wipe).
    const rolled = worldView(status({ phase: "closing" }), C.wipeAt + 1_000);
    assert.equal(rolled.cycle, K + 1);
    assert.equal(rolled.phase, "resetting");
  });

  it("cycle bar positions", () => {
    assert.equal(worldView(null, C.startAt).elapsed, 0);
    assert.equal(worldView(null, at(22, 30)).elapsed, 0.5);
    assert.equal(worldView(null, at(1)).closeMark, 35 / 45);
  });
});

describe("formatting", () => {
  it("fmtClockS is m:ss, rounded up, never negative", () => {
    assert.equal(fmtClockS(0), "0:00");
    assert.equal(fmtClockS(14), "0:14");
    assert.equal(fmtClockS(462), "7:42");
    assert.equal(fmtClockS(1872), "31:12");
    assert.equal(fmtClockS(-3), "0:00");
    assert.equal(fmtClockS(59.2), "1:00");
    assert.equal(fmtClockS(Number.NaN), "0:00");
  });
  it("secsUntil rounds up", () => {
    assert.equal(secsUntil(10_001, 0), 11);
    assert.equal(secsUntil(5, 10), 0);
  });
  it("fmtLocalHm is a 24 h HH:mm in the given zone", () => {
    assert.equal(fmtLocalHm(Date.UTC(2026, 9, 6, 15, 0), { timeZone: "UTC" }), "15:00");
    assert.equal(fmtLocalHm(Date.UTC(2026, 9, 6, 9, 5), { timeZone: "UTC" }), "09:05");
  });
});

describe("levels", () => {
  it("badge colours by level band", () => {
    assert.equal(levelColor(1), "#cbd5e1");
    assert.equal(levelColor(4), "#cbd5e1");
    assert.equal(levelColor(5), "#CCFF00");
    assert.equal(levelColor(10), "#4cc9ff");
    assert.equal(levelColor(15), "#b07bff");
    assert.equal(levelColor(20), "#ffc93c");
    assert.equal(levelColor(77), "#ffc93c");
  });
  it("unlocks: market selling at the sell level, each new bound-trader tier with offers", () => {
    assert.ok(levelUnlocks(MARKET.SELL_UNLOCK_LEVEL).includes("Market selling unlocked"));
    assert.ok(levelUnlocks(MARKET.SELL_UNLOCK_LEVEL, 1).every((s) => s !== "Market selling unlocked"));
    // Follows boundTraderLevel exactly: a line on the first level of every tier that has offers.
    for (let l = 2; l <= 30; l++) {
      const tier = boundTraderLevel(l);
      const fresh = tier > boundTraderLevel(l - 1) && BOUND_OFFERS.some((o) => o.traderLevel === tier);
      assert.equal(levelUnlocks(l).some((s) => s.startsWith(`Traders tier ${tier}: `)), fresh, `level ${l}`);
    }
    assert.deepEqual(levelUnlocks(1), []);
    const tier2 = Array.from({ length: 30 }, (_, i) => i + 2).find((l) => boundTraderLevel(l) === 2)!;
    assert.match(levelUnlocks(tier2).join(" | "), /Traders tier 2: Assault rifle/);
    assert.deepEqual(unlocksBetween(1, 30), Array.from({ length: 29 }, (_, i) => levelUnlocks(i + 2)).flat());
    assert.deepEqual(unlocksBetween(7, 7), []);
  });
});

describe("news dot", () => {
  it("lights for an unseen patch or a newer boss event", () => {
    assert.equal(hasUnseenNews(null, "p1", null), true);
    assert.equal(hasUnseenNews(null, null, null), false);
    assert.equal(hasUnseenNews({ patch: "p1", event: 100 }, "p1", 50), false);
    assert.equal(hasUnseenNews({ patch: "p1", event: 100 }, "p1", 150), true);
    assert.equal(hasUnseenNews({ patch: "p0", event: 100 }, "p1", null), true);
  });
  it("parses stored markers defensively", () => {
    assert.equal(parseNewsSeen(null), null);
    assert.equal(parseNewsSeen("{bad json"), null);
    assert.equal(parseNewsSeen("42"), null);
    assert.deepEqual(parseNewsSeen('{"patch":"p1","event":5}'), { patch: "p1", event: 5 });
    assert.deepEqual(parseNewsSeen('{"patch":7,"event":"x"}'), { patch: null, event: 0 });
  });
});
