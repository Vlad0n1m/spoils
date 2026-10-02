/**
 * Run: apps/game-server/node_modules/.bin/tsx --test apps/web/src/lib/matchmaking-room.test.ts
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MM_BATTLE_READY } from "@extract/shared";
import { wireMatchmakingRoom, type MmRoomHandlers, type MmRoomLike } from "./matchmaking-room";

/** Captures the listeners so a test can replay server events, including ones in flight after leave(). */
function fakeRoom() {
  const msg = new Map<string, (m: { battleRoomId?: unknown } | undefined) => void>();
  let state: ((s: unknown) => void) | undefined;
  let error: ((code: number, message?: string) => void) | undefined;
  let leave: ((code: number, reason?: string) => void) | undefined;
  const room: MmRoomLike = {
    onStateChange: (cb) => (state = cb),
    onMessage: (type, cb) => msg.set(type, cb),
    onError: (cb) => (error = cb),
    onLeave: (cb) => (leave = cb),
  };
  return {
    room,
    state: (s: unknown) => state?.(s),
    message: (type: string, m: { battleRoomId?: unknown } | undefined) => msg.get(type)?.(m),
    error: (code: number, message?: string) => error?.(code, message),
    leave: (code: number, reason?: string) => leave?.(code, reason),
  };
}

function recorder() {
  let disposed = false;
  const calls: string[] = [];
  const handlers: MmRoomHandlers = {
    isDisposed: () => disposed,
    onState: () => calls.push("state"),
    onBattleReady: (id) => calls.push(`ready:${id}`),
    onError: (code) => calls.push(`error:${code}`),
    onClosed: (code) => calls.push(`closed:${code}`),
  };
  return { handlers, calls, dispose: () => (disposed = true) };
}

describe("wireMatchmakingRoom", () => {
  it("forwards battle_ready while searching and then ignores the room closing", () => {
    const r = fakeRoom();
    const h = recorder();
    wireMatchmakingRoom(r.room, h.handlers);
    r.state({});
    r.message(MM_BATTLE_READY, { battleRoomId: "b1" });
    r.message(MM_BATTLE_READY, { battleRoomId: "b1" });
    r.leave(1000);
    assert.deepEqual(h.calls, ["state", "ready:b1"]);
  });

  it("ignores a battle_ready that lands after Cancel", () => {
    const r = fakeRoom();
    const h = recorder();
    wireMatchmakingRoom(r.room, h.handlers);
    h.dispose(); // Cancel: leave() sent, but the server already launched.
    r.message(MM_BATTLE_READY, { battleRoomId: "b1" });
    r.state({ status: "started" });
    r.error(4000);
    r.leave(4000);
    assert.deepEqual(h.calls, []);
  });

  it("reports a kick while still searching", () => {
    const r = fakeRoom();
    const h = recorder();
    wireMatchmakingRoom(r.room, h.handlers);
    r.message(MM_BATTLE_READY, { battleRoomId: 42 });
    r.leave(4001);
    assert.deepEqual(h.calls, ["closed:4001"]);
  });
});
