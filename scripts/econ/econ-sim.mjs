// Economy population simulation (NPC MODEL v5 on LOOT ECONOMY v4): N players over D days, fed by the
// loot-yield harness (apps/game-server/src/sim/econ/loot-yield.bench.ts) JSON outputs.
//
//   pnpm --filter @extract/shared build      # the sim imports the real rules from packages/shared/dist
//   T=apps/game-server/node_modules/.bin/tsx; B=apps/game-server/src/sim/econ/loot-yield.bench.ts; O=/tmp/extract-econ
//   # PvE records, one scripted human per raid (the sim samples them per strategy:kit):
//   $T $B --strategy rat --out $O;  $T $B --strategy rat --kit free --tag free --out $O
//   $T $B --strategy poi --out $O;  $T $B --strategy poi --kit free --tag free --out $O
//   $T $B --strategy full --out $O; $T $B --strategy npcfarm --out $O
//   $T $B --strategy boss --boss-target foreman --tag foreman --out $O   (… commander / warden, --kit hunter)
//   # container / carrier capture rates need a full-lobby release (R = 24):
//   $T $B --strategy poi --lobby-r 24 --tag r24 --out $O   (… rat / full / boss)
//   # optional PvP calibration (multi-human lobbies):
//   $T $B --humans 8 --seeds 20 --tag pvp --out $O
//   node scripts/econ/econ-sim.mjs --data $O [--scenario base|ratheavy|altfarm|lowdau|highdau|crash|queue90|all]
//        [--days 90] [--seed 7] [--json out.json] [--csv DIR] [--pvp-source harness|design]  (default harness)
//        [--queue-window 45] [--max-humans 24] [--min-humans 12] [--no-primary] [--no-giveaway-cap] [--no-regulator] [--k 1.0]
//        [--no-bound-shop] [--cr-kit CR]   (bound gear shop for CR: default ON at BOUND_OFFERS prices; --cr-kit overrides the set price)
//        [--free-kit-autosell M]   (free-kit raid junk sells at M ×; default FREE_KIT.AUTOSELL_MULT)
//        [--comp C]   (lobby competition: junk / consumables × 1/(1+C(n−1)); default harness-calibrated)
//        [--pvp-loot L]   (share of a PvP loser's haul the winner can take, × LOOT_IF_EXTRACT; default 0.5)
//
// Every yield-*.json in --data is read; records are bucketed by strategy:kit (boss hunters also by
// target). PvE buckets use single-human records only (lobby.humans === 1); multi-human lobby records
// only calibrate PvP (reported, and used as encounter rates with --pvp-source harness). A missing
// bucket falls back (kit → starter → any kit; full → poi; npcfarm → rat:free) with a warning.
//
// Model (design v5, targets §F):
// - lobbies: the matchmaking queue (one queue, window --queue-window s from the first join; launch at
//   max humans at once, at min humans after MATCH.MIN_WAIT_MS, else with whoever is queued at the window
//   end — a solo raid is legal); arrivals are Poisson at the day's raid rate × a 2.5 peak factor;
// - NPCs per match: the real rolls (rollBossSpawns / rollNpcSpawns / raidNpcCarriers on the generated
//   Steppe) from a random match seed;
// - pool: poolReleasePlanV4(P, R = Σ loadout uniques, B = Σ boss slots); bosses first (top tier score
//   first), the rest by weight to T3/T4 containers (poolContainerWeight) or spawned T3/T4 marauder
//   carriers (npcCarrierWeight, one item each). Boss items go to a hunter of that boss whose sampled
//   record killed it and who got out; container / carrier items to an extracting human with the
//   harness capture rate q of its strategy; everything else is leftOnMap → pool, no wear;
// - PvE: a raid samples a harness record of its strategy:kit (survival vs NPCs, junk, consumables
//   found / used, NPC kills, boss kill); PvP on top: each human gets Poisson(λ[type]·(n−1)/23)
//   encounters with a random lobby member; P(i wins) = logistic(K·(power_i − power_j + N(0, SD)));
//   the loser dies (BREAK_CHANCE_ON_DEATH per unique → pool −BREAK_DUR_LOSS, the rest to the winner
//   with LOOT_IF_EXTRACT if it extracts, else leftOnMap → pool); the winner spends FIGHT_CONS_CR of
//   consumables and gets the dog tag (dogTagCr) if it extracts;
// - treasury: 1% tax (takeTreasuryTax), tax items and primary batches sold on the market, 5% P2P fee.
//   The game NEVER pays SOL: the only money moves are buyer → seller (−fee) and buyer → house;
// - CR: faucet = junk autosell (NPC bag junk is in the harness hauls) + dog tags; sinks = junker
//   consumables (CONSUMABLES_CR) + CR listing fees; daily regulator nextAutosellMult on the veterans' median.

import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const shared = await import(resolve(here, "../../packages/shared/dist/index.js"));
const {
  BOSSES, BOSS_KINDS, CONSUMABLES_CR, MARKET, POOL, GIVEAWAY, PROGRESSION, MATCH, FREE_KIT, BOUND_OFFERS,
  nextAutosellMult, levelForXp, takeTreasuryTax, dogTagCr, poolReleasePlanV4, generateMap,
  rollBossSpawns, rollNpcSpawns, raidNpcCarriers, bossGroupNpcCount, npcPostsOf, npcCarrierWeight,
  poolContainerEligible, poolContainerWeight, containerGuarded, boundTraderLevel,
} = shared;
const BREAK = shared.BREAK_CHANCE_ON_DEATH ?? 0.5;

