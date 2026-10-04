/**
 * Admin replay recorder (format: @extract/shared replay.ts). One per world shard: BattleRoom.tick
 * hands it the tick's drained sim events after Match.step, and it writes
 *   - a SPAWN for every new runtime (humans with userId / nickname / entry / party; NPCs by kind),
 *   - the replay-relevant events (shots, hits, kills, human exits, containers opened, searches that
 *     got ready, supply drops and hot zones (WEV, world-events.ts), the wipe),
 *   - a frame of every runtime every REPLAY.FRAME_MS of cycle clock (the first of a chunk a KEY frame,
 *     then only the rows that changed), and the event boss brain state when it changes,
 * into one ReplayEncoder. About every REPLAY.CHUNK_MS (or at REPLAY.SEAL_RAW_BYTES, the wipe, or the
 * room closing) the chunk is sealed and handed to `onChunk` (world/replay-upload.ts compresses and
 * posts it off the tick).
 *
 * The recorder only reads the Match. It never throws into the tick: an error drops the chunk being
 * written (its seq is skipped, so the gap shows), the next frame starts a fresh chunk with a KEY
 * frame, and after MAX_ERRORS errors the shard stops recording (logged).
 */

import {
  NPC_ROLE,
  REPLAY,
  ReplayEncoder,
  qAim,
  qHp,
  qPos,
  replayFlags,
  type ReplayBossState,
  type ReplayKind,
  type ReplaySpawn,
} from "@extract/shared";
import type { Match } from "./match.js";
import type { MatchEvent, PlayerRuntime } from "./types.js";

/** One sealed chunk (uncompressed). */
export interface SealedReplayChunk {
  seq: number;
  startMs: number;
  endMs: number;
  frames: number;
  events: number;
  /** Human entries on the shard so far. */
  entries: number;
  final: boolean;
  raw: Uint8Array;
}

export interface ReplayRecorderOptions {
  onChunk(chunk: SealedReplayChunk): void;
  frameMs?: number;
  chunkMs?: number;
  sealRawBytes?: number;
  log?: (msg: string, err?: unknown) => void;
}

/** Errors after which a shard stops recording. */
export const MAX_ERRORS = 5;

/** Cycle clock as whole ms (chunk windows and record times are integers). */
const clockMs = (m: Match): number => Math.max(0, Math.round(m.clock));

const KINDS: readonly ReplayKind[] = ["human", "boss", "guard", "marauder"];
const BOSS_STATES: readonly ReplayBossState[] = ["idle", "suspicious", "combat", "search", "return", "cover"];

export class ReplayRecorder {
  private readonly enc = new ReplayEncoder(256 * 1024);
  private readonly frameMs: number;
  private readonly chunkMs: number;
  private readonly sealRawBytes: number;
  private readonly onChunk: (c: SealedReplayChunk) => void;
  private readonly log: (msg: string, err?: unknown) => void;

  /** Last written quantized row per roster index; onMap = listed and still on the map. */
  private readonly px: Uint16Array;
  private readonly py: Uint16Array;
  private readonly pa: Uint8Array;
  private readonly php: Uint8Array;
  private readonly pf: Uint8Array;
  private readonly pact: Uint8Array;
  private readonly onMap: Uint8Array;
  private readonly spawns: ReplaySpawn[] = [];
  private readonly bossState = new Map<number, ReplayBossState>();

  private started = false;
  private open = false;
  private finished = false;
  private disabled = false;
  private keyNext = true;
  private seq = 0;
  private chunkStart = 0;
  private nextFrameAt = 0;
  private entries = 0;
  private lastFrameAt = -1;

  readonly stats = { ticks: 0, frames: 0, chunks: 0, errors: 0, droppedChunks: 0 };

  constructor(
    private readonly m: Match,
    opts: ReplayRecorderOptions,
  ) {
    this.frameMs = opts.frameMs ?? REPLAY.FRAME_MS;
    this.chunkMs = opts.chunkMs ?? REPLAY.CHUNK_MS;
    this.sealRawBytes = opts.sealRawBytes ?? REPLAY.SEAL_RAW_BYTES;
    this.onChunk = opts.onChunk;
    this.log = opts.log ?? ((msg, err) => (err === undefined ? console.error(msg) : console.error(msg, err)));
    const cap = Math.max(1, m.runtimeCapacity);
    this.px = new Uint16Array(cap);
    this.py = new Uint16Array(cap);
    this.pa = new Uint8Array(cap);
    this.php = new Uint8Array(cap);
    this.pf = new Uint8Array(cap);
    this.pact = new Uint8Array(cap);
    this.onMap = new Uint8Array(cap);
  }

