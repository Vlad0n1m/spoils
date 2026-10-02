/**
 * Ledger invariant over 10 seeded whole matches (inventory memo §2.6, critique "Do not cut"):
 * every unique uid that entered a match (loadout, lost pool, demo mint) ends in EXACTLY one of
 * extracted / lost (broke on death → pool, or timeout) / destroyed / leftOnMap, the server ledger
 * agrees with the reports, and fungible stacks are conserved (junk exactly; ammo and meds are only
 * ever consumed, never duplicated).
 *
 * Brain bots fight; scripted human "looters" exercise the inventory paths the brains do not use
 * yet (WP-G): they walk (nav grid) to containers and bodies, search them, take revealed slots one
 * by one or with take-all, drop junk now and then, and extract — or die and become corpses that
 * other looters search. Odd seeds run demo mode (server mints), even seeds live mode (loadouts +
 * pool allocation, nothing minted).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CONTAINER_STATE,
  INPUT_DT_MS,
  MATCH,
  SEARCH,
  SERVER_TICK_MS,
  bagKeys,
  bpLevelOf,
  itemDef,
  mulberry32,
  rollContainerFungibles,
  type InputSample,
  type ItemLike,
  type LoadoutSnapshot,
  type Rng,
  type SettledItem,
} from "@extract/shared";
import { currentTarget, invTakeAllOp, invTakeOp } from "./containers.js";
import { extractAllowed, extractIsOpen } from "./extraction.js";
import { toPlain } from "./items.js";
import { LEGACY_MATCH_PLAYERS, Match } from "./match.js";
import { navGridFor, type Pt } from "./nav.js";
import { counterUid } from "./test-utils.js";
import type { PlayerRuntime, RosterEntry } from "./types.js";

const LOOTERS = 3;

class Looter {
  private path: Pt[] = [];
  private goal: { key: string; x: number; y: number } | null = null;
  private readonly visited = new Set<string>();
  private lastX = 0;
  private lastY = 0;
  private still = 0;
  private searchStart = 0;
  private acc = 0;
  private seq = 0;
  takes = 0;
  drops = 0;
  searched = 0;

  constructor(
    private readonly m: Match,
    readonly rt: PlayerRuntime,
    private readonly rng: Rng,
    private readonly takeAll: boolean,
    private readonly maxTakes: number,
  ) {}

  private wantsOut(): boolean {
    return this.m.clock >= MATCH.EXTRACT_OPEN_AT_MS && (this.takes >= this.maxTakes || this.m.clock > 14 * 60_000);
  }

  tick(): void {
    const m = this.m;
    const rt = this.rt;
    const p = rt.pub;
    if (!p.alive || m.ended) return;
    let mx = 0;
    let my = 0;
    const t = currentTarget(m, rt);
    if (t) {
      if (this.searchStart === 0) this.searchStart = m.clock;
      if (t.ready.has(rt)) {
        if (this.takeAll) {
          if (t.loot.revealed === t.loot.total) {
            if (invTakeAllOp(m, rt.id) !== "rate" && t.loot.slots.size >= 0) this.takes += 1;
            this.finishSearch(t.key);
          }
        } else {
          const first = [...t.loot.slots.entries()][0];
          if (first) {
            const [key, it] = first;
            if (invTakeOp(m, rt.id, { from: "loot", key, uid: it.uid, def: it.def }) === null) this.takes++;
            else if (t.loot.revealed === t.loot.total) this.finishSearch(t.key);
          } else if (t.loot.revealed === t.loot.total) {
            this.finishSearch(t.key);
          }
        }
      }
      if (m.clock - this.searchStart > 20_000) this.finishSearch(t.key);
    } else {
      this.searchStart = 0;
      if (this.drops < 2 && this.rng() < 0.002) this.dropJunk();
      const dest = this.wantsOut() ? this.extractGoal() : this.lootGoal();
      if (dest) {
        const d = Math.hypot(dest.x - p.x, dest.y - p.y);
        if (dest.key !== "extract" && d < SEARCH.OPEN_RANGE * 0.7) {
          this.visited.add(dest.key);
          if (m.interact(rt.id) && rt.search) {
            this.searched++;
            this.visited.add(rt.search.key);
          }
          this.goal = null;
          this.path = [];
        } else if (dest.key !== "extract" || d > 20) {
          [mx, my] = this.steer(dest);
        }
      }
      // Stuck (walls, crates): give the goal up.
      if (Math.hypot(p.x - this.lastX, p.y - this.lastY) < 2 && (mx !== 0 || my !== 0)) {
        if (++this.still > 40 && this.goal) {
          this.visited.add(this.goal.key);
          this.goal = null;
          this.path = [];
          this.still = 0;
        }
      } else {
        this.still = 0;
      }
    }
    this.lastX = p.x;
    this.lastY = p.y;
    // ~30 Hz input stream like a real client.
    this.acc += SERVER_TICK_MS;
    while (this.acc >= INPUT_DT_MS) {
      this.acc -= INPUT_DT_MS;
      const s: InputSample = { seq: ++this.seq, mx, my, aim: Math.atan2(my, mx || 1e-9), fire: false };
      m.enqueueInput(rt.id, s);
    }
  }

  private finishSearch(key: string): void {
    this.visited.add(key);
    this.m.searchClose(this.rt.id);
    this.searchStart = 0;
  }

  private dropJunk(): void {
    const s = this.rt.self.slots;
    for (const k of ["p0", "p1", "p2", "p3", ...bagKeys(bpLevelOf(s))]) {
      const it = s.get(k);
      if (it && itemDef(it.def)?.cat === "junk") {
        if (this.m.invDrop(this.rt.id, { key: k as "p0", uid: it.uid, def: it.def }) === null) this.drops++;
        return;
      }
    }
  }

  private lootGoal(): { key: string; x: number; y: number } | null {
    const m = this.m;
    const p = this.rt.pub;
    if (this.goal && !this.visited.has(this.goal.key)) return this.goal;
    let best: { key: string; x: number; y: number } | null = null;
    let bestD = Infinity;
    m.map.containers.forEach((c, i) => {
      const key = `c${i}`;
      if (this.visited.has(key) || m.state.containerState[i] === CONTAINER_STATE.EMPTIED) return;
      const d = Math.hypot(c.x - p.x, c.y - p.y);
      if (d < bestD) { bestD = d; best = { key, x: c.x, y: c.y }; }
    });
    for (const t of m.containers.corpses()) {
      if (this.visited.has(t.key) || t.corpse!.empty) continue;
      // Bodies are worth a detour.
      const d = Math.hypot(t.x - p.x, t.y - p.y) * 0.5;
      if (d < bestD) { bestD = d; best = { key: t.key, x: t.x, y: t.y }; }
    }
    if (best) this.setGoal(best);
    return best;
  }

  private extractGoal(): { key: string; x: number; y: number } | null {
    const m = this.m;
    const p = this.rt.pub;
    let best: { key: string; x: number; y: number } | null = null;
    let bestD = Infinity;
    for (const e of m.state.extracts.values()) {
      if (!extractIsOpen(e, m.clock) || !extractAllowed(m, this.rt, e)) continue;
      const d = Math.hypot(e.x - p.x, e.y - p.y);
      if (d < bestD) { bestD = d; best = { key: "extract", x: e.x, y: e.y }; }
    }
    if (best && (this.goal?.key !== "extract" || Math.hypot(this.goal.x - best.x, this.goal.y - best.y) > 1)) this.setGoal(best);
    return best;
  }

  private setGoal(g: { key: string; x: number; y: number }): void {
    this.goal = g;
    const p = this.rt.pub;
    this.path = navGridFor(this.m.map).findPath({ x: p.x, y: p.y }, g) ?? [{ x: g.x, y: g.y }];
  }

  private steer(dest: Pt): [number, number] {
    const p = this.rt.pub;
    while (this.path.length > 1 && Math.hypot(this.path[0]!.x - p.x, this.path[0]!.y - p.y) < 24) this.path.shift();
    const to = this.path[0] ?? dest;
    const dx = to.x - p.x;
    const dy = to.y - p.y;
    const d = Math.hypot(dx, dy) || 1;
    return [dx / d, dy / d];
  }
}

function loadoutFor(userId: string, k: number, seed: number): LoadoutSnapshot {
  const u = (s: string) => `L${seed}-${k}-${s}`;
  return {
    loadoutId: `lo-${seed}-${k}`,
    userId,
    level: 2 + k,
    entries: [
      { key: "w1", uid: u("rifle"), def: "rifle", qty: 1, rarity: (k % 4) as 0, dur: 90 },
      { key: "armor", uid: u("armor"), def: "armor_1", qty: 1, rarity: 0, dur: 80 },
      { key: "bp", uid: u("bp"), def: "backpack_2", qty: 1, rarity: 1, dur: 100 },
      { key: "p2", uid: "", def: "ammo_heavy", qty: 20, rarity: 0, dur: 0 },
      { key: "b0", uid: "", def: "medkit", qty: 2, rarity: 1, dur: 0 },
    ],
  };
}

interface Totals { [def: string]: number }
const add = (t: Totals, items: Iterable<{ def: string; qty: number }>) => {
  for (const it of items) t[it.def] = (t[it.def] ?? 0) + it.qty;
};

function worldNow(m: Match): Totals {
  const t: Totals = {};
  for (const rt of m.allRuntimes()) add(t, [...rt.self.slots.values()]);
  add(t, [...m.ground.all()].map((g) => g.item));
  for (const target of m.containers.targets.values()) add(t, m.containers.remaining(target));
  return t;
}

function runMatch(seed: number) {
  const live = seed % 2 === 0;
  const rng = mulberry32(seed * 7_771);
  const humans: RosterEntry[] = Array.from({ length: LOOTERS }, (_, k) => ({
    userId: `user-${seed}-${k}`, nickname: `Looter${k}`, isBot: false, loadoutId: live ? `lo-${seed}-${k}` : "",
  }));
  const bots: RosterEntry[] = Array.from({ length: LEGACY_MATCH_PLAYERS - LOOTERS }, (_, i) => ({ userId: null, nickname: `Bot${i}`, isBot: true }));
  const pool: Record<string, SettledItem[]> = {};
  if (live) {
    const defs = ["sniper", "shotgun", "armor_3", "backpack_3", "rifle", "armor_2"];
    defs.forEach((def, i) => {
      (pool[String(i * 3)] ??= []).push({ uid: `pool-${seed}-${i}`, def, qty: 1, rarity: (i % 4) as 0, dur: def.startsWith("armor") ? 50 : 70 });
    });
  }
  const m = new Match({
    mapId: "legacy",
    roster: [...humans, ...bots],
    rng: mulberry32(seed),
    mapSeed: 1000 + seed,
    newUid: counterUid,
    now: () => 1_700_000_000_000,
    strictLedger: true,
    mode: live ? "live" : "demo",
    loadouts: live ? humans.map((h, k) => loadoutFor(h.userId!, k, seed)) : [],
    containerLoot: pool,
  });
  // Half the looters are tough (test-only hp) so some survive to extract with their loot.
  m.allRuntimes().filter((r) => !r.isBot).forEach((rt, k) => { if (k % 2 === 0) rt.pub.hp = 2_000; });
  const start = worldNow(m);
  const looters = m.allRuntimes().filter((r) => !r.isBot).map((rt, k) => new Looter(m, rt, rng, k % 2 === 0, 4 + k * 3));
  const maxTicks = MATCH.DURATION_MS / SERVER_TICK_MS + 10;
  for (let i = 0; i < maxTicks && !m.ended; i++) {
    for (const l of looters) l.tick();
    m.step(SERVER_TICK_MS);
    m.drainEvents();
  }
  assert.ok(m.ended, `seed ${seed}: match ended`);
  return { m, live, start, looters };
}

/** Every known uid in exactly one report bucket; ledger and reports agree. */
function assertUids(m: Match, live: boolean, seed: number): void {
  const r = m.report!;
  assert.deepEqual(m.ledgerGaps(), [], `seed ${seed}: every known uid resolved`);
  const where = new Map<string, string[]>();
  const put = (uid: string, at: string) => where.set(uid, [...(where.get(uid) ?? []), at]);
  for (const rep of m.exitReports) {
    for (const it of rep.extracted) if (it.uid) put(it.uid, "extract");
    for (const it of rep.lost) if (it.uid) put(it.uid, "lost");
    for (const it of rep.destroyed) if (it.uid) put(it.uid, "destroyed");
  }
  for (const it of r.leftOnMap) put(it.uid, "left");
  for (const [uid, info] of m.ledger.known) {
    const at = where.get(uid) ?? [];
    assert.equal(at.length, 1, `seed ${seed}: uid ${uid} (${info.def}) reported ${at.length}×: ${at.join(", ")}`);
    assert.equal(m.ledger.resolved.get(uid), at[0], `seed ${seed}: uid ${uid}: ledger vs report`);
  }
  for (const uid of where.keys()) assert.ok(m.ledger.known.has(uid), `seed ${seed}: unknown uid ${uid} reported`);
  assert.equal(m.exitReports.length, m.allRuntimes().length, "one exit report per participant");
  if (live) {
    assert.deepEqual(r.minted, [], "live mode never mints");
    for (const [, k] of m.ledger.known) assert.ok(k.origin === "loadout" || k.origin === "pool");
  } else {
    for (const it of r.minted) assert.equal(m.ledger.known.get(it.uid)?.origin, "minted");
  }
  assert.deepEqual(m.ledger.anomalies, []);
}