// ---------------------------------------------------------------- CLI
const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
const flag = (n) => argv.includes(`--${n}`);
const DATA = resolve(arg("data", join(tmpdir(), "extract-econ")));
const DAYS = Number(arg("days", 90));
const SEED = Number(arg("seed", 7));
const RISK_K = Number(arg("k", POOL.RISK_K));
const OPTS = { primary: !flag("no-primary"), giveawayCap: !flag("no-giveaway-cap"), regulator: !flag("no-regulator"), boundShop: !flag("no-bound-shop") };
// Bound gear shop (v5 review, web market/trader.ts buyBound over BOUND_OFFERS, default ON; --no-bound-shop
// turns it off): a player with no weapon buys a BOUND set (weapon + armor_1 + backpack_1) for CR: shotgun
// before level 5, rifle from level 5 (boundTraderLevel). Bound items are never tradable, never pool items
// and add 0 risk units; extracted they stay, lost they are destroyed (a killer may loot them, still bound).
// --cr-kit P overrides the set price (lever study).
const CR_KIT_OVERRIDE = arg("cr-kit") !== undefined ? Number(arg("cr-kit")) : null;
const offerCr = (def) => BOUND_OFFERS.find((o) => o.def === def)?.cr ?? 0;
function boundKitCr(level) {
  if (CR_KIT_OVERRIDE !== null) return CR_KIT_OVERRIDE;
  const gun = boundTraderLevel(level) >= 2 ? "rifle" : "shotgun";
  return offerCr(gun) + offerCr("armor_1") + offerCr("backpack_1");
}
// --free-kit-autosell M: junk extracted from a live raid entered with no unique at all (the FREE kit)
// autosells at M × the regulated price (web raids.ts freeKitRaid; default FREE_KIT.AUTOSELL_MULT; dog
// tags keep their price). Bound-kit raids are geared (× 1).
const FREE_KIT_AUTOSELL = Number(arg("free-kit-autosell", FREE_KIT.AUTOSELL_MULT ?? 1));
// --comp C: lobby competition. Harness multi-human lobbies split the same containers / NPC bags, so a
// human's junk and consumables found shrink with the lobby: × 1 / (1 + C·(n−1)). Default: calibrated
// from the harness (lobby records vs solo records of the same strategy), fallback 0.058; --comp 0 = off.
const COMP_ARG = arg("comp");
// --pvp-loot L: the share of a PvP loser's haul (junk + consumables, valued at half its full-raid haul:
// fights happen mid-raid) the winner extracts (× LOOT_IF_EXTRACT). v5 review: it used to vanish.
const PVP_LOOT_HAUL = Number(arg("pvp-loot", 0.5));
// Sensitivity knobs (all default 1): --junk-mult (harness junk CR), --found-mult (consumables found),
// --rate-mult (raids per player-day), --lambda-mult (PvP encounter rates), --fight-cons CR (per PvP fight).
// --primary-share S: primary sales per day as a share of DAU (design 0.08).
const PRIMARY_SHARE = Number(arg("primary-share", 0.08));
const SENS = { junk: Number(arg("junk-mult", 1)), found: Number(arg("found-mult", 1)), rate: Number(arg("rate-mult", 1)), lambda: Number(arg("lambda-mult", 1)) };
const QUEUE = {
  WINDOW_S: Number(arg("queue-window", MATCH.QUEUE_WINDOW_MS / 1000)),
  MAX: Number(arg("max-humans", MATCH.MAX_HUMANS ?? 24)),
  MIN: Number(arg("min-humans", MATCH.MIN_HUMANS ?? 12)),
  MIN_WAIT_S: (MATCH.MIN_WAIT_MS ?? 10_000) / 1000,
  PEAK: 2.5 * Number(arg("peak-mult", 1)),
};
// v5 review: the default PvP encounter rates are the harness-calibrated ones (multi-human lobby records);
// the design λ (3–15× higher) is a sensitivity run (--pvp-source design). Scripted humans seek fights
// less than real players do, so the harness λ is a lower bound.
const PVP_SOURCE = arg("pvp-source", "harness");
/** PvP layer (design v5 CONFIG I). λ = encounters per raid at a full lobby (24 humans). */
const PVP = {
  LAMBDA_FULL_LOBBY: { rat: 0.4, poi: 1.2, t34: 2.0, boss: 2.0, full: 1.6, alt: 0.4 },
  POWER: { free: 0, starter: 1, hunter: 2 },
  SKILL_SD: 0.8, K: 1.2, LOOT_IF_EXTRACT: Number(arg("loot-if-extract", 0.7)), FIGHT_CONS_CR: Number(arg("fight-cons", 80)),
};

// ---------------------------------------------------------------- harness data
const files = existsSync(DATA) ? readdirSync(DATA).filter((f) => /^yield-.*\.json$/.test(f)) : [];
if (!files.length) throw new Error(`no harness outputs (yield-*.json) in ${DATA} — run loot-yield.bench.ts first (see the header)`);
const PVE = new Map(); // bucket → records
const LOBBY = []; // multi-human records
let legacy = 0;
for (const f of files) {
  const j = JSON.parse(readFileSync(join(DATA, f), "utf8"));
  for (const r of j.records ?? []) {
    if (!r.lobby) { legacy++; continue; } // pre-v5 (bot) records: not comparable
    if (r.lobby.humans > 1) { LOBBY.push(r); continue; }
    const keys = [`${r.strategy}:${r.kit}`];
    if (r.strategy === "boss" && r.hunt?.kind) keys.push(`boss:${r.hunt.kind}:${r.kit}`);
    for (const k of keys) { if (!PVE.has(k)) PVE.set(k, []); PVE.get(k).push(r); }
  }
}
if (legacy) console.warn(`[econ-sim] skipped ${legacy} pre-v5 records (no lobby field: bot-era harness output)`);
const warned = new Set();
/** Records for strategy:kit with the fallback chain; throws when nothing fits. */
function bucket(strategy, kit, target = null) {
  const tries = [];
  const strategies = strategy === "full" ? ["full", "poi"] : strategy === "npcfarm" ? ["npcfarm", "rat"] : [strategy];
  for (const s of strategies) {
    const kits = s === "npcfarm" || (strategy === "npcfarm" && s === "rat") ? ["free"] : [kit, "starter", "free", "hunter"];
    for (const k of kits) {
      if (target) tries.push(`boss:${target}:${k}`);
      tries.push(`${s}:${k}`);
    }
  }
  for (const t of tries) {
    const rs = PVE.get(t);
    if (rs?.length) {
      const want = target ? `boss:${target}:${kit}` : `${strategy}:${kit}`;
      if (t !== want && !warned.has(want)) { warned.add(want); console.warn(`[econ-sim] no records for ${want}; using ${t}`); }
      return rs;
    }
  }
  throw new Error(`[econ-sim] no harness records for ${strategy}:${kit}${target ? ` (target ${target})` : ""}; have: ${[...PVE.keys()].join(", ")}`);
}
/** Boss-hunt records of a target, stratified by whether that boss spawned in the record. */
function bossRecords(kind, kit, spawned) {
  const all = bucket("boss", kit, kind);
  const s = all.filter((r) => r.bosses.some((b) => b.kind === kind) === spawned);
  return s.length ? s : all;
}
/** Per released item: chance a human of this strategy extracts it, given it survived (harness). */
function capture(strategy, origin, field, fallback) {
  let got = 0, rel = 0, surv = 0, n = 0;
  for (const [k, rs] of PVE) {
    if (!k.startsWith(`${strategy}:`) || k.split(":").length !== 2) continue;
    for (const r of rs) {
      if (!(r.pool?.[field] > 0)) continue;
      got += r.gained.filter((u) => u.origin === origin).length;
      rel += r.pool[field];
      surv += r.survived ? 1 : 0;
      n++;
    }
  }
  if (!rel) return { q: fallback, src: "default", got, rel };
  const q = got / rel / Math.max(0.05, surv / n);
  return { q: Math.min(0.95, q), src: "harness", got, rel };
}
const TYPES = ["rat", "poi", "boss", "full", "alt"];
// v5 review: alts play the best CR route for their kit (full raid; free kit or their bound kit),
// not the npcfarm route (the worst free-kit strategy, which made E9 pass by construction).
const STRAT_OF = { rat: "rat", poi: "poi", boss: "boss", full: "full", alt: "full" };
const Q = {}, QC = {};
for (const t of TYPES) {
  const s = STRAT_OF[t];
  Q[t] = capture(s, "pool", "container", { rat: 0, poi: 0.08, boss: 0.1, full: 0.15, alt: 0 }[t]);
  QC[t] = capture(s, "carrier", "carrier", { rat: 0, poi: 0.1, boss: 0.15, full: 0.05, alt: 0 }[t]);
}
/** Harness PvP calibration: per strategy, deaths by humans and PvP kills per raid, scaled to a full lobby. */
function pvpCalibration() {
  const by = {};
  for (const r of LOBBY) {
    const o = (by[r.strategy] ??= { raids: 0, deaths: 0, kills: 0, seen: 0, scale: 0 });
    o.raids++;
    o.deaths += r.pvp.died ? 1 : 0;
    o.kills += r.pvp.kills;
    o.seen += r.pvp.humansSeen;
    o.scale += (r.lobby.humans - 1) / 23;
  }
  for (const o of Object.values(by)) o.lambdaFull = o.scale > 0 ? +((o.deaths + o.kills) / o.scale).toFixed(3) : 0;
  return by;
}
const PVP_CAL = pvpCalibration();
/**
 * Lobby competition from the harness (starter kits): per lobby size n, pooled ratio = Σ junk of the
 * lobby members / Σ their strategies' solo junk mean → C_n = (1/ratio − 1)/(n − 1); C = the mean of
 * C_n weighted by members (pooling keeps one strategy's noisy small sample from dominating).
 */
