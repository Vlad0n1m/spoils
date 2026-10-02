import { Encoder } from "@colyseus/schema";
import { NET } from "@extract/shared";

// FIRST statement (critique): the full v2 state (30 players, containers, views) overflowed the 8 KB
// default. Static imports are hoisted in ESM, so everything that could create a room or serializer
// is imported dynamically below, after this line has run.
Encoder.BUFFER_SIZE = NET.ENCODER_BUFFER_BYTES;

await import("./env.js");
const { default: express } = await import("express");
const { createServer } = await import("node:http");
const { Server, matchMaker } = await import("@colyseus/core");
const { WebSocketTransport } = await import("@colyseus/ws-transport");
const { monitor } = await import("@colyseus/monitor");
const { BattleRoom } = await import("./rooms/battle-room.js");
const { MatchmakingRoom } = await import("./rooms/matchmaking-room.js");
const { ROOMS } = await import("@extract/shared");

const port = Number(process.env.GAME_SERVER_PORT ?? 2567);

const app = express();
app.get("/healthz", (_req, res) => res.json({ ok: true }));
// The monitor exposes every room's state and lets anyone dispose rooms: dev only.
if (process.env.NODE_ENV !== "production") app.use("/colyseus", monitor());

// Clients only queue (joinOrCreate "mm") and enter their battle by id; "create" / "join" would let
// anyone spawn queues at will. Battle creation is additionally gated by LAUNCH_KEY.
matchMaker.controller.exposedMethods = ["joinOrCreate", "joinById", "reconnect"];

const httpServer = createServer(app);
const gameServer = new Server({
  transport: new WebSocketTransport({ server: httpServer }),
});

gameServer.define(ROOMS.MATCHMAKING, MatchmakingRoom);
gameServer.define(ROOMS.BATTLE, BattleRoom);

await gameServer.listen(port);
console.log(`[game-server] listening on :${port}`);