/** Fungibles: junk is conserved exactly (never consumed); ammo / meds are never duplicated. */
function assertFungibles(m: Match, start: Totals, seed: number): void {
  const sources: Totals = { ...start };
  for (const t of m.containers.targets.values()) {
    if (t.kind !== "container") continue;
    add(sources, t.initial.filter((i) => !i.uid));
    // Independent re-roll: the container held exactly its deterministic fungible roll (+ demo table).
    const spot = m.map.containers[t.idx]!;
    const junkRolled: Totals = {};
    add(junkRolled, rollContainerFungibles(m.state.mapSeed, t.idx, spot).filter((f) => itemDef(f.def)?.cat === "junk"));
    const junkHeld: Totals = {};
    add(junkHeld, t.initial.filter((i) => itemDef(i.def)?.cat === "junk"));
    assert.deepEqual(junkHeld, junkRolled, `seed ${seed}: container ${t.idx} junk = its roll`);
  }
  const humanDeaths = m.exitReports.filter((r) => r.exit === "dead" && m.allRuntimes().some((rt) => !rt.isBot && rt.userId === r.userId)).length;
  sources.junk_dogtag = (sources.junk_dogtag ?? 0) + humanDeaths;

  const end: Totals = worldNow(m);
  for (const rep of m.exitReports) add(end, [...rep.extracted, ...rep.lost].filter((i) => !i.uid));
  for (const def of new Set([...Object.keys(sources), ...Object.keys(end)])) {
    const d = itemDef(def);
    if (!d || d.unique) continue;
    if (d.cat === "junk") assert.equal(end[def] ?? 0, sources[def] ?? 0, `seed ${seed}: junk ${def} conserved`);
    else assert.ok((end[def] ?? 0) <= (sources[def] ?? 0), `seed ${seed}: ${def} ${end[def]} > sources ${sources[def]} (duplication)`);
  }
  // Nothing BROKEN is ever left on the map or in a report other than `lost`.
  const broken = (items: ItemLike[]) => items.filter((i) => i.flags & 2);
  for (const t of m.containers.targets.values()) assert.deepEqual(broken(m.containers.remaining(t)), []);
  assert.deepEqual(broken([...m.ground.all()].map((g) => toPlain(g.item))), []);
}