function compCalibration() {
  const solo = {};
  for (const [k, rs] of PVE) {
    const [st, kit] = k.split(":");
    if (k.split(":").length !== 2 || kit !== "starter") continue;
    solo[st] = rs.reduce((a, r) => a + (r.exit === "extract" ? r.haul.junkCr : 0), 0) / Math.max(1, rs.length);
  }
  const by = {};
  for (const r of LOBBY) {
    const base = solo[r.strategy];
    if (!base || r.kit !== "starter") continue;
    const o = (by[r.lobby.humans] ??= { n: r.lobby.humans, junk: 0, base: 0, cnt: 0 });
    o.junk += r.exit === "extract" ? r.haul.junkCr : 0;
    o.base += base;
    o.cnt++;
  }
  let num = 0, den = 0;
  for (const o of Object.values(by)) {
    if (o.cnt < 10 || o.n < 2) continue;
    o.ratio = +Math.max(0.05, Math.min(1, o.junk / o.base)).toFixed(3);
    o.c = +((1 / o.ratio - 1) / (o.n - 1)).toFixed(4);
    num += o.c * o.cnt; den += o.cnt;
    delete o.junk; delete o.base;
  }
  return { c: den > 0 ? num / den : null, by };
}
const COMP_CAL = compCalibration();
const COMP = COMP_ARG !== undefined ? Number(COMP_ARG) : (COMP_CAL.c ?? 0.058);
const compOf = (n) => 1 / (1 + COMP * Math.max(0, n - 1));
if (PVP_SOURCE === "harness") {
  // T3/T4 looters have no lobby strategy of their own: the poi calibration × the design ratio t34 / poi.
  const DESIGN = { ...PVP.LAMBDA_FULL_LOBBY };
  if (PVP_CAL.poi?.raids >= 10) PVP.LAMBDA_FULL_LOBBY.t34 = +(PVP_CAL.poi.lambdaFull * DESIGN.t34 / DESIGN.poi).toFixed(3);
  for (const t of TYPES) {
    const c = PVP_CAL[STRAT_OF[t]] ?? (t === "alt" ? PVP_CAL.rat : null);
    if (c && c.raids >= 10) PVP.LAMBDA_FULL_LOBBY[t] = c.lambdaFull;
    else console.warn(`[econ-sim] --pvp-source harness: too few lobby records for ${t}; keeping λ ${PVP.LAMBDA_FULL_LOBBY[t]}`);
  }
}

// ---------------------------------------------------------------- map / NPC rolls (the real generator)
const MAP = generateMap("steppe");
const POSTS = npcPostsOf(MAP);
const ELIGIBLE = MAP.containers.filter(poolContainerEligible);
const CONT_DESTS = ELIGIBLE.map((c, i) => ({ key: `c${i}`, w: poolContainerWeight({ tier: c.tier, guarded: containerGuarded(c, MAP.bosses) }), carrier: false }));
/**
 * Mirror of web planAllocation's non-boss draw (pool.ts): weighted WITHOUT replacement over the
 * eligible containers and the spawned carriers; a carrier holds one item ever, the containers start a
 * new round once each holds one. Returns per item "cont" | "carrier".
 */
function allocRest(n, carriers) {
  const dests = [...CONT_DESTS, ...carriers.map((c) => ({ key: c.key, w: npcCarrierWeight(c.tier), carrier: true }))];
  const used = new Set();
  const out = [];
  for (let k = 0; k < n; k++) {
    let unused = dests.filter((d) => !used.has(d.key));
    if (CONT_DESTS.length > 0 && !unused.some((d) => !d.carrier)) {
      for (const d of CONT_DESTS) used.delete(d.key);
      unused = dests.filter((d) => !used.has(d.key));
    }
    if (!unused.length) { out.push(null); continue; }
    let roll = rnd() * unused.reduce((a, d) => a + d.w, 0);
    let pick = unused[unused.length - 1];
    for (const d of unused) { roll -= d.w; if (roll <= 0) { pick = d; break; } }
    used.add(pick.key);
    out.push(pick.carrier ? "carrier" : "cont");
  }
  return out;
}

// ---------------------------------------------------------------- rng
let seed = SEED;
function rnd() { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }
const chance = (p) => rnd() < p;
const pick = (a) => a[Math.floor(rnd() * a.length)];
function poisson(l) { if (l <= 0) return 0; const L = Math.exp(-l); let k = 0, p = 1; do { k++; p *= rnd(); } while (p > L); return k - 1; }
function shuffle(a) { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }
function gauss() { const u = Math.max(1e-12, rnd()); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rnd()); }
const med = (a) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const pctl = (a, q) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(s.length * q))]; };
const logistic = (x) => 1 / (1 + Math.exp(-x));

