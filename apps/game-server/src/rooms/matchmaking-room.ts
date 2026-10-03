import { randomInt, randomUUID } from "node:crypto";
import { Room, matchMaker, type Client } from "@colyseus/core";
import { Schema, type } from "@colyseus/schema";
import {
  MATCH,
  MM_BATTLE_READY,
  ROOMS,
  bossGroupNpcCount,
  bossSlotCount,
  containerGuarded,
  mmShouldLaunch,
  npcPostsOf,
  raidBossSlots,
  raidNpcCarriers,
  rollBossSpawns,
  rollNpcSpawns,
  type BattleReadyMsg,
  type JoinTicket,
  type RaidMode,
  type RaidStartRequest,
  type RaidStartResponse,
} from "@extract/shared";
import { CLOSE } from "./close-codes.js";
import type { RaidLaunchOptions } from "./inventory-handlers.js";
import { LAUNCH_KEY, authenticate, releasePendingSeatsOf } from "./room-auth.js";
import { SERVER_INSTANCE, startRaid } from "../net/web-api.js";
import type { RosterEntry } from "../sim/types.js";
import { matchMap } from "../sim/match.js";

/** One queued human (server-side only: never synced, so nobody learns who else is queued). */
export interface MmPlayer {
  userId: string;
  nickname: string;
}

/**
 * Synced to the queue screen: how many humans wait and when the window closes ("Players in queue:
 * N · launching in m:ss"). Only the count is public (v5 review: the synced list of queued userIds /
 * nicknames let a cheater see when a lobby held only his own alts).
 */
export class MmState extends Schema {
  /** "waiting" | "starting" | "started" */
  @type("string") status = "waiting";
  /** Server wall-clock ms the queue window opened (first join; 0 until somebody joins). */
  @type("number") startedAt = 0;
  /** Server wall-clock ms the window ends: the match launches with whoever is queued (never with bots). */
  @type("number") deadlineAt = 0;
  @type("uint8") maxPlayers = MATCH.MAX_HUMANS;
  /** Humans in the queue (players.length). */
  @type("uint8") queued = 0;
  /** Server-side seat list (not synced). */
  players: MmPlayer[] = [];
  @type("string") battleRoomId = "";
}

/** Delay between "battle_ready" and closing the queue so every client receives the message. */
const CLOSE_AFTER_LAUNCH_MS = 2_000;

/** Queue window length: env MM_QUEUE_WINDOW_MS (dev / tests), default MATCH.QUEUE_WINDOW_MS. */
export function queueWindowMs(): number {
  const raw = process.env.MM_QUEUE_WINDOW_MS;
  const v = raw === undefined || raw === "" ? NaN : Number(raw);
  return Number.isFinite(v) && v >= 0 && v <= 600_000 ? Math.floor(v) : MATCH.QUEUE_WINDOW_MS;
}

/**
 * Queue rules (NPC MODEL v5 §1.1, shared mmShouldLaunch): launch now, or when to look again.
 * - queue ≥ MATCH.MAX_HUMANS: at once;
 * - queue ≥ MATCH.MIN_HUMANS and MATCH.MIN_WAIT_MS since the window opened (a friend group gets in);
 * - the window ends with ≥ 1 human: launch with whoever is queued (a solo raid against NPCs only).
 * `recheckInMs` = the next moment a rule can fire (null = only another join changes anything).
 */
export function queueDecision(queued: number, sinceOpenMs: number, windowMs: number): { launch: boolean; recheckInMs: number | null } {
  if (mmShouldLaunch(queued, sinceOpenMs, windowMs)) return { launch: true, recheckInMs: null };
  if (queued < 1) return { launch: false, recheckInMs: null };
  const toWindow = Math.max(0, windowMs - sinceOpenMs);
  const toMinWait = queued >= MATCH.MIN_HUMANS ? Math.max(0, MATCH.MIN_WAIT_MS - sinceOpenMs) : Infinity;
  return { launch: false, recheckInMs: Math.min(toWindow, toMinWait) };
}