test("ledger invariant over 10 seeded bot matches with scripted looters (demo and live)", () => {
  const agg = { looterExtracts: 0, takes: 0, searched: 0, drops: 0, corpses: 0, corpseSearches: 0, extractedJunk: 0, known: 0, left: 0, dead: 0, extracted: 0 };
  for (let seed = 1; seed <= 10; seed++) {
    const { m, live, start, looters } = runMatch(seed);
    assertUids(m, live, seed);
    assertFungibles(m, start, seed);
    for (const l of looters) {
      agg.takes += l.takes;
      agg.searched += l.searched;
      agg.drops += l.drops;
      agg.corpseSearches += l.rt.stats.corpsesSearched;
      if (l.rt.exitReport?.exit === "extract") agg.looterExtracts++;
    }
    agg.corpses += m.containers.corpses().length;
    agg.known += m.ledger.known.size;
    agg.left += m.report!.leftOnMap.length;
    for (const rep of m.exitReports) {
      if (rep.exit === "dead") agg.dead++;
      if (rep.exit === "extract") agg.extracted++;
      agg.extractedJunk += rep.extracted.filter((i) => itemDef(i.def)?.cat === "junk").length;
    }
  }
  console.log(`ledger x10: ${JSON.stringify(agg)}`);
  // The paths under test were actually exercised.
  assert.ok(agg.searched > 20, "looters searched containers and bodies");
  assert.ok(agg.takes > 20, "looters took items");
  assert.ok(agg.corpses > 50 && agg.corpseSearches > 0, "bodies were searched");
  assert.ok(agg.extracted > 0 && agg.dead > 0);
  assert.ok(agg.looterExtracts > 0 && agg.extractedJunk > 0, "looters carried junk out");
});
