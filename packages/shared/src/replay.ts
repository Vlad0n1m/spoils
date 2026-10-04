/**
 * Admin replays (WORLD v6): the game server records every shard-cycle as a compact binary stream,
 * cut into chunks of about REPLAY.CHUNK_MS, deflate-raw compressed, and POSTed (HMAC-signed, like
 * every game server → web call) to REPLAY_INGEST_PATH. The web stores them for REPLAY.RETENTION_DAYS
 * (replays / replay_chunks) and serves them to admins only. Players never see replays; nothing in
 * them is money, CR or items.
 *
 * This module is the format: the quantizers, the streaming encoder the recorder writes with
 * (apps/game-server/src/sim/replay-recorder.ts), the whole-chunk encoder used by tests and tools,
 * and the strict decoder an admin viewer reads with. It has no Node or DOM dependencies (UTF-8 is
 * done by hand), so the browser can decode after DecompressionStream("deflate-raw").
 *
 * Chunk layout (version 1, little endian), before compression:
 *   header   "SPRP" u8 version, u32 seq, u32 startMs (cycle clock)
 *   ROSTER   u16 n, n × spawn body: every runtime spawned before startMs (a chunk is self-contained)
 *   records  in time order, each `u8 type, u32 t (cycle clock ms), body`:
 *     KEY / DELTA frame, column by column (deflate matches each column against the last frames):
 *       u16 n; n × u16 r; n × u8 flags (REPLAY_FLAG | kind << 5 | ABS); n × i8 dx; n × i8 dy;
 *       n × u8 aim (2π/256); n × u8 hp (share of maxHp × 255, ≥ 1 while hp > 0); n × u8 act;
 *       then for the k rows with ABS: k × u16 x, k × u16 y; then u16 m, m × u16 removed r.
 *       Positions are in REPLAY.POS_UNIT_PX units: an ABS row carries x / y, any other row moves
 *       by (dx, dy) from that runtime's previous row (every KEY row is ABS).
 *       KEY lists every runtime on the map; DELTA only the ones whose quantized row changed. A
 *       runtime that left (died / extracted / MIA) is listed once more with ALIVE cleared and is
 *       gone from the next frame. The first frame of every chunk is a KEY frame.
 *     SPAWN  spawn body (a runtime joined: human entry or NPC, with its identity)
 *     SHOT   u16 r, u8 weapon, u16 x, u16 y (muzzle), u8 n, n × u16 pellet angle (2π/65536)
 *     HIT    u16 src (0xffff = none), u16 target, u16 hp lost × 10, u8 armor absorbed
 *     KILL   u16 victim, u16 killer (0xffff = none), u8 weapon
 *     EXIT   u16 r, u8 exit type, str extract id ("" unless extract)  — humans leaving the map
 *     CHEST  u16 r, u16 container index                             — a container opened first
 *     LOOT   u16 r, u8 0 container / 1 corpse, u16 id                — a search session got ready
 *     BOSS   u16 r, u8 boss brain state                              — on change, every frame
 *     WIPE   (no body)                                               — the map was wiped
 *   END      u32 endMs, u8 final
 * spawn body: u16 r, u8 kind, u16 maxHp, u8 color, u16 level, u8 bit0 guest, str nickname,
 *   str userId, str entryId, str partyId (NPCs: empty strings). str = u8 byte length + UTF-8.
 */

import type { WeaponId } from "./items.js";
import type { ExitType } from "./types.js";

export const REPLAY = {
  /** Format version (chunk header byte, ReplayChunkUpload.v). */
  VERSION: 1,
  /** One frame of every runtime this often (cycle clock). */
  FRAME_MS: 200,
  /** A chunk is sealed after this much cycle clock (or earlier at SEAL_RAW_BYTES / the wipe). */
  CHUNK_MS: 60_000,
  /** Position quantum: x and y are stored as u16 in these units (131 km of map). */
  POS_UNIT_PX: 2,
  /** The recorder seals a chunk early once its uncompressed size reaches this. */
  SEAL_RAW_BYTES: 1024 * 1024,
  /** Most uncompressed bytes of one chunk a reader accepts (inflate limit). */
  MAX_RAW_BYTES: 2 * 1024 * 1024,
  /** Most compressed bytes of one chunk the ingest accepts. */
  MAX_CHUNK_BYTES: 1280 * 1024,
  /** Most bytes of one ingest request body (base64 of MAX_CHUNK_BYTES + the JSON envelope; under nginx's 2m). */
  MAX_BODY_BYTES: 1792 * 1024,
  /** Web down: the game server keeps at most this many unsent chunks (≈ 1 min each) … */
  MAX_BUFFERED_CHUNKS: 10,
  /** … and none sealed longer ago than this; older ones are dropped (logged). */
  MAX_BUFFER_MS: 10 * 60_000,
  /** The retention cron deletes replays whose cycle started longer ago than this. */
  RETENTION_DAYS: 14,
  /** Most chunks one admin read returns. */
  READ_MAX_CHUNKS: 10,
  /** Highest chunk seq the ingest accepts (45 one-minute chunks per cycle, plus early seals). */
  MAX_SEQ: 4095,
} as const;

