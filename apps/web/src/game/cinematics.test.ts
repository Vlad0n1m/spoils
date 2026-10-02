/**
 * Run: apps/game-server/node_modules/.bin/tsx --test apps/web/src/game/cinematics.test.ts
 */

import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";
import { Container } from "pixi.js";
import { MATCH, type EventsMsg, type KillMsg } from "@extract/shared";
import { createCameraSystem, getCameraRig } from "./camera";
import type { GameContext } from "./systems";
import { heartbeatFor, LOW_HP } from "./audio/game-audio";
import {
  CINE,
  HITMARKER,
  PX_PER_METER,
  autosellLine,
  channelBars,
  createCinematicSystem,
  createHitmarkerSystem,
  createLowHpSystem,
  deathPose,
  diedNow,
  KILLER_SEEN_MS,
  locateKiller,
  easeOutBack,
  emptyPose,
  extractPose,
  formatCredits,
  heartbeatIntervalMs,
  heartbeatPulse,
  hitmarkerPose,
  killCard,
  lowHpStrength,
} from "./cinematics";

describe("hitmarkerPose", () => {
  const out = { alpha: 0, scale: 0, gap: 0 };
  it("pops in, fades, and ends", () => {
    assert.equal(hitmarkerPose(-1, "hit", out), false);
    assert.equal(hitmarkerPose(0, "hit", out), true);
    assert.equal(out.alpha, 1);
    assert.ok(out.scale > 1.3, "pops in big");
    hitmarkerPose(200, "hit", out);
    assert.ok(out.alpha > 0 && out.alpha < 1);
    assert.equal(out.scale, 1);
    assert.equal(hitmarkerPose(HITMARKER.HIT_MS, "hit", out), false);
  });
  it("kills last longer and spread", () => {
    assert.equal(hitmarkerPose(HITMARKER.HIT_MS + 50, "kill", out), true);
    const gap = out.gap;
    hitmarkerPose(HITMARKER.KILL_MS - 10, "kill", out);
    assert.ok(out.gap > gap);
    assert.equal(hitmarkerPose(HITMARKER.KILL_MS, "kill", out), false);
    assert.equal(hitmarkerPose(10, "armor", out), true, "armor hits use the hit timing");
  });
});

describe("low HP", () => {
  it("strength ramps from the heartbeat threshold to the floor", () => {
    assert.equal(lowHpStrength(100), 0);
    assert.equal(lowHpStrength(LOW_HP.threshold), 0);
    assert.equal(lowHpStrength(LOW_HP.floor), 1);
    assert.equal(lowHpStrength(1), 1);
    assert.equal(lowHpStrength(0), 0, "dead: no vignette");
    assert.ok(lowHpStrength(20) > lowHpStrength(30));
  });
  it("beats in time with game-audio's heartbeat", () => {
    for (const hp of [34, 30, 22, 15, 10, 3]) assert.equal(heartbeatIntervalMs(hp), heartbeatFor(hp)!.intervalMs, `hp ${hp}`);
  });
  it("pulse has a strong lub at 0 and a softer dub at 0.2, quiet in between", () => {
    assert.ok(heartbeatPulse(0) > 0.99);
    assert.ok(heartbeatPulse(0.2) > 0.55 && heartbeatPulse(0.2) < 0.7);
    assert.ok(heartbeatPulse(0.6) < 0.01);
    assert.ok(Math.abs(heartbeatPulse(0.97) - heartbeatPulse(0.03)) < 1e-3, "the lub wraps around");
    assert.ok(Math.abs(heartbeatPulse(3.2) - heartbeatPulse(0.2)) < 1e-9);
  });
});

