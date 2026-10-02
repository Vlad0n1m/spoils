import "./env.js";
import { Encoder } from "@colyseus/schema";
import express from "express";
import { createServer } from "node:http";
import { Server, matchMaker } from "@colyseus/core";
import { WebSocketTransport } from "@colyseus/ws-transport";
import { monitor } from "@colyseus/monitor";
import { BattleRoom } from "./rooms/battle-room.js";
import { MatchmakingRoom } from "./rooms/matchmaking-room.js";
import { ROOMS } from "@extract/shared";

/**
 * The default 8 KB is too small: a full 16-player battle state measures ~8–9 KB (players with
 * weapon slots, ~60–80 ground items, ~30 chests). 64 KB leaves ample room for late-match drops.
 */
Encoder.BUFFER_SIZE = 64 * 1024;

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