/** Game server → web: one sealed chunk (HMAC-signed POST, idempotent by (matchId, seq)). */
export const REPLAY_INGEST_PATH = "/api/admin/replays/ingest";

/** Record type bytes. */
export const REPLAY_REC = {
  ROSTER: 1,
  KEY: 2,
  DELTA: 3,
  SPAWN: 16,
  SHOT: 17,
  HIT: 18,
  KILL: 19,
  EXIT: 20,
  CHEST: 21,
  LOOT: 22,
  BOSS: 23,
  WIPE: 24,
  END: 127,
} as const;

/** Entity flag bits (bits 5–6 hold the kind index). */
export const REPLAY_FLAG = {
  ALIVE: 1,
  EXTRACTED: 2,
  /** Human with a live client connection. */
  CONNECTED: 4,
  /** NPC asleep (no human near). */
  DORMANT: 8,
  /** Standing in an extract zone, channelling. */
  EXTRACTING: 16,
} as const;
const KIND_SHIFT = 5;
const KIND_MASK = 0b11;
/** Frame row flag: absolute position (else a delta from the runtime's previous row). Never decoded into ReplayEnt. */
const ABS = 128;

/** Runtime kinds, indexed like NPC_ROLE (NONE = human, BOSS, GUARD, MARAUDER). */
export const REPLAY_KINDS = ["human", "boss", "guard", "marauder"] as const;
export type ReplayKind = (typeof REPLAY_KINDS)[number];
/** Weapon codes; NO_CODE = no weapon. */
export const REPLAY_WEAPONS: readonly WeaponId[] = ["pistol", "rifle", "shotgun", "sniper"];
export const REPLAY_EXITS: readonly ExitType[] = ["extract", "dead", "timeout", "mia"];
/** Boss brain states (game server NpcFsmState). */
export const REPLAY_BOSS_STATES = ["idle", "suspicious", "combat", "search", "return", "cover"] as const;
export type ReplayBossState = (typeof REPLAY_BOSS_STATES)[number];
/** "None" code of a u8 enum and a u16 roster reference. */
const NO_CODE = 0xff;
const NO_REF = 0xffff;

const MAGIC = [0x53, 0x50, 0x52, 0x50] as const; // "SPRP"
const TAU = Math.PI * 2;
const MAX_STR_BYTES = 255;
/** Sanity caps of the decoder (a frame never lists more runtimes than a shard holds; 256 today). */
const MAX_FRAME_ENTS = 4096;

// ------------------------------------------------------------------------------- data model

/** Identity of one runtime (ROSTER / SPAWN). NPCs have empty userId / entryId / partyId. */
export interface ReplaySpawn {
  /** Roster index (never reused within a shard-cycle). */
  r: number;
  kind: ReplayKind;
  maxHp: number;
  color: number;
  level: number;
  guest: boolean;
  nickname: string;
  userId: string;
  entryId: string;
  partyId: string;
}

/** One runtime in one frame (dequantized). */
export interface ReplayEnt {
  r: number;
  kind: ReplayKind;
  /** px, multiples of REPLAY.POS_UNIT_PX. */
  x: number;
  y: number;
  /** Radians in [0, 2π), multiples of 2π/256. */
  aim: number;
  /** Share of maxHp × 255 (0 = no HP; ≥ 1 while alive with HP). */
  hp: number;
  alive: boolean;
  extracted: boolean;
  connected: boolean;
  dormant: boolean;
  extracting: boolean;
  /** Player.act bits (reload, heal, extract, roll, loot, walk). */
  act: number;
}

/** A full frame: every runtime on the map at `t`, plus those that left since the previous frame. */
export interface ReplayFrame {
  t: number;
  ents: ReplayEnt[];
}

export type ReplayEvent =
  | { t: number; type: "spawn"; spawn: ReplaySpawn }
  /** x / y = muzzle; angles in radians (multiples of 2π/65536). */
  | { t: number; type: "shot"; r: number; weapon: WeaponId | ""; x: number; y: number; angles: number[] }
  /** src −1 = no shooter (environment); dmg = HP lost, 0.1 steps. */
  | { t: number; type: "hit"; src: number; target: number; dmg: number; armor: boolean }
  | { t: number; type: "kill"; victim: number; killer: number; weapon: WeaponId | "" }
  | { t: number; type: "exit"; r: number; exit: ExitType; extractId: string }
  | { t: number; type: "chest"; r: number; idx: number }
  | { t: number; type: "loot"; r: number; target: "container" | "corpse"; id: number }
  | { t: number; type: "boss"; r: number; state: ReplayBossState }
  | { t: number; type: "wipe" };

