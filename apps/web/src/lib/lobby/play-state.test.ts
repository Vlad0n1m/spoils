/**
 * T23 PLAY states (WORLD v6 spec §6.5): every row of the PlayState table, the press actions and the
 * join failure mapping.
 * Run: apps/game-server/node_modules/.bin/tsx --test apps/web/src/lib/lobby/play-state.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { WORLD, worldCycleOf, type MeWorldDto, type WorldStatusDto } from "@extract/shared";
import {
  SETTLE_GRACE_MS,
  classifyJoinFailure,
  derivePlayState,
  playAction,
  riskLine,
  type PlayInput,
  type PlayState,
} from "./play-state";

const K = 650_000;
const C = worldCycleOf(K);
/** Wall ms at mm:ss into map K (0:00 = its opening; it wipes at 55:00, entry closes at 45:00). */
const at = (min: number, sec = 0) => C.startAt + min * 60_000 + sec * 1000;
const fmtTime = (ms: number) => `T${ms}`;

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
    humans: 3,
    capacity: WORLD.CAPACITY,
    shards: 1,
    boss: null,
    next: { cycle: K + 1, mapNumber: 2, openAt: worldCycleOf(K + 1).openAt },
    closing: null,
    last: null,
    ...over,
  };
}

const ME_NONE: MeWorldDto = { serverTime: at(5), activeEntry: null, lastRaid: null };

function input(over: Partial<Omit<PlayInput, "local">> & { local?: Partial<PlayInput["local"]> } = {}): PlayInput {
  const { local, ...rest } = over;
  return {
    session: { loading: false, kind: "user" },
    stash: { loaded: true, inRaid: false, atRisk: 4, starterClaimed: true },
    world: status(),
    worldError: false,
    me: ME_NONE,
    now: at(5),
    fmtTime,
    ...rest,
    local: { joining: false, armedCycle: null, error: null, hidden: false, inRaidUntil: null, ...local },
  };
}

const kind = (s: PlayState) => s.kind;

