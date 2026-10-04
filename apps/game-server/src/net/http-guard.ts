/**
 * Body cap for Colyseus' HTTP matchmaking (security audit "matchmake HTTP body"): @colyseus/core
 * 0.16.24 Server.handleMatchMakeRequest buffers the whole body of any POST whose URL contains
 * "/matchmake" before it looks at the method or the ticket, with no size limit. A joinById body is
 * a JoinTicket plus the map hash (well under 1 KB), so anything past MATCHMAKE_MAX_BODY_BYTES is
 * refused (413 when the length is declared up front, the connection dropped when it streams past it).
 * nginx caps the public path as well (deploy/nginx client_max_body_size); this covers GAME_BIND=0.0.0.0.
 */

import type { IncomingMessage, Server, ServerResponse } from "node:http";

export const MATCHMAKE_MAX_BODY_BYTES = 8 * 1024;

type Listener = (req: IncomingMessage, res: ServerResponse) => void;

/** Call after `new Server({ transport })` (it installs Colyseus' request listener) and before listen. */
export function guardMatchmakeBodies(server: Server, limit = MATCHMAKE_MAX_BODY_BYTES): void {
  const listeners = server.listeners("request").slice() as Listener[];
  server.removeAllListeners("request");
  server.on("request", (req: IncomingMessage, res: ServerResponse) => {
    if (req.method === "POST" && (req.url ?? "").includes("/matchmake")) {
      const declared = Number(req.headers["content-length"]);
      if (Number.isFinite(declared) && declared > limit) {
        res.writeHead(413, { Connection: "close", "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "body_too_large" }));
        return;
      }
      let seen = 0;
      req.on("data", (chunk: Buffer) => {
        seen += chunk.length;
        if (seen > limit) req.destroy();
      });
    }
    for (const l of listeners) l.call(server, req, res);
  });
}