export interface ReplayChunkData {
  v: number;
  seq: number;
  /** Cycle clock ms of the chunk start / end (end exclusive). */
  startMs: number;
  endMs: number;
  /** The last chunk of the shard-cycle (wipe or room closed). */
  final: boolean;
  /** Runtimes spawned before startMs; later ones arrive as spawn events. */
  roster: ReplaySpawn[];
  frames: ReplayFrame[];
  events: ReplayEvent[];
}

/** Body of POST REPLAY_INGEST_PATH (JSON; `data` = base64 of the deflate-raw compressed chunk). */
export interface ReplayChunkUpload {
  v: number;
  matchId: string;
  cycleId: number;
  shard: number;
  mapId: string;
  /** Wall ms of the cycle start (replays.started_at). */
  cycleStartsAt: number;
  seq: number;
  startMs: number;
  endMs: number;
  frames: number;
  events: number;
  /** Human entries on this shard so far. */
  entries: number;
  final: boolean;
  /** Uncompressed chunk bytes. */
  rawBytes: number;
  data: string;
}

// ------------------------------------------------------------------------------- quantizers

/** px → u16 in REPLAY.POS_UNIT_PX units (clamped; NaN → 0). */
export function qPos(v: number): number {
  const q = Math.round(v / REPLAY.POS_UNIT_PX);
  return q >= 0 ? (q > 0xffff ? 0xffff : q) : 0;
}

/** Radians → u8 (2π/256 steps, any range; NaN → 0). */
export function qAim(a: number): number {
  return Math.round((a * 256) / TAU) & 0xff;
}

/** Radians → u16 (2π/65536 steps). */
export function qAngle(a: number): number {
  return Math.round((a * 65536) / TAU) & 0xffff;
}

/** HP → u8 share of maxHp (any HP left is at least 1). */
export function qHp(hp: number, maxHp: number): number {
  if (!(hp > 0)) return 0;
  const q = Math.round((hp / Math.max(1, maxHp)) * 255);
  return q < 1 ? 1 : q > 255 ? 255 : q;
}

/** Entity flags byte. */
export function replayFlags(kind: number, alive: boolean, extracted: boolean, connected: boolean, dormant: boolean, extracting: boolean): number {
  return (
    (alive ? REPLAY_FLAG.ALIVE : 0) |
    (extracted ? REPLAY_FLAG.EXTRACTED : 0) |
    (connected ? REPLAY_FLAG.CONNECTED : 0) |
    (dormant ? REPLAY_FLAG.DORMANT : 0) |
    (extracting ? REPLAY_FLAG.EXTRACTING : 0) |
    ((kind & KIND_MASK) << KIND_SHIFT)
  );
}

export function weaponCode(w: string): number {
  const i = REPLAY_WEAPONS.indexOf(w as WeaponId);
  return i < 0 ? NO_CODE : i;
}

const kindCode = (k: ReplayKind): number => Math.max(0, REPLAY_KINDS.indexOf(k));

// ------------------------------------------------------------------------------- encoder

/**
 * Streaming chunk encoder: one growable buffer, reused across chunks (begin() resets it). The
 * recorder writes quantized values straight in (no per-entity objects); bytes() copies the chunk out.
 */
export class ReplayEncoder {
  private buf: Uint8Array;
  private dv: DataView;
  private n = 0;
  // Columns of the open frame (written out by frameEnd).
  private inFrame = false;
  private frameKey = false;
  private count = 0;
  private absCount = 0;
  private readonly cR = new Uint16Array(MAX_FRAME_ENTS);
  private readonly cF = new Uint8Array(MAX_FRAME_ENTS);
  private readonly cDx = new Int8Array(MAX_FRAME_ENTS);
  private readonly cDy = new Int8Array(MAX_FRAME_ENTS);
  private readonly cA = new Uint8Array(MAX_FRAME_ENTS);
  private readonly cHp = new Uint8Array(MAX_FRAME_ENTS);
  private readonly cAct = new Uint8Array(MAX_FRAME_ENTS);
  private readonly cAx = new Uint16Array(MAX_FRAME_ENTS);
  private readonly cAy = new Uint16Array(MAX_FRAME_ENTS);
  /** Frames / event records written since begin(). */
  frames = 0;
  events = 0;

  constructor(initialBytes = 64 * 1024) {
    this.buf = new Uint8Array(Math.max(256, initialBytes));
    this.dv = new DataView(this.buf.buffer);
  }

