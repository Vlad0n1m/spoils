/**
 * Colyseus-independent simulation of one match. Owns a BattleState and advances it with
 * step(dtMs); the room only feeds intents in and forwards drained events out. All randomness
 * goes through `rng` and all item ids through `newUid`, so tests can run whole matches
 * deterministically without a network.
 */

import { randomUUID, randomInt } from "node:crypto";
import {
  BattleState,
  Chest,
  Extract,
  FREE_KIT,
  INPUT_DT_MS,
  MATCH,
  MAX_QUEUED_INPUTS,
  PLAYER,
  Player,
  WEAPONS,
  WeaponSlot,
  applyMovement,
  buildCollisionIndex,
  generateMap,
  getCollisionIndex,
  mulberry32,
  sanitizeInput,
  type CollisionIndex,
  type ExitType,
  type HealKind,
  type ItemRef,
  type MapData,
  type MatchSettlementPayload,
  type OutcomeMsg,
  type Player as PlayerT,
  type Rng,
} from "@extract/shared";
import { finishHealIfDue, finishReloadIfDue, startHeal, startReload, switchSlot } from "./actions.js";
import { BotBrain } from "./bot.js";
import { stepBullets, tryFire } from "./combat.js";
import { stepExtraction, timeoutPlayer } from "./extraction.js";
import { autoPickup, interact, rollChest, rollFloorLoot, spawnGroundItem } from "./inventory.js";
import type { Bullet, LootDrop, MatchEvent, PlayerRuntime, RosterEntry } from "./types.js";

/**
 * Most movement time a player can bank while sending nothing. Spending is capped by real time
 * elapsed, so on average nobody moves faster than PLAYER.SPEED; this bounds the catch-up burst
 * after a network hiccup to ~6 inputs.
 */
export const MAX_ALLOWANCE_MS = 200;
/** A frozen event loop must not turn into one giant simulation step. */
const MAX_STEP_MS = 250;

export interface MatchOptions {
  roster: RosterEntry[];
  rng?: Rng;
  mapSeed?: number;
  /** Tests: a hand-made map instead of generateMap(mapSeed). */
  map?: MapData;
  newUid?: () => string;
  now?: () => number;
  /** Bots get a BotBrain (default true). Rule tests drive bot players by hand. */
  botBrains?: boolean;
  /** Skip chests/extracts/floor loot from the map (rule tests place their own). */
  emptyWorld?: boolean;
}

export class Match {
  readonly state = new BattleState();
  readonly map: MapData;
  readonly idx: CollisionIndex;
  rng: Rng;
  readonly newUid: () => string;
  private readonly now: () => number;

  /** Every valuable item ever created in this match, by uid. */
  readonly ledger = new Map<string, ItemRef>();
  /** Pre-rolled contents of chests not opened yet. */
  readonly chestContents = new Map<string, LootDrop[]>();
  bullets: Bullet[] = [];
  readonly bots: BotBrain[] = [];

  private readonly runtimes = new Map<string, PlayerRuntime>();
  private readonly ordered: PlayerRuntime[] = [];
  private events: MatchEvent[] = [];
  private entitySeq = 0;
  private readonly hasHumans: boolean;
  settlement: MatchSettlementPayload | null = null;

  constructor(opts: MatchOptions) {
    this.rng = opts.rng ?? mulberry32(randomInt(0, 2 ** 32 - 1));
    this.newUid = opts.newUid ?? randomUUID;
    this.now = opts.now ?? Date.now;
    const seed = opts.mapSeed ?? Math.floor(this.rng() * 2 ** 32) >>> 0;

    if (opts.map) {
      this.map = opts.map;
      this.idx = buildCollisionIndex(
        { rects: [...opts.map.walls, ...opts.map.crates], circles: [...opts.map.rocks, ...opts.map.trees] },
        opts.map.width,
        opts.map.height,
      );
    } else {
      this.map = generateMap(seed);
      this.idx = getCollisionIndex(this.map);
    }

    this.state.matchId = this.newUid();
    this.state.mapSeed = this.map.seed >>> 0;
    this.state.phase = "drop";
    this.state.startedAt = this.now();
    this.state.clockMs = 0;
    this.state.durationMs = MATCH.DURATION_MS;
    this.hasHumans = opts.roster.some((r) => !r.isBot);

    if (!opts.emptyWorld) this.setupWorld();
    this.setupPlayers(opts.roster, opts.botBrains ?? true);
  }

