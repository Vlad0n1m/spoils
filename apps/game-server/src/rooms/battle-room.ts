import { Room, ServerError, type Client } from "@colyseus/core";
import { StateView } from "@colyseus/schema";
import {
  C2S,
  MATCH,
  S2C,
  SERVER_TICK_MS,
  type BattleState,
  type JoinTicket,
  type JoinedMsg,
  type MatchEndReport,
  type MatchSummaryMsg,
} from "@extract/shared";
import { CLOSE } from "./close-codes.js";
import { raidOptions, registerInventoryHandlers } from "./inventory-handlers.js";
import { authenticate, isLaunchKey, releasePendingSeatsOf } from "./room-auth.js";
import { reportEnd, reportExit } from "../net/web-api.js";
import { buildBatches } from "../sim/audience.js";
import { Match, expectedMapHash, warmMatchMap } from "../sim/match.js";
import type { MatchEvent, RosterEntry } from "../sim/types.js";
import { ViewSync } from "../sim/views.js";
import { TickStats, fmtTickSummary, perfLogEnabled } from "./tick-stats.js";

// Process boot (map-boot, WP-M2): this module is imported once by index.ts before the server
// listens, so the static map runtime (MapData, indexes, walk grid, region graph) is built here and
// never inside a room creation or a tick.
const bootMap = warmMatchMap();
if (bootMap) console.log(`[game-server] map ${bootMap.map.id} ${bootMap.hash} ready (${bootMap.buildMs.toFixed(0)} ms, ${bootMap.regions.count} regions)`);

/**
 * BattleJoinOptions.mapHash must equal the server's mapHash of the match map: a client whose
 * generator output differs (another JS engine drifting, a stale bundle) would render walls the
 * server does not have and rubber-band through prediction. Refused before any seat is reserved.
 */
export function checkJoinMapHash(options: unknown): void {
  const expected = expectedMapHash();
  if (expected === null) return; // legacy test map: seed-dependent, no single hash to compare
  const got = (options as { mapHash?: unknown } | null)?.mapHash;
  if (got !== expected) {
    throw new ServerError(409, `map_mismatch: client map ${typeof got === "string" && got ? got.slice(0, 16) : "(none)"} != server ${expected}; reload the game`);
  }
}

interface CreateOptions {
  roster: RosterEntry[];
  /** Must equal LAUNCH_KEY: only MatchmakingRoom may create battles. */
  launchKey: string;
}

/** Most samples accepted in one INPUT message (clients may batch after a hitch). */
const MAX_INPUT_BATCH = 15;
/** Clients get their SETTLED even if the web API is slow; the post keeps retrying in the background. */
const SETTLE_WAIT_MS = 5_000;

/**
 * Thin network wrapper around sim/Match: messages become intents, drained sim events become
 * per-client `ev` batches or personal sends. All game rules live in sim/.
 *
 * Tick order (fog memo §2.4): match.step → syncViews → broadcastPatch → dispatch. Patches are sent
 * by the tick itself (patchRate = null), so a newly visible shooter's Player entry reaches the
 * client in the same tick, before the ShotMsg that references it.
 */
export class BattleRoom extends Room<BattleState, unknown, unknown, JoinTicket> {
  override autoDispose = false;
  /** Tick timing samples, only with BATTLE_PERF_LOG=1. */
  private perf: TickStats | null = perfLogEnabled() ? new TickStats() : null;
  // null = no automatic patch interval (Colyseus' typings say number; the setter accepts null).
  override patchRate = null as unknown as number;
  private match!: Match;
  private views!: ViewSync;
  /** userId → client currently controlling that player (a reconnect replaces the old one). */
  private readonly owners = new Map<string, Client>();
  /** rosterIndex → connected client: all sim routing is by roster index. */
  private readonly byRoster = new Map<number, Client>();
  private finishing = false;
  private summary: MatchSummaryMsg | null = null;

  /** Refuse a create without leaving timers behind (Colyseus starts the room clock before onCreate). */
  private abortCreate(reason: string): never {
    this.patchRate = null as unknown as number;
    this.clock.clear();
    this.clock.stop();
    throw new Error(reason);
  }