  /** Uncompressed bytes written so far. */
  get size(): number {
    return this.n;
  }

  private ensure(extra: number): void {
    if (this.n + extra <= this.buf.length) return;
    let cap = this.buf.length * 2;
    while (cap < this.n + extra) cap *= 2;
    const next = new Uint8Array(cap);
    next.set(this.buf.subarray(0, this.n));
    this.buf = next;
    this.dv = new DataView(next.buffer);
  }

  private u8(v: number): void {
    this.buf[this.n++] = v & 0xff;
  }

  private u16(v: number): void {
    this.dv.setUint16(this.n, v & 0xffff, true);
    this.n += 2;
  }

  private u32(v: number): void {
    this.dv.setUint32(this.n, v >>> 0, true);
    this.n += 4;
  }

  /** u8 length + UTF-8, cut at MAX_STR_BYTES on a code point boundary. */
  private str(s: string): void {
    this.ensure(1 + MAX_STR_BYTES);
    const at = this.n++;
    let len = 0;
    for (const ch of s) {
      const c = ch.codePointAt(0)!;
      const need = c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4;
      if (len + need > MAX_STR_BYTES) break;
      const b = this.buf;
      let p = this.n;
      if (need === 1) b[p++] = c;
      else if (need === 2) {
        b[p++] = 0xc0 | (c >> 6);
        b[p++] = 0x80 | (c & 0x3f);
      } else if (need === 3) {
        b[p++] = 0xe0 | (c >> 12);
        b[p++] = 0x80 | ((c >> 6) & 0x3f);
        b[p++] = 0x80 | (c & 0x3f);
      } else {
        b[p++] = 0xf0 | (c >> 18);
        b[p++] = 0x80 | ((c >> 12) & 0x3f);
        b[p++] = 0x80 | ((c >> 6) & 0x3f);
        b[p++] = 0x80 | (c & 0x3f);
      }
      this.n = p;
      len += need;
    }
    this.buf[at] = len;
  }

  private rec(type: number, t: number, body: number): void {
    this.ensure(5 + body);
    this.u8(type);
    this.u32(Math.max(0, Math.round(t)));
  }

  /** Start a new chunk (drops whatever was written before). */
  begin(seq: number, startMs: number): void {
    this.n = 0;
    this.frames = 0;
    this.events = 0;
    this.inFrame = false;
    this.ensure(13);
    for (const b of MAGIC) this.u8(b);
    this.u8(REPLAY.VERSION);
    this.u32(seq);
    this.u32(Math.max(0, Math.round(startMs)));
  }

  private spawnBody(s: ReplaySpawn): void {
    this.ensure(10);
    this.u16(s.r);
    this.u8(kindCode(s.kind));
    this.u16(Math.max(0, Math.min(0xffff, Math.round(s.maxHp))));
    this.u8(s.color);
    this.u16(Math.max(0, Math.min(0xffff, Math.round(s.level))));
    this.u8(s.guest ? 1 : 0);
    this.str(s.nickname);
    this.str(s.userId);
    this.str(s.entryId);
    this.str(s.partyId);
  }

  roster(list: readonly ReplaySpawn[]): void {
    this.ensure(3);
    this.u8(REPLAY_REC.ROSTER);
    this.u16(list.length);
    for (const s of list) this.spawnBody(s);
  }

  spawn(t: number, s: ReplaySpawn): void {
    this.rec(REPLAY_REC.SPAWN, t, 0);
    this.spawnBody(s);
    this.events++;
  }

  frameBegin(t: number, key: boolean): void {
    this.rec(key ? REPLAY_REC.KEY : REPLAY_REC.DELTA, t, 0);
    this.inFrame = true;
    this.frameKey = key;
    this.count = 0;
    this.absCount = 0;
  }

  /**
   * One row of the open frame (already quantized; x / y in POS_UNIT_PX units). prevX / prevY = the
   * runtime's previous row in this chunk (−1 = none): the row then stores a delta when it fits in
   * an i8; KEY frames always store absolute positions.
   */
  ent(r: number, x: number, y: number, aim: number, hp: number, flags: number, act: number, prevX = -1, prevY = -1): void {
    const i = this.count;
    if (i >= MAX_FRAME_ENTS) throw new Error("replay: frame too large");
    let f = flags & 0x7f;
    const dx = x - prevX;
    const dy = y - prevY;
    if (this.frameKey || prevX < 0 || prevY < 0 || dx < -128 || dx > 127 || dy < -128 || dy > 127) {
      f |= ABS;
      this.cDx[i] = 0;
      this.cDy[i] = 0;
      this.cAx[this.absCount] = x;
      this.cAy[this.absCount] = y;
      this.absCount++;
    } else {
      this.cDx[i] = dx;
      this.cDy[i] = dy;
    }
    this.cR[i] = r;
    this.cF[i] = f;
    this.cA[i] = aim;
    this.cHp[i] = hp;
    this.cAct[i] = act;
    this.count = i + 1;
  }