  get clock(): number {
    return this.state.clockMs;
  }

  get ended(): boolean {
    return this.settlement !== null;
  }

  newEntityId(prefix: string): string {
    return `${prefix}${(this.entitySeq++).toString(36)}`;
  }

  emit(e: MatchEvent): void {
    this.events.push(e);
  }

  drainEvents(): MatchEvent[] {
    const out = this.events;
    this.events = [];
    return out;
  }

  runtime(id: string): PlayerRuntime | undefined {
    return this.runtimes.get(id);
  }

  allRuntimes(): readonly PlayerRuntime[] {
    return this.ordered;
  }

  player(id: string): PlayerT | undefined {
    return this.state.players.get(id);
  }

  // ---------------------------------------------------------------- setup

  private setupWorld(): void {
    this.map.chestSpots.forEach((spot, i) => {
      const c = new Chest();
      c.id = `c${i}`;
      c.x = spot.x;
      c.y = spot.y;
      c.rarity = spot.rarity;
      this.state.chests.set(c.id, c);
      this.chestContents.set(c.id, rollChest(this, spot.rarity));
    });

    const closing = new Set(
      shuffle(this.rng, this.map.extractSpots.map((_, i) => i)).slice(
        0,
        Math.floor(this.map.extractSpots.length * MATCH.EXTRACT_CLOSE_EARLY_FRACTION),
      ),
    );
    this.map.extractSpots.forEach((spot, i) => {
      const e = new Extract();
      e.id = `e${i}`;
      e.x = spot.x;
      e.y = spot.y;
      e.r = spot.r;
      e.openAt = MATCH.EXTRACT_OPEN_AT_MS;
      e.closeAt = closing.has(i) ? MATCH.DURATION_MS * MATCH.EXTRACT_CLOSE_EARLY_AT : 0;
      this.state.extracts.set(e.id, e);
    });

    for (const spot of this.map.lootSpots) {
      spawnGroundItem(this, rollFloorLoot(this), spot.x, spot.y);
    }
  }

  private setupPlayers(roster: RosterEntry[], botBrains: boolean): void {
    const spawns = shuffle(this.rng, [...this.map.spawnSpots]);
    const colors = shuffle(this.rng, Array.from({ length: Math.max(16, roster.length) }, (_, i) => i));
    roster.forEach((entry, i) => {
      const id = entry.isBot ? `bot${i}` : `pending${i}`;
      const spawn = spawns[i % Math.max(1, spawns.length)] ?? { x: this.map.width / 2, y: this.map.height / 2 };
      // More players than spawn spots only happens in tests; spread the extras out a little.
      const lap = Math.floor(i / Math.max(1, spawns.length));
      const p = new Player();
      p.sessionId = id;
      p.userId = entry.userId ?? "";
      p.nickname = entry.nickname;
      p.isBot = entry.isBot;
      p.color = colors[i]! % 256;
      p.x = spawn.x + lap * PLAYER.RADIUS * 2.5;
      p.y = spawn.y;
      p.hp = PLAYER.MAX_HP;
      p.alive = true;
      giveFreeKit(p);
      this.state.players.set(id, p);

      const rt: PlayerRuntime = {
        id,
        rosterIndex: i,
        userId: entry.isBot ? null : entry.userId,
        nickname: entry.nickname,
        isBot: entry.isBot,
        connected: false,
        queue: [],
        lastQueuedSeq: -1,
        allowanceMs: 0,
        triggerHeld: false,
        pressPending: false,
        pressAt: 0,
        nextFireAt: 0,
        reloadSlot: 0,
        exit: null,
        extracted: [],
        lost: [],
        dropped: [],
        killedBy: "",
        outcome: null,
      };
      this.runtimes.set(id, rt);
      this.ordered.push(rt);
      if (entry.isBot && botBrains) this.bots.push(new BotBrain(this, rt));
    });
  }

