/**
 * Run: apps/game-server/node_modules/.bin/tsx --test apps/web/src/components/matchmaking-queue.test.ts
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MATCH, mmShouldLaunch } from "@extract/shared";
import { fmtQueueClock, queueLine, queueStatus, readQueueState, type QueueView } from "./matchmaking-queue";

const NOW = 1_800_000_000_000;

function view(players: number, openedAgoMs: number, launching = false): QueueView {
  const openedAt = NOW - openedAgoMs;
  return { players, openedAt, deadlineAt: openedAt + MATCH.QUEUE_WINDOW_MS, launching };
}

describe("readQueueState", () => {
  it("reads the humans-only queue state", () => {
    const v = readQueueState(
      { players: { length: 3 }, startedAt: NOW - 5000, deadlineAt: NOW + 40_000, status: "waiting" },
      NOW + 45_000,
      NOW,
    );
    assert.deepEqual(v, { players: 3, openedAt: NOW - 5000, deadlineAt: NOW + 40_000, launching: false });
  });

  it("reads the synced count (MmState.queued: the server never syncs who is queued)", () => {
    const v = readQueueState({ queued: 5, startedAt: NOW - 1000, deadlineAt: NOW + 30_000, status: "waiting" }, NOW + 45_000, NOW);
    assert.equal(v.players, 5);
  });

  it("degrades missing or skewed fields to the fallback", () => {
    const v = readQueueState({ players: { size: 2 }, deadlineAt: NOW + 10 * MATCH.QUEUE_WINDOW_MS, status: "started" }, NOW + 45_000, NOW);
    assert.deepEqual(v, { players: 2, openedAt: 0, deadlineAt: NOW + 45_000, launching: true });
    assert.deepEqual(readQueueState(null, NOW + 1, NOW), { players: 0, openedAt: 0, deadlineAt: NOW + 1, launching: false });
    // A reset window (startedAt 0, deadlineAt 0) uses the fallback.
    assert.equal(readQueueState({ players: [], startedAt: 0, deadlineAt: 0 }, NOW + 7, NOW).deadlineAt, NOW + 7);
  });
});

describe("queueStatus", () => {
  it("a solo queue waits for the window end", () => {
    const s = queueStatus(view(1, 13_000), NOW);
    assert.equal(s.solo, true);
    assert.equal(s.early, false);
    assert.equal(s.secsLeft, 32);
    assert.equal(s.countdown, "0:32");
    assert.equal(queueLine(s), "Players in queue: 1 · launching in 0:32");
  });

  it("MIN_HUMANS launch early, but never before MIN_WAIT_MS", () => {
    const fresh = queueStatus(view(MATCH.MIN_HUMANS, 2000), NOW);
    assert.equal(fresh.early, true);
    assert.equal(fresh.launchAt, NOW - 2000 + MATCH.MIN_WAIT_MS);
    assert.equal(fresh.secsLeft, 8);
    const late = queueStatus(view(MATCH.MIN_HUMANS, MATCH.MIN_WAIT_MS + 1000), NOW);
    assert.equal(late.secsLeft, 0);
    assert.equal(late.launching, true);
    assert.equal(queueLine(late), `Players in queue: ${MATCH.MIN_HUMANS} · launching now`);
  });

  it("a full queue launches at once and never shows more than MAX_HUMANS", () => {
    const s = queueStatus(view(MATCH.MAX_HUMANS + 5, 0), NOW);
    assert.equal(s.humans, MATCH.MAX_HUMANS);
    assert.equal(s.max, MATCH.MAX_HUMANS);
    assert.equal(s.launching, true);
  });

  it("agrees with the shared queue rule at the launch moment", () => {
    for (const n of [1, 5, MATCH.MIN_HUMANS, MATCH.MAX_HUMANS]) {
      const v = view(n, 0);
      const s = queueStatus(v, NOW);
      const atLaunch = s.launchAt - v.openedAt;
      assert.equal(mmShouldLaunch(n, atLaunch), true, `n=${n} launches at ${atLaunch}`);
      if (atLaunch > 0) assert.equal(mmShouldLaunch(n, atLaunch - 1), false, `n=${n} not before ${atLaunch}`);
    }
  });

  it("an unknown open time falls back to deadline − window", () => {
    const v: QueueView = { players: MATCH.MIN_HUMANS, openedAt: 0, deadlineAt: NOW + 40_000, launching: false };
    assert.equal(queueStatus(v, NOW).launchAt, NOW + 5000);
  });

  it("formats m:ss and never mentions bots", () => {
    assert.equal(fmtQueueClock(0), "0:00");
    assert.equal(fmtQueueClock(45), "0:45");
    assert.equal(fmtQueueClock(90.2), "1:31");
    assert.equal(fmtQueueClock(-3), "0:00");
    assert.doesNotMatch(queueLine(queueStatus(view(3, 0), NOW)), /bot/i);
  });
});