/**
 * Single queue "mm" (NPC MODEL v5): humans only. The window opens on the first join
 * (queueWindowMs()); the match launches at MATCH.MAX_HUMANS at once, at MATCH.MIN_HUMANS after
 * MATCH.MIN_WAIT_MS, or at the window end with whoever is queued (queueDecision). Nobody is ever
 * filled in: the raid holds the queued humans plus the map's NPCs. Joiners beyond MAX_HUMANS are
 * turned away (QUEUE_CLOSED) and requeue into the next window, never a bigger match.
 * Each seat's loadoutId (from the signed ticket) stays server-side and goes into the roster
 * (raids/start in launch()).
 */
export class MatchmakingRoom extends Room<MmState, unknown, unknown, JoinTicket> {
  override maxClients = MATCH.MAX_HUMANS * 2;
  private timer?: NodeJS.Timeout;
  private launching = false;
  private readonly windowMs = queueWindowMs();
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
    if (!prev && this.state.players.length >= MATCH.MAX_HUMANS) {
      // Full: the next window takes this one (never a bigger match).
      client.leave(CLOSE.QUEUE_CLOSED, "queue_full");
      return;
    }
    this.seats.set(ticket.userId, client);
    if (prev && prev !== client) {
      prev.leave(CLOSE.JOINED_ELSEWHERE, "joined_elsewhere");
    } else {
      this.state.players.push({ userId: ticket.userId, nickname: ticket.nickname });
      this.state.queued = this.state.players.length;
    }