  // ---------------------------------------------------------------- connections

  /**
   * A human (re)connects: their roster player is re-keyed to the client's sessionId so the client
   * finds itself via state.players.get(room.sessionId). The input seq restarts with the new client.
   */
  attachHuman(userId: string, sessionId: string): PlayerRuntime | null {
    const rt = this.ordered.find((r) => !r.isBot && r.userId === userId);
    if (!rt) return null;
    if (rt.id !== sessionId) {
      const p = this.state.players.get(rt.id);
      if (!p) return null;
      this.state.players.delete(rt.id);
      this.runtimes.delete(rt.id);
      p.sessionId = sessionId;
      rt.id = sessionId;
      this.state.players.set(sessionId, p);
      this.runtimes.set(sessionId, rt);
    }
    rt.connected = true;
    rt.queue.length = 0;
    rt.lastQueuedSeq = -1;
    rt.triggerHeld = false;
    rt.pressPending = false;
    const p = this.state.players.get(sessionId);
    if (p) p.lastSeq = 0;
    return rt;
  }

  /** Disconnected players stay on the map, idle and vulnerable. */
  detach(sessionId: string): void {
    const rt = this.runtimes.get(sessionId);
    if (!rt) return;
    rt.connected = false;
    rt.queue.length = 0;
    rt.triggerHeld = false;
    rt.pressPending = false;
  }

  // ---------------------------------------------------------------- intents

  enqueueInput(id: string, raw: unknown): boolean {
    const rt = this.runtimes.get(id);
    const p = this.state.players.get(id);
    if (!rt || !p?.alive || this.ended) return false;
    const input = sanitizeInput(raw);
    if (!input || input.seq <= rt.lastQueuedSeq) return false;
    rt.lastQueuedSeq = input.seq;
    rt.queue.push(input);
    if (rt.queue.length > MAX_QUEUED_INPUTS) rt.queue.splice(0, rt.queue.length - MAX_QUEUED_INPUTS);
    return true;
  }

  interact(id: string): boolean {
    const { rt, p } = this.actor(id);
    return rt && p ? interact(this, rt, p) : false;
  }

  reload(id: string): boolean {
    const { rt, p } = this.actor(id);
    return rt && p ? startReload(this, rt, p) : false;
  }

  switchSlot(id: string, slot: number): boolean {
    const { rt, p } = this.actor(id);
    return rt && p ? switchSlot(rt, p, slot) : false;
  }

  heal(id: string, kind: HealKind): boolean {
    const { p } = this.actor(id);
    return p ? startHeal(this, p, kind) : false;
  }

  private actor(id: string): { rt?: PlayerRuntime; p?: PlayerT } {
    if (this.ended) return {};
    const rt = this.runtimes.get(id);
    const p = this.state.players.get(id);
    if (!rt || !p?.alive) return {};
    return { rt, p };
  }

  // ---------------------------------------------------------------- simulation

  step(dtMs: number): void {
    if (this.ended) return;
    const dt = Math.max(0, Math.min(MAX_STEP_MS, dtMs));
    this.state.clockMs = Math.min(this.clock + dt, MATCH.DURATION_MS);
    this.state.phase = this.clock >= MATCH.EXTRACT_OPEN_AT_MS ? "open" : "drop";

    for (const bot of this.bots) bot.update(dt);

    for (const rt of this.ordered) {
      const p = this.state.players.get(rt.id);
      if (!p?.alive) continue;
      finishReloadIfDue(this, rt, p);
      finishHealIfDue(this, p);
      this.applyInputs(rt, p, dt);
    }

    stepBullets(this, dt);

    for (const p of this.state.players.values()) {
      if (p.alive) autoPickup(this, p);
    }

    stepExtraction(this);

    const alive = [...this.state.players.values()].filter((p) => p.alive);
    const humansAlive = alive.some((p) => !p.isBot);
    // A bots-only match (tests, demo) runs until nobody is left; otherwise it ends with the last human.
    if (this.clock >= MATCH.DURATION_MS || (this.hasHumans ? !humansAlive : alive.length === 0)) {
      this.end();
    }
  }