describe("derivePlayState", () => {
  it("loading while the session, /api/me/world or a registered stash is pending", () => {
    assert.equal(kind(derivePlayState(input({ session: { loading: true, kind: "anon" } }))), "loading");
    assert.equal(kind(derivePlayState(input({ me: undefined }))), "loading");
    assert.equal(kind(derivePlayState(input({ stash: { loaded: false, inRaid: false, atRisk: 0, starterClaimed: false } }))), "loading");
    assert.equal(kind(derivePlayState(input({ stash: null }))), "loading");
  });

  it("signed_out without a session (the world card still runs)", () => {
    assert.deepEqual(derivePlayState(input({ session: { loading: false, kind: "anon" }, me: null, stash: null })), { kind: "signed_out" });
  });

  it("ready (lime) with the risk line only (the wipe countdown is on the world card)", () => {
    assert.deepEqual(derivePlayState(input()), { kind: "ready", sub: "4 items at risk", tone: "lime" });
    const one = derivePlayState(input({ stash: { loaded: true, inRaid: false, atRisk: 1, starterClaimed: true } }));
    assert.deepEqual(one, { kind: "ready", sub: "1 item at risk", tone: "lime" });
    const empty = derivePlayState(input({ stash: { loaded: true, inRaid: false, atRisk: 0, starterClaimed: false } }));
    assert.deepEqual(empty, { kind: "ready", sub: "Basic gear · nothing at risk", tone: "lime" });
  });

  it("ready for a guest: basic gear, loot isn't kept (no stash needed)", () => {
    const s = derivePlayState(input({ session: { loading: false, kind: "guest" }, stash: null }));
    assert.deepEqual(s, { kind: "ready", sub: "Basic gear · loot isn't kept", tone: "lime" });
  });

  it("ready turns amber when the wipe is under 15 minutes away", () => {
    const s = derivePlayState(input({ now: at(42, 20) }));
    assert.deepEqual(s, { kind: "ready", sub: "Short raid · 4 items at risk", tone: "amber" });
    assert.equal((derivePlayState(input({ now: at(39, 59) })) as { tone: string }).tone, "lime");
  });

  it("joining while the join is in flight", () => {
    assert.deepEqual(derivePlayState(input({ local: { joining: true } })), { kind: "joining" });
  });

  it("never closed: in a map's last 10 minutes the next map is already open (overlapping maps)", () => {
    // 47:42 into map K: entry to K closed at 45:00, map K + 1 opened then and wipes 45 min after K.
    const s = derivePlayState(input({ now: at(47, 42) }));
    assert.deepEqual(s, { kind: "ready", sub: "4 items at risk", tone: "lime" });
    assert.equal(worldCycleOf(K + 1).wipeAt - at(47, 42), (52 * 60 + 18) * 1000);
    // No reset gap either: a map takes entries from its first second.
    assert.deepEqual(derivePlayState(input({ now: at(0, 6) })), { kind: "ready", sub: "4 items at risk", tone: "lime" });
  });

  it("the clock decides the phase even with a stale status (from the previous map)", () => {
    const stale = status({ cycle: K - 1, online: false });
    assert.equal(kind(derivePlayState(input({ world: stale }))), "ready");
  });

  it("armed: an arm left from before fires for the open map at once; an older cycle's arm is ignored", () => {
    assert.deepEqual(derivePlayState(input({ now: at(0, 10), local: { armedCycle: K } })), { kind: "armed", nextInS: 0 });
    assert.equal(kind(derivePlayState(input({ now: at(47), local: { armedCycle: K } }))), "ready");
  });

  it("armed at 0 once the map opens (the menu fires the auto-enter); a hidden tab gets ready instead", () => {
    assert.deepEqual(derivePlayState(input({ now: at(0, 21), local: { armedCycle: K } })), { kind: "armed", nextInS: 0 });
    assert.equal(kind(derivePlayState(input({ now: at(0, 21), local: { armedCycle: K, hidden: true } }))), "ready");
  });

  it("rejoin while the caller's raider is still on this map, whatever the phase", () => {
    const me: MeWorldDto = { ...ME_NONE, activeEntry: { matchId: "m", entryId: "e", cycle: K, wipeAt: C.wipeAt, rejoinable: true } };
    assert.deepEqual(derivePlayState(input({ me })), { kind: "rejoin" });
    assert.deepEqual(derivePlayState(input({ me, now: at(40) })), { kind: "rejoin" });
  });

  it("gear_in_raid with the local settle time when the entry cannot be rejoined", () => {
    const me: MeWorldDto = { ...ME_NONE, activeEntry: { matchId: "m", entryId: "e", cycle: K - 1, wipeAt: C.startAt, rejoinable: false } };
    assert.deepEqual(derivePlayState(input({ me })), { kind: "gear_in_raid", settlesAtLocal: fmtTime(C.startAt + SETTLE_GRACE_MS) });
  });

  it("gear_in_raid after a join answered in_raid, until its settle time", () => {
    const until = at(8);
    assert.deepEqual(derivePlayState(input({ local: { inRaidUntil: until } })), { kind: "gear_in_raid", settlesAtLocal: fmtTime(until) });
    assert.equal(kind(derivePlayState(input({ now: at(8, 1), local: { inRaidUntil: until } }))), "ready");
  });

  it("gear_in_raid (time unknown) when the stash says the loadout is in a raid", () => {
    const s = derivePlayState(input({ stash: { loaded: true, inRaid: true, atRisk: 2, starterClaimed: true } }));
    assert.deepEqual(s, { kind: "gear_in_raid", settlesAtLocal: "" });
  });

  it("offline when the status keeps failing, or the current map has no running shard", () => {
    assert.deepEqual(derivePlayState(input({ world: null, worldError: true })), { kind: "offline" });
    assert.deepEqual(derivePlayState(input({ world: status({ online: false }) })), { kind: "offline" });
    // A failing poll with a good cached status keeps PLAY usable.
    assert.equal(kind(derivePlayState(input({ worldError: true }))), "ready");
    // Not yet answered at all: the clock alone decides.
    assert.equal(kind(derivePlayState(input({ world: null }))), "ready");
    // The next map is open during the last 10 minutes too: still offline without a status.
    assert.equal(kind(derivePlayState(input({ world: null, worldError: true, now: at(47) }))), "offline");
  });

  it("error wraps the base state with the API message and a fix", () => {
    const s = derivePlayState(input({ local: { error: { message: "No backpack slot", fix: "inventory" } } }));
    assert.equal(s.kind, "error");
    if (s.kind !== "error") return;
    assert.equal(s.base.kind, "ready");
    assert.equal(s.message, "No backpack slot");
    assert.equal(s.fix, "inventory");
    const late = derivePlayState(input({ now: at(47), local: { error: { message: "x" } } }));
    assert.equal(late.kind === "error" && late.base.kind, "ready");
    assert.equal(late.kind === "error" && late.fix, undefined);
  });

  it("an error never hides loading, joining or signed_out", () => {
    const error = { message: "boom", fix: "retry" as const };
    assert.equal(kind(derivePlayState(input({ local: { joining: true, error } }))), "joining");
    assert.equal(kind(derivePlayState(input({ session: { loading: true, kind: "user" }, local: { error } }))), "loading");
    assert.equal(kind(derivePlayState(input({ session: { loading: false, kind: "anon" }, local: { error } }))), "signed_out");
  });

  it("riskLine wording", () => {
    assert.equal(riskLine("guest", 3), "Basic gear · loot isn't kept");
    assert.equal(riskLine("user", 0), "Basic gear · nothing at risk");
    assert.equal(riskLine("user", 2), "2 items at risk");
  });
});