  /** Close the open frame (writes its columns); `removed` = roster indexes that vanished without a leave row. */
  frameEnd(removed: readonly number[] = []): void {
    if (!this.inFrame) throw new Error("replay: frameEnd without frameBegin");
    this.inFrame = false;
    const n = this.count;
    const k = this.absCount;
    this.ensure(2 + n * 8 + k * 4 + 2 + removed.length * 2);
    const dv = this.dv;
    const b = this.buf;
    let p = this.n;
    dv.setUint16(p, n, true);
    p += 2;
    for (let i = 0; i < n; i++, p += 2) dv.setUint16(p, this.cR[i]!, true);
    b.set(this.cF.subarray(0, n), p);
    p += n;
    b.set(new Uint8Array(this.cDx.buffer, 0, n), p);
    p += n;
    b.set(new Uint8Array(this.cDy.buffer, 0, n), p);
    p += n;
    b.set(this.cA.subarray(0, n), p);
    p += n;
    b.set(this.cHp.subarray(0, n), p);
    p += n;
    b.set(this.cAct.subarray(0, n), p);
    p += n;
    for (let i = 0; i < k; i++, p += 2) dv.setUint16(p, this.cAx[i]!, true);
    for (let i = 0; i < k; i++, p += 2) dv.setUint16(p, this.cAy[i]!, true);
    dv.setUint16(p, removed.length, true);
    p += 2;
    for (const r of removed) {
      dv.setUint16(p, r, true);
      p += 2;
    }
    this.n = p;
    this.frames++;
  }

  shot(t: number, r: number, weapon: string, x: number, y: number, angles: readonly number[]): void {
    const n = Math.min(255, angles.length);
    this.rec(REPLAY_REC.SHOT, t, 8 + n * 2);
    this.u16(r);
    this.u8(weaponCode(weapon));
    this.u16(qPos(x));
    this.u16(qPos(y));
    this.u8(n);
    for (let i = 0; i < n; i++) this.u16(qAngle(angles[i]!));
    this.events++;
  }

  /** src / target: roster indexes (src −1 = none); dmg in HP (stored in 0.1 steps). */
  hit(t: number, src: number, target: number, dmg: number, armor: boolean): void {
    this.rec(REPLAY_REC.HIT, t, 7);
    this.u16(src < 0 ? NO_REF : src);
    this.u16(target);
    const d = Math.round(dmg * 10);
    this.u16(d >= 0 ? (d > 0xffff ? 0xffff : d) : 0);
    this.u8(armor ? 1 : 0);
    this.events++;
  }

  kill(t: number, victim: number, killer: number, weapon: string): void {
    this.rec(REPLAY_REC.KILL, t, 5);
    this.u16(victim);
    this.u16(killer < 0 ? NO_REF : killer);
    this.u8(weaponCode(weapon));
    this.events++;
  }

  exit(t: number, r: number, exit: ExitType, extractId: string): void {
    this.rec(REPLAY_REC.EXIT, t, 3);
    this.u16(r);
    const c = REPLAY_EXITS.indexOf(exit);
    this.u8(c < 0 ? NO_CODE : c);
    this.str(extractId);
    this.events++;
  }

  chest(t: number, r: number, idx: number): void {
    this.rec(REPLAY_REC.CHEST, t, 4);
    this.u16(r);
    this.u16(idx);
    this.events++;
  }

  loot(t: number, r: number, target: "container" | "corpse", id: number): void {
    this.rec(REPLAY_REC.LOOT, t, 5);
    this.u16(r);
    this.u8(target === "corpse" ? 1 : 0);
    this.u16(id);
    this.events++;
  }

  boss(t: number, r: number, state: ReplayBossState): void {
    this.rec(REPLAY_REC.BOSS, t, 3);
    this.u16(r);
    const c = REPLAY_BOSS_STATES.indexOf(state);
    this.u8(c < 0 ? NO_CODE : c);
    this.events++;
  }

  wipe(t: number): void {
    this.rec(REPLAY_REC.WIPE, t, 0);
    this.events++;
  }

  /** Close the chunk (END record). */
  end(endMs: number, final: boolean): void {
    this.ensure(6);
    this.u8(REPLAY_REC.END);
    this.u32(Math.max(0, Math.round(endMs)));
    this.u8(final ? 1 : 0);
  }

  /** A copy of the chunk written so far. */
  bytes(): Uint8Array {
    return this.buf.slice(0, this.n);
  }
}

