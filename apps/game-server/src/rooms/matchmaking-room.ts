import { randomInt, randomUUID } from "node:crypto";
import { Room, matchMaker, type Client } from "@colyseus/core";
import { ArraySchema, Schema, type } from "@colyseus/schema";
import {
  MATCH,
  MM_BATTLE_READY,
  ROOMS,
  type BattleReadyMsg,
  type JoinTicket,
  type RaidMode,
  type RaidStartRequest,
  type RaidStartResponse,
} from "@extract/shared";
import { CLOSE } from "./close-codes.js";
import type { RaidLaunchOptions } from "./inventory-handlers.js";
import { LAUNCH_KEY, authenticate, releasePendingSeatsOf } from "./room-auth.js";
import { startRaid } from "../net/web-api.js";
import type { RosterEntry } from "../sim/types.js";
import { MATCH_PLAYERS, matchMap } from "../sim/match.js";
import { botNames } from "../sim/names.js";

export class MmPlayer extends Schema {
  @type("string") userId = "";
  @type("string") nickname = "";
}

/** Synced to the queue screen: who is waiting and when bots fill the rest. */
export class MmState extends Schema {
  /** "waiting" | "starting" | "started" */
  @type("string") status = "waiting";
  /** Server wall-clock ms of the first join (0 until somebody joins). */
  @type("number") startedAt = 0;
  /** Server wall-clock ms when the match launches with bots if the queue is not full. */
  @type("number") deadlineAt = 0;
  @type("uint8") maxPlayers = MATCH_PLAYERS;
  @type([MmPlayer]) players = new ArraySchema<MmPlayer>();
  @type("string") battleRoomId = "";
}

/** Delay between "battle_ready" and closing the queue so every client receives the message. */
const CLOSE_AFTER_LAUNCH_MS = 2_000;

/**
 * Single demo queue "mm": launches a battle when MATCH_PLAYERS humans are in, or
 * MATCH.MATCHMAKING_TIMEOUT_MS after the first join with bots filling the rest.
 * Each seat's loadoutId (from the signed ticket) stays server-side and goes into the roster
 * (WP-B: raids/start in launch()).
 */
export class MatchmakingRoom extends Room<MmState, unknown, unknown, JoinTicket> {
  override maxClients = MATCH_PLAYERS * 2;
  private deadline?: NodeJS.Timeout;
  private launching = false;
  /** userId → client currently holding that seat (a second tab replaces the first). */
  private readonly seats = new Map<string, Client>();

  override onCreate() {
    this.setState(new MmState());
  }

  /** Runs before Colyseus finds, creates or reserves anything: no valid ticket, no seat. */
  static override async onAuth(_token: string, options: unknown): Promise<JoinTicket> {
    return authenticate(options);
  }

  /** One pending seat per user, so a single ticket cannot fill (and lock) the queue. */
  protected override async _reserveSeat(
    sessionId: string,
    joinOptions?: unknown,
    authData?: unknown,
    seconds?: number,
    allowReconnection = false,
    devModeReconnection?: boolean,
  ): Promise<boolean> {
    if (!allowReconnection) {
      const userId = (authData as JoinTicket | undefined)?.userId;
      if (!userId) return false;
      await releasePendingSeatsOf(this, userId);
    }
    return super._reserveSeat(sessionId, joinOptions, authData, seconds, allowReconnection, devModeReconnection);
  }

  override onJoin(client: Client, _options: unknown, ticket: JoinTicket) {
    if (this.state.status !== "waiting") {
      client.leave(CLOSE.QUEUE_CLOSED, "queue_closed");
      return;
    }
    const prev = this.seats.get(ticket.userId);
    this.seats.set(ticket.userId, client);
    if (prev && prev !== client) {
      prev.leave(CLOSE.JOINED_ELSEWHERE, "joined_elsewhere");
    } else {
      const p = new MmPlayer();
      p.userId = ticket.userId;
      p.nickname = ticket.nickname;
      this.state.players.push(p);
    }

    if (!this.deadline) {
      this.state.startedAt = Date.now();
      this.state.deadlineAt = this.state.startedAt + MATCH.MATCHMAKING_TIMEOUT_MS;
      this.deadline = setTimeout(() => void this.launch(), MATCH.MATCHMAKING_TIMEOUT_MS);
    }
    if (this.state.players.length >= MATCH_PLAYERS) void this.launch();
  }

  override onLeave(client: Client) {
    if (this.state.status !== "waiting") return;
    const ticket = client.auth as JoinTicket | undefined;
    if (!ticket || this.seats.get(ticket.userId) !== client) return;
    this.seats.delete(ticket.userId);
    const idx = this.state.players.findIndex((p) => p.userId === ticket.userId);
    if (idx >= 0) this.state.players.splice(idx, 1);
  }

  override onDispose() {
    if (this.deadline) clearTimeout(this.deadline);
  }

