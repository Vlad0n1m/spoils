/**
 * Run: apps/game-server/node_modules/.bin/tsx --test apps/web/src/lib/password.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BcryptBusyError, BcryptGate } from "./password";

describe("BcryptGate (security audit: bcrypt floods froze every route)", () => {
  it("runs at most `concurrency` at once, queues the rest in order and refuses past maxQueue", async () => {
    const gate = new BcryptGate(2, 2);
    let running = 0;
    let peak = 0;
    const order: number[] = [];
    const releases: Array<() => void> = [];
    const job = (i: number) =>
      gate.run(async () => {
        running++;
        peak = Math.max(peak, running);
        order.push(i);
        await new Promise<void>((r) => releases.push(r));
        running--;
        return i;
      });
    const jobs = [job(1), job(2), job(3), job(4)];
    await assert.rejects(job(5), BcryptBusyError, "2 running + 2 waiting: the 5th fails fast");
    await new Promise((r) => setImmediate(r));
    assert.equal(running, 2);
    assert.equal(gate.queued, 2);
    while (releases.length || running) {
      releases.shift()?.();
      await new Promise((r) => setImmediate(r));
    }
    assert.deepEqual(await Promise.all(jobs), [1, 2, 3, 4]);
    assert.equal(peak, 2);
    assert.deepEqual(order, [1, 2, 3, 4]);
    assert.equal(await gate.run(async () => "free again"), "free again");
  });

  it("a failing job frees its slot", async () => {
    const gate = new BcryptGate(1, 1);
    await assert.rejects(gate.run(async () => { throw new Error("boom"); }), /boom/);
    assert.equal(await gate.run(async () => 7), 7);
  });
});