// ---------------------------------------------------------------- items (DB view: k w|a|b, level/rarity, dur %)
const NPC_PRICE_MINOR = { w: [300, 900, 2500, 6000], a: [0, 400, 1100, 2800], b: [0, 300, 900, 2200] };
const SCRAP_CR = { w: [300, 700, 1600, 3500], a: [0, 200, 500, 1200], b: [0, 150, 450, 1100] };
/** uniqueTierScore: weapon r>=2 / armor_3 / backpack_3 = 2; weapon r1 / level 2 = 1. */
const tierScore = (it) => (it.k === "w" ? (it.r >= 2 ? 2 : it.r >= 1 ? 1 : 0) : it.r === 3 ? 2 : it.r === 2 ? 1 : 0);
const refPrice = (it) => Math.round(NPC_PRICE_MINOR[it.k][it.r] * (0.6 + 0.4 * it.dur / 100));
const refCr = (it) => SCRAP_CR[it.k][it.r] * it.dur / 100;
let uid = 0;
const mk = (k, r, dur = 100, lock = 0, bound = false) => ({ id: ++uid, k, r, dur, lock, bound });
/** riskUnitOf: not bound and at least POOL.RISK_MIN_DUR_PCT durability. */
const riskUnit = (it) => (!it.bound && it.dur >= (POOL.RISK_MIN_DUR_PCT ?? 0) ? 1 : 0);
/** seed.ts rollPiece (pool seed): giveaway-like pieces, ~12% rarer weapons, 8% armor_3, 15% backpack_2. */
function seedPiece(i) {
  const s = i % 3;
  if (s === 0) return rnd() < 0.12 ? mk("w", rnd() < 0.3 ? 3 : 2) : mk("w", rnd() < 0.25 ? 1 : 0);
  if (s === 1) return rnd() < 0.08 ? mk("a", 3) : mk("a", rnd() < 0.2 ? 2 : 1);
  return mk("b", rnd() < 0.15 ? 2 : 1);
}
function giveawayKit(bound = false) {
  const lock = bound ? 0 : GIVEAWAY.LOCK_RAIDS;
  return [mk("w", rnd() < 0.25 ? 1 : 0, 100, lock, bound), mk("a", rnd() < 0.2 ? 2 : 1, 100, lock, bound), mk("b", 1, 100, lock, bound)];
}
/** A bound-shop set (weapon r0 + armor_1 + backpack_1), bound. */
const boundKit = () => [mk("w", 0, 100, 0, true), mk("a", 1, 100, 0, true), mk("b", 1, 100, 0, true)];
/** Primary batch item: like the giveaway, with ~10% top tier (design §5). */
function primaryItem() {
  if (rnd() < 0.1) return pick([mk("w", rnd() < 0.3 ? 3 : 2), mk("a", 3)]);
  const s = Math.floor(rnd() * 3);
  return s === 0 ? mk("w", rnd() < 0.25 ? 1 : 0) : s === 1 ? mk("a", rnd() < 0.2 ? 2 : 1) : mk("b", rnd() < 0.15 ? 2 : 1);
}

// ---------------------------------------------------------------- consumables (junker prices)
const C = CONSUMABLES_CR;
const KIT_CR = { starter: 3 * C.ammo_light.cr + 3 * C.bandage.cr + C.medkit.cr, hunter: 6 * C.ammo_light.cr + 3 * C.bandage.cr + 2 * C.medkit.cr, free: 0 };

// ---------------------------------------------------------------- scenarios
const MIX = { rat: 0.3, poi: 0.4, boss: 0.15, full: 0.15 };
const SCEN = {
  base: { mix: MIX, scale: 1 },
  ratheavy: { mix: { rat: 0.7, poi: 0.15, boss: 0.05, full: 0.1 }, scale: 1 },
  altfarm: { mix: MIX, scale: 1, alts: { day: 10, n: 300 } },
  lowdau: { mix: MIX, dau: 150 },
  highdau: { mix: MIX, dau: 3000 },
  crash: { mix: MIX, scale: 1, crashDay: 30 },
  queue90: { mix: MIX, scale: 1, windowS: 90 },
};

const arrivalsOf = (day, scale, crashDay) =>
  crashDay !== undefined && day >= crashDay ? Math.round(8 * scale) : Math.round((day === 0 ? 300 : 120 * Math.exp(-day / 25) + 35) * scale);
/** Mean DAU over days 14..end of the arrival / lifetime process at `scale` (own rng: no effect on runs). */
function meanDau(scale) {
  let s = 12345;
  const r = () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648; };
  const lives = [];
  let sum = 0, n = 0;
  for (let day = 0; day < DAYS; day++) {
    for (let i = 0; i < arrivalsOf(day, scale); i++) lives.push([day, Math.max(2, -Math.log(Math.max(1e-9, r())) * 14)]);
    if (day >= 14) { sum += lives.filter(([j, l]) => day - j < l).length; n++; }
  }
  return n ? sum / n : 1;
}

/**
 * Lobby sizes for `tickets` raid tickets a day: the queue model (window, early launch, max).
 * Arrivals are Poisson at λ = tickets / 86 400 s × PEAK while anyone plays.
 */
function lobbySizes(tickets, windowS) {
  const lam = (tickets / 86_400) * QUEUE.PEAK;
  const out = [];
  let left = tickets;
  while (left > 0) {
    let n = 1, t = 0;
    for (;;) {
      t += -Math.log(Math.max(1e-12, rnd())) / Math.max(1e-9, lam);
      if (t > windowS) break;
      if (n >= QUEUE.MIN && t > QUEUE.MIN_WAIT_S) break; // launched at MIN_WAIT with n queued
      n++;
      if (n >= QUEUE.MAX) break;
    }
    n = Math.min(n, left);
    out.push(n);
    left -= n;
  }
  return out;
}