  /** Runs before Colyseus finds, creates or reserves anything: no valid ticket, no seat. */
  static override async onAuth(_token: string, options: unknown): Promise<JoinTicket> {
    const ticket = authenticate(options);
    checkJoinMapHash(options);
    return ticket;
  }

  override onCreate(opts: CreateOptions) {
    // Colyseus forwards client options of /matchmake/* to onCreate: never take a roster from them.
    if (!isLaunchKey(opts?.launchKey)) this.abortCreate("battle: not launched by matchmaking");
    const roster = sanitizeRoster(opts?.roster);
    if (!roster) this.abortCreate("battle: invalid roster");
    this.match = new Match({ roster, ...raidOptions(opts, roster) });
    this.views = new ViewSync(this.match);
    this.setState(this.match.state);
    // Double the humans: a reconnecting player may join before their stale socket is dropped.
    this.maxClients = Math.max(1, roster.filter((r) => !r.isBot).length * 2);
    this.setMetadata({ matchId: this.match.state.matchId });

    this.onMessage(C2S.INPUT, (client, raw: unknown) => {
      const samples = Array.isArray(raw) ? raw.slice(-MAX_INPUT_BATCH) : [raw];
      for (const s of samples) this.match.enqueueInput(client.sessionId, s);
    });
    this.onMessage(C2S.INTERACT, (client) => this.match.interact(client.sessionId));
    this.onMessage(C2S.RELOAD, (client) => this.match.reload(client.sessionId));
    this.onMessage(C2S.SWITCH, (client, raw: unknown) => {
      const slot = (raw as { slot?: unknown } | null)?.slot;
      // SwitchMsg is { slot: "w1" | "w2" }; the v1 numeric form is still accepted.
      const key = slot === "w1" || slot === 0 ? "w1" : slot === "w2" || slot === 1 ? "w2" : null;
      if (key) this.match.switchSlot(client.sessionId, key);
    });
    this.onMessage(C2S.HEAL, (client, raw: unknown) => {
      const kind = (raw as { kind?: unknown } | null)?.kind;
      if (kind === "bandage" || kind === "medkit") this.match.heal(client.sessionId, kind);
    });
    this.onMessage(C2S.PING, (client, raw: unknown) => {
      const t = (raw as { t?: unknown } | null)?.t;
      if (typeof t === "number" && Number.isFinite(t)) client.send(S2C.PONG, { t });
    });
    registerInventoryHandlers(this, () => this.match);
    // Unknown messages are ignored instead of logged: clients are untrusted.
    this.onMessage("*", () => {});

    this.setSimulationInterval((dt) => this.tick(dt), SERVER_TICK_MS);
  }