  private applyInputs(rt: PlayerRuntime, p: PlayerT, dt: number): void {
    rt.allowanceMs = Math.min(rt.allowanceMs + dt, MAX_ALLOWANCE_MS);
    while (rt.queue.length > 0 && rt.allowanceMs + 1e-6 >= INPUT_DT_MS) {
      const input = rt.queue.shift()!;
      rt.allowanceMs -= INPUT_DT_MS;
      const mult = p.healUntil > 0 ? PLAYER.HEAL_SPEED_MULT : 1;
      const pos = applyMovement(this.idx, p.x, p.y, input, mult);
      p.x = pos.x;
      p.y = pos.y;
      p.aim = input.aim;
      if (input.fire && !rt.triggerHeld) {
        rt.pressPending = true;
        rt.pressAt = this.clock;
      }
      rt.triggerHeld = input.fire;
      p.lastSeq = input.seq;
      tryFire(this, rt, p);
      if (!p.alive) break;
    }
  }

  /** Records the player's exit and sends their personal outcome (humans only). */
  finishPlayer(rt: PlayerRuntime, exit: ExitType): void {
    rt.exit = exit;
    const p = this.state.players.get(rt.id);
    const msg: OutcomeMsg = {
      matchId: this.state.matchId,
      exit,
      extracted: exit === "extract" ? [...rt.extracted] : [],
      lost: [...rt.lost],
      dropped: [...rt.dropped],
      kills: p?.kills ?? 0,
      killedBy: rt.killedBy,
      atMs: this.clock,
    };
    rt.outcome = msg;
    if (!rt.isBot) this.emit({ type: "outcome", to: rt.id, msg });
  }

  private end(): void {
    for (const rt of this.ordered) {
      const p = this.state.players.get(rt.id);
      if (p?.alive) timeoutPlayer(this, rt, p);
    }
    this.bullets = [];
    this.state.phase = "ended";
    this.settlement = {
      matchId: this.state.matchId,
      mapSeed: this.state.mapSeed,
      startedAt: this.state.startedAt,
      endedAt: this.now(),
      participants: this.ordered.map((rt) => ({
        userId: rt.isBot ? null : rt.userId,
        nickname: rt.nickname,
        isBot: rt.isBot,
        exitType: rt.exit ?? "timeout",
        kills: this.state.players.get(rt.id)?.kills ?? 0,
        extracted: [...rt.extracted],
        lost: [...rt.lost],
      })),
    };
    this.emit({ type: "ended", settlement: this.settlement });
  }
}

export function giveFreeKit(p: PlayerT): void {
  p.slots.clear();
  const pistol = new WeaponSlot();
  pistol.weapon = FREE_KIT.WEAPON;
  pistol.mag = WEAPONS[FREE_KIT.WEAPON].magSize;
  pistol.free = true;
  p.slots.push(pistol);
  p.slots.push(new WeaponSlot());
  p.active = 0;
  p.ammoLight = FREE_KIT.AMMO_LIGHT;
  p.ammoShell = 0;
  p.ammoHeavy = 0;
  p.bandages = FREE_KIT.BANDAGES;
  p.medkits = 0;
  p.armor = 0;
  p.armorDur = 0;
  p.armorUid = "";
}

export function shuffle<T>(rng: Rng, arr: T[]): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j]!, arr[i]!];
  }
  return arr;
}
