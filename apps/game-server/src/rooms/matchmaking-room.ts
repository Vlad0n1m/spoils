import { Room, Client, matchMaker } from "@colyseus/core";
import { Schema, type, ArraySchema } from "@colyseus/schema";
import {
  MATCHMAKING_TIMEOUT_MS,
  MIN_PLAYERS,
  ENTRY_TIERS_CENTS,
} from "@extract/shared";

class MmPlayer extends Schema {
  @type("string") userId = "";
  @type("string") nickname = "";
  @type("boolean") ready = false;
}

class MmState extends Schema {
  @type("string") entryTierCents = "0";
  @type("number") startedAt = 0;
  @type("number") deadlineAt = 0;
  @type([MmPlayer]) players = new ArraySchema<MmPlayer>();
  @type("string") status = "waiting"; // waiting | starting | started | cancelled
  @type("string") battleRoomId = "";
}

interface MmJoinOptions {
  userId: string;
  nickname: string;
  entryTierCents: string;
}

export class MatchmakingRoom extends Room<MmState> {
  override maxClients = MIN_PLAYERS;
  state = new MmState();
  private dispatchTimer?: NodeJS.Timeout;
  private launching = false;

  override onCreate(opts: { entryTierCents: string }) {
    const tier = BigInt(opts.entryTierCents);
    if (!ENTRY_TIERS_CENTS.includes(tier)) {
      throw new Error(`bad tier ${opts.entryTierCents}`);
    }
    this.state.entryTierCents = tier.toString();
    this.state.startedAt = Date.now();
    this.state.deadlineAt = this.state.startedAt + MATCHMAKING_TIMEOUT_MS;
    this.dispatchTimer = setTimeout(
      () => this.tryLaunch(true),
      MATCHMAKING_TIMEOUT_MS,
    );
    this.setMetadata({ entryTierCents: tier.toString() });
  }

  override onJoin(client: Client, options: MmJoinOptions) {
    const p = new MmPlayer();
    p.userId = options.userId;
    p.nickname = options.nickname;
    p.ready = true;
    this.state.players.push(p);
    if (this.state.players.length >= MIN_PLAYERS) {
      this.tryLaunch(false);
    }
  }

  override onLeave(client: Client) {
    if (this.state.status !== "waiting") return;
    const idx = this.state.players.findIndex(
      (p) => p.userId === (client.userData as MmJoinOptions | undefined)?.userId,
    );
    if (idx >= 0) this.state.players.splice(idx, 1);
  }

  private async tryLaunch(fillWithBots: boolean) {
    if (this.launching || this.state.status !== "waiting") return;
    if (!fillWithBots && this.state.players.length < MIN_PLAYERS) return;
    this.launching = true;
    if (this.dispatchTimer) clearTimeout(this.dispatchTimer);
    this.state.status = "starting";

    const humans = this.state.players.map((p) => ({
      userId: p.userId,
      nickname: p.nickname,
      isBot: false,
    }));
    const botsNeeded = Math.max(0, MIN_PLAYERS - humans.length);
    const bots = Array.from({ length: botsNeeded }, (_, i) => ({
      userId: "",
      nickname: randomBotName(i),
      isBot: true,
    }));
    const roster = [...humans, ...bots];

    const battle = await matchMaker.createRoom("battle", {
      entryTierCents: this.state.entryTierCents,
      roster,
    });
    this.state.battleRoomId = battle.roomId;
    this.state.status = "started";

    this.broadcast("battle_ready", { battleRoomId: battle.roomId });
    setTimeout(() => this.disconnect(), 2_000);
  }
}

const BOT_NAMES = [
  "vipergpt",
  "noodleboi",
  "sssolflare",
  "pythonsama",
  "hisss",
  "scaledup",
  "fangz",
  "constrictor",
  "rattlerug",
  "venomeme",
  "anaconda",
  "kingcobra",
  "asp",
  "boa",
  "mamba",
  "garter",
];
function randomBotName(i: number) {
  return `${BOT_NAMES[i % BOT_NAMES.length]}_${Math.floor(Math.random() * 99)}`;
}