  /** The last chunk was sealed (wipe or close) or recording stopped. */
  get done(): boolean {
    return this.finished || this.disabled;
  }

  /** After Match.step and drainEvents, once per room tick. Never throws. */
  tick(events: readonly MatchEvent[]): void {
    if (this.finished || this.disabled) return;
    try {
      this.step(events);
    } catch (e) {
      this.fail(e);
    }
  }

  /** The room is closing: seal what was recorded as the final chunk. Never throws. */
  close(): void {
    if (this.finished || this.disabled || !this.started) {
      this.finished = true;
      return;
    }
    try {
      const t = clockMs(this.m);
      if (!this.open) this.begin(t);
      this.seal(t, true);
    } catch (e) {
      this.fail(e);
    }
    this.finished = true;
  }

  private step(events: readonly MatchEvent[]): void {
    const m = this.m;
    if (!this.started) {
      // A prewarmed shard idles (clock 0) until its cycle starts: nothing to record yet.
      if (!m.world || m.now() < m.world.cycleStartsAt) return;
      this.started = true;
      this.nextFrameAt = m.clock;
    }
    this.stats.ticks++;
    const t = clockMs(m);
    const frameDue = t >= this.nextFrameAt;
    if (this.open && frameDue && (t - this.chunkStart >= this.chunkMs || this.enc.size >= this.sealRawBytes)) this.seal(t, false);
    if (!this.open) this.begin(t);
    this.spawnNew(t);
    let wiped = false;
    for (const ev of events) if (this.event(t, ev)) wiped = true;
    if (frameDue || wiped || m.ended) {
      this.frame(t);
      while (this.nextFrameAt <= t) this.nextFrameAt += this.frameMs;
    }
    if (wiped || m.ended) {
      if (!wiped) this.enc.wipe(t);
      this.seal(t, true);
      this.finished = true;
    }
  }

  private begin(t: number): void {
    this.enc.begin(this.seq, t);
    this.enc.roster(this.spawns);
    this.chunkStart = t;
    this.open = true;
    this.keyNext = true;
  }

  private seal(t: number, final: boolean): void {
    this.enc.end(t, final);
    const chunk: SealedReplayChunk = {
      seq: this.seq,
      startMs: this.chunkStart,
      endMs: t,
      frames: this.enc.frames,
      events: this.enc.events,
      entries: this.entries,
      final,
      raw: this.enc.bytes(),
    };
    this.seq++;
    this.open = false;
    this.stats.chunks++;
    this.onChunk(chunk);
  }

  private fail(e: unknown): void {
    this.stats.errors++;
    if (this.open) this.stats.droppedChunks++;
    // Drop the chunk being written; the next tick starts a fresh one (seq skipped) with a KEY frame.
    if (this.open) this.seq++;
    this.open = false;
    this.keyNext = true;
    if (this.stats.errors >= MAX_ERRORS) {
      this.disabled = true;
      this.log(`[replay ${this.m.state.matchId}] ${this.stats.errors} errors: recording stopped for this shard`, e);
    } else {
      this.log(`[replay ${this.m.state.matchId}] chunk dropped after an error`, e);
    }
  }

  /** SPAWN for every runtime added since the last tick (indexes only grow, D16). */
  private spawnNew(t: number): void {
    const rts = this.m.allRuntimes();
    while (this.spawns.length < rts.length) {
      const rt = rts[this.spawns.length]!;
      const s: ReplaySpawn = {
        r: rt.rosterIndex,
        kind: KINDS[rt.pub.role] ?? (rt.isNpc ? "marauder" : "human"),
        maxHp: rt.pub.maxHp,
        color: rt.pub.color,
        level: rt.level,
        guest: rt.guest,
        nickname: rt.nickname,
        userId: rt.userId ?? "",
        entryId: rt.entryId,
        partyId: rt.partyId,
      };
      this.spawns.push(s);
      if (!rt.isNpc && rt.entryId) this.entries++;
      this.enc.spawn(t, s);
    }
  }