/** Quantized row of an entity as one comparable key (x, y, aim, hp, flags, act). */
function entSig(e: ReplayEnt): string {
  return `${qPos(e.x)},${qPos(e.y)},${qAim(e.aim)},${e.hp},${entFlags(e)},${e.act}`;
}

interface PrevRow {
  x: number;
  y: number;
  sig: string;
}

function entFlags(e: ReplayEnt): number {
  return replayFlags(kindCode(e.kind), e.alive, e.extracted, e.connected, e.dormant, e.extracting);
}

function writeEvent(enc: ReplayEncoder, e: ReplayEvent): void {
  switch (e.type) {
    case "spawn":
      return enc.spawn(e.t, e.spawn);
    case "shot":
      return enc.shot(e.t, e.r, e.weapon, e.x, e.y, e.angles);
    case "hit":
      return enc.hit(e.t, e.src, e.target, e.dmg, e.armor);
    case "kill":
      return enc.kill(e.t, e.victim, e.killer, e.weapon);
    case "exit":
      return enc.exit(e.t, e.r, e.exit, e.extractId);
    case "chest":
      return enc.chest(e.t, e.r, e.idx);
    case "loot":
      return enc.loot(e.t, e.r, e.target, e.id);
    case "boss":
      return enc.boss(e.t, e.r, e.state);
    case "wipe":
      return enc.wipe(e.t);
  }
}

/**
 * Whole-chunk encoder (tests, tools). Frames must be full (every runtime on the map, ascending r)
 * and in time order, events in time order; the first frame becomes a KEY frame, the rest DELTA
 * frames. decodeReplayChunk(encodeReplayChunk(c)) deep-equals c when every value already sits on
 * its quantum (x / y on POS_UNIT_PX, aim on 2π/256, angles on 2π/65536, dmg on 0.1, hp 0..255).
 */
export function encodeReplayChunk(c: ReplayChunkData): Uint8Array {
  const enc = new ReplayEncoder();
  enc.begin(c.seq, c.startMs);
  enc.roster(c.roster);
  let ei = 0;
  let prev: Map<number, PrevRow> | null = null;
  for (const f of c.frames) {
    while (ei < c.events.length && c.events[ei]!.t <= f.t) writeEvent(enc, c.events[ei++]!);
    const key = prev === null;
    const cur = new Map<number, PrevRow>();
    const listed = new Set<number>();
    enc.frameBegin(f.t, key);
    for (const e of f.ents) {
      const row: PrevRow = { x: qPos(e.x), y: qPos(e.y), sig: entSig(e) };
      const before = key ? undefined : prev!.get(e.r);
      listed.add(e.r);
      if (!before || before.sig !== row.sig) {
        enc.ent(e.r, row.x, row.y, qAim(e.aim), e.hp & 0xff, entFlags(e), e.act & 0xff, before?.x ?? -1, before?.y ?? -1);
      }
      if (e.alive && !e.extracted) cur.set(e.r, row);
    }
    const removed = key ? [] : [...prev!.keys()].filter((r) => !listed.has(r));
    enc.frameEnd(removed);
    prev = cur;
  }
  while (ei < c.events.length) writeEvent(enc, c.events[ei++]!);
  enc.end(c.endMs, c.final);
  return enc.bytes();
}

// ------------------------------------------------------------------------------- decoder

export class ReplayFormatError extends Error {
  constructor(message: string) {
    super(`replay: ${message}`);
    this.name = "ReplayFormatError";
  }
}

class Reader {
  private readonly dv: DataView;
  p = 0;
  constructor(readonly b: Uint8Array) {
    this.dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  }
  get left(): number {
    return this.b.length - this.p;
  }
  need(n: number): void {
    if (this.p + n > this.b.length) throw new ReplayFormatError(`truncated at byte ${this.p}`);
  }
  u8(): number {
    this.need(1);
    return this.b[this.p++]!;
  }
  u16(): number {
    this.need(2);
    const v = this.dv.getUint16(this.p, true);
    this.p += 2;
    return v;
  }
  u32(): number {
    this.need(4);
    const v = this.dv.getUint32(this.p, true);
    this.p += 4;
    return v;
  }
  str(): string {
    const len = this.u8();
    this.need(len);
    const end = this.p + len;
    let s = "";
    while (this.p < end) {
      const a = this.b[this.p++]!;
      let c: number;
      if (a < 0x80) c = a;
      else if (a >= 0xc0 && a < 0xe0 && this.p < end) c = ((a & 0x1f) << 6) | (this.b[this.p++]! & 0x3f);
      else if (a >= 0xe0 && a < 0xf0 && this.p + 1 < end) {
        c = ((a & 0x0f) << 12) | ((this.b[this.p]! & 0x3f) << 6) | (this.b[this.p + 1]! & 0x3f);
        this.p += 2;
      } else if (a >= 0xf0 && a < 0xf8 && this.p + 2 < end) {
        c = ((a & 0x07) << 18) | ((this.b[this.p]! & 0x3f) << 12) | ((this.b[this.p + 1]! & 0x3f) << 6) | (this.b[this.p + 2]! & 0x3f);
        this.p += 3;
      } else throw new ReplayFormatError(`bad UTF-8 at byte ${this.p - 1}`);
      if (c > 0x10ffff) throw new ReplayFormatError(`bad code point at byte ${this.p}`);
      s += String.fromCodePoint(c);
    }
    return s;
  }
}

