import { Encoder } from "@colyseus/schema";
import { NET } from "@extract/shared";

// FIRST statement (critique): the full v2 state (30 players, containers, views) overflowed the 8 KB
// default. Static imports are hoisted in ESM, so everything that could create a room or serializer
// is imported dynamically below, after this line has run.
Encoder.BUFFER_SIZE = NET.ENCODER_BUFFER_BYTES;

// Loads .env and refuses to boot in production without GAME_SERVER_ID (D29).
await import("./env.js");
const { default: express } = await import("express");
const { createServer } = await import("node:http");
const { Server } = await import("@colyseus/core");
const { WebSocketTransport } = await import("@colyseus/ws-transport");
const { monitor } = await import("@colyseus/monitor");
const { defineRooms } = await import("./rooms/define.js");
const { announceBoot, BOOT_RETRY_MS } = await import("./net/web-api.js");
const { worldDirectory } = await import("./world/directory.js");

// The directory's timers and the web posts never throw by design; anything that still slips
// through must not take down every map on this process.
process.on("unhandledRejection", (reason) => {
  console.error("[game-server] unhandled rejection:", reason);
});

const port = Number(process.env.GAME_SERVER_PORT ?? 2567);

const app = express();
app.get("/healthz", (_req, res) => res.json({ ok: true }));
// The monitor exposes every room's state and lets anyone dispose rooms: dev only.
if (process.env.NODE_ENV !== "production") app.use("/colyseus", monitor());

const httpServer = createServer(app);
const gameServer = new Server({
  transport: new WebSocketTransport({ server: httpServer }),
});

// WORLD v6: one room type (the world shard), clients may only joinById (D4).
defineRooms(gameServer);

await gameServer.listen(port);
console.log(`[game-server] listening on :${port}`);
// Shards of a previous (crashed) process can never settle: have the web void them first, then open
// the current cycle's shard (fresh matchId and loot, same boss event) and run the world timers.
// When the web stays unreachable for the first ≈1 min the announce keeps retrying in the background
// (the web also voids a shard row lazily once a newer row of its cycle exists).
await announceBoot(undefined, { retryEveryMs: BOOT_RETRY_MS });
await worldDirectory.start();
