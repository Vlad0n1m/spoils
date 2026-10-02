import { Room, Client } from "@colyseus/core";
import {
  BattleState,
  Player,
  Orb,
  ENTRY_TIERS_CENTS,
  EXTRACT_CHANNEL_MS,
  LOCKIN_MS,
  MASS_UNITS_PER_CENT,
  ROUND_MS,
  SERVER_TICK_MS,
  WORLD,
  ORB,
  applyMultiplier,
  massUnitsToCents,
  payoutMultiplier,
  type ExitType,
  type MatchSettlementParticipant,
  type MatchSettlementPayload,
  type PlayerOutcomePayload,
} from "@extract/shared";
import { SpatialHash } from "../sim/spatial-hash.js";
import {
  initSnake,
  stepSnake,
  growSnake,
  syncBodyToMass,
  migrateSnakeTrail,
  clearSnakeTrail,
} from "../sim/snake.js";
import { BotController } from "../sim/bot.js";
import { postExtractCredit } from "../net/extract-credit.js";
import { postSettlement } from "../net/settle.js";
import { randomUUID } from "node:crypto";

interface RosterEntry {
  userId: string;
  nickname: string;
  isBot: boolean;
}

interface Participant {
  userId: string | null;
  nickname: string;
  isBot: boolean;
  /** Stake in US dollar cents. */
  entryCents: bigint;
  exitType: ExitType;
  exitOrder: number | null;
  /** Current mass in internal units; at extract, used for payout. */
  payoutMass: bigint;
  sessionId: string | null;
  /** Mirrors Player.extractStartedAt for payout rank (do not rely on Colyseus map only). */
  extractStartedAt: number;
  /** Mirrors Player.extractedAt when channel completes. */
  extractedAt: number;
  bot?: BotController;
}

interface CreateOptions {
  entryTierCents: string;
  roster: RosterEntry[];
}

export class BattleRoom extends Room<BattleState> {
  override autoDispose = false;
  override patchRate = 50; // 20 Hz state patches
  state = new BattleState();
  private entryTierCents = 0n;
  private participants = new Map<string, Participant>(); // key: userId or bot key
  private sessionToParticipant = new Map<string, Participant>();
  private settled = false;
  private lastTickAt = 0;

  override async onCreate(opts: CreateOptions) {
    const tierCents = BigInt(opts.entryTierCents);
    if (!ENTRY_TIERS_CENTS.includes(tierCents)) {
      throw new Error(`bad tier ${opts.entryTierCents}`);
    }
    const tierMass = tierCents * MASS_UNITS_PER_CENT;
    this.entryTierCents = tierCents;
    this.state.matchId = randomUUID();
    this.state.entryTierCents = tierCents.toString();
    this.state.startedAt = Date.now();
    this.state.zone.cx = 0;
    this.state.zone.cy = 0;
    this.state.zone.radius = WORLD.R0;
    this.state.phase = "lockin";
    this.state.clockMs = 0;
    this.state.nextExitOrder = 1;
    this.maxClients = opts.roster.filter((r) => !r.isBot).length || 1;

    for (const r of opts.roster) {
      const key = r.isBot ? `bot:${r.nickname}` : `user:${r.userId}`;
      this.participants.set(key, {
        userId: r.isBot ? null : r.userId,
        nickname: r.nickname,
        isBot: r.isBot,
        entryCents: tierCents,
        exitType: "timeout",
        exitOrder: null,
        payoutMass: 0n,
        sessionId: null,
        extractStartedAt: 0,
        extractedAt: 0,
      });
    }

    // Spawn snakes for everyone (humans get attached when they connect; bots immediately).
    let i = 0;
    const total = this.participants.size;
    for (const [key, part] of this.participants) {
      const angle = (i / Math.max(1, total)) * Math.PI * 2;
      const radius = WORLD.R0 * 0.4;
      const x = Math.cos(angle) * radius;
      const y = Math.sin(angle) * radius;
      const startMass =
        (tierMass * BigInt(Math.round((1 - WORLD.AMBIENT_ORB_FRACTION) * 1000))) / 1000n;
      const sessionId = part.isBot ? `bot:${randomUUID()}` : key;
      const player = new Player();
      player.sessionId = sessionId;
      player.userId = part.userId ?? "";
      player.nickname = part.nickname;
      player.isBot = part.isBot;
      initSnake(player, x, y, startMass, tierCents);
      this.state.players.set(sessionId, player);
      part.sessionId = sessionId;
      if (part.isBot) {
        part.bot = new BotController(sessionId);
        this.sessionToParticipant.set(sessionId, part);
      }
      i++;
    }

    // Spawn ambient orbs
    const ambientPool =
      (tierMass * BigInt(opts.roster.length) *
        BigInt(Math.round(WORLD.AMBIENT_ORB_FRACTION * 1000))) /
      1000n;
    let orbCount = opts.roster.length * WORLD.AMBIENT_ORBS_PER_PLAYER;
    if (orbCount < 1) orbCount = 1;
    if (ambientPool < BigInt(orbCount)) {
      orbCount = Number(ambientPool);
    }
    if (orbCount >= 1 && ambientPool > 0n) {
      this.spawnAmbientOrbs(ambientPool, orbCount);
    }

    this.onMessage("input", (client, raw) => this.handleInput(client, raw));
    this.onMessage("extract", (client) => this.handleExtractRequest(client));
    this.onMessage("ping", (client, raw) => {
      const t = typeof (raw as { t?: unknown })?.t === "number" ? (raw as { t: number }).t : null;
      if (t == null || !Number.isFinite(t)) return;
      client.send("pong", { t });
    });

    this.lastTickAt = Date.now();
    this.setSimulationInterval((dt) => this.update(dt), SERVER_TICK_MS);
  }