function run(name) {
  const sc = SCEN[name];
  seed = SEED;
  uid = 0;
  const scale = sc.dau ? sc.dau / meanDau(1) : sc.scale;
  const windowS = sc.windowS ?? QUEUE.WINDOW_S;
  const players = [];
  let nextId = 1;
  let giveawayLeft = GIVEAWAY.KITS;
  let pool = [];
  for (let i = 0; i < 700; i++) { const it = seedPiece(i); it.dur = Math.round(55 + rnd() * 45); pool.push(it); }
  const treasury = { items: [], revenue: 0, revenueToday: 0, taxAcc: 0, primarySold: 0, taxSold: 0, feeRev: 0, primRev: 0, taxRev: 0 };
  let overhang = [];
  let autosellMult = 1;
  let prevActive = new Set();
  let poolEmptyStreak = 0, poolEmptyMaxStreak = 0;
  let startIdx = null;
  const tot = { destroyed: 0, boundDestroyed: 0, captured: { boss: 0, cont: 0, carrier: 0 }, released: 0, bossKills: 0, freeKitBossItems: 0, deaths: { pvp: 0, npc: 0 }, altRaids: 0, altCr: 0, altUniques: 0, altTradable: 0, lobbies: 0, solo: 0, humans: 0, tradableKits: 0, boundKits: 0, bossItems: 0, bossTop: 0, bossItems30: 0, bossTop30: 0 };
  const rows = [];
  let solStart = 0;

  function newPlayer(day, alt = false) {
    const r = rnd();
    const m = sc.mix;
    const type = alt ? "alt" : r < m.rat ? "rat" : r < m.rat + m.poi ? "poi" : r < m.rat + m.poi + m.boss ? "boss" : "full";
    const p = {
      id: nextId++, joined: day, alt, type, life: alt ? 999 : Math.max(2, -Math.log(Math.max(1e-9, rnd())) * 14),
      rate: (alt ? 6 : Math.exp(Math.log(2.2) + 0.6 * (rnd() * 2 - 1))) * SENS.rate, cr: 1000, cons: 0, xp: 0, lvl: 1, items: [],
      sol: alt ? 0 : chance(0.6) ? Math.round(rnd() * 3000) : 0, raids: 0, lastRaid: -99,
    };
    solStart += p.sol;
    // Giveaway (v5 review, web starter.ts): tradable for the first GIVEAWAY.KITS accounts that deposited
    // ≥ MIN_DEPOSIT_MINOR (here: players holding SOL; alts never deposit), BOUND for everyone else.
    // --no-giveaway-cap: every account gets a tradable kit (the old P3 lever, sybil-unsafe).
    const tradable = !OPTS.giveawayCap || (!alt && giveawayLeft > 0 && p.sol >= (GIVEAWAY.MIN_DEPOSIT_MINOR ?? 0) && p.sol > 0);
    if (tradable) { giveawayLeft--; tot.tradableKits++; p.items.push(...giveawayKit(false)); }
    else { tot.boundKits++; p.items.push(...giveawayKit(true)); }
    return p;
  }

  const enterPool = (it, broke) => {
    if (it.bound) { tot.boundDestroyed++; return; } // poolEntry: a bound item never enters the pool
    if (broke) it.dur -= POOL.BREAK_DUR_LOSS;
    if (it.dur <= 0) { tot.destroyed++; return; }
    pool.push(it);
    // 1% treasury tax on entering value (takeTreasuryTax: whole items when the accumulator covers them).
    const res = takeTreasuryTax(treasury.taxAcc, [{ uid: String(it.id), value: refCr(it) }]);
    treasury.taxAcc = res.acc;
    if (res.taken.length) { pool.pop(); treasury.items.push(it); }
  };

  for (let day = 0; day < DAYS; day++) {
    const arrivals = arrivalsOf(day, scale, sc.crashDay);
    for (let i = 0; i < arrivals; i++) players.push(newPlayer(day));
    if (sc.alts && day === sc.alts.day) for (let i = 0; i < sc.alts.n; i++) players.push(newPlayer(day, true));
    const crashMul = sc.crashDay !== undefined && day >= sc.crashDay ? 0.6 : 1;
    const active = players.filter((p) => day - p.joined < p.life * crashMul);
    const activeSet = new Set(active);
    // Leaving players dump their stash on the market with p 0.35 (memo).
    for (const p of prevActive) if (!activeSet.has(p) && !p.alt && p.lvl >= MARKET.SELL_UNLOCK_LEVEL && chance(0.35)) {
      const keep = []; for (const it of p.items) (it.lock > 0 || it.bound ? keep : overhang).push(it); p.items = keep;
    }
    prevActive = activeSet;
    const dau = active.filter((p) => !p.alt).length;

    const tickets = [];
    for (const p of active) { const n = poisson(p.rate); for (let i = 0; i < n; i++) tickets.push(p); }
    shuffle(tickets);
    const sizes = lobbySizes(tickets.length, windowS);
    const d = {
      raids: 0, junkCr: 0, tagCr: 0, consBought: 0, listFees: 0, found: 0, used: 0, extracts: 0, released: 0,
      capBoss: 0, capCont: 0, capCarrier: 0, bossKills: 0, geared: 0, altCr: 0, altRaids: 0, pvpDeaths: 0, npcDeaths: 0,
      fights: 0, lobbies: sizes.length, solo: sizes.filter((n) => n === 1).length, npcKills: 0, crKitBought: 0, crKitRaids: 0,
      foundExt: 0, freeKitRaids: 0, pvpLootCr: 0,
    };
    treasury.revenueToday = 0;

    let at = 0;
    for (const n of sizes) {
      const group = [...new Set(tickets.slice(at, at + n))];
      at += n;
      d.raids += group.length;
      // Loadouts.
      const rs = group.map((p) => {
        p.raids++; p.lastRaid = day;
        const best = (k) => p.items.filter((it) => it.k === k).sort((a, b) => b.r - a.r || b.dur - a.dur)[0];
        // No weapon at all: the bound gear shop (v5 review CR sink), when the CR allow it.
        if (!best("w") && OPTS.boundShop) {
          const price = boundKitCr(p.lvl);
          if (p.cr >= price + KIT_CR.starter * 0.5 && (p.alt || chance(0.75))) {
            p.cr -= price; d.crKitBought += price; p.items.push(...boundKit());
          }
        }
        const w = best("w"), a = best("a");
        const hunter = !!w && !!a && w.r >= 1 && a.r >= 2;
        const kitCr = hunter ? KIT_CR.hunter : KIT_CR.starter;
        // Alts are CR farmers: they gear whenever they can (their kits are bound: no risk units).
        const geared = !!w && p.cr + p.cons >= kitCr * 0.5 && (p.alt || chance(0.75));
        const lo = [];
        let kit = "free";
        if (geared) {
          for (const k of ["w", "a", "b"]) { const it = best(k); if (it) { lo.push(it); p.items.splice(p.items.indexOf(it), 1); } }
          const fromStock = Math.min(p.cons, kitCr); p.cons -= fromStock;
          const buy = Math.min(p.cr, kitCr - fromStock); p.cr -= buy; d.consBought += buy;
          d.geared++;
          if (lo.every((it) => it.bound)) d.crKitRaids++;
          p.lastGeared = day;
          kit = hunter ? "hunter" : "starter";
        } else d.freeKitRaids++;
        const target = p.type === "boss" ? pick(BOSS_KINDS.filter((k) => BOSSES[k].enabled)) : null;
        return { p, lo, kit, target, rec: null, out: "", killedBy: "", gain: [], fights: 0, tags: 0, extraJunk: 0, extraCons: 0 };
      });
      // NPCs of this match (the real rolls).
      const matchSeed = Math.floor(rnd() * 2 ** 32) >>> 0;
      const spawnedSpots = rollBossSpawns(matchSeed, MAP.bosses);
      const spawned = spawnedSpots.map((s) => s.kind);
      const carriers = raidNpcCarriers(rollNpcSpawns(matchSeed, POSTS, bossGroupNpcCount(spawnedSpots)), POSTS);
      // Pool release (v4 rule + v5 carriers).
      const B = spawned.reduce((s, k) => s + BOSSES[k].poolSlots.length, 0);
      // raids/start riskUnits = Σ riskUnitOf(loadout uniques) (bound / worn-out gear adds 0); --k scales
      // it relative to POOL.RISK_K (poolReleasePlanV4 applies POOL.RISK_K itself: no double K).
      const R = rs.reduce((s, r) => s + r.lo.reduce((a, it) => a + riskUnit(it), 0), 0) * (RISK_K / POOL.RISK_K);
      const rel = poolReleasePlanV4(pool.length, R, B);
      const total = rel.total;
      shuffle(pool);
      const bossTake = Math.min(B, total);
      const byScore = pool.map((it, i) => ({ it, i, s: tierScore(it) })).sort((a, b) => b.s - a.s || a.i - b.i);
      const bossItems = byScore.slice(0, bossTake).map((e) => e.it);
      const bset = new Set(bossItems);
      const restItems = pool.filter((it) => !bset.has(it)).slice(0, total - bossTake);
      const out = new Set([...bossItems, ...restItems]);
      pool = pool.filter((it) => !out.has(it));
      d.released += total;
      // Boss slots: rankBossSlots order (min score desc, tougher boss first).
      const slots = [];
      for (const k of spawned) BOSSES[k].poolSlots.forEach((min, i) => slots.push({ k, min, hp: BOSSES[k].hp, i }));
      slots.sort((a, b) => b.min - a.min || b.hp - a.hp || a.i - b.i);
      const bag = Object.fromEntries(spawned.map((k) => [k, []]));
      bossItems.forEach((it, i) => bag[slots[i].k].push(it));
      // The rest: the web planAllocation draw (allocRest: containers and carriers without replacement).
      const contItems = [], carrierItems = [];
      const dest = allocRest(restItems.length, carriers);
      restItems.forEach((it, k) => {
        if (dest[k] === "carrier") carrierItems.push(it);
        else if (dest[k] === "cont") contItems.push(it);
        else enterPool(it, false);
      });

      // PvE: sample a harness record per human; junk / consumables found shrink with the lobby
      // (competition for the same containers and NPC bags, compOf(n), harness-calibrated).
      const comp = compOf(rs.length);
      for (const r of rs) {
        const strat = STRAT_OF[r.p.type];
        r.rec = r.p.type === "boss" ? pick(bossRecords(r.target, r.kit, spawned.includes(r.target))) : pick(bucket(strat, r.kit));
        r.out = r.rec.exit;
        r.killedBy = r.rec.exit === "dead" ? r.rec.killedBy || "npc" : "";
        d.found += r.rec.cons.foundCr * comp * SENS.found; d.used += r.rec.cons.usedCr;
        d.npcKills += (r.rec.killsBy?.marauder ?? 0) + (r.rec.killsBy?.guard ?? 0);
      }
      // PvP layer.
      const nH = rs.length;
      if (nH > 1) {
        const order = [];
        for (const r of rs) {
          const lam = PVP.LAMBDA_FULL_LOBBY[r.p.type === "poi" && (r.rec.containers?.byTier?.T3 || r.rec.containers?.byTier?.T4) ? "t34" : r.p.type] * SENS.lambda * (nH - 1) / 23;
          for (let k = poisson(lam); k > 0; k--) order.push(r);
        }
        const pvpDead = new Set();
        for (const a of shuffle(order)) {
          if (pvpDead.has(a)) continue;
          const others = rs.filter((x) => x !== a && !pvpDead.has(x) && (x.out !== "dead" || chance(0.5)));
          if (a.out === "dead" && !chance(0.5)) continue; // killed by NPCs before this encounter
          if (!others.length) continue;
          const b = pick(others);
          const pa = PVP.POWER[a.kit] + (a.p.lvl >= 10 ? 0.3 : 0);
          const pb = PVP.POWER[b.kit] + (b.p.lvl >= 10 ? 0.3 : 0);
          const aWins = chance(logistic(PVP.K * (pa - pb + gauss() * PVP.SKILL_SD)));
          const [w, l] = aWins ? [a, b] : [b, a];
          w.fights++; l.fights++;
          d.fights++;
          pvpDead.add(l);
          // The loser's haul so far (half its full-raid haul: fights happen mid-raid) is the winner's
          // to take; LOOT_IF_EXTRACT of it leaves with the winner if the winner extracts (v5 review).
          const lh = l.out === "extract" ? l.rec.haul : null;
          if (lh) { w.extraJunk += lh.junkCr * comp * PVP_LOOT_HAUL * PVP.LOOT_IF_EXTRACT; w.extraCons += lh.consumables.cr * comp * PVP_LOOT_HAUL * PVP.LOOT_IF_EXTRACT; }
          l.out = "dead"; l.killedBy = "human"; l.winner = w;
          w.tags++;
        }
      }
      // web raids.ts (v5 review): a pool unique extracted by a raider who risked nothing (free kit or
      // only bound gear) arrives bound — usable, never sellable.
      const bindIfRiskFree = (r, items) => { if (!r.lo.some((it) => !it.bound)) for (const it of items) it.bound = true; };
      // Boss items: the first hunter of that boss whose record killed it.
      const back = [];
      for (const k of spawned) {
        const items = bag[k];
        const killer = shuffle(rs.filter((r) => r.target === k)).find((r) => r.rec.bosses.some((b) => b.kind === k && b.fate === "human"));
        if (killer) { d.bossKills++; tot.bossKills++; }
        tot.bossItems += items.length; tot.bossTop += items.filter((it) => tierScore(it) === 2).length;
        if (day >= 30) { tot.bossItems30 += items.length; tot.bossTop30 += items.filter((it) => tierScore(it) === 2).length; }
        if (killer && killer.out === "extract") { bindIfRiskFree(killer, items); killer.gain.push(...items); d.capBoss += items.length; if (killer.kit === "free") tot.freeKitBossItems += items.length; }
        else if (killer) for (const it of items) back.push([it, chance(BREAK)]);
        else for (const it of items) back.push([it, false]);
      }
      // Container / carrier items: per item, humans in random order with q(strategy | survived).
      for (const [items, qq, key] of [[contItems, Q, "capCont"], [carrierItems, QC, "capCarrier"]]) {
        for (const it of items) {
          let got = null;
          for (const r of shuffle([...rs])) {
            if (r.out !== "extract") continue;
            if (chance(qq[r.p.type].q)) { got = r; break; }
          }
          if (got) { bindIfRiskFree(got, [it]); got.gain.push(it); d[key]++; if (got.p.alt) { tot.altUniques++; if (!it.bound) tot.altTradable++; } }
          else back.push([it, false]);
        }
      }
      for (const [it, broke] of back) enterPool(it, broke);
      // Outcomes.
      for (const r of rs) {
        const p = r.p;
        const ks = r.rec.killsBy ?? {};
        p.xp += PROGRESSION.XP_RAID + (r.out === "extract" ? PROGRESSION.XP_EXTRACT : 0) + r.tags * PROGRESSION.XP_KILL +
          (ks.marauder ?? 0) * (PROGRESSION.XP_NPC ?? 0) + (ks.guard ?? 0) * (PROGRESSION.XP_GUARD ?? 0) + (r.rec.humanBossKills ?? 0) * PROGRESSION.XP_BOSS;
        p.lvl = levelForXp(p.xp);
        d.used += r.fights * PVP.FIGHT_CONS_CR;
        if (r.out === "extract") {
          d.extracts++;
          const tagCr = r.tags * dogTagCr(Math.max(1, Math.round(p.lvl)));
          const junk = (r.rec.haul.junkCr * SENS.junk * comp + r.extraJunk) * (r.lo.length === 0 ? FREE_KIT_AUTOSELL : 1);
          const cr = Math.round((junk + tagCr) * autosellMult);
          p.cr += cr; d.junkCr += cr; d.tagCr += Math.round(tagCr * autosellMult); d.pvpLootCr += Math.round(r.extraJunk * autosellMult);
          if (p.alt) { d.altCr += cr; d.altRaids++; tot.altCr += cr; tot.altRaids++; }
          const consIn = r.rec.haul.consumables.cr * comp * SENS.found + r.extraCons;
          // Found by raiders who got out (what reaches stashes, + PvP loot): the supply side of E5 (v5 review).
          d.foundExt += r.rec.cons.foundCr * comp * SENS.found + r.extraCons;
          p.cons += Math.max(0, consIn - r.fights * PVP.FIGHT_CONS_CR);
          for (const it of r.lo) {
            if (it.k === "a") it.dur -= 10 + rnd() * 35; else if (it.k === "w") it.dur -= 2 + rnd() * 4; else it.dur -= 1 + rnd() * 3;
            if (it.lock > 0) it.lock--;
            if (it.dur <= 0) tot.destroyed++; else p.items.push(it);
          }
          p.items.push(...r.gain);
        } else if (r.out === "timeout") {
          for (const it of [...r.lo, ...r.gain]) enterPool(it, false);
          if (p.alt) { d.altRaids++; tot.altRaids++; }
        } else {
          if (r.killedBy === "human") { d.pvpDeaths++; tot.deaths.pvp++; } else { d.npcDeaths++; tot.deaths.npc++; }
          if (p.alt) { d.altRaids++; tot.altRaids++; }
          const w = r.killedBy === "human" ? r.winner : null;
          for (const it of [...r.lo, ...r.gain]) {
            // Bound gear never breaks into the pool: a killer may loot it (still bound), else destroyed.
            if (!it.bound && chance(BREAK)) enterPool(it, true);
            else if (w && w.out === "extract" && chance(PVP.LOOT_IF_EXTRACT)) w.p.items.push(it);
            else enterPool(it, false);
          }
        }
      }
    }
    tot.lobbies += d.lobbies; tot.solo += d.solo; tot.humans += d.raids;

    // Market (opens day 3): P2P from sellers lvl >= SELL_UNLOCK_LEVEL with a spare, overhang first; fee 5%.
    const tradable = active.reduce((a, p) => a + (p.alt ? 0 : p.items.filter((i) => !i.bound).length), 0);
    const perActive = tradable / Math.max(1, dau);
    const priceIdx = Math.pow(2 / Math.max(0.3, perActive), 0.8);
    let trades = 0, primary = 0;
    if (day >= 3) {
      if (startIdx === null) startIdx = priceIdx;
      const sellers = active.filter((p) => !p.alt && p.lvl >= MARKET.SELL_UNLOCK_LEVEL);
      const buyers = shuffle(active.filter((p) => !p.alt && p.sol > 0 && !p.items.some((i) => i.k === "w" && !i.bound)));
      for (const b of buyers) {
        if (!chance(0.25)) continue;
        let it = null;
        if (treasury.items.length) {
          it = treasury.items.pop();
          const price = Math.round(refPrice(it) * Math.max(1, priceIdx));
          if (b.sol < price) { treasury.items.push(it); continue; }
          b.sol -= price; treasury.revenueToday += price; treasury.taxRev += price; treasury.taxSold++;
        } else {
          let s = null;
          if (overhang.length) it = overhang.pop();
          else {
            s = pick(sellers);
            if (!s || s === b) continue;
            it = s.items.filter((i) => i.lock <= 0 && !i.bound && s.items.filter((j) => j.k === i.k).length >= 2).sort((x, y) => x.r - y.r)[0];
            if (!it) continue;
            const fee = MARKET.LISTING_FEE_CR[Math.min(3, it.r)];
            if (s.cr < fee) continue;
            s.cr -= fee; d.listFees += fee;
          }
          const price = Math.round(refPrice(it) * priceIdx);
          if (b.sol < price) { if (s) s.items.push(it); else overhang.push(it); continue; }
          if (s) s.items.splice(s.items.indexOf(it), 1);
          b.sol -= price;
          const fee = Math.ceil(price * MARKET.FEE_BPS / 10_000);
          if (s) s.sol += price - fee;
          treasury.revenueToday += fee; treasury.feeRev += fee;
        }
        b.items.push(it); trades++;
      }
      // Primary sales: daily from day 14 while items/active < 2.5, up to 8% DAU, ~10% top tier, price max(ref, ref × idx).
      if (OPTS.primary && day >= 14 && perActive < 2.5) {
        const rich = active.filter((p) => !p.alt && p.sol > 500);
        const n = Math.min(rich.length, Math.round(dau * PRIMARY_SHARE));
        for (let i = 0; i < n; i++) {
          const b = pick(rich); const it = primaryItem(); const price = Math.round(refPrice(it) * Math.max(1, priceIdx));
          if (b.sol < price) continue;
          b.sol -= price; b.items.push(it); treasury.revenueToday += price; treasury.primRev += price; primary++;
        }
        treasury.primarySold += primary;
      }
    }
    treasury.revenue += treasury.revenueToday;

    // Autosell regulator (daily cron): veterans = joined >= 7 days ago and raided in the last 7 days.
    // web daily.ts: veterans = older than 7 days with a GEARED raid (a loadout with a unique) in 7 days.
    const vets = active.filter((p) => day - p.joined >= 7 && day - p.lastRaid <= 7 && p.lastGeared !== undefined && day - p.lastGeared <= 7).map((p) => p.cr);
    const vetMed = med(vets);
    if (OPTS.regulator) autosellMult = nextAutosellMult(autosellMult, vetMed, vets.length);

    poolEmptyStreak = pool.length === 0 ? poolEmptyStreak + 1 : 0;
    poolEmptyMaxStreak = Math.max(poolEmptyMaxStreak, poolEmptyStreak);
    const crs = active.filter((p) => !p.alt).map((p) => p.cr);
    tot.captured.boss += d.capBoss; tot.captured.cont += d.capCont; tot.captured.carrier += d.capCarrier; tot.released += d.released;
    const deaths = d.pvpDeaths + d.npcDeaths;
    const sink = d.consBought + d.listFees + d.crKitBought;
    rows.push({
      day, dau, raids: d.raids, lobbies: d.lobbies, medLobby: med(sizes), soloShare: +(d.solo / Math.max(1, d.lobbies)).toFixed(2),
      geared: +(d.geared / Math.max(1, d.raids)).toFixed(2), ext: +(d.extracts / Math.max(1, d.raids)).toFixed(2),
      itemsPerActive: +perActive.toFixed(2), priceIdx: +priceIdx.toFixed(2), priceVsStart: startIdx ? +(priceIdx / startIdx).toFixed(2) : null,
      revenue: treasury.revenueToday, trades, primary, pool: pool.length, poolTop: pool.filter((i) => tierScore(i) === 2).length,
      released: d.released, capBoss: d.capBoss, capCont: d.capCont, capCarrier: d.capCarrier, bossKills: d.bossKills,
      crMed: med(crs), crP99: pctl(crs, 0.99), vetMed, mult: +autosellMult.toFixed(2),
      faucet: d.junkCr, tags: d.tagCr, sink, faucetSink: +(d.junkCr / Math.max(1, sink)).toFixed(2),
      consFound: Math.round(d.found), consUsed: Math.round(d.used), foundUsed: +(d.found / Math.max(1, d.used)).toFixed(2), consBought: d.consBought,
      consFoundExt: Math.round(d.foundExt), foundUsedExt: +(d.foundExt / Math.max(1, d.used)).toFixed(2), freeKitShare: +(d.freeKitRaids / Math.max(1, d.raids)).toFixed(2), pvpLootCr: d.pvpLootCr,
      pvpDeaths: d.pvpDeaths, npcDeaths: d.npcDeaths, pvpShare: +(d.pvpDeaths / Math.max(1, deaths)).toFixed(2), fights: d.fights, npcKills: d.npcKills,
      crKitBought: d.crKitBought, crKitRaids: d.crKitRaids, altCr: d.altCr, altRaids: d.altRaids, altCrPerRaid: d.altRaids ? Math.round(d.altCr / d.altRaids) : 0,
    });
  }
  const solNow = players.reduce((a, p) => a + p.sol, 0) + treasury.revenue;
  return {
    name, scale: +scale.toFixed(3), windowS, rows, tot,
    treasury: { revenue: treasury.revenue, feeRev: treasury.feeRev, primRev: treasury.primRev, taxRev: treasury.taxRev, primarySold: treasury.primarySold, taxSold: treasury.taxSold },
    solConserved: solNow === solStart, poolEmptyMaxStreak,
    alts: sc.alts ? altStats(players, tot) : null,
  };
}

