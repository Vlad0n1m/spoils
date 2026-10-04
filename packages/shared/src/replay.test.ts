/**
 * Replay format: whole-chunk round trip (key + delta frames, every event kind, UTF-8 names), the
 * quantizers, and the strict decoder (bad magic / version, truncation, unknown records).
 * Run: apps/game-server/node_modules/.bin/tsx --test packages/shared/src/replay.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  REPLAY,
  REPLAY_REC,
  ReplayEncoder,
  ReplayFormatError,
  decodeReplayChunk,
  encodeReplayChunk,
  qAim,
  qAngle,
  qHp,
  qPos,
  readReplayHeader,
  type ReplayChunkData,
  type ReplayEnt,
  type ReplaySpawn,
} from "./replay.js";

const TAU = Math.PI * 2;
const aimOf = (q: number) => (q * TAU) / 256;
const angleOf = (q: number) => (q * TAU) / 65536;

function ent(r: number, o: Partial<ReplayEnt> = {}): ReplayEnt {
  return {
    r,
    kind: "human",
    x: 1000 + r * 10,
    y: 2000,
    aim: aimOf(r),
    hp: 255,
    alive: true,
    extracted: false,
    connected: true,
    dormant: false,
    extracting: false,
    act: 0,
    ...o,
  };
}

const npc: ReplaySpawn = { r: 0, kind: "marauder", maxHp: 110, color: 255, level: 0, guest: false, nickname: "Marauder", userId: "", entryId: "", partyId: "" };
const boss: ReplaySpawn = { r: 1, kind: "boss", maxHp: 1200, color: 255, level: 0, guest: false, nickname: "The Foreman", userId: "", entryId: "", partyId: "" };
const human: ReplaySpawn = {
  r: 2,
  kind: "human",
  maxHp: 100,
  color: 3,
  level: 12,
  guest: false,
  nickname: "Ния 🦊 raider",
  userId: "0c8b2f0e-5b6a-4f7d-9c1e-2a3b4c5d6e7f",
  entryId: "1d9c3a1f-6c7b-4e8e-8d2f-3b4c5d6e7f80",
  partyId: "2eaf4b20-7d8c-4f9f-9e30-4c5d6e7f8091",
};
const late: ReplaySpawn = { ...human, r: 3, nickname: "guest-41", guest: true, level: 0, userId: "3fb05c31-8e9d-4a00-8f41-5d6e7f8091a2", entryId: "4c1a6d42-9fae-4b11-9a52-6e7f8091a2b3", partyId: "" };

function sample(): ReplayChunkData {
  return {
    v: REPLAY.VERSION,
    seq: 7,
    startMs: 420_000,
    endMs: 480_000,
    final: false,
    roster: [npc, boss, human],
    frames: [
      { t: 420_000, ents: [ent(0, { kind: "marauder", dormant: true, connected: false }), ent(1, { kind: "boss", hp: 200, connected: false }), ent(2)] },
      // 2 moved and reloads, 0 unchanged (carried by the delta), boss unchanged
      { t: 420_200, ents: [ent(0, { kind: "marauder", dormant: true, connected: false }), ent(1, { kind: "boss", hp: 200, connected: false }), ent(2, { x: 1026, act: 1 })] },
      // 3 spawned; 0 died (listed once with alive=false)
      {
        t: 420_400,
        ents: [
          ent(0, { kind: "marauder", dormant: false, connected: false, alive: false, hp: 0 }),
          ent(1, { kind: "boss", hp: 180, connected: false }),
          ent(2, { x: 1030, act: 1, extracting: true }),
          ent(3, { aim: aimOf(255) }),
        ],
      },
      // 0 gone; 2 extracted (listed once); 3 disconnected
      { t: 420_600, ents: [ent(1, { kind: "boss", hp: 180, connected: false }), ent(2, { x: 1030, alive: false, extracted: true }), ent(3, { aim: aimOf(255), connected: false })] },
      // 1 vanished without a leave row (explicit removal)
      { t: 420_800, ents: [ent(3, { aim: aimOf(255), connected: false, y: 65_534 * 2 })] },
    ],
    events: [
      { t: 420_000, type: "boss", r: 1, state: "idle" },
      { t: 420_150, type: "shot", r: 2, weapon: "shotgun", x: 1022, y: 2000, angles: [angleOf(0), angleOf(1), angleOf(65_535)] },
      { t: 420_150, type: "hit", src: 2, target: 0, dmg: 12.5, armor: true },
      { t: 420_200, type: "hit", src: -1, target: 1, dmg: 0.1, armor: false },
      { t: 420_350, type: "spawn", spawn: late },
      { t: 420_350, type: "kill", victim: 0, killer: 2, weapon: "rifle" },
      { t: 420_350, type: "kill", victim: 1, killer: -1, weapon: "" },
      { t: 420_400, type: "chest", r: 2, idx: 517 },
      { t: 420_450, type: "loot", r: 2, target: "corpse", id: 0 },
      { t: 420_460, type: "loot", r: 3, target: "container", id: 517 },
      { t: 420_500, type: "boss", r: 1, state: "combat" },
      { t: 420_600, type: "exit", r: 2, exit: "extract", extractId: "N1" },
      { t: 420_700, type: "exit", r: 3, exit: "mia", extractId: "" },
      { t: 479_999, type: "wipe" },
    ],
  };
}

test("a chunk round-trips exactly: key + delta frames, removals, every event kind, UTF-8 names", () => {
  const c = sample();
  const bytes = encodeReplayChunk(c);
  assert.deepEqual(decodeReplayChunk(bytes), c);
  assert.deepEqual(readReplayHeader(bytes), { v: REPLAY.VERSION, seq: 7, startMs: 420_000 });
  // deltas carry only changed rows: frame 2 lists one row (runtime 2), not three
  const second = encodeReplayChunk({ ...c, frames: c.frames.slice(0, 2), events: [] });
  const first = encodeReplayChunk({ ...c, frames: c.frames.slice(0, 1), events: [] });
  assert.equal(second.length - first.length, 5 + 2 + 8 + 2, "delta = record header, count, one 8-byte row (dx 3 units), removed count");
});

test("positions move by i8 deltas and fall back to absolute rows on a jump", () => {
  const enc = new ReplayEncoder();
  enc.begin(0, 0);
  enc.roster([]);
  enc.frameBegin(0, true);
  enc.ent(1, 1000, 1000, 0, 255, 1, 0, 990, 990); // KEY rows stay absolute whatever prev says
  enc.frameEnd();
  const keyEnd = enc.size;
  enc.frameBegin(200, false);
  enc.ent(1, 1127, 872, 0, 255, 1, 0, 1000, 1000); // dx +127, dy −128: still a delta
  enc.frameEnd();
  assert.equal(enc.size - keyEnd, 5 + 2 + 8 + 2, "a delta row has no absolute part");
  enc.frameBegin(400, false);
  enc.ent(1, 1255, 872, 0, 255, 1, 0, 1127, 872); // dx +128: absolute
  enc.frameEnd();
  enc.end(400, false);
  const c = decodeReplayChunk(enc.bytes());
  assert.deepEqual(c.frames.map((f) => [f.ents[0]!.x, f.ents[0]!.y]), [[2000, 2000], [2254, 1744], [2510, 1744]]);
});

test("an empty final chunk round-trips", () => {
  const c: ReplayChunkData = { v: REPLAY.VERSION, seq: 0, startMs: 0, endMs: 0, final: true, roster: [], frames: [], events: [] };
  assert.deepEqual(decodeReplayChunk(encodeReplayChunk(c)), c);
});

test("long names are cut at 255 bytes on a code point boundary", () => {
  const nick = "ж".repeat(200); // 400 bytes of UTF-8
  const c: ReplayChunkData = { ...sample(), roster: [{ ...human, nickname: nick }], frames: [], events: [] };
  const out = decodeReplayChunk(encodeReplayChunk(c));
  assert.equal(out.roster[0]!.nickname, "ж".repeat(127));
});

test("quantizers clamp and wrap", () => {
  assert.equal(qPos(-5), 0);
  assert.equal(qPos(Number.NaN), 0);
  assert.equal(qPos(20_480), 10_240);
  assert.equal(qPos(1e9), 0xffff);
  assert.equal(qAim(0), 0);
  assert.equal(qAim(-Math.PI / 2), 192);
  assert.equal(qAim(TAU), 0);
  assert.equal(qAim(Number.NaN), 0);
  assert.equal(qAngle(Math.PI), 32_768);
  assert.equal(qHp(0, 100), 0);
  assert.equal(qHp(-3, 100), 0);
  assert.equal(qHp(0.01, 1200), 1, "any HP left is at least 1");
  assert.equal(qHp(100, 100), 255);
  assert.equal(qHp(500, 100), 255);
});

test("the streaming encoder grows its buffer and reuses it across chunks", () => {
  const enc = new ReplayEncoder(256);
  enc.begin(1, 0);
  enc.roster([]);
  enc.frameBegin(0, true);
  for (let r = 0; r < 256; r++) enc.ent(r, r, r, r & 0xff, 255, 1, 0);
  enc.frameEnd();
  enc.end(200, false);
  const a = decodeReplayChunk(enc.bytes());
  assert.equal(a.frames[0]!.ents.length, 256);
  assert.equal(enc.frames, 1);
  enc.begin(2, 200);
  enc.roster([]);
  enc.wipe(300);
  enc.end(300, true);
  const b = decodeReplayChunk(enc.bytes());
  assert.equal(b.seq, 2);
  assert.deepEqual(b.events, [{ t: 300, type: "wipe" }]);
  assert.equal(b.final, true);
});

test("the decoder is strict", () => {
  const good = encodeReplayChunk(sample());
  const bad = (mutate: (b: Uint8Array) => Uint8Array, re: RegExp) =>
    assert.throws(() => decodeReplayChunk(mutate(good.slice())), (e: unknown) => e instanceof ReplayFormatError && re.test(e.message));
  bad((b) => ((b[0] = 0x58), b), /magic/);
  bad((b) => ((b[4] = 99), b), /version/);
  bad((b) => b.slice(0, b.length - 3), /truncated/);
  bad((b) => {
    const out = new Uint8Array(b.length + 1);
    out.set(b);
    return out;
  }, /after END/);
  // the first record after the roster is the boss event: make it an unknown type
  const enc = new ReplayEncoder();
  enc.begin(0, 0);
  enc.roster([]);
  const rosterEnd = enc.size;
  enc.wipe(5);
  enc.end(5, true);
  const raw = enc.bytes();
  raw[rosterEnd] = 99;
  assert.throws(() => decodeReplayChunk(raw), /unknown record 99/);
  // a delta frame needs a key frame first
  const d = new ReplayEncoder();
  d.begin(0, 0);
  d.roster([]);
  d.frameBegin(0, false);
  d.frameEnd();
  d.end(0, false);
  assert.throws(() => decodeReplayChunk(d.bytes()), /delta frame before a key frame/);
  // a delta row needs a previous row of that runtime
  const g = new ReplayEncoder();
  g.begin(0, 0);
  g.roster([]);
  g.frameBegin(0, true);
  g.frameEnd();
  g.frameBegin(200, false);
  g.ent(5, 10, 10, 0, 255, 1, 0, 8, 8);
  g.frameEnd();
  g.end(200, false);
  assert.throws(() => decodeReplayChunk(g.bytes()), /delta row 5 without a previous row/);
  assert.equal(REPLAY_REC.END, 127);
  assert.throws(() => decodeReplayChunk(new Uint8Array(REPLAY.MAX_RAW_BYTES + 1)), /too large/);
});
