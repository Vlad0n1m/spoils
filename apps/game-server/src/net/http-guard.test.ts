/** Security audit: the matchmaking body cap in front of Colyseus' request listener. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, request, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { MATCHMAKE_MAX_BODY_BYTES, guardMatchmakeBodies } from "./http-guard.js";

/** A stand-in for Colyseus' listener: buffers every /matchmake body like handleMatchMakeRequest. */
function fakeColyseus(seen: number[]) {
  return (req: IncomingMessage, res: ServerResponse) => {
    if (!(req.url ?? "").includes("/matchmake")) {
      res.end("other");
      return;
    }
    const parts: Buffer[] = [];
    req.on("data", (c: Buffer) => parts.push(c));
    req.on("end", () => {
      seen.push(Buffer.concat(parts).length);
      res.end("ok");
    });
  };
}

function post(port: number, path: string, body: Buffer, chunked = false): Promise<{ status: number; text: string } | "dropped"> {
  return new Promise((resolve) => {
    const req = request(
      { port, path, method: "POST", headers: chunked ? { "Transfer-Encoding": "chunked" } : { "Content-Length": String(body.length) } },
      (res) => {
        let text = "";
        res.on("data", (c) => (text += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, text }));
        res.on("error", () => resolve("dropped"));
      },
    );
    req.on("error", () => resolve("dropped"));
    if (chunked) {
      for (let i = 0; i < body.length; i += 1024) req.write(body.subarray(i, i + 1024));
    } else {
      req.write(body);
    }
    req.end();
  });
}

test("matchmake bodies past the cap never reach Colyseus; small ones and other routes pass", async () => {
  const seen: number[] = [];
  const server = createServer(fakeColyseus(seen));
  guardMatchmakeBodies(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const { port } = server.address() as AddressInfo;
  try {
    const smallBody = Buffer.from(JSON.stringify({ ticket: "x".repeat(200) }));
    const small = await post(port, "/matchmake/joinById/abc", smallBody);
    assert.deepEqual(small, { status: 200, text: "ok" });
    const declared = await post(port, "/matchmake/joinById/abc", Buffer.alloc(MATCHMAKE_MAX_BODY_BYTES + 1, 0x61));
    assert.ok(declared !== "dropped" && declared.status === 413, "declared length over the cap: 413");
    const streamed = await post(port, "/matchmake/joinById/abc", Buffer.alloc(64 * 1024, 0x61), true);
    assert.equal(streamed, "dropped", "a chunked body growing past the cap: connection dropped");
    assert.deepEqual(seen, [smallBody.length], "Colyseus only ever saw the small body");
    assert.deepEqual(await post(port, "/healthz", Buffer.alloc(MATCHMAKE_MAX_BODY_BYTES * 2)), { status: 200, text: "other" });
  } finally {
    server.close();
  }
});
