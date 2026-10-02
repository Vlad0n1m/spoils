import { Room, type Client } from "@colyseus/core";
import {
  C2S,
  MATCH,
  S2C,
  SERVER_TICK_MS,
  type BattleState,
  type JoinTicket,
  type JoinedMsg,
  type MatchSettlementPayload,
} from "@extract/shared";
import { CLOSE } from "./close-codes.js";
import { authenticate, isLaunchKey, releasePendingSeatsOf } from "./room-auth.js";
import { postSettlement } from "../net/settle.js";
import { Match } from "../sim/match.js";
import type { MatchEvent, RosterEntry } from "../sim/types.js";

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
 * broadcasts or personal sends. All game rules live in sim/.
 */
export class BattleRoom extends Room<BattleState, unknown, unknown, JoinTicket> {
  override autoDispose = false;
  override patchRate = SERVER_TICK_MS;
  private match!: Match;
  /** userId → client currently controlling that player (a reconnect replaces the old one). */
  private readonly owners = new Map<string, Client>();
  private finishing = false;

  /**
   * Colyseus starts the patch interval before onCreate and never stops it when onCreate throws, so
   * every refused create would leak a 20 Hz timer for good. Stop it, then refuse.
   */
  private abortCreate(reason: string): never {
    this.patchRate = 0;
    this.clock.clear();
    this.clock.stop();
    throw new Error(reason);
  }

  /** Runs before Colyseus finds, creates or reserves anything: no valid ticket, no seat. */
  static override async onAuth(_token: string, options: unknown): Promise<JoinTicket> {
    return authenticate(options);
  }

  override onCreate(opts: CreateOptions) {
    // Colyseus forwards client options of /matchmake/* to onCreate: never take a roster from them.
    if (!isLaunchKey(opts?.launchKey)) this.abortCreate("battle: not launched by matchmaking");
    const roster = sanitizeRoster(opts?.roster);
    if (!roster) this.abortCreate("battle: invalid roster");
    this.match = new Match({ roster });
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
      if (slot === 0 || slot === 1) this.match.switchSlot(client.sessionId, slot);
    });
    this.onMessage(C2S.HEAL, (client, raw: unknown) => {
      const kind = (raw as { kind?: unknown } | null)?.kind;
      if (kind === "bandage" || kind === "medkit") this.match.heal(client.sessionId, kind);
    });
    this.onMessage(C2S.PING, (client, raw: unknown) => {
      const t = (raw as { t?: unknown } | null)?.t;
      if (typeof t === "number" && Number.isFinite(t)) client.send(S2C.PONG, { t });
    });
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
    if (prev && prev !== client) prev.leave(CLOSE.JOINED_ELSEWHERE, "joined_elsewhere");

    const joined: JoinedMsg = { sessionId: client.sessionId, matchId: this.match.state.matchId };
    client.send(S2C.JOINED, joined);
    // A player who reconnects after their exit still gets their result.
    if (rt.outcome) client.send(S2C.OUTCOME, rt.outcome);
    if (this.match.settlement && this.finishing) client.send(S2C.SETTLED, this.match.settlement);
  }

  override onLeave(client: Client) {
    const ticket = client.auth as JoinTicket | undefined;
    if (!ticket || this.owners.get(ticket.userId) !== client) return;
    this.owners.delete(ticket.userId);
    this.match.detach(client.sessionId);
  }

  private tick(dtMs: number) {
    if (this.finishing) return;
    try {
      this.match.step(dtMs);
    } catch (e) {
      // One bad tick must not take down the room (and every player's items with it).
      console.error(`[battle ${this.match.state.matchId}] step failed:`, e);
    }
    for (const ev of this.match.drainEvents()) this.dispatch(ev);
  }

  private dispatch(ev: MatchEvent) {
    switch (ev.type) {
      case "shot":
        this.broadcast(S2C.SHOT, ev.msg);
        break;
      case "hit":
        this.broadcast(S2C.HIT, ev.msg);
        break;
      case "kill":
        this.broadcast(S2C.KILL, ev.msg);
        break;
      case "chest":
        this.broadcast(S2C.CHEST, ev.msg);
        break;
      case "outcome":
        this.clients.find((c) => c.sessionId === ev.to)?.send(S2C.OUTCOME, ev.msg);
        break;
      case "ended":
        void this.finish(ev.settlement);
        break;
    }
  }

  private async finish(settlement: MatchSettlementPayload) {
    if (this.finishing) return;
    this.finishing = true;
    const post = postSettlement(settlement);
    await Promise.race([post, new Promise((r) => setTimeout(r, SETTLE_WAIT_MS))]);
    this.broadcast(S2C.SETTLED, settlement);
    this.clock.setTimeout(() => void this.disconnect(), MATCH.DISPOSE_AFTER_END_MS);
  }
}

function sanitizeRoster(raw: unknown): RosterEntry[] | null {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MATCH.MAX_PLAYERS) return null;
  const out: RosterEntry[] = [];
  const seen = new Set<string>();
  for (const r of raw) {
    if (!r || typeof r !== "object") return null;
    const { userId, nickname, isBot } = r as Record<string, unknown>;
    if (typeof nickname !== "string" || typeof isBot !== "boolean") return null;
    if (!isBot) {
      if (typeof userId !== "string" || !userId || seen.has(userId)) return null;
      seen.add(userId);
    }
    out.push({ userId: isBot ? null : (userId as string), nickname: nickname.slice(0, 24), isBot });
  }
  return out;
}