function altStats(players, tot) {
  const f = players.filter((p) => p.alt);
  return { accounts: f.length, items: f.reduce((a, p) => a + p.items.length, 0), tradableItems: f.reduce((a, p) => a + p.items.filter((i) => !i.bound).length, 0), crMedian: med(f.map((p) => p.cr)), raids: tot.altRaids, crPerRaid: tot.altRaids ? Math.round(tot.altCr / tot.altRaids) : 0, uniques: tot.altUniques, tradableUniques: tot.altTradable };
}

// ---------------------------------------------------------------- report
const scen = arg("scenario", "all");
const names = scen === "all" ? Object.keys(SCEN) : [scen];
for (const n of names) if (!SCEN[n]) throw new Error(`--scenario: unknown ${n} (one of ${Object.keys(SCEN).join("|")}|all)`);
const results = names.map(run);
console.log(`data ${DATA} (${files.length} files; PvE buckets ${[...PVE].map(([k, v]) => `${k}:${v.length}`).join(" ")}; lobby records ${LOBBY.length}); K ${RISK_K}; ` +
  `primary ${OPTS.primary}; giveaway cap ${OPTS.giveawayCap}; bound shop ${OPTS.boundShop ? `on (set ${boundKitCr(1)} / ${boundKitCr(5)} CR)` : "off"}; free-kit autosell ×${FREE_KIT_AUTOSELL}; ` +
  `competition C ${COMP.toFixed(4)} (${COMP_ARG !== undefined ? "--comp" : COMP_CAL.c !== null ? "harness" : "fallback"}); PvP loot ${PVP_LOOT_HAUL}; regulator ${OPTS.regulator}; queue ${JSON.stringify(QUEUE)}; PvP ${PVP_SOURCE} ${JSON.stringify(PVP.LAMBDA_FULL_LOBBY)}`);