    if (this.state.startedAt === 0) {
      this.state.startedAt = Date.now();
      this.state.deadlineAt = this.state.startedAt + this.windowMs;
    }
    if (this.state.players.length >= MATCH.MAX_HUMANS) void this.lock();
    this.check();
  }

  /** Apply the queue rules now; otherwise look again when the next rule can fire. */
  private check() {
    if (this.launching || this.state.status !== "waiting") return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (this.state.startedAt === 0) return;
    const d = queueDecision(this.state.players.length, Date.now() - this.state.startedAt, this.windowMs);
    if (d.launch) {
      void this.launch();
      return;
    }
    if (d.recheckInMs !== null) this.timer = setTimeout(() => this.check(), d.recheckInMs + 5);
  }

  override onLeave(client: Client) {
    if (this.state.status !== "waiting") return;
    const ticket = client.auth as JoinTicket | undefined;
    if (!ticket || this.seats.get(ticket.userId) !== client) return;
    this.seats.delete(ticket.userId);
    const idx = this.state.players.findIndex((p) => p.userId === ticket.userId);
    if (idx >= 0) this.state.players.splice(idx, 1);
    this.state.queued = this.state.players.length;
    if (this.state.players.length === 0) {
      // Everyone left before the launch: the next joiner opens a fresh window.
      if (this.timer) clearTimeout(this.timer);
      this.timer = undefined;
      this.state.startedAt = 0;
      this.state.deadlineAt = 0;
    }
  }

  override onDispose() {
    if (this.timer) clearTimeout(this.timer);
  }

  private async launch() {
    if (this.launching || this.state.status !== "waiting") return;
    if (this.state.players.length === 0) {
      this.state.startedAt = 0;
      this.state.deadlineAt = 0;
      return;
    }
    this.launching = true;
    if (this.timer) clearTimeout(this.timer);
    this.state.status = "starting";
    await this.lock();

    const humans: RosterEntry[] = this.state.players
      .slice(0, MATCH.MAX_HUMANS)
      .map((p) => ({
        userId: p.userId,
        nickname: p.nickname,
        loadoutId: (this.seats.get(p.userId)?.auth as JoinTicket | undefined)?.loadoutId ?? "",
      }));

    const plan = await planLaunch(humans);
    for (const userId of plan.rejected) {
      this.seats.get(userId)?.leave(CLOSE.LOADOUT_REJECTED, "loadout_rejected");
    }
    if (plan.roster.length === 0) {
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
  /** The humans that keep their seat (humans only: NPCs are spawned by the match itself). */
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
  /** Server-secret loot / NPC seed (tests pin it; default: a fresh crypto random per match). */
  lootSeed?: number;
}

/**
 * Live mode: POST /api/raids/start (retried inside startRaid) so the web locks the loadouts into
 * this match (locked → in_raid) and releases lost-pool items into containers, bosses and marauder
 * carriers; players then spawn with their accepted snapshot. The request carries the same NPC rolls
 * the match will make from the server-secret `lootSeed` (rollBossSpawns → `bosses` / `bossSlots`,
 * rollNpcSpawns → `carriers`) and the v4 `guarded` flag per container, so the web's allocation and
 * the sim agree. `matchSeed` is public (BattleState.mapSeed); `lootSeed` never reaches a client, so
 * nobody can precompute container contents, NPC spawns / kits / bags or where the pool items went
 * (v5 review). The web seeds its allocation with `allocSeed` = lootSeed.
 * Demo mode (ECONOMY_MODE=demo, or raids/start unreachable / refused): free kits, the server mints
 * container uniques itself and reports them as `minted`; NPCs carry no pool items.
 * A loadout id that cannot be a DB id never reaches the API (it would fail the whole request).
 */
export async function planLaunch(humans: RosterEntry[], deps: LaunchDeps = {}): Promise<LaunchPlan> {
  let matchId = deps.matchId ?? randomUUID();
  const matchSeed = deps.matchSeed ?? randomInt(0, 2 ** 32);
  const lootSeed = deps.lootSeed ?? randomInt(0, 2 ** 32);
  let mode = deps.mode ?? economyMode();
  const rejected = new Set<string>();
  // Humans only (v5): a pre-v5 bot entry never reaches the roster.
  const seats = humans.filter((h) => h.isBot !== true && !!h.userId);
  for (const h of seats) if (h.loadoutId && !UUID_RE.test(h.loadoutId)) rejected.add(h.userId!);

  let res: RaidStartResponse | null = null;
  if (mode === "live") {
    const map = matchMap(matchSeed);
    const spawned = rollBossSpawns(lootSeed, map.bosses);
    const bosses = raidBossSlots(spawned);
    const posts = npcPostsOf(map);
    const squads = rollNpcSpawns(lootSeed, posts, bossGroupNpcCount(spawned));
    const req: RaidStartRequest = {
      matchId,
      mode: "live",
      mapId: map.id,
      matchSeed,
      allocSeed: lootSeed,
      players: seats.filter((h) => !rejected.has(h.userId!)).map((h) => ({ userId: h.userId!, loadoutId: h.loadoutId ?? "" })),
      containers: map.containers.map((c, idx) => ({ idx, kind: c.kind, tier: c.tier, guarded: containerGuarded(c, map.bosses) })),
      bossSlots: bossSlotCount(bosses),
      bosses,
      carriers: raidNpcCarriers(squads, posts),
      // The web voids this raid at once if this process dies and a new one boots (void-orphans).
      instanceId: SERVER_INSTANCE.instanceId,
      serverId: SERVER_INSTANCE.serverId,
    };
    res = await (deps.startRaid ?? startRaid)(req);
    if (!res) {
      // The start may have committed on the web with only the reply lost: loadouts in_raid under
      // this matchId. A demo raid under the same id would settle them (exit) and sweep them into
      // the lost pool (end) although nobody carried them. A fresh id leaves that raid untouched
      // until the web voids it (stale timeout / void-orphans: gear back to its owners).
      const fresh = randomUUID();
      console.error(`[mm] raids/start ${matchId} unavailable: launching in demo mode as ${fresh}`);
      matchId = fresh;
      mode = "demo";
    }
  }
  if (res) for (const r of res.rejected) rejected.add(r.userId);
  // Demo fallback: locked loadouts stay in the stash side (the web expires the lock); free kits.
  const kept: RosterEntry[] = seats
    .filter((h) => !rejected.has(h.userId!))
    .map(({ userId, nickname, loadoutId }) => ({
      userId, nickname, loadoutId: res && res.accepted.some((a) => a.userId === userId) ? loadoutId : "",
    }));
  return {
    roster: kept,
    rejected: [...rejected],
    options: {
      matchId,
      mapSeed: matchSeed,
      lootSeed,
      mode,
      loadouts: res?.accepted.filter((a) => kept.some((h) => h.userId === a.userId)) ?? [],
      containerLoot: res?.containerLoot ?? {},
      autosellMult: res?.autosellMult ?? 1,
    },
  };
}