  /**
   * Seats count toward maxClients from the HTTP reservation on, so only players of this roster may
   * hold one (and only one pending each); anyone else would lock the room against its players.
   */
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
      if (!userId || !this.match.allRuntimes().some((rt) => !rt.isBot && rt.userId === userId)) return false;
      await releasePendingSeatsOf(this, userId);
    }
    return super._reserveSeat(sessionId, joinOptions, authData, seconds, allowReconnection, devModeReconnection);
  }

  override onJoin(client: Client, _options: unknown, ticket: JoinTicket) {
    const prev = this.owners.get(ticket.userId);
    const rt = this.match.attachHuman(ticket.userId, client.sessionId);
    if (!rt) {
      client.leave(CLOSE.NOT_IN_ROSTER, "not_in_roster");
      return;
    }
    this.owners.set(ticket.userId, client);
    this.byRoster.set(rt.rosterIndex, client);
    if (prev && prev !== client) prev.leave(CLOSE.JOINED_ELSEWHERE, "joined_elsewhere");

    // Fresh view on every (re)connect: own self entry first, then what this player may see.
    client.view = new StateView();
    this.views.attach(rt.rosterIndex, client.view);

    const joined: JoinedMsg = { sessionId: client.sessionId, matchId: this.match.state.matchId, selfKey: rt.selfKey };
    client.send(S2C.JOINED, joined);
    // A player who reconnects after their exit still gets their result.
    if (rt.outcome) client.send(S2C.OUTCOME, rt.outcome);
    if (this.summary && this.finishing) client.send(S2C.SETTLED, this.summary);
  }

  override onLeave(client: Client) {
    const ticket = client.auth as JoinTicket | undefined;
    if (!ticket || this.owners.get(ticket.userId) !== client) return;
    this.owners.delete(ticket.userId);
    const rt = this.match.runtime(client.sessionId);
    if (rt && this.byRoster.get(rt.rosterIndex) === client) {
      this.byRoster.delete(rt.rosterIndex);
      this.views.detach(rt.rosterIndex, client.view);
    }
    this.match.detach(client.sessionId);
  }

  private tick(dtMs: number) {
    const t0 = this.perf ? performance.now() : 0;
    if (!this.finishing) {
      try {
        this.match.step(dtMs);
      } catch (e) {
        // One bad tick must not take down the room (and every player's items with it).
        console.error(`[battle ${this.match.state.matchId}] step failed:`, e);
      }
    }
    const t1 = this.perf ? performance.now() : 0;
    const events = this.match.drainEvents();
    this.syncViews(events);
    this.broadcastPatch();
    this.dispatch(events);
    if (this.perf) {
      this.perf.add(t1 - t0, performance.now() - t0);
      // One line per ~30 s of ticks.
      if (this.perf.size >= 30_000 / SERVER_TICK_MS) {
        const s = this.perf.flush();
        if (s) console.log(`[battle ${this.match.state.matchId}] perf ${fmtTickSummary(s)} (${this.clients.length} clients)`);
      }
    }
  }

  /**
   * StateViews follow the sim (views.ts): players = each client's published vision row, items and
   * corpses = its AOI ring, loot entries = its search sessions (`view` events).
   */
  private syncViews(events: readonly MatchEvent[]) {
    for (const ev of events) if (ev.type === "view") this.views.applyLoot(ev.to, ev.op, ev.key);
    this.views.sync();
  }

  /**
   * One `ev` batch per client (audience.ts: clipped shots, hit / chest audiences, per-listener
   * sounds), then the personal sends and web reports.
   */
  private dispatch(events: readonly MatchEvent[]) {
    const batches = buildBatches(this.match, events, [...this.byRoster.keys()]);
    for (const [r, batch] of batches) this.byRoster.get(r)?.send(S2C.EV, batch);
    for (const ev of events) {
      switch (ev.type) {
        case "outcome":
          this.byRoster.get(ev.to)?.send(S2C.OUTCOME, ev.msg);
          break;
        case "invErr":
          this.byRoster.get(ev.to)?.send(S2C.INV_ERR, ev.msg);
          break;
        case "exit":
          void reportExit(ev.report);
          break;
        case "ended":
          void this.finish(ev.report, ev.summary);
          break;
        default:
          break;
      }
    }
  }

  private async finish(report: MatchEndReport, summary: MatchSummaryMsg) {
    if (this.finishing) return;
    this.finishing = true;
    this.summary = summary;
    await Promise.race([reportEnd(report), new Promise((r) => setTimeout(r, SETTLE_WAIT_MS))]);
    this.broadcast(S2C.SETTLED, summary);
    this.clock.setTimeout(() => void this.disconnect(), MATCH.DISPOSE_AFTER_END_MS);
  }
}

export function sanitizeRoster(raw: unknown): RosterEntry[] | null {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MATCH.MAX_PLAYERS) return null;
  const out: RosterEntry[] = [];
  const seen = new Set<string>();
  for (const r of raw) {
    if (!r || typeof r !== "object") return null;
    const { userId, nickname, isBot, loadoutId } = r as Record<string, unknown>;
    if (typeof nickname !== "string" || typeof isBot !== "boolean") return null;
    if (!isBot) {
      if (typeof userId !== "string" || !userId || seen.has(userId)) return null;
      seen.add(userId);
    }
    const lid = typeof loadoutId === "string" && loadoutId.length <= 64 && !isBot ? loadoutId : "";
    out.push({ userId: isBot ? null : (userId as string), nickname: nickname.slice(0, 24), isBot, loadoutId: lid });
  }
  return out;
}