  /** One drained sim event; true for the wipe. */
  private event(t: number, ev: MatchEvent): boolean {
    const enc = this.enc;
    switch (ev.type) {
      case "shot":
        enc.shot(t, ev.src, ev.msg.w, ev.msg.x, ev.msg.y, ev.msg.a);
        return false;
      case "hit":
        enc.hit(t, ev.src, ev.target, ev.msg.d, ev.msg.ar);
        return false;
      case "kill": {
        const victim = this.m.runtime(ev.msg.victimId);
        if (victim) enc.kill(t, victim.rosterIndex, ev.src, ev.msg.weapon);
        return false;
      }
      case "chest":
        enc.chest(t, ev.src, ev.idx);
        return false;
      case "view": {
        // A search session got past its open delay (c<idx> container, k<rosterIndex> corpse).
        if (ev.op !== "add") return false;
        const id = Number(ev.key.slice(1));
        if (!Number.isInteger(id) || id < 0 || id > 0xffff) return false;
        if (ev.key[0] === "k") enc.loot(t, ev.to, "corpse", id);
        else if (ev.key[0] === "c") enc.loot(t, ev.to, "container", id);
        return false;
      }
      case "exit": {
        const rt = ev.report.entryId ? this.m.entryById(ev.report.entryId) : this.m.currentOf(ev.report.userId);
        if (rt) enc.exit(t, rt.rosterIndex, ev.report.exit, ev.report.exit === "extract" ? this.extractAt(rt) : "");
        return false;
      }
      case "wev":
        enc.wev(t, ev.ev, ev.n, ev.x, ev.y, ev.r, ev.zone);
        return false;
      case "ended":
        enc.wipe(t);
        return true;
      default:
        return false;
    }
  }

  /** The extract zone a runtime stands in ("" if none: it left the zone the same tick). */
  private extractAt(rt: PlayerRuntime): string {
    let id = "";
    this.m.state.extracts.forEach((e) => {
      if (!id && (rt.pub.x - e.x) ** 2 + (rt.pub.y - e.y) ** 2 <= e.r * e.r) id = e.id;
    });
    return id;
  }

  /** One frame: every runtime on the map whose row changed (all of them in a KEY frame), plus leavers. */
  private frame(t: number): void {
    if (t === this.lastFrameAt && !this.keyNext) return;
    const key = this.keyNext;
    this.keyNext = false;
    this.lastFrameAt = t;
    const enc = this.enc;
    const { px, py, pa, php, pf, pact, onMap } = this;
    const cap = onMap.length;
    enc.frameBegin(t, key);
    for (const rt of this.m.allRuntimes()) {
      const i = rt.rosterIndex;
      if (i >= cap) continue;
      const p = rt.pub;
      if (!p.alive) {
        // Left since the last frame (died / extracted / MIA): one row with ALIVE cleared.
        if (onMap[i]) {
          const extracted = rt.self.extractedAt > 0;
          enc.ent(i, qPos(p.x), qPos(p.y), qAim(p.aim), 0, replayFlags(p.role, false, extracted, false, false, false), 0, px[i], py[i]);
          onMap[i] = 0;
        }
        continue;
      }
      const x = qPos(p.x);
      const y = qPos(p.y);
      const a = qAim(p.aim);
      const hp = qHp(p.hp, p.maxHp);
      const f = replayFlags(p.role, true, false, rt.connected, rt.dormant, rt.self.extractId !== "");
      const act = p.act & 0xff;
      if (key || !onMap[i] || px[i] !== x || py[i] !== y || pa[i] !== a || php[i] !== hp || pf[i] !== f || pact[i] !== act) {
        // A delta from its last row while it stays on the map (the encoder keeps KEY rows absolute).
        if (onMap[i]) enc.ent(i, x, y, a, hp, f, act, px[i], py[i]);
        else enc.ent(i, x, y, a, hp, f, act);
        px[i] = x;
        py[i] = y;
        pa[i] = a;
        php[i] = hp;
        pf[i] = f;
        pact[i] = act;
      }
      onMap[i] = 1;
    }
    enc.frameEnd();
    this.stats.frames++;
    this.bossStates(t);
  }

  /** BOSS record when a living boss's brain state changes (bosses only: a handful of runtimes). */
  private bossStates(t: number): void {
    for (const g of this.m.npcs.groups) {
      const rt = g.boss;
      if (!rt.pub.alive || rt.pub.role !== NPC_ROLE.BOSS) continue;
      const state = this.m.npcs.brain(rt)?.state;
      if (!state || !BOSS_STATES.includes(state as ReplayBossState)) continue;
      if (this.bossState.get(rt.rosterIndex) === state) continue;
      this.bossState.set(rt.rosterIndex, state as ReplayBossState);
      this.enc.boss(t, rt.rosterIndex, state as ReplayBossState);
    }
  }
}