function enumAt<T>(list: readonly T[], code: number, what: string): T {
  const v = list[code];
  if (v === undefined) throw new ReplayFormatError(`unknown ${what} code ${code}`);
  return v;
}

const weaponAt = (code: number): WeaponId | "" => (code === NO_CODE ? "" : enumAt(REPLAY_WEAPONS, code, "weapon"));
const refAt = (v: number): number => (v === NO_REF ? -1 : v);

function readSpawn(rd: Reader): ReplaySpawn {
  const r = rd.u16();
  const kind = enumAt(REPLAY_KINDS, rd.u8(), "kind");
  const maxHp = rd.u16();
  const color = rd.u8();
  const level = rd.u16();
  const guest = (rd.u8() & 1) === 1;
  return { r, kind, maxHp, color, level, guest, nickname: rd.str(), userId: rd.str(), entryId: rd.str(), partyId: rd.str() };
}

/**
 * The rows of one frame (columns), applied to `onMap` (r → row; KEY frames replace it). Positions
 * are kept in POS_UNIT_PX units while decoding (exact integers), scaled on output.
 */
function readFrameRows(rd: Reader, key: boolean, onMap: Map<number, ReplayEnt>): void {
  const n = rd.u16();
  if (n > MAX_FRAME_ENTS) throw new ReplayFormatError(`frame of ${n} runtimes`);
  rd.need(n * 8);
  const base = rd.p;
  const b = rd.b;
  const rs: number[] = new Array(n);
  for (let i = 0; i < n; i++) rs[i] = b[base + i * 2]! | (b[base + i * 2 + 1]! << 8);
  const fAt = base + n * 2;
  const dxAt = fAt + n;
  const dyAt = dxAt + n;
  const aAt = dyAt + n;
  const hpAt = aAt + n;
  const actAt = hpAt + n;
  rd.p = actAt + n;
  let k = 0;
  for (let i = 0; i < n; i++) if (b[fAt + i]! & ABS) k++;
  rd.need(k * 4);
  const axAt = rd.p;
  const ayAt = axAt + k * 2;
  rd.p = ayAt + k * 2;
  if (key) onMap.clear();
  let j = 0;
  for (let i = 0; i < n; i++) {
    const r = rs[i]!;
    const f = b[fAt + i]!;
    let qx: number;
    let qy: number;
    if (f & ABS) {
      qx = b[axAt + j * 2]! | (b[axAt + j * 2 + 1]! << 8);
      qy = b[ayAt + j * 2]! | (b[ayAt + j * 2 + 1]! << 8);
      j++;
    } else {
      if (key) throw new ReplayFormatError(`key frame row ${r} without an absolute position`);
      const before = onMap.get(r);
      if (!before) throw new ReplayFormatError(`delta row ${r} without a previous row`);
      qx = before.x / REPLAY.POS_UNIT_PX + ((b[dxAt + i]! << 24) >> 24);
      qy = before.y / REPLAY.POS_UNIT_PX + ((b[dyAt + i]! << 24) >> 24);
      if (qx < 0 || qx > 0xffff || qy < 0 || qy > 0xffff) throw new ReplayFormatError(`row ${r} moved off the u16 range`);
    }
    onMap.set(r, {
      r,
      kind: REPLAY_KINDS[(f >> KIND_SHIFT) & KIND_MASK]!,
      x: qx * REPLAY.POS_UNIT_PX,
      y: qy * REPLAY.POS_UNIT_PX,
      aim: (b[aAt + i]! * TAU) / 256,
      hp: b[hpAt + i]!,
      alive: (f & REPLAY_FLAG.ALIVE) !== 0,
      extracted: (f & REPLAY_FLAG.EXTRACTED) !== 0,
      connected: (f & REPLAY_FLAG.CONNECTED) !== 0,
      dormant: (f & REPLAY_FLAG.DORMANT) !== 0,
      extracting: (f & REPLAY_FLAG.EXTRACTING) !== 0,
      act: b[actAt + i]!,
    });
  }
}