describe("cinematic poses", () => {
  it("channel bars creep in over the last seconds only", () => {
    assert.equal(channelBars(MATCH.EXTRACT_CHANNEL_MS), 0);
    assert.equal(channelBars(CINE.CHANNEL_LEAD_MS), 0);
    assert.ok(channelBars(1500) > 0 && channelBars(1500) < CINE.CHANNEL_BARS);
    assert.equal(channelBars(0), CINE.CHANNEL_BARS);
    assert.equal(channelBars(-100), CINE.CHANNEL_BARS);
  });
  it("extraction: bars close from the channel level, flash fades, stamp slams to 1×", () => {
    const p = emptyPose();
    extractPose(0, 0.03, CINE.FLASH, p);
    assert.equal(p.bars, 0.03);
    assert.equal(p.flash, CINE.FLASH);
    assert.equal(p.stampAlpha, 0);
    extractPose(CINE.EXTRACT_BARS_MS, 0.03, CINE.FLASH, p);
    assert.equal(p.bars, CINE.EXTRACT_BARS);
    assert.equal(p.flash, 0);
    extractPose(CINE.STAMP_AT_MS + CINE.STAMP_MS * 0.6, 0, CINE.FLASH, p);
    assert.ok(p.stampScale < 1, "overshoots below 1× on the way down");
    extractPose(CINE.STAMP_AT_MS + CINE.STAMP_MS, 0, CINE.FLASH, p);
    assert.ok(Math.abs(p.stampScale - 1) < 1e-9);
    assert.equal(p.stampAlpha, 1);
    extractPose(5000, 0, CINE.FLASH_REDUCED, p);
    assert.equal(p.cardAlpha, 1);
    assert.equal(p.fade, CINE.EXTRACT_FADE);
    assert.equal(p.desat, 0);
  });
  it("death: slow fade + desaturation, card after a beat", () => {
    const p = emptyPose();
    deathPose(0, p);
    assert.equal(p.fade, 0);
    assert.equal(p.cardAlpha, 0);
    deathPose(CINE.DEATH_CARD_AT_MS, p);
    assert.equal(p.cardAlpha, 0);
    deathPose(CINE.DEATH_FADE_MS, p);
    assert.equal(p.fade, CINE.DEATH_FADE);
    assert.equal(p.desat, CINE.DEATH_DESAT);
    assert.equal(p.cardAlpha, 1);
    assert.equal(p.flash, 0);
  });
  it("easeOutBack starts at 0, ends at 1, overshoots", () => {
    assert.ok(Math.abs(easeOutBack(0)) < 1e-9);
    assert.ok(Math.abs(easeOutBack(1) - 1) < 1e-9);
    assert.ok(easeOutBack(0.7) > 1);
  });
});

describe("cards", () => {
  it("formats credits with thousands separators", () => {
    assert.equal(formatCredits(0), "0");
    assert.equal(formatCredits(999), "999");
    assert.equal(formatCredits(1240), "1,240");
    assert.equal(formatCredits(1234567.4), "1,234,567");
    assert.equal(formatCredits(-5), "0");
  });
  it("auto-sell line for players, guests and the wait", () => {
    assert.equal(autosellLine(null), "Settling the haul…");
    assert.equal(autosellLine({ credits: 1240, guest: false, sold: [] }), "+1,240 CR auto-sold");
    assert.equal(autosellLine({ credits: 0, guest: false, sold: [] }), "Gear secured");
    assert.equal(autosellLine({ credits: 300, guest: true, sold: [] }), "Junk worth 300 CR · sign up to keep it");
    assert.equal(autosellLine({ credits: 0, guest: true, sold: [] }), "Guest raid · nothing kept");
  });
  it("kill card names the killer, the gun and the distance", () => {
    assert.deepEqual(killCard({ killer: "Bot_3", weapon: "rifle" }, 34 * PX_PER_METER), { kicker: "KILLED BY", name: "Bot_3", sub: "Assault rifle · 34 m" });
    assert.deepEqual(killCard({ killer: "Bot_3", weapon: "" }, null), { kicker: "KILLED BY", name: "Bot_3", sub: "" });
    assert.deepEqual(killCard({ killer: "", weapon: "" }, null).kicker, "YOU DIED");
    assert.deepEqual(killCard(null, 100).name, "K.I.A.");
  });
});

describe("systems", () => {
  it("construct without a DOM and dispose twice", () => {
    for (const s of [createHitmarkerSystem(), createLowHpSystem(), createCinematicSystem()]) {
      s.dispose();
      s.dispose();
    }
  });
});

// ---------------------------------------------------------------- death beat on the real message order

interface FakeWorld {
  phase: string;
  alive: boolean;
  players: Map<string, { x: number; y: number; alive: boolean }>;
  seen: Map<string, { x: number; y: number; at: number }>;
}

function fakeCtx(w: FakeWorld): GameContext {
  // An unparented ground layer: no world container, so no desaturation filter (needs WebGL).
  const ground = new Container();
  return {
    app: { canvas: {} },
    room: { sessionId: "sB", onMessage: () => () => {} },
    layers: { screen: new Container(), ground, worldFx: new Container(), worldTop: new Container() },
    map: () => null,
    state: () => ({ phase: w.phase, players: w.players }),
    selfKey: () => "p1",
    self: () => ({ extractedAt: 0, extractStartedAt: 0 }),
    me: () => ({ alive: w.alive, hp: w.alive ? 100 : 0 }),
    selfPos: () => ({ x: 1000, y: 1000 }),
    aim: () => 0,
    camera: () => ({ x: 1000, y: 1000, zoom: 1, width: 1280, height: 720 }),
    clockMs: () => 60_000,
    toScreen: (x: number, y: number) => ({ x, y }),
    inputBlocked: () => false,
    lastSeen: (id: string) => w.seen.get(id) ?? null,
  } as unknown as GameContext;
}

const KILL: KillMsg = { victim: "Victim", victimId: "sB", killer: "Killer", killerId: "sA", weapon: "rifle" } as KillMsg;

