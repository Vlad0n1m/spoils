#!/usr/bin/env node
/**
 * Load-test clients for the world shard: N colyseus.js connections that join with valid tickets and
 * play like a person at the keyboard (they are test clients of the load test, not in-game bots: they
 * hold a human seat exactly as a browser would). Each client:
 * - decodes the room state with the real BattleState schema (StateView patches, like the web client);
 * - sends one INPUT sample per INPUT_DT_MS (30 Hz): it walks from zone to zone (most trips go to one
 *   "hot" zone so the clients meet), steps around walls when stuck, aims at the nearest visible
 *   player or NPC and fires bursts at it (rare idle bursts otherwise), rolls now and then;
 * - sends PING every 2 s (RTT), RELOAD on an empty magazine, HEAL when hurt, INTERACT → TAKE_ALL →
 *   SEARCH_CLOSE every ~12 s (container / corpse loot traffic), a grenade at a target now and then;
 * - counts every received message by kind (full state, patch, ev, party, pong, other) and its own
 *   sent bytes, so bytes/s per client can be reported (WebSocket payload bytes; frame and TCP/IP
 *   overhead are not included);
 * - after a death / extraction (OUTCOME) leaves and joins again with a new entry (--rejoin, default on).
 *
 * Tickets:
 * - "sign" (default): the client signs JoinTickets itself with the game server's HMAC secret, read from
 *   the env var named by --secret-env (default LOAD_HMAC_SECRET; never printed). Needs --room and --match
 *   (run.mjs parses them from the server log). Use with a server whose web API is web-stub.mjs.
 * - "web": a guest session per client (POST /api/auth/guest) and POST /api/world/join on --web for each
 *   entry, i.e. the full production path incl. Postgres (needs GUEST_PLAY_ENABLED on that web). The web
 *   allows WORLD.MAX_ENTRIES_PER_CYCLE entries per user and cycle; a client that hits the limit stops.
 *   Not exercised by the local run of block D/E (see docs/SCALING.md).
 *
 * CLI (run.mjs uses createSwarm directly):
 *   LOAD_HMAC_SECRET=… node scripts/load/clients.mjs --server ws://127.0.0.1:2669 --room <roomId> \
 *     --match <matchId> --schedule 1:60,4:75,8:90 [--out dir] [--seed 1]
 *   node scripts/load/clients.mjs --tickets web --web https://staging.example --server wss://gs.example \
 *     --schedule 8:120
 */

import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { loadColyseus, loadShared, parseArgs, parseSchedule, signTicket, sleep } from "./lib.mjs";

/** colyseus Protocol codes (colyseus.js Protocol.mjs). */
const P = { JOIN_ROOM: 10, ERROR: 11, LEAVE_ROOM: 12, ROOM_DATA: 13, ROOM_STATE: 14, ROOM_STATE_PATCH: 15, ROOM_DATA_BYTES: 17 };
const KINDS = ["join", "state", "patch", "ev", "party", "pong", "joined", "outcome", "other"];

/** Seeded PRNG (mulberry32) so two runs with the same --seed drive the same way. */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** ROOM_DATA type string (schema encode.string: fixstr 0xa0|len for short names). */
function dataType(buf) {
  const b = buf[1];
  if ((b & 0xe0) !== 0xa0) return "other";
  const len = b & 0x1f;
  let s = "";
  for (let i = 0; i < len && 2 + i < buf.length; i++) s += String.fromCharCode(buf[2 + i]);
  return s;
}

function kindOf(buf) {
  switch (buf[0]) {
    case P.JOIN_ROOM:
      return "join";
    case P.ROOM_STATE:
      return "state";
    case P.ROOM_STATE_PATCH:
      return "patch";
    case P.ROOM_DATA: {
      const t = dataType(buf);
      return t === "ev" || t === "party" || t === "pong" || t === "joined" || t === "outcome" ? t : "other";
    }
    default:
      return "other";
  }
}

const zeroKinds = () => Object.fromEntries(KINDS.map((k) => [k, 0]));