  override onJoin(client: Client, options: { userId: string }) {
    const p = this.participants.get(`user:${options.userId}`);
    if (!p) {
      client.leave(4001, "not_in_roster");
      return;
    }
    if (p.sessionId) {
      const oldSessionId = p.sessionId;
      const player = this.state.players.get(p.sessionId);
      if (player) {
        // re-key under client.sessionId so client receives state for self
        this.state.players.delete(p.sessionId);
        player.sessionId = client.sessionId;
        this.state.players.set(client.sessionId, player);
        p.sessionId = client.sessionId;
        migrateSnakeTrail(oldSessionId, client.sessionId);
      }
    }
    this.sessionToParticipant.set(client.sessionId, p);
    client.send("joined", {
      sessionId: client.sessionId,
      matchId: this.state.matchId,
    });
  }

  override onLeave(client: Client, _consented: boolean) {
    // Player keeps their snake on the field (still vulnerable). Common slither.io behavior.
    // No state mutation needed; bot of self could take over but we'll just freeze inputs.
  }

  private handleInput(client: Client, raw: any) {
    const p = this.sessionToParticipant.get(client.sessionId);
    if (!p?.sessionId) return;
    const player = this.state.players.get(p.sessionId);
    if (!player?.alive) return;
    if (
      typeof raw?.angle === "number" &&
      Number.isFinite(raw.angle) &&
      Math.abs(raw.angle) < 100
    ) {
      // wrap to [-PI, PI]
      let a = raw.angle;
      while (a > Math.PI) a -= Math.PI * 2;
      while (a < -Math.PI) a += Math.PI * 2;
      player.targetAngle = a;
    }
    if (typeof raw?.boost === "boolean") {
      player.boost = raw.boost;
    }
  }

  private handleExtractRequest(client: Client) {
    const p = this.sessionToParticipant.get(client.sessionId);
    if (!p?.sessionId) return;
    const player = this.state.players.get(p.sessionId);
    if (!player?.alive) return;
    if (this.state.phase !== "open") return;
    if (player.extractStartedAt > 0) return;
    const t0 = this.state.clockMs;
    player.extractStartedAt = t0;
    p.extractStartedAt = t0;
  }