console.log("competition calibration (starter lobby records vs solo):", JSON.stringify(COMP_CAL.by));
console.log("capture q (per released item | survived):", Object.fromEntries(TYPES.map((t) => [t, `container ${Q[t].q.toFixed(3)} (${Q[t].src} ${Q[t].got}/${Q[t].rel}), carrier ${QC[t].q.toFixed(3)} (${QC[t].src} ${QC[t].got}/${QC[t].rel})`])));
if (LOBBY.length) console.log("harness PvP calibration (multi-human lobbies):", JSON.stringify(PVP_CAL));
const pickDays = [6, 13, 29, 59, DAYS - 1].filter((x, i, a) => x < DAYS && a.indexOf(x) === i);
for (const r of results) {
  console.log(`\n=== ${r.name} (arrival scale ${r.scale}, queue window ${r.windowS} s) ===`);
  console.table(r.rows.filter((x) => pickDays.includes(x.day)).map((x) => ({
    d: x.day + 1, dau: x.dau, lob: x.medLobby, solo: x.soloShare, "it/act": x.itemsPerActive, pIdx: x.priceIdx, "p/start": x.priceVsStart, rev: x.revenue,
    pool: x.pool, top: x.poolTop, rel: x.released, "cap b/c/n": `${x.capBoss}/${x.capCont}/${x.capCarrier}`, crMed: x.crMed, crP99: x.crP99, mult: x.mult,
    "f/s": x.faucetSink, "cons f/u": x.foundUsed, pvp: x.pvpShare, ...(r.alts ? { "alt CR/raid": x.altCrPerRaid } : {}),
  })));
  const from3 = r.rows.filter((x) => x.day >= 3);
  const from14 = r.rows.filter((x) => x.day >= 14);
  const mean = (rows, f) => rows.length ? +(rows.reduce((a, x) => a + f(x), 0) / rows.length).toFixed(2) : 0;
  console.log(
    `revenue>0 every day from day 3: ${from3.every((x) => x.revenue > 0)} (zero days: ${from3.filter((x) => x.revenue <= 0).map((x) => x.day).join(",") || "-"}); ` +
    `pool max empty streak ${r.poolEmptyMaxStreak}; SOL conserved (no game payout) ${r.solConserved}; ` +
    `day 14+: median lobby ${mean(from14, (x) => x.medLobby)}, solo share ${mean(from14, (x) => x.soloShare)}, PvP share of deaths ${mean(from14, (x) => x.pvpShare)}, ` +
    `faucet/sink ${mean(from14, (x) => x.faucetSink)}, cons found/used ${mean(from14, (x) => x.foundUsed)}, items/active ${mean(from14, (x) => x.itemsPerActive)}; ` +
    `treasury ${JSON.stringify(r.treasury)}; totals ${JSON.stringify(r.tot)}` + (r.alts ? `; alts ${JSON.stringify(r.alts)}` : ""),
  );
}
const jsonOut = arg("json");
if (jsonOut) writeFileSync(jsonOut, JSON.stringify({ data: DATA, k: RISK_K, opts: OPTS, queue: QUEUE, pvp: PVP, pvpSource: PVP_SOURCE, pvpCalibration: PVP_CAL, q: Q, qCarrier: QC, results }, null, 1));
const csvDir = arg("csv");
if (csvDir) {
  mkdirSync(csvDir, { recursive: true });
  for (const r of results) {
    const cols = Object.keys(r.rows[0] ?? {});
    writeFileSync(join(csvDir, `econ-${r.name}.csv`), [cols.join(","), ...r.rows.map((x) => cols.map((c) => x[c] ?? "").join(","))].join("\n") + "\n");
  }
  console.log(`wrote per-day CSVs to ${csvDir}`);
}