class LoadClient {
  constructor(i, ctx) {
    this.i = i;
    this.ctx = ctx;
    this.rand = rng((ctx.seed * 7919 + i * 104729) >>> 0);
    this.userId = `load-${ctx.runTag}-${i}`;
    this.nickname = `Load${ctx.runTag.slice(0, 4)}${i}`.slice(0, 16);
    this.room = null;
    this.selfKey = "";
    this.active = false;
    this.alive = false;
    this.connected = false;
    this.seq = 0;
    this.cookie = "";
    /** Web tickets: guest generation (a new guest after entry_limit) and the earliest next try. */
    this.gen = 0;
    this.waitUntil = 0;
    // counters (cumulative; the swarm snapshots them)
    this.inBytes = zeroKinds();
    this.inMsgs = zeroKinds();
    this.outBytes = 0;
    this.outMsgs = 0;
    this.rtts = [];
    this.joinMs = [];
    this.joins = 0;
    this.joinErrors = {};
    this.outcomes = {};
    this.stopReason = "";
    this.resetDrive();
  }

  resetDrive() {
    this.wp = null;
    this.heading = this.rand() * Math.PI * 2;
    this.lastPos = null;
    this.lastMoveCheck = 0;
    this.detourUntil = 0;
    this.detourDir = 0;
    this.fireUntil = 0;
    this.fireNextAt = 0;
    this.nextPing = 0;
    this.nextRoll = performance.now() + 4000 + this.rand() * 8000;
    this.nextInteract = performance.now() + 6000 + this.rand() * 10000;
    this.pendingTakeAt = 0;
    this.pendingCloseAt = 0;
    this.nextReload = 0;
    this.nextHeal = 0;
    this.nextThrow = performance.now() + 20000 + this.rand() * 40000;
    this.pings = new Map();
  }

  count(data) {
    const buf = new Uint8Array(data);
    const k = kindOf(buf);
    this.inBytes[k] += buf.byteLength;
    this.inMsgs[k]++;
  }

  async ticket() {
    const { ctx } = this;
    if (ctx.tickets === "web") return this.webTicket();
    return {
      roomId: ctx.roomId,
      ticket: signTicket(ctx.shared, ctx.secret, {
        userId: this.userId,
        nickname: this.nickname,
        matchId: ctx.matchId,
        entryId: randomUUID(),
      }),
    };
  }

  /** Guest session once, then /api/world/join per entry (production path). */
  async webTicket() {
    const base = this.ctx.web.replace(/\/$/, "");
    const headers = { "content-type": "application/json", accept: "application/json" };
    if (!this.cookie) {
      const r = await fetch(`${base}/api/auth/guest`, { method: "POST", headers, body: JSON.stringify({ nickname: this.nickname }) });
      if (!r.ok) throw new Error(`guest ${r.status} ${(await r.text()).slice(0, 120)}`);
      this.cookie = r.headers
        .getSetCookie()
        .map((c) => c.split(";")[0])
        .join("; ");
    }
    const r = await fetch(`${base}/api/world/join`, { method: "POST", headers: { ...headers, cookie: this.cookie }, body: "{}" });
    const body = await r.json().catch(() => null);
    if (!r.ok || !body?.ticket || !body?.roomId) {
      const err = new Error(`world/join ${r.status} ${body?.error ?? ""}`);
      err.code = body?.error ?? `http_${r.status}`;
      err.retryInMs = Number.isFinite(body?.retryInMs) ? body.retryInMs : undefined;
      throw err;
    }
    return { roomId: body.roomId, ticket: body.ticket };
  }