  private update(dtMs: number) {
    if (this.settled) return;
    const now = Date.now();
    this.state.clockMs = now - this.state.startedAt;

    // Phase transitions
    if (this.state.clockMs < LOCKIN_MS) {
      this.state.phase = "lockin";
    } else if (this.state.clockMs < ROUND_MS) {
      this.state.phase = "open";
    } else {
      this.state.phase = "ended";
    }

    // Zone shrink
    const t = Math.min(1, this.state.clockMs / ROUND_MS);
    this.state.zone.radius = WORLD.R0 + (WORLD.R_END - WORLD.R0) * t;

    // Bot inputs
    for (const part of this.participants.values()) {
      if (!part.isBot || !part.bot || !part.sessionId) continue;
      const player = this.state.players.get(part.sessionId);
      if (!player?.alive) continue;
      part.bot.update(player, this.state, dtMs);
    }

    // Move snakes
    for (const player of this.state.players.values()) {
      if (!player.alive) continue;
      stepSnake(player, dtMs);
      // Boost: 1/300 of lobby entry (mass) per server tick while boosting
      if (player.boost) {
        const perTick = (this.entryTierCents * MASS_UNITS_PER_CENT) / 300n;
        const newMass = BigInt(player.massUnits) - perTick;
        if (newMass <= 0n) {
          player.boost = false;
          this.killPlayer(player, "dead");
        } else {
          player.massUnits = newMass.toString();
          syncBodyToMass(player, this.entryTierCents);
        }
      }
    }

    // Build spatial hash of body segments + orbs
    const segHash = new SpatialHash<{ x: number; y: number; ownerSession: string }>(64);
    const orbHash = new SpatialHash<{ x: number; y: number; id: string }>(64);
    for (const p of this.state.players.values()) {
      if (!p.alive) continue;
      for (const s of p.body) segHash.insert({ x: s.x, y: s.y, ownerSession: p.sessionId });
    }
    for (const o of this.state.orbs.values()) {
      orbHash.insert({ x: o.x, y: o.y, id: o.id });
    }

    // Collisions: heads
    const dyingThisTick = new Set<string>();
    const players = Array.from(this.state.players.values()).filter((p) => p.alive);

    for (const p of players) {
      if (dyingThisTick.has(p.sessionId)) continue;
      // 1) zone border
      const dz = Math.hypot(p.headX - this.state.zone.cx, p.headY - this.state.zone.cy);
      if (dz > this.state.zone.radius) {
        dyingThisTick.add(p.sessionId);
        continue;
      }
      // 2) head-vs-head
      let headHead = false;
      for (const q of players) {
        if (q.sessionId === p.sessionId) continue;
        if (dyingThisTick.has(q.sessionId)) continue;
        const d = Math.hypot(p.headX - q.headX, p.headY - q.headY);
        if (d < p.radius + q.radius) {
          dyingThisTick.add(p.sessionId);
          dyingThisTick.add(q.sessionId);
          headHead = true;
          break;
        }
      }
      if (headHead) continue;
      // 3) head-vs-other-body
      const candidates = segHash.queryRadius(p.headX, p.headY, p.radius + 8);
      for (const c of candidates) {
        if (c.ownerSession === p.sessionId) continue;
        const d = Math.hypot(p.headX - c.x, p.headY - c.y);
        if (d < p.radius + 6) {
          dyingThisTick.add(p.sessionId);
          break;
        }
      }
    }

    // 4) head -> orb (eat)
    for (const p of players) {
      if (dyingThisTick.has(p.sessionId)) continue;
      const cands = orbHash.queryRadius(
        p.headX,
        p.headY,
        p.radius + ORB.PICKUP_RADIUS_BONUS,
      );
      for (const c of cands) {
        const orb = this.state.orbs.get(c.id);
        if (!orb) continue;
        const d = Math.hypot(p.headX - orb.x, p.headY - orb.y);
        if (d < p.radius + ORB.PICKUP_RADIUS_BONUS) {
          growSnake(p, BigInt(orb.value), this.entryTierCents);
          this.state.orbs.delete(c.id);
        }
      }
    }

    // Resolve deaths
    for (const sid of dyingThisTick) {
      const player = this.state.players.get(sid);
      if (!player) continue;
      this.killPlayer(player, "dead");
    }

    // Extraction tick (only successful extracts; deaths do not affect rank)
    const finishing: Player[] = [];
    for (const player of this.state.players.values()) {
      if (!player.alive) continue;
      if (player.extractStartedAt <= 0) continue;
      const elapsed = this.state.clockMs - player.extractStartedAt;
      if (elapsed >= EXTRACT_CHANNEL_MS) finishing.push(player);
    }
    finishing.sort((a, b) => {
      if (a.extractStartedAt !== b.extractStartedAt)
        return a.extractStartedAt - b.extractStartedAt;
      return a.sessionId.localeCompare(b.sessionId);
    });
    for (const player of finishing) {
      this.extractPlayer(player);
    }

    // End: round time up, or everyone eliminated. Only extract = cashout win; there is no "last on arena" win.
    const alive = Array.from(this.state.players.values()).filter((p) => p.alive);
    if (this.state.phase === "ended" || alive.length === 0) {
      void this.settle();
    }
  }

