/**
 * draft-flush: PLAY waits for a pending loadout edit and for draft saves in flight.
 * Run: apps/game-server/node_modules/.bin/tsx --test apps/web/src/lib/lobby/draft-flush.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { flushDraft, registerDraftFlush, trackDraftSave } from "./draft-flush";

const later = <T>(ms: number, v: T, fail = false) =>
  new Promise<T>((resolve, reject) => setTimeout(() => (fail ? reject(new Error("x")) : resolve(v)), ms));

test("flushDraft sends the pending edit, waits for saves in flight, never throws, and forgets unregistered boards", async () => {
  const log: string[] = [];
  const off = registerDraftFlush(async () => {
    await later(20, null);
    log.push("pending sent");
  });
  void trackDraftSave(later(40, null)).then(() => log.push("in-flight save done"));
  void trackDraftSave(later(10, null, true)).catch(() => log.push("failed save"));
  await flushDraft();
  log.push("join");
  assert.deepEqual(log.slice(-1), ["join"]);
  assert.ok(log.includes("pending sent") && log.includes("in-flight save done") && log.includes("failed save"));

  off();
  const off2 = registerDraftFlush(async () => {
    throw new Error("network");
  });
  await flushDraft(); // a failing flusher does not block or throw
  off2();
  const t0 = Date.now();
  await flushDraft();
  assert.ok(Date.now() - t0 < 15, "nothing registered or in flight: immediate");
});