describe("locateKiller / diedNow", () => {
  const out = { x: 0, y: 0 };
  const ctx = (players: FakeWorld["players"], seen: FakeWorld["seen"]) =>
    ({ state: () => ({ players }), lastSeen: (id: string) => seen.get(id) ?? null }) as unknown as Pick<GameContext, "state" | "lastSeen">;
  it("prefers the live state, falls back to a fresh last-seen position, ignores a stale one", () => {
    const now = 50_000;
    assert.equal(locateKiller("sA", ctx(new Map([["sA", { x: 5, y: 6, alive: true }]]), new Map()), now, out), true);
    assert.deepEqual(out, { x: 5, y: 6 });
    assert.equal(locateKiller("sA", ctx(new Map(), new Map([["sA", { x: 7, y: 8, at: now - 10 }]])), now, out), true);
    assert.deepEqual(out, { x: 7, y: 8 });
    assert.equal(locateKiller("sA", ctx(new Map(), new Map([["sA", { x: 7, y: 8, at: now - KILLER_SEEN_MS - 1 }]])), now, out), false, "shot from the fog");
    assert.equal(locateKiller("", ctx(new Map(), new Map()), now, out), false);
  });
  it("a raid timeout (alive = false with phase ended) is not a death", () => {
    assert.equal(diedNow(true, false, "live"), true);
    assert.equal(diedNow(true, false, "ended"), false);
    assert.equal(diedNow(null, false, "live"), false, "first observation only primes");
    assert.equal(diedNow(false, false, "live"), false);
  });
});

describe("cinematic system: death on the real patch → EV order", () => {
  it("the KILLED BY card shows the distance and the camera pans to where the killer stood", () => {
    let t = 100_000;
    const nowMock = mock.method(performance, "now", () => t);
    const cam = createCameraSystem();
    const cine = createCinematicSystem();
    try {
      // Killer 34 m east of us, in view.
      const w: FakeWorld = { phase: "live", alive: true, players: new Map([["sA", { x: 1000 + 34 * PX_PER_METER, y: 1000, alive: true }]]), seen: new Map() };
      const ctx = fakeCtx(w);
      cam.init!(ctx);
      cine.init!(ctx);
      cine.frame!(16, ctx);
      // The patch: we are dead and the server cleared our vision row — every other player is gone
      // (the renderer remembers where it drew them). It is decoded before the EV batch.
      w.alive = false;
      w.seen.set("sA", { x: 1000 + 34 * PX_PER_METER, y: 1000, at: t });
      w.players.clear();
      cine.frame!(16, ctx);
      t += 5;
      cine.onEvents!({ kills: [KILL] } as unknown as EventsMsg, ctx);
      const card = cine as unknown as { kicker: { text: string }; name: { text: string }; sub: { text: string } };
      assert.equal(card.kicker.text, "KILLED BY");
      assert.equal(card.name.text, "Killer");
      assert.equal(card.sub.text, "Assault rifle · 34 m");

      // Past PAN_AT_MS the killer is still absent from the state: the death cam pans anyway.
      const rig = getCameraRig()!;
      for (let k = 0; k < 40; k++) {
        t += 100;
        cine.frame!(100, ctx);
        rig.update(100);
      }
      assert.ok(t - 100_000 > CINE.PAN_AT_MS);
      const want = Math.min(CINE.PAN_MAX_PX, 34 * PX_PER_METER * CINE.PAN_SHARE);
      assert.ok(Math.abs(rig.offX - want) < 5, `pans toward the killer: offX ${rig.offX} ≈ ${want}`);
      assert.ok(Math.abs(rig.offY) < 1e-6);
    } finally {
      cine.dispose();
      cam.dispose();
      nowMock.mock.restore();
    }
  });

  it("a raid timeout does not play YOU DIED / K.I.A.", () => {
    const cine = createCinematicSystem();
    try {
      const w: FakeWorld = { phase: "live", alive: true, players: new Map(), seen: new Map() };
      const ctx = fakeCtx(w);
      cine.init!(ctx);
      cine.frame!(16, ctx);
      // timeoutPlayer + phase = "ended" arrive in one patch.
      w.alive = false;
      w.phase = "ended";
      cine.frame!(16, ctx);
      const sys = cine as unknown as { mode: string; kicker: { text: string } };
      assert.equal(sys.mode, "idle");
      assert.notEqual(sys.kicker.text, "YOU DIED");

      // A real death (no timeout) still starts the beat.
      const cine2 = createCinematicSystem();
      const w2: FakeWorld = { phase: "live", alive: true, players: new Map(), seen: new Map() };
      const ctx2 = fakeCtx(w2);
      cine2.init!(ctx2);
      cine2.frame!(16, ctx2);
      w2.alive = false;
      cine2.frame!(16, ctx2);
      assert.equal((cine2 as unknown as { mode: string }).mode, "dead");
      cine2.dispose();
    } finally {
      cine.dispose();
    }
  });
});
