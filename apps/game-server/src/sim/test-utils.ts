/** Helpers for the node:test suites: a tiny open map and deterministic matches driven by hand. */

import {
  Extract,
  SERVER_TICK_MS,
  WORLD,
  WEAPONS,
  mulberry32,
  type InputSample,
  type MapData,
  type Player,
  type Rarity,
  type WeaponId,
} from "@extract/shared";
import { Match, type MatchOptions } from "./match.js";
import type { MatchEvent, RosterEntry } from "./types.js";

/** Empty arena: border walls, one crate wall for bullet tests, nothing else. */
export function testMap(seed = 0x7e57): MapData {
  const W = WORLD.WIDTH;
  const H = WORLD.HEIGHT;
  const B = WORLD.BORDER;
  return {
    seed, width: W, height: H,
    walls: [
      { x: 0, y: 0, w: W, h: B },
      { x: 0, y: H - B, w: W, h: B },
      { x: 0, y: 0, w: B, h: H },
      { x: W - B, y: 0, w: B, h: H },
    ],
    // A wall well away from the test area (x 1000..2000, y 1000..2000).
    crates: [{ x: 3000, y: 3000, w: 64, h: 400 }],
    rocks: [], trees: [], bushes: [], dirt: [], buildings: [],
    chestSpots: [], extractSpots: [],
    spawnSpots: Array.from({ length: 8 }, (_, i) => ({ x: 1000 + i * 150, y: 1000 })),
    lootSpots: [],
  };
}

let uidSeq = 0;
export function counterUid(): string {
  return `uid-${(uidSeq++).toString().padStart(5, "0")}`;
}

export function humans(n: number): RosterEntry[] {
  return Array.from({ length: n }, (_, i) => ({ userId: `user${i}`, nickname: `P${i}`, isBot: false }));
}

export function testMatch(n = 2, opts: Partial<MatchOptions> = {}): Match {
  return new Match({
    roster: humans(n),
    rng: mulberry32(42),
    map: testMap(),
    newUid: counterUid,
    now: () => 1_700_000_000_000,
    emptyWorld: true,
    ...opts,
  });
}

/** State keys of roster players, in roster order. */
export function ids(m: Match): string[] {
  return m.allRuntimes().map((r) => r.id);
}

export function pl(m: Match, id: string): Player {
  const p = m.player(id);
  if (!p) throw new Error(`no player ${id}`);
  return p;
}

export function place(m: Match, id: string, x: number, y: number): void {
  const p = pl(m, id);
  p.x = x;
  p.y = y;
}

export function giveWeapon(m: Match, id: string, slot: 0 | 1, weapon: WeaponId, rarity: Rarity = 0, mag?: number): string {
  const p = pl(m, id);
  const uid = m.newUid();
  m.ledger.set(uid, { uid, kind: "weapon", type: weapon, rarity });
  const s = p.slots[slot]!;
  s.uid = uid;
  s.weapon = weapon;
  s.rarity = rarity;
  s.mag = mag ?? WEAPONS[weapon].magSize;
  s.free = false;
  return uid;
}

export function addExtract(m: Match, x: number, y: number, openAt = 0, closeAt = 0, r = 110): Extract {
  const e = new Extract();
  e.id = `e${m.state.extracts.size}`;
  e.x = x;
  e.y = y;
  e.r = r;
  e.openAt = openAt;
  e.closeAt = closeAt;
  m.state.extracts.set(e.id, e);
  return e;
}

/** Queue one sample with the next seq for that player. */
export function send(m: Match, id: string, s: Partial<Omit<InputSample, "seq">> = {}): boolean {
  const rt = m.runtime(id)!;
  return m.enqueueInput(id, { seq: rt.lastQueuedSeq + 1, mx: 0, my: 0, aim: 0, fire: false, ...s });
}

/**
 * Advance `ms` of match time in server ticks while feeding the given players a steady 30 Hz
 * input stream (what a real client does). Returns every event emitted meanwhile, with its clock.
 */
export function run(
  m: Match,
  ms: number,
  inputs: Record<string, Partial<Omit<InputSample, "seq">>> = {},
): Array<MatchEvent & { at: number }> {
  const out: Array<MatchEvent & { at: number }> = [];
  const acc: Record<string, number> = {};
  for (let t = 0; t < ms - 1e-6; t += SERVER_TICK_MS) {
    for (const [id, s] of Object.entries(inputs)) {
      acc[id] = (acc[id] ?? 0) + SERVER_TICK_MS;
      while (acc[id]! >= 1000 / 30 - 1e-6) {
        acc[id]! -= 1000 / 30;
        send(m, id, s);
      }
    }
    m.step(SERVER_TICK_MS);
    for (const e of m.drainEvents()) out.push({ ...e, at: m.clock });
  }
  return out;
}
