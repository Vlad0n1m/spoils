import { Room, ServerError, matchMaker, type Client } from "@colyseus/core";
import { ArraySchema, Schema, type } from "@colyseus/schema";
import { MATCH, type JoinTicket } from "@extract/shared";
import { verifyJoinTicket } from "../auth/ticket.js";
import { CLOSE } from "./close-codes.js";
import type { RosterEntry } from "../sim/types.js";
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
  @type("uint8") maxPlayers = MATCH.MAX_PLAYERS;
  @type([MmPlayer]) players = new ArraySchema<MmPlayer>();
  @type("string") battleRoomId = "";
}

/** Delay between "battle_ready" and closing the queue so every client receives the message. */
const CLOSE_AFTER_LAUNCH_MS = 2_000;

/**
 * Single demo queue "mm": launches a battle when MATCH.MAX_PLAYERS humans are in, or
 * MATCH.MATCHMAKING_TIMEOUT_MS after the first join with bots filling the rest.
 */
export class MatchmakingRoom extends Room<MmState, unknown, unknown, JoinTicket> {
  override maxClients = MATCH.MAX_PLAYERS * 2;
  private deadline?: NodeJS.Timeout;
  private launching = false;
  /** userId → client currently holding that seat (a second tab replaces the first). */
  private readonly seats = new Map<string, Client>();

  override onCreate() {
    this.setState(new MmState());
  }

  override onAuth(_client: Client, options: { ticket?: unknown }) {
    const ticket = verifyJoinTicket(options?.ticket);
    if (!ticket) throw new ServerError(401, "invalid_ticket");
    return ticket;
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
    if (this.state.players.length >= MATCH.MAX_PLAYERS) void this.launch();
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
      .slice(0, MATCH.MAX_PLAYERS)
      .map((p) => ({ userId: p.userId, nickname: p.nickname, isBot: false }));
    const bots: RosterEntry[] = botNames(MATCH.MAX_PLAYERS - humans.length).map((nickname) => ({
      userId: null,
      nickname,
      isBot: true,
    }));

    try {
      const battle = await matchMaker.createRoom("battle", { roster: [...humans, ...bots] });
      this.state.battleRoomId = battle.roomId;
      this.state.status = "started";
      this.broadcast("battle_ready", { battleRoomId: battle.roomId });
    } catch (e) {
      console.error("[mm] failed to create battle room:", e);
      for (const c of this.clients) c.leave(CLOSE.LAUNCH_FAILED, "launch_failed");
    }
    this.clock.setTimeout(() => void this.disconnect(), CLOSE_AFTER_LAUNCH_MS);
  }
}