  private spawnAmbientOrbs(totalUnits: bigint, count: number) {
    if (totalUnits <= 0n || count < 1) return;
    const n = BigInt(count);
    const base = totalUnits / n;
    const remainder = totalUnits % n;
    for (let i = 0; i < count; i++) {
      const v = base + (BigInt(i) < remainder ? 1n : 0n);
      if (v <= 0n) continue;
      const orb = new Orb();
      orb.id = randomUUID();
      const r = Math.sqrt(Math.random()) * (this.state.zone.radius * 0.95);
      const a = Math.random() * Math.PI * 2;
      orb.x = Math.cos(a) * r;
      orb.y = Math.sin(a) * r;
      orb.value = v.toString();
      orb.tier = 0;
      this.state.orbs.set(orb.id, orb);
    }
  }

  private killPlayer(player: Player, reason: ExitType) {
    if (!player.alive) return;
    player.alive = false;
    player.diedAt = this.state.clockMs;
    const part = this.sessionToParticipant.get(player.sessionId);
    if (part) {
      part.exitType = reason;
    }
    // Drop body as orbs
    const total = BigInt(player.massUnits);
    if (total > 0n && player.body.length > 0) {
      const per = total / BigInt(player.body.length);
      let leftover = total - per * BigInt(player.body.length);
      for (const seg of player.body) {
        let v = per;
        if (leftover > 0n) {
          v += 1n;
          leftover -= 1n;
        }
        if (v <= 0n) continue;
        const orb = new Orb();
        orb.id = randomUUID();
        orb.x = seg.x + (Math.random() - 0.5) * 8;
        orb.y = seg.y + (Math.random() - 0.5) * 8;
        orb.value = v.toString();
        orb.tier = 1;
        this.state.orbs.set(orb.id, orb);
      }
    }
    player.massUnits = "0";
    player.body.clear();
    clearSnakeTrail(player.sessionId);
    this.sendPlayerOutcome(player.sessionId);
  }

  private extractPlayer(player: Player) {
    if (!player.alive) return;
    player.alive = false;
    clearSnakeTrail(player.sessionId);
    player.extractedAt = this.state.clockMs;
    const part = this.sessionToParticipant.get(player.sessionId);
    if (part) {
      part.exitType = "extract";
      part.payoutMass = BigInt(player.massUnits);
      part.extractedAt = player.extractedAt;
    }
    const { rank, total } = this.extractPayoutRank(player.sessionId);
    player.exitOrder = rank;
    if (part) part.exitOrder = rank;
    this.state.nextExitOrder = total + 1;
    this.sendPlayerOutcome(player.sessionId);
    if (part?.userId && !part.isBot) {
      const { payoutCents } = this.getPayoutInfo(part);
      if (payoutCents > 0n) {
        void this.pushInstantPayout(this.state.matchId, part.userId, payoutCents);
      }
    }
  }

  /** Same formula as settlement and `player_outcome` (final total extractors can change mid/late round). */
  private getPayoutInfo(part: Participant): {
    payoutCents: bigint;
    extRank: number;
    totalExt: number;
  } {
    if (part.exitType !== "extract" || !part.sessionId) {
      return { payoutCents: 0n, extRank: 0, totalExt: 0 };
    }
    const { rank, total } = this.extractPayoutRank(part.sessionId);
    if (total <= 0 || rank < 1) {
      return { payoutCents: 0n, extRank: rank, totalExt: total };
    }
    const mult = payoutMultiplier(rank, total);
    const massPayout = applyMultiplier(part.payoutMass, mult);
    return {
      payoutCents: massUnitsToCents(massPayout),
      extRank: rank,
      totalExt: total,
    };
  }