  async join() {
    const { ctx } = this;
    const t0 = performance.now();
    let roomId;
    let ticket;
    try {
      ({ roomId, ticket } = await this.ticket());
    } catch (e) {
      const code = e?.code ?? "ticket_failed";
      this.joinErrors[code] = (this.joinErrors[code] ?? 0) + 1;
      if (ctx.tickets === "web") {
        // Multi-cycle runs: a fresh guest after the per-cycle entry limit; wait out the closed /
        // resetting part of the cycle (the web says how long).
        if (code === "entry_limit") this.newGuest();
        else if (code === "entry_closed" || code === "world_starting") this.waitUntil = Date.now() + Math.min(15 * 60_000, e.retryInMs ?? 15_000);
      } else if (code === "entry_limit" || code === "entry_closed") this.stopReason = code;
      ctx.log(`[client ${this.i}] ticket: ${e?.message ?? e}`);
      return false;
    }
    const client = new ctx.Colyseus.Client(ctx.server);
    // Every Room this client creates carries its counter owner from the first byte on.
    client.createRoom = (name, schema) => {
      const r = new ctx.Colyseus.Room(name, schema);
      r.__load = this;
      return r;
    };
    let room;
    try {
      room = await client.joinById(roomId, { ticket, mapHash: ctx.mapHash }, ctx.shared.BattleState);
    } catch (e) {
      const code = String(e?.message ?? e).split(":")[0] || "join_failed";
      this.joinErrors[code] = (this.joinErrors[code] ?? 0) + 1;
      if (ctx.tickets !== "web" && (code === "entry_closed" || code === "map_gone")) this.stopReason = code;
      ctx.log(`[client ${this.i}] join refused: ${e?.message ?? e}`);
      return false;
    }
    if (!this.active) {
      // stop() ran while this join was in flight.
      void room.leave(true).catch(() => {});
      return true;
    }
    this.joinMs.push(performance.now() - t0);
    this.joins++;
    this.room = room;
    this.connected = true;
    this.alive = true;
    this.resetDrive();
    const conn = room.connection;
    const send = conn.send.bind(conn);
    conn.send = (data) => {
      this.outBytes += data.byteLength;
      this.outMsgs++;
      send(data);
    };
    const { S2C } = ctx.shared;
    room.onMessage(S2C.JOINED, (m) => {
      if (typeof m?.selfKey === "string") this.selfKey = m.selfKey;
    });
    room.onMessage(S2C.EV, () => {});
    room.onMessage(S2C.PARTY, () => {});
    room.onMessage(S2C.INV_ERR, () => {});
    room.onMessage(S2C.SETTLED, () => {});
    room.onMessage(S2C.PONG, (m) => {
      const sent = this.pings.get(m?.t);
      if (sent !== undefined) {
        this.rtts.push(performance.now() - sent);
        this.pings.delete(m.t);
      }
    });
    room.onMessage(S2C.OUTCOME, (o) => {
      if (!this.alive) return;
      this.alive = false;
      const exit = o?.exit ?? "unknown";
      this.outcomes[exit] = (this.outcomes[exit] ?? 0) + 1;
      if (this.active && ctx.rejoin && !this.stopReason) void this.rejoin();
    });
    room.onMessage("*", () => {});
    room.onLeave((code) => {
      this.connected = false;
      this.alive = false;
      if (this.room === room) this.room = null;
      // Signed tickets name one shard: the wipe ends that client. Web tickets follow the world.
      if (code === ctx.shared.CLOSE_CODES.WIPED && ctx.tickets !== "web") this.stopReason = "wiped";
      if (this.active && !this.stopReason && code !== 1000 && code !== 4000) {
        ctx.log(`[client ${this.i}] dropped (${code}); joining again`);
        void this.rejoin();
      }
    });
    return true;
  }

  async rejoin() {
    if (this.rejoining) return;
    this.rejoining = true;
    try {
      const old = this.room;
      this.room = null;
      if (old) await Promise.race([old.leave(true).catch(() => {}), sleep(2000)]);
      await sleep(3000);
      while (this.active && !this.stopReason && !(await this.join())) await this.backoff();
    } finally {
      this.rejoining = false;
    }
  }

  async start() {
    this.active = true;
    while (this.active && !this.stopReason && !(await this.join())) await this.backoff();
  }

  /** Pause between join attempts: 3 s, or until the web's retry time (checked every 5 s so stop() is quick). */
  async backoff() {
    await sleep(3000);
    while (this.active && Date.now() < this.waitUntil) await sleep(Math.min(5000, this.waitUntil - Date.now()));
  }

  newGuest() {
    this.gen++;
    this.cookie = "";
    this.nickname = `L${this.ctx.runTag.slice(0, 4)}${this.i}g${this.gen}`.slice(0, 16);
  }