/** The fixed header of a chunk (cheap check of an upload without decoding it). */
export function readReplayHeader(bytes: Uint8Array): { v: number; seq: number; startMs: number } {
  const rd = new Reader(bytes);
  rd.need(13);
  for (const b of MAGIC) if (rd.u8() !== b) throw new ReplayFormatError("bad magic");
  const v = rd.u8();
  if (v !== REPLAY.VERSION) throw new ReplayFormatError(`unsupported version ${v}`);
  return { v, seq: rd.u32(), startMs: rd.u32() };
}

/**
 * Strict decoder of one uncompressed chunk: unknown records, bad enum codes, truncation and
 * trailing bytes throw ReplayFormatError. Frames come back full (deltas applied).
 */
export function decodeReplayChunk(bytes: Uint8Array): ReplayChunkData {
  if (bytes.length > REPLAY.MAX_RAW_BYTES) throw new ReplayFormatError(`chunk of ${bytes.length} bytes is too large`);
  const head = readReplayHeader(bytes);
  const rd = new Reader(bytes);
  rd.p = 13;
  if (rd.u8() !== REPLAY_REC.ROSTER) throw new ReplayFormatError("roster record missing");
  const roster: ReplaySpawn[] = [];
  for (let i = 0, n = rd.u16(); i < n; i++) roster.push(readSpawn(rd));
  const frames: ReplayFrame[] = [];
  const events: ReplayEvent[] = [];
  const onMap = new Map<number, ReplayEnt>();
  let keySeen = false;
  for (;;) {
    const type = rd.u8();
    if (type === REPLAY_REC.END) {
      const endMs = rd.u32();
      const final = rd.u8() === 1;
      if (rd.left !== 0) throw new ReplayFormatError(`${rd.left} bytes after END`);
      return { v: head.v, seq: head.seq, startMs: head.startMs, endMs, final, roster, frames, events };
    }
    const t = rd.u32();
    switch (type) {
      case REPLAY_REC.KEY:
      case REPLAY_REC.DELTA: {
        if (type === REPLAY_REC.DELTA && !keySeen) throw new ReplayFormatError("delta frame before a key frame");
        keySeen = true;
        readFrameRows(rd, type === REPLAY_REC.KEY, onMap);
        for (let i = 0, m = rd.u16(); i < m; i++) onMap.delete(rd.u16());
        const ents = [...onMap.values()].sort((a, b) => a.r - b.r);
        frames.push({ t, ents });
        for (const e of ents) if (!e.alive || e.extracted) onMap.delete(e.r);
        break;
      }
      case REPLAY_REC.SPAWN:
        events.push({ t, type: "spawn", spawn: readSpawn(rd) });
        break;
      case REPLAY_REC.SHOT: {
        const r = rd.u16();
        const weapon = weaponAt(rd.u8());
        const x = rd.u16() * REPLAY.POS_UNIT_PX;
        const y = rd.u16() * REPLAY.POS_UNIT_PX;
        const angles: number[] = [];
        for (let i = 0, n = rd.u8(); i < n; i++) angles.push((rd.u16() * TAU) / 65536);
        events.push({ t, type: "shot", r, weapon, x, y, angles });
        break;
      }
      case REPLAY_REC.HIT: {
        const src = refAt(rd.u16());
        const target = rd.u16();
        const dmg = rd.u16() / 10;
        events.push({ t, type: "hit", src, target, dmg, armor: rd.u8() === 1 });
        break;
      }
      case REPLAY_REC.KILL: {
        const victim = rd.u16();
        const killer = refAt(rd.u16());
        events.push({ t, type: "kill", victim, killer, weapon: weaponAt(rd.u8()) });
        break;
      }
      case REPLAY_REC.EXIT: {
        const r = rd.u16();
        const exit = enumAt(REPLAY_EXITS, rd.u8(), "exit");
        events.push({ t, type: "exit", r, exit, extractId: rd.str() });
        break;
      }
      case REPLAY_REC.CHEST: {
        const r = rd.u16();
        events.push({ t, type: "chest", r, idx: rd.u16() });
        break;
      }
      case REPLAY_REC.LOOT: {
        const r = rd.u16();
        const k = rd.u8();
        if (k > 1) throw new ReplayFormatError(`unknown loot target ${k}`);
        events.push({ t, type: "loot", r, target: k === 1 ? "corpse" : "container", id: rd.u16() });
        break;
      }
      case REPLAY_REC.BOSS: {
        const r = rd.u16();
        events.push({ t, type: "boss", r, state: enumAt(REPLAY_BOSS_STATES, rd.u8(), "boss state") });
        break;
      }
      case REPLAY_REC.WIPE:
        events.push({ t, type: "wipe" });
        break;
      default:
        throw new ReplayFormatError(`unknown record ${type} at byte ${rd.p - 5}`);
    }
  }
}