  private async pushInstantPayout(
    matchId: string,
    userId: string,
    payoutCents: bigint,
  ) {
    try {
      await postExtractCredit({
        matchId,
        userId,
        payoutCents: payoutCents.toString(),
      });
    } catch (e) {
      console.error("[battle] postExtractCredit failed:", e);
    }
  }

  /**
   * Rank among **successful extracts only** (chronological). Deaths / timeouts do not appear here,
   * so prior eliminations do not change whether you are "first out" on extract.
   */
  private extractPayoutRank(sessionId: string): { rank: number; total: number } {
    const entries = Array.from(this.participants.values())
      .filter((p) => p.exitType === "extract" && p.sessionId)
      .map((p) => ({
        sessionId: p.sessionId!,
        extractedAt: p.extractedAt,
        startedAt: p.extractStartedAt,
      }))
      .filter((e) => e.extractedAt > 0)
      .sort((a, b) => {
        if (a.extractedAt !== b.extractedAt) return a.extractedAt - b.extractedAt;
        if (a.startedAt !== b.startedAt) return a.startedAt - b.startedAt;
        return a.sessionId.localeCompare(b.sessionId);
      });
    const total = entries.length;
    const idx = entries.findIndex((e) => e.sessionId === sessionId);
    const rank = idx >= 0 ? idx + 1 : Math.max(1, total);
    return { rank, total };
  }

  /** Payout in US cents for the affected human client. */
  private sendPlayerOutcome(sessionId: string) {
    const part = this.sessionToParticipant.get(sessionId);
    if (!part?.userId || part.isBot) return;
    const client = this.clients.find((c) => c.sessionId === sessionId);
    if (!client) return;

    const { payoutCents, extRank, totalExt } = this.getPayoutInfo(part);
    const deltaCents = payoutCents - part.entryCents;

    const payload: PlayerOutcomePayload = {
      matchId: this.state.matchId,
      userId: part.userId,
      entryCents: part.entryCents.toString(),
      payoutCents: payoutCents.toString(),
      deltaCents: deltaCents.toString(),
      exitType: part.exitType,
      exitOrder: part.exitType === "extract" ? extRank : part.exitOrder,
      provisional: true,
      totalExtractorsSoFar: totalExt,
    };
    client.send("player_outcome", payload);
  }

  private async settle() {
    if (this.settled) return;
    this.settled = true;
    this.clock.clear();

    // Swallowed by the closing ring / time — no payout. Never overwrite a successful extract.
    for (const player of this.state.players.values()) {
      if (!player.alive) continue;
      const part = this.sessionToParticipant.get(player.sessionId);
      if (part?.exitType === "extract") continue;
      if (part) {
        part.exitType = "timeout";
        part.exitOrder = null;
        part.payoutMass = 0n;
      }
      player.alive = false;
      clearSnakeTrail(player.sessionId);
    }

    const settlement: MatchSettlementParticipant[] = [];
    for (const p of this.participants.values()) {
      let payoutCents = 0n;
      let exitOrderOut: number | null = p.exitOrder;
      if (p.exitType === "extract" && p.sessionId) {
        const { rank, total } = this.extractPayoutRank(p.sessionId);
        exitOrderOut = rank;
        if (total > 0 && rank >= 1) {
          const mult = payoutMultiplier(rank, total);
          const massPayout = applyMultiplier(p.payoutMass, mult);
          payoutCents = massUnitsToCents(massPayout);
        }
      }
      const deltaCents = payoutCents - p.entryCents;
      settlement.push({
        userId: p.userId,
        isBot: p.isBot,
        entryCents: p.entryCents.toString(),
        payoutCents: payoutCents.toString(),
        deltaCents: deltaCents.toString(),
        exitType: p.exitType,
        exitOrder: exitOrderOut,
      });
    }

    const payload: MatchSettlementPayload = {
      matchId: this.state.matchId,
      entryTierCents: this.entryTierCents.toString(),
      startedAt: this.state.startedAt,
      endedAt: Date.now(),
      participants: settlement,
    };

    // Persist payouts before clients refresh balance; avoids race where /api/me is stale after "settled".
    try {
      await postSettlement(payload);
    } catch (e) {
      console.error(
        "[battle] postSettlement failed — DB balance may be wrong until retried:",
        e,
      );
    }
    this.broadcast("settled", payload);
    setTimeout(() => this.disconnect(), 5_000);
  }
}
