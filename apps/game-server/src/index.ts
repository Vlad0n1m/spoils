import "./env.js";
import { Encoder } from "@colyseus/schema";
import express from "express";
import { createServer } from "node:http";
import { Server } from "@colyseus/core";
import { WebSocketTransport } from "@colyseus/ws-transport";
import { monitor } from "@colyseus/monitor";
import { BattleRoom } from "./rooms/battle-room.js";
import { MatchmakingRoom } from "./rooms/matchmaking-room.js";
import { ENTRY_TIERS_CENTS } from "@extract/shared";

/** Default 8 KB; battle room with many orbs + long snakes overflows (schema merge patch). */
Encoder.BUFFER_SIZE = 64 * 1024;

const port = Number(process.env.GAME_SERVER_PORT ?? 2567);

const app = express();
app.get("/healthz", (_req, res) => res.json({ ok: true }));
app.use("/colyseus", monitor());

const httpServer = createServer(app);
const gameServer = new Server({
  transport: new WebSocketTransport({ server: httpServer }),
});

for (const tier of ENTRY_TIERS_CENTS) {
  gameServer.define(`mm_${tier.toString()}`, MatchmakingRoom, {
    entryTierCents: tier.toString(),
  });
}
gameServer.define("battle", BattleRoom);

await gameServer.listen(port);
console.log(`[game-server] listening on :${port}`);