  async stop() {
    this.active = false;
    const r = this.room;
    this.room = null;
    if (r) await Promise.race([r.leave(true).catch(() => {}), sleep(2000)]);
    this.connected = false;
  }

  /** Pick the next waypoint: a zone centre, mostly the hot zone. */
  nextWaypoint() {
    const zones = this.ctx.zones;
    const z = this.rand() < 0.6 ? this.ctx.hotZone : zones[Math.floor(this.rand() * zones.length)];
    const r = z.rect;
    this.wp = { x: r.x + r.w * (0.25 + this.rand() * 0.5), y: r.y + r.h * (0.25 + this.rand() * 0.5) };
  }

  /** One 30 Hz input step. */
  step(now) {
    const room = this.room;
    if (!room || !this.alive || !this.connected) return;
    const { C2S } = this.ctx.shared;
    const st = room.state;
    const me = st?.players?.get(room.sessionId);
    let mx = 0;
    let my = 0;
    let aim = this.heading;
    let fire = false;
    if (me) {
      if (!this.wp) this.nextWaypoint();
      const dx = this.wp.x - me.x;
      const dy = this.wp.y - me.y;
      const dist = Math.hypot(dx, dy);
      if (dist < 250) this.nextWaypoint();
      // Stuck check every 600 ms: barely moved while walking → side-step for a moment.
      if (now - this.lastMoveCheck > 600) {
        if (this.lastPos && Math.hypot(me.x - this.lastPos.x, me.y - this.lastPos.y) < 25 && now > this.detourUntil) {
          this.detourUntil = now + 700 + this.rand() * 900;
          this.detourDir = Math.atan2(dy, dx) + (this.rand() < 0.5 ? 1 : -1) * (Math.PI / 2 + this.rand() * 0.6);
        }
        this.lastPos = { x: me.x, y: me.y };
        this.lastMoveCheck = now;
      }
      this.heading = now < this.detourUntil ? this.detourDir : Math.atan2(dy, dx);
      mx = Math.cos(this.heading);
      my = Math.sin(this.heading);
      aim = this.heading + Math.sin(now / 700 + this.i) * 0.35;

      // Nearest visible living target (players holds only what this client may see).
      let best = null;
      let bestD = 700;
      st.players.forEach((p) => {
        if (p.sessionId === room.sessionId || !p.alive) return;
        const d = Math.hypot(p.x - me.x, p.y - me.y);
        if (d < bestD) {
          bestD = d;
          best = p;
        }
      });
      if (best) {
        aim = Math.atan2(best.y - me.y, best.x - me.x) + (this.rand() - 0.5) * 0.12;
        if (now >= this.fireNextAt) {
          this.fireUntil = now + 300 + this.rand() * 900;
          this.fireNextAt = this.fireUntil + 300 + this.rand() * 900;
        }
        fire = now < this.fireUntil;
        // Strafe a little instead of walking into the target.
        if (bestD < 350) {
          mx = Math.cos(aim + Math.PI / 2);
          my = Math.sin(aim + Math.PI / 2);
        }
        if (now >= this.nextThrow && bestD > 150) {
          this.nextThrow = now + 30000 + this.rand() * 30000;
          room.send(C2S.THROW, { a: aim, d: Math.min(1, bestD / 600), q: this.seq });
        }
      } else if (now >= this.fireNextAt) {
        // Idle burst (checking a corner) about once every 15 s.
        if (this.rand() < 0.002 * 30) {
          this.fireUntil = now + 200 + this.rand() * 300;
        }
        this.fireNextAt = now + 1000;
        fire = now < this.fireUntil;
      } else fire = now < this.fireUntil;

      const self = (this.selfKey && st.self?.get(this.selfKey)) || firstSelf(st);
      if (self) {
        const w = self.slots?.get(self.active);
        if (w && w.mag === 0 && now >= this.nextReload && self.reloadUntil === 0) {
          this.nextReload = now + 2500;
          room.send(C2S.RELOAD, {});
        }
      }
      if (me.hp < 50 && now >= this.nextHeal && !fire) {
        this.nextHeal = now + 8000;
        room.send(C2S.HEAL, { kind: "bandage" });
      }
    }
    const sample = { seq: ++this.seq, mx, my, aim, fire };
    if (now >= this.nextRoll) {
      this.nextRoll = now + 6000 + this.rand() * 9000;
      sample.roll = true;
    }
    room.send(C2S.INPUT, sample);

    if (now >= this.nextPing) {
      this.nextPing = now + 2000;
      const t = Math.round(now * 1000) / 1000;
      this.pings.set(t, now);
      if (this.pings.size > 20) this.pings.delete(this.pings.keys().next().value);
      room.send(C2S.PING, { t });
    }
    if (now >= this.nextInteract) {
      this.nextInteract = now + 9000 + this.rand() * 6000;
      room.send(C2S.INTERACT, {});
      this.pendingTakeAt = now + 1800;
    }
    if (this.pendingTakeAt && now >= this.pendingTakeAt) {
      this.pendingTakeAt = 0;
      room.send(C2S.INV_TAKE_ALL, {});
      this.pendingCloseAt = now + 800;
    }
    if (this.pendingCloseAt && now >= this.pendingCloseAt) {
      this.pendingCloseAt = 0;
      room.send(C2S.SEARCH_CLOSE, {});
    }
  }
}