  private async launch() {
    if (this.launching || this.state.status !== "waiting") return;
    if (this.state.players.length === 0) {
      // Everyone left before the deadline: the next joiner starts a fresh countdown.
      this.deadline = undefined;
      this.state.startedAt = 0;
      this.state.deadlineAt = 0;
      return;
    }
    this.launching = true;
    if (this.deadline) clearTimeout(this.deadline);
    this.state.status = "starting";
    await this.lock();

    const humans: RosterEntry[] = this.state.players
      .slice(0, MATCH_PLAYERS)
      .map((p) => ({
        userId: p.userId,
        nickname: p.nickname,
        isBot: false,
        loadoutId: (this.seats.get(p.userId)?.auth as JoinTicket | undefined)?.loadoutId ?? "",
      }));

    const plan = await planLaunch(humans);
    for (const userId of plan.rejected) {
      this.seats.get(userId)?.leave(CLOSE.LOADOUT_REJECTED, "loadout_rejected");
    }
    if (!plan.roster.some((r) => !r.isBot)) {
      // Every loadout was refused: nobody is left to play.
      this.clock.setTimeout(() => void this.disconnect(), CLOSE_AFTER_LAUNCH_MS);
      return;
    }

    try {
      const battle = await matchMaker.createRoom(ROOMS.BATTLE, {
        roster: plan.roster,
        launchKey: LAUNCH_KEY,
        ...plan.options,
      });
      this.state.battleRoomId = battle.roomId;
      this.state.status = "started";
      this.broadcast(MM_BATTLE_READY, { battleRoomId: battle.roomId } satisfies BattleReadyMsg);
    } catch (e) {
      console.error("[mm] failed to create battle room:", e);
      for (const c of this.clients) c.leave(CLOSE.LAUNCH_FAILED, "launch_failed");
    }
    this.clock.setTimeout(() => void this.disconnect(), CLOSE_AFTER_LAUNCH_MS);
  }
}

// ---------------------------------------------------------------- launch path (inventory lane)

/** ECONOMY_MODE=demo forces demo raids; anything else tries live (demo stays the fallback). */
export function economyMode(): RaidMode {
  return process.env.ECONOMY_MODE === "demo" ? "demo" : "live";
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface LaunchPlan {
  /** Humans that keep their seat, then bots up to MATCH_PLAYERS. */
  roster: RosterEntry[];
  /** userIds whose loadout raids/start refused: kicked with CLOSE_CODES.LOADOUT_REJECTED. */
  rejected: string[];
  /** Spread into the battle's create options (sanitized again by raidOptions in onCreate). */
  options: RaidLaunchOptions;
}

export interface LaunchDeps {
  mode?: RaidMode;
  startRaid?: (req: RaidStartRequest) => Promise<RaidStartResponse | null>;
  matchId?: string;
  matchSeed?: number;
}

/**
 * Live mode: POST /api/raids/start (retried inside startRaid) so the web locks the loadouts into
 * this match (locked → in_raid) and releases lost-pool items into containers; players then spawn
 * with their accepted snapshot. Demo mode (ECONOMY_MODE=demo, or raids/start unreachable /
 * refused): free kits, the server mints container uniques itself and reports them as `minted`.
 * A loadout id that cannot be a DB id never reaches the API (it would fail the whole request).
 */
export async function planLaunch(humans: RosterEntry[], deps: LaunchDeps = {}): Promise<LaunchPlan> {
  const matchId = deps.matchId ?? randomUUID();
  const matchSeed = deps.matchSeed ?? randomInt(0, 2 ** 32);
  let mode = deps.mode ?? economyMode();
  const rejected = new Set<string>();
  for (const h of humans) if (h.loadoutId && !UUID_RE.test(h.loadoutId)) rejected.add(h.userId!);

  let res: RaidStartResponse | null = null;
  if (mode === "live") {
    const map = matchMap(matchSeed);
    const req: RaidStartRequest = {
      matchId,
      mode: "live",
      mapId: map.id,
      matchSeed,
      players: humans.filter((h) => !rejected.has(h.userId!)).map((h) => ({ userId: h.userId!, loadoutId: h.loadoutId ?? "" })),
      containers: map.containers.map((c, idx) => ({ idx, kind: c.kind, tier: c.tier })),
      bossSlots: 0,
    };
    res = await (deps.startRaid ?? startRaid)(req);
    if (!res) {
      console.error(`[mm] raids/start ${matchId} unavailable: launching in demo mode`);
      mode = "demo";
    }
  }
  if (res) for (const r of res.rejected) rejected.add(r.userId);
  // Demo fallback: locked loadouts stay in the stash side (the web expires the lock); free kits.
  const kept = humans
    .filter((h) => !rejected.has(h.userId!))
    .map((h) => (res && res.accepted.some((a) => a.userId === h.userId) ? h : { ...h, loadoutId: "" }));
  const bots: RosterEntry[] = botNames(Math.max(0, MATCH_PLAYERS - kept.length)).map((nickname) => ({
    userId: null,
    nickname,
    isBot: true,
  }));
  return {
    roster: [...kept, ...bots],
    rejected: [...rejected],
    options: {
      matchId,
      mapSeed: matchSeed,
      mode,
      loadouts: res?.accepted.filter((a) => kept.some((h) => h.userId === a.userId)) ?? [],
      containerLoot: res?.containerLoot ?? {},
      autosellMult: res?.autosellMult ?? 1,
    },
  };
}