describe("playAction", () => {
  it("maps every state to what pressing PLAY does", () => {
    assert.equal(playAction({ kind: "ready", sub: "", tone: "lime" }), "join");
    assert.equal(playAction({ kind: "rejoin" }), "join");
    assert.equal(playAction({ kind: "closed", label: "NEXT MAP", nextInS: 5 }), "arm");
    assert.equal(playAction({ kind: "armed", nextInS: 5 }), "disarm");
    assert.equal(playAction({ kind: "signed_out" }), "signin");
    assert.equal(playAction({ kind: "offline" }), "retry_status");
    assert.equal(playAction({ kind: "loading" }), null);
    assert.equal(playAction({ kind: "joining" }), null);
    assert.equal(playAction({ kind: "gear_in_raid", settlesAtLocal: "" }), null);
    assert.equal(playAction({ kind: "error", base: { kind: "ready", sub: "", tone: "lime" }, message: "x" }), "join");
    assert.equal(playAction({ kind: "error", base: { kind: "closed", label: "NEW MAP", nextInS: 1 }, message: "x" }), "arm");
  });
});

describe("classifyJoinFailure", () => {
  const T = at(5);
  it("entry_closed lets the clock show NEXT MAP / NEW MAP", () => {
    assert.deepEqual(classifyJoinFailure(409, { error: "entry_closed", message: "closed", serverTime: T, openAt: T + 1 }), { kind: "closed" });
  });
  it("world_starting retries after retryInMs (3 s by default), world_full too", () => {
    assert.deepEqual(classifyJoinFailure(503, { error: "world_starting", message: "m", serverTime: T, retryInMs: 3000 }), {
      kind: "retry",
      afterMs: 3000,
      message: "m",
    });
    const full = classifyJoinFailure(503, { error: "world_full" as never, message: "", serverTime: T });
    assert.equal(full.kind === "retry" && full.afterMs, 3000);
  });
  it("in_raid carries settlesAt", () => {
    assert.deepEqual(classifyJoinFailure(409, { error: "in_raid", message: "m", serverTime: T, settlesAt: T + 60_000 }), {
      kind: "in_raid",
      settlesAt: T + 60_000,
    });
    assert.deepEqual(classifyJoinFailure(409, { error: "in_raid", message: "m", serverTime: T }), { kind: "in_raid", settlesAt: null });
  });
  it("loadout codes offer Fix loadout; 401 offers Sign in; conflict and 5xx offer Try again", () => {
    for (const code of ["bad_item", "dup_slot", "bad_slot", "no_backpack_room", "item_unavailable", "bad_qty", "not_enough"] as const) {
      const f = classifyJoinFailure(400, { error: code, message: `msg ${code}`, serverTime: T });
      assert.deepEqual(f, { kind: "error", error: { message: `msg ${code}`, fix: "inventory" } }, code);
    }
    const auth = classifyJoinFailure(401, { error: "unauthenticated", message: "Sign in first.", serverTime: T });
    assert.deepEqual(auth, { kind: "error", error: { message: "Sign in first.", fix: "signin" } });
    const conflict = classifyJoinFailure(409, { error: "conflict", message: "busy", serverTime: T });
    assert.equal(conflict.kind === "error" && conflict.error.fix, "retry");
    const crash = classifyJoinFailure(500, null);
    assert.equal(crash.kind === "error" && crash.error.fix, "retry");
    const net = classifyJoinFailure(0, null);
    assert.equal(net.kind === "error" && net.error.fix, "retry");
  });
  it("entry_limit is a plain message (nothing to fix until the next map)", () => {
    const f = classifyJoinFailure(409, { error: "entry_limit", message: "4 times", serverTime: T });
    assert.deepEqual(f, { kind: "error", error: { message: "4 times" } });
  });
});