/** The only self entry a client ever sees is its own (StateView). */
function firstSelf(st) {
  let out = null;
  st.self?.forEach?.((s) => {
    out ??= s;
  });
  return out;
}

/**
 * A swarm of load clients. `setCount(n)` joins / leaves clients (joins staggered by `staggerMs`),
 * `snapshot()` returns cumulative counters, `stop()` disconnects everyone.
 */
export async function createSwarm(opts) {
  const [Colyseus, shared] = await Promise.all([loadColyseus(), loadShared()]);
  const map = shared.generateMap(opts.mapId ?? "steppe");
  const mapHash = shared.mapHash(map);
  // Hot zone: the zone closest to the map centre (where the clients mostly go, so they meet).
  const cx = map.width / 2;
  const cy = map.height / 2;
  const zones = map.zones.filter((z) => z.rect.w > 0 && z.rect.h > 0);
  const hotZone = zones.reduce((a, z) => {
    const d = (z) => Math.hypot(z.rect.x + z.rect.w / 2 - cx, z.rect.y + z.rect.h / 2 - cy);
    return d(z) < d(a) ? z : a;
  });
  const ctx = {
    Colyseus,
    shared,
    server: opts.server,
    roomId: opts.roomId,
    matchId: opts.matchId,
    secret: opts.secret,
    tickets: opts.tickets ?? "sign",
    web: opts.web ?? "",
    rejoin: opts.rejoin !== false,
    seed: Number(opts.seed ?? 1),
    runTag: opts.runTag ?? randomUUID().slice(0, 8),
    mapHash,
    zones,
    hotZone,
    log: opts.log ?? ((m) => console.log(m)),
  };
  if (ctx.tickets === "sign" && (!ctx.secret || !ctx.roomId || !ctx.matchId)) throw new Error("sign tickets need the secret, --room and --match");
  if (ctx.tickets === "web" && !ctx.web) throw new Error("web tickets need --web");

  // Count every received byte per room, from the handshake on (connect() binds the prototype method).
  const orig = Colyseus.Room.prototype.onMessageCallback;
  Colyseus.Room.prototype.onMessageCallback = function (event) {
    this.__load?.count(event.data);
    return orig.call(this, event);
  };

  const clients = [];
  const inputMs = shared.INPUT_DT_MS;
  let ticking = true;
  // One timer drives every client at 30 Hz (each one sends exactly one sample per period).
  let nextAt = performance.now();
  const loop = () => {
    if (!ticking) return;
    const now = performance.now();
    for (const c of clients) {
      try {
        c.step(now);
      } catch (e) {
        ctx.log(`[client ${c.i}] step failed: ${e?.message ?? e}`);
      }
    }
    nextAt += inputMs;
    if (nextAt < now - 200) nextAt = now + inputMs; // fell behind (laptop hitch): do not burst
    setTimeout(loop, Math.max(0, nextAt - performance.now()));
  };
  loop();

  async function setCount(n, staggerMs = opts.staggerMs ?? 400) {
    while (clients.filter((c) => c.active).length > n) {
      const c = [...clients].reverse().find((x) => x.active);
      await c.stop();
    }
    const starts = [];
    while (clients.filter((c) => c.active).length < n) {
      let c = clients.find((x) => !x.active && !x.stopReason);
      if (!c) {
        c = new LoadClient(clients.length, ctx);
        clients.push(c);
      }
      c.active = true;
      starts.push(c.start());
      if (staggerMs > 0) await sleep(staggerMs);
    }
    await Promise.all(starts);
  }

  function snapshot() {
    const inBytes = zeroKinds();
    const inMsgs = zeroKinds();
    let outBytes = 0;
    let outMsgs = 0;
    let connected = 0;
    let alive = 0;
    const rtts = [];
    const joinMs = [];
    const outcomes = {};
    const joinErrors = {};
    let joins = 0;
    for (const c of clients) {
      for (const k of KINDS) {
        inBytes[k] += c.inBytes[k];
        inMsgs[k] += c.inMsgs[k];
      }
      outBytes += c.outBytes;
      outMsgs += c.outMsgs;
      if (c.connected) connected++;
      if (c.alive) alive++;
      rtts.push(...c.rtts.splice(0));
      joinMs.push(...c.joinMs.splice(0));
      joins += c.joins;
      for (const [k, v] of Object.entries(c.outcomes)) outcomes[k] = (outcomes[k] ?? 0) + v;
      for (const [k, v] of Object.entries(c.joinErrors)) joinErrors[k] = (joinErrors[k] ?? 0) + v;
    }
    return { t: Date.now(), active: clients.filter((c) => c.active).length, connected, alive, inBytes, inMsgs, outBytes, outMsgs, rtts, joinMs, joins, outcomes, joinErrors };
  }

  async function stop() {
    await Promise.all(clients.map((c) => c.stop()));
    ticking = false;
  }

  return { setCount, snapshot, stop, mapHash, hotZone: hotZone.name, clients };
}

/** Swarm snapshots every `everyMs` to `<dir>/clients.jsonl` (rtts / join times as arrays of that window). */
export function recordSwarm(swarm, dir, everyMs = 5000) {
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "clients.jsonl");
  const write = () => {
    const s = swarm.snapshot();
    appendFileSync(file, JSON.stringify({ ...s, rtts: s.rtts.map((v) => +v.toFixed(2)), joinMs: s.joinMs.map((v) => Math.round(v)) }) + "\n");
  };
  const h = setInterval(write, everyMs);
  return () => {
    clearInterval(h);
    write();
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const args = parseArgs(process.argv.slice(2));
  const schedule = parseSchedule(args.schedule ?? "1:60");
  const secretEnv = String(args["secret-env"] ?? "LOAD_HMAC_SECRET");
  const out = path.resolve(String(args.out ?? "load-clients"));
  const swarm = await createSwarm({
    server: String(args.server ?? "ws://127.0.0.1:2669"),
    roomId: args.room,
    matchId: args.match,
    secret: process.env[secretEnv],
    tickets: args.tickets ?? "sign",
    web: args.web,
    rejoin: args.rejoin !== false,
    seed: args.seed ?? 1,
  });
  const stopRec = recordSwarm(swarm, out);
  const phases = [];
  for (const step of schedule) {
    const startMs = Date.now();
    console.log(`[clients] ${step.clients} client(s) for ${step.seconds} s`);
    await swarm.setCount(step.clients);
    await sleep(Math.max(0, step.seconds * 1000 - (Date.now() - startMs)));
    phases.push({ name: `${step.clients} clients`, clients: step.clients, startMs, endMs: Date.now() });
  }
  await swarm.stop();
  stopRec();
  // analyze.mjs reads phases.json next to the server's ticks.csv / probe.jsonl (copy them into one dir).
  writeFileSync(path.join(out, "phases.json"), JSON.stringify(phases, null, 1));
  const s = swarm.snapshot();
  console.log(`[clients] done: ${s.joins} joins, outcomes ${JSON.stringify(s.outcomes)}, join errors ${JSON.stringify(s.joinErrors)}`);
  process.exit(0);
}
