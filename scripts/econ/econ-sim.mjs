// Economy population simulation, WORLD v6 cycle model (spec §8.2, addendum A2): N players over D days on one
// always-live map wiped every 45 minutes, fed by the loot-yield harness (apps/game-server/src/sim/econ/
// loot-yield.bench.ts) JSON outputs: v5 single-human raid records (sampled per entry by strategy:kit) and,
// when present, the world harness (`--world` runs, yield-world*.json) for the map-age / capture calibration.
//
//   pnpm --filter @extract/shared build      # the sim imports the real rules from packages/shared/dist
//   T=apps/game-server/node_modules/.bin/tsx; B=apps/game-server/src/sim/econ/loot-yield.bench.ts; O=/tmp/extract-econ
//   # PvE records, one scripted human per raid (§25.4 lists the full set):
//   $T $B --strategy rat --out $O;  $T $B --strategy poi --out $O;  $T $B --strategy full --out $O; …
//   # world harness (≤ 4 shard-cycles): late-joiner curve, pool capture with the 8-min delay, corpse fates
//   $T $B --world --cycles 4 --users 48 --out $O --tag v6
//   node scripts/econ/econ-sim.mjs --data $O [--world FILE|DIR] [--scenario base|lowdau|highdau|altfarm|afkbot|tagtour|cheaprisk|crash|noexpiry|kitfarm|all]
//        [--days 90] [--seed 7] [--json out.json] [--csv DIR] [--pvp-source harness|design]  (default harness)
//        [--k 1.0] [--set '{"POOL.CYCLE_MAX":32}']   (lever study: dotted paths into the shared exports, §8.6)
//        [--map-stock CR] [--corpse-loot P] [--place-capture P] [--boss-mult M] [--mia 0.03] [--xp-aware [P]] [--no-expiry]
//        [--peak-mult M] [--night-mult M] [--no-primary] [--no-kits] [--no-regulator] [--no-bound-shop]
//        [--cr-kit CR] [--free-kit-autosell M] [--pvp-loot L] [--prim-day D]
//        [--prim-target T] [--prim-fixed] [--prim-mult M] [--list-p P] [--buy-p P] [--alt-day D]
//        [--alt-n N] [--dump-players FILE]
//        [--sim-per-minor U] [--kit-daily-max N] [--kit-buy-p P] [--kit-rebuy-p P]   (paid starter kit, design §19)
//
// Every yield-*.json in --data with `records` is read; records are bucketed by strategy:kit (boss hunters also
// by target). PvE buckets use single-human records only (lobby.humans === 1); multi-human lobby records only
// calibrate PvP. A missing bucket falls back (kit → starter → any kit; full → poi) with a warning.
//
// Cycle model (spec §8.2; the shared rules come from packages/shared/dist, so the sim cannot drift):
// - time: 32 cycles a day (WORLD.CYCLE_MS); entry opens at 0:20 and closes at 35:00, the wipe at 45:00. Daily
//   sessions (first entries) per player = Poisson(rate); each goes to a cycle by an hour-of-day profile (× 2.5 at
//   19–23 UTC, × 0.4 at 03–09, 1 otherwise), entering 35 % in minutes 0:20–5 and the rest in 5–35;
// - one shard, ≤ WORLD.CAPACITY humans on the map: a first entry that finds it full waits for the next cycle (at
//   most twice) and every refusal counts as `world_full`; re-entry after a death 40 %, after an extract 20 %,
//   1–2 min later, ≤ WORLD.MAX_ENTRIES_PER_CYCLE per cycle, only while entry is open;
// - per entry a v5 single-human record of its strategy:kit is sampled. The map is one junk stock per cycle
//   (--map-stock, default: the world harness's junk extracted per shard, else 26 000 CR): an entry takes its
//   record's junk × r, r = 1 − (junk already taken, counted as the earlier entries progress) / stock — the
//   late-joiner curve. Consumables found scale by r; on a stripped map an extractor leaves near its arm
//   (on-map time = arm + (record − arm) × r). The spec's opens formula (1 − exp(−opens / 400)) under-predicts
//   the harness cliff (best containers go first), so the stock calibrated on the harness replaces it;
// - pool release per entry with the real poolReleaseForEntry (per (cycle, user) budget, shard cap, daily cap,
//   late taper; targets = untouched T3/T4 pool containers 70 × exp(−T3/T4 opens / 93) + carriers) and the tier
//   match; the items are placed 8 min after the entry (or at its death); an extract before that returns them
//   (untaxed); placed items are captured with --place-capture (world harness) × the human-minutes left on
//   the map after placement, by an extractor picked by overlap; the rest is leftOnMap (untaxed, no wear);
// - boss events by the real bossEventOf with a seeded test hash; boss-type entries on a boss map are attempts
//   (a record sampled among the v5 raids where that boss spawned: its kill is the per-attempt band); the first
//   sampled kill takes the boss and its bag (bossFillPlan at the first entry that passes the gate);
// - PvP: each entry gets Poisson(λ[type] × humans on the map / 23) encounters with someone on the map; the
//   loser dies (the winner gets the tag at full price and LOOT_IF_EXTRACT of the body);
// - death: every unique breaks with BREAK_CHANCE_ON_DEATH (→ pool −8 dur, taxed), the rest stays in the body:
//   the PvP killer, else another human with --corpse-loot (world harness), else (A6) the body expires 15 min
//   after death → player uniques to the TREASURY (no tax; it sells them like the house's other lots) — or, for
//   deaths in the last 15 min, leftOnMap → pool (taxed). Tags of a body looted by a non-killer pay × 0.25 (D22);
// - MIA: --mia (3 %) of entries stay to the wipe: everything carried → pool (no wear, taxed), XP kill lines only;
// - XP per exit with the real xpForExit (daily grind, first extract of the day, ranked PvP: victim level ≥ 5
//   and account ≥ 72 h, ≤ PVP_DAILY_MAX a day) → levels, entries to L5 / L10, weekly boards;
// - treasury: 1 % tax (takeTreasuryTax), tax / expiry lots and primary batches sold on the market, 5 % P2P fee.
//   The game NEVER pays SOL: the only money moves are buyer → seller (−fee) and buyer → house;
// - CR: faucet = junk autosell (basic gear × FREE_KIT.AUTOSELL_MULT) + dog tags; sinks = junker consumables
//   (CONSUMABLES_CR) + bound gear shop (incl. the backpack a kit lacks) + CR listing fees; daily regulator
//   nextAutosellMult on the veterans' median;
// - starter kit (04.10): always paid STARTER_KIT.PRICE_MINOR (× --sim-per-minor units) to the treasury, ≤ DAILY_MAX a
//   day: on day one by KIT_BUY_P of those who can afford it, then on an entry without a weapon by KIT_REBUY_P (before
//   the bound CR shop). 3 locked tradable pistols + armor, the stacks as consumable stock, no CR. A pistol loadout
//   samples the bench's "pistol" records (power 0.5 in PvP).
// Scenarios (§8.3): base, lowdau (150 DAU), highdau (3 000), altfarm (300 free-kit alts churning 4 entries a
// session from day 10), afkbot (5 % of entries idle to the wipe), tagtour (10 % free-kit late entries that only
// collect tags), cheaprisk (300 alts with one common 50 % unique), crash (arrivals drop at day 30), noexpiry
// (base without A6: unlooted bodies stay to the wipe → pool), kitfarm (300 alts buying the daily cap of kits).

import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync, statSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const shared = await import(resolve(here, "../../packages/shared/dist/index.js"));
const {
  BOSSES, BOSS_KINDS, CONSUMABLES_CR, MARKET, POOL, GIVEAWAY, STARTER_KIT, FREE_KIT, BOUND_OFFERS, WORLD, XP, DOG_TAG,
  xpForExit, nextAutosellMult, levelForXp, takeTreasuryTax, dogTagCr, boundTraderLevel, bossEventOf,
  poolReleaseForEntry, bossFillPlan, generateMap, poolContainerEligible, npcPostsOf, npcCarrierEligible,
} = shared;
const BREAK = shared.BREAK_CHANCE_ON_DEATH ?? 0.5;

// ---------------------------------------------------------------- CLI
const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
const flag = (n) => argv.includes(`--${n}`);
// --set: lever study (§8.6), dotted paths into the shared exports (mutable objects; the real rules read them).
const SET = arg("set") ? JSON.parse(arg("set")) : null;
if (SET) for (const [path, value] of Object.entries(SET)) {
  const parts = path.split(".");
  let o = shared[parts[0]];
  for (const k of parts.slice(1, -1)) o = o?.[k];
  if (!o || typeof o !== "object") throw new Error(`--set path not found: ${path}`);
  o[parts.at(-1)] = value;
}
const DATA = resolve(arg("data", join(tmpdir(), "extract-econ")));
const DAYS = Number(arg("days", 90));
const SEED = Number(arg("seed", 7));
const RISK_K = Number(arg("k", POOL.RISK_K));
// --xp-aware [P]: share P (default 1 with the flag, 0 without) of players who never extract before XP.MIN_ONMAP_MS
// (they wait for the extract XP); the rest leave when their v5 record does (scripted, XP-blind).
const XP_AWARE = flag("xp-aware") ? (Number.isFinite(Number(arg("xp-aware"))) ? Number(arg("xp-aware")) : 1) : 0;
const OPTS = { primary: !flag("no-primary"), kits: !flag("no-kits"), regulator: !flag("no-regulator"), boundShop: !flag("no-bound-shop"), expiry: !flag("no-expiry"), xpAware: XP_AWARE };
// Bound gear shop (web market/trader.ts buyBound over BOUND_OFFERS): a player with no weapon buys a BOUND set
// (weapon + armor_1 + backpack_1) for CR: shotgun before level 5, rifle from level 5 (boundTraderLevel).
const CR_KIT_OVERRIDE = arg("cr-kit") !== undefined ? Number(arg("cr-kit")) : null;
const offerCr = (def) => BOUND_OFFERS.find((o) => o.def === def)?.cr ?? 0;
function boundKitCr(level) {
  if (CR_KIT_OVERRIDE !== null) return CR_KIT_OVERRIDE;
  const gun = boundTraderLevel(level) >= 2 ? "rifle" : "shotgun";
  return offerCr(gun) + offerCr("armor_1") + offerCr("backpack_1");
}
const FREE_KIT_AUTOSELL = Number(arg("free-kit-autosell", FREE_KIT.AUTOSELL_MULT ?? 1));
// ---- Paid starter kit (design §19, Vlad 04.10): always paid, STARTER_KIT.PRICE_MINOR (0.05 SOL), repeatable up
// to STARTER_KIT.DAILY_MAX a day, tradable after GIVEAWAY.LOCK_RAIDS extracts, no CR. Money anchor: the sim's
// item prices are NPC_PRICE_MINOR sim units (common weapon 300 = 3 primary-price units); --sim-per-minor (default
// 200) sim units per balance minor (0.01 SOL) makes the kit 1 000 units ≈ the reference value of its uniques
// (3 pistols at half a common weapon + armor Lv 1 / Lv 2 at 80 / 20 %). It sets who can afford a kit, never a lever.
const SIM_PER_MINOR = Number(arg("sim-per-minor", 200));
const KIT_PRICE = STARTER_KIT.PRICE_MINOR * SIM_PER_MINOR;
const KIT_DAILY_MAX = Number(arg("kit-daily-max", STARTER_KIT.DAILY_MAX));
/** Share of new players who can afford a kit and buy one on day one; share of weaponless entries that rebuy. */
const KIT_BUY_P = Number(arg("kit-buy-p", 0.7));
const KIT_REBUY_P = Number(arg("kit-rebuy-p", 0.5));
const KIT_ARMOR2_P = (STARTER_KIT.armor.find((a) => a.def === "armor_2")?.weight ?? 0) / STARTER_KIT.armor.reduce((a, b) => a + b.weight, 0);
const PVP_LOOT_HAUL = Number(arg("pvp-loot", 0.5));
const PRIMARY_SHARE = Number(arg("primary-share", 0.08));
const MARKET_LIST_P = Number(arg("list-p", 0.3));
const MARKET_BUY_P = Number(arg("buy-p", 0.25));
const SENS = { junk: Number(arg("junk-mult", 1)), found: Number(arg("found-mult", 1)), rate: Number(arg("rate-mult", 1)), lambda: Number(arg("lambda-mult", 1)) };
const MIA_RATE = Number(arg("mia", 0.03));
const PEAK = 2.5 * Number(arg("peak-mult", 1));
const NIGHT = 0.4 * Number(arg("night-mult", 1));
const PVP_SOURCE = arg("pvp-source", "harness");
/** PvP layer (design v5 CONFIG I). λ = encounters per entry with 23 other humans on the map. */
const PVP = {
  LAMBDA_FULL_LOBBY: { rat: 0.4, poi: 1.2, t34: 2.0, boss: 2.0, full: 1.6, alt: 0.4 },
  POWER: { free: 0, pistol: 0.5, starter: 1, hunter: 2 },
  SKILL_SD: 0.8, K: 1.2, LOOT_IF_EXTRACT: Number(arg("loot-if-extract", 0.7)), FIGHT_CONS_CR: Number(arg("fight-cons", 80)),
};
const MIN = 60_000;
const CYCLE_MIN = WORLD.CYCLE_MS / MIN;
const OPEN_MIN = WORLD.RESET_MS / MIN;
const CLOSE_MIN = (WORLD.CYCLE_MS - WORLD.ENTRY_CLOSE_MS) / MIN;
const ARM_MIN = WORLD.EXTRACT_ARM_MS / MIN;
const APPLY_MIN = POOL.APPLY_AFTER_MS / MIN;
const CORPSE_MIN = (WORLD.CORPSE_EXPIRE_MS ?? 900_000) / MIN;
const CYCLES_PER_DAY = Math.round(86_400_000 / WORLD.CYCLE_MS);

// ---------------------------------------------------------------- harness data (v5 single-human records)
const files = existsSync(DATA) ? readdirSync(DATA).filter((f) => /^yield-.*\.json$/.test(f)) : [];
if (!files.length) throw new Error(`no harness outputs (yield-*.json) in ${DATA} — run loot-yield.bench.ts first (see the header)`);
const PVE = new Map();
const LOBBY = [];
const worldFiles = [];
let legacy = 0;
for (const f of files) {
  const j = JSON.parse(readFileSync(join(DATA, f), "utf8"));
  if (j.mode === "world") { worldFiles.push(j); continue; }
  for (const r of j.records ?? []) {
    if (!r.lobby) { legacy++; continue; }
    if (r.lobby.humans > 1) { LOBBY.push(r); continue; }
    const keys = [`${r.strategy}:${r.kit}`];
    if (r.strategy === "boss" && r.hunt?.kind) keys.push(`boss:${r.hunt.kind}:${r.kit}`);
    for (const k of keys) { if (!PVE.has(k)) PVE.set(k, []); PVE.get(k).push(r); }
  }
}
if (legacy) console.warn(`[econ-sim] skipped ${legacy} pre-v5 records (no lobby field)`);
// --world FILE|DIR: the world harness output (default: yield-world*.json inside --data).
const WORLD_ARG = arg("world");
if (WORLD_ARG) {
  const p = resolve(WORLD_ARG);
  const list = statSync(p).isDirectory() ? readdirSync(p).filter((f) => /^yield-world.*\.json$/.test(f)).map((f) => join(p, f)) : [p];
  for (const f of list) worldFiles.push(JSON.parse(readFileSync(f, "utf8")));
}
const warned = new Set();
function bucket(strategy, kit, target = null) {
  const tries = [];
  const strategies = strategy === "full" ? ["full", "poi"] : [strategy];
  for (const s of strategies) for (const k of [kit, "starter", "free", "hunter"]) { if (target) tries.push(`boss:${target}:${k}`); tries.push(`${s}:${k}`); }
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
/** v5 per-attempt kill rate of a boss kind by kit: share of its hunt records (boss spawned) where the hunter killed it. */
function bossBand(kind, kit) {
  const rs = bossRecords(kind, kit, true);
  return rs.filter((r) => r.bosses.some((b) => b.kind === kind && b.fate === "human")).length / Math.max(1, rs.length);
}
const TYPES = ["rat", "poi", "boss", "full", "alt"];
const STRAT_OF = { rat: "rat", poi: "poi", boss: "boss", full: "full", alt: "full" };
/** Harness PvP calibration: per strategy, deaths by humans and PvP kills per raid, scaled to a full map. */
function pvpCalibration() {
  const by = {};
  for (const r of LOBBY) {
    const o = (by[r.strategy] ??= { raids: 0, deaths: 0, kills: 0, scale: 0 });
    o.raids++; o.deaths += r.pvp.died ? 1 : 0; o.kills += r.pvp.kills; o.scale += (r.lobby.humans - 1) / 23;
  }
  for (const o of Object.values(by)) o.lambdaFull = o.scale > 0 ? +((o.deaths + o.kills) / o.scale).toFixed(3) : 0;
  return by;
}
const PVP_CAL = pvpCalibration();
if (PVP_SOURCE === "harness") {
  const DESIGN = { ...PVP.LAMBDA_FULL_LOBBY };
  if (PVP_CAL.poi?.raids >= 10) PVP.LAMBDA_FULL_LOBBY.t34 = +(PVP_CAL.poi.lambdaFull * DESIGN.t34 / DESIGN.poi).toFixed(3);
  for (const t of TYPES) {
    const c = PVP_CAL[STRAT_OF[t]] ?? (t === "alt" ? PVP_CAL.rat : null);
    if (c && c.raids >= 10) PVP.LAMBDA_FULL_LOBBY[t] = c.lambdaFull;
  }
}

// ---------------------------------------------------------------- world harness calibration (§8.4)
/**
 * From yield-world*.json (world harness): the map's junk stock per shard-cycle (junk extracted), the share of
 * placed pool items any human extracted, and how the surviving uniques on dead humans ended (looted by
 * another human vs expired / left). Absent → defaults (stated in the report).
 */
function worldCalibration() {
  const cal = { src: "default", shards: 0, stock: 26_000, placeCapture: 0.5, corpseLoot: 0.6, harness: null };
  const shards = worldFiles.flatMap((j) => j.shards ?? []);
  const entries = worldFiles.flatMap((j) => j.entries ?? []);
  if (!shards.length) return cal;
  cal.src = "world harness";
  cal.shards = shards.length;
  const junk = shards.map((s) => entries.filter((e) => e.seed === s.seed && e.cycle === s.cycle).reduce((a, e) => a + e.junkCr, 0));
  cal.stock = Math.round(junk.reduce((a, b) => a + b, 0) / junk.length);
  const placed = shards.reduce((n, s) => n + s.pool.placed, 0);
  const extracted = shards.reduce((n, s) => n + (s.pool.fate.extracted ?? 0), 0);
  if (placed > 0) cal.placeCapture = +(extracted / placed).toFixed(3);
  const cu = {};
  for (const s of shards) for (const [k, v] of Object.entries(s.corpseUniques ?? {})) cu[k] = (cu[k] ?? 0) + v;
  const fin = (cu.looted ?? 0) + (cu.expired ?? 0) + (cu.left ?? 0);
  if (fin > 0) cal.corpseLoot = +((cu.looted ?? 0) / fin).toFixed(3);
  // Boss events: kills by attempts made while the boss lived vs the v5 single-hunter bands for the same
  // kinds / kits (several hunters on one boss pool their damage: the per-attempt rate goes up).
  let obs = 0, exp = 0, att = 0;
  for (const s of shards) {
    if (!s.bossEvent) continue;
    const killAt = s.boss.killedAtMin < 0 ? Infinity : s.boss.killedAtMin;
    for (const e of entries) {
      if (e.seed !== s.seed || e.cycle !== s.cycle || e.strategy !== "boss") continue;
      if (!(e.attempt ?? e.enterMin < killAt)) continue;
      att++; obs += e.hunt?.killed ? 1 : 0; exp += bossBand(s.bossEvent, e.kit);
    }
  }
  if (exp > 0) { cal.bossMult = +(obs / exp).toFixed(2); cal.bossAttempts = att; cal.bossKills = obs; cal.bossExpected = +exp.toFixed(2); }
  // Human-minutes on the map after a placement at the harness density: the capture reference.
  cal.humanMinRef = +(entries.filter((e) => e.exit === "extract").reduce((a, e) => a + e.onMapMin, 0) / shards.length / 2).toFixed(1);
  cal.harness = worldFiles[0]?.summary ?? null;
  return cal;
}
const WCAL = worldCalibration();
const MAP_STOCK = Number(arg("map-stock", WCAL.stock));
const PLACE_CAPTURE = Number(arg("place-capture", WCAL.placeCapture));
const CORPSE_LOOT = Number(arg("corpse-loot", WCAL.corpseLoot));
const HUMAN_MIN_REF = WCAL.humanMinRef ?? 150;
const BOSS_MULT = Number(arg("boss-mult", WCAL.bossMult ?? 1));
const BAND = new Map();
const bandOf = (kind, kit) => { const k = `${kind}:${kit}`; if (!BAND.has(k)) BAND.set(k, bossBand(kind, kit)); return BAND.get(k); };

// ---------------------------------------------------------------- map (the real generator)
const MAP = generateMap("steppe");
const ELIGIBLE = MAP.containers.filter(poolContainerEligible).length;
const T34 = MAP.containers.filter((c) => c.tier >= 3).length;
const CARRIERS = npcPostsOf(MAP).filter((p) => p.kind !== "road" && npcCarrierEligible(p.tier)).reduce((n, p) => n + p.size[1], 0);

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
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
const logistic = (x) => 1 / (1 + Math.exp(-x));
/** The seeded test hash for bossEventOf (the game server uses an HMAC of its world secret). */
function testHash(label) { let h = 0x811c9dc5 ^ SEED; for (let i = 0; i < label.length; i++) { h ^= label.charCodeAt(i); h = Math.imul(h, 0x01000193); } return h >>> 0; }
/** Hour-of-day weight (UTC = local for the model). */
const hourW = (h) => (h >= 19 && h < 23 ? PEAK : h >= 3 && h < 9 ? NIGHT : 1);
const CYCLE_W = Array.from({ length: CYCLES_PER_DAY }, (_, c) => hourW(Math.floor(((c + 0.5) * CYCLE_MIN) / 60) % 24));
const CYCLE_W_SUM = CYCLE_W.reduce((a, b) => a + b, 0);
const isPeak = (c) => { const h = Math.floor(((c + 0.5) * CYCLE_MIN) / 60) % 24; return h >= 19 && h < 23; };
function pickCycle(uniform) {
  if (uniform) return Math.floor(rnd() * CYCLES_PER_DAY);
  let roll = rnd() * CYCLE_W_SUM;
  for (let c = 0; c < CYCLES_PER_DAY; c++) { roll -= CYCLE_W[c]; if (roll <= 0) return c; }
  return CYCLES_PER_DAY - 1;
}
const entryMinute = () => (chance(0.35) ? OPEN_MIN + rnd() * (5 - OPEN_MIN) : 5 + rnd() * (CLOSE_MIN - 5 - 0.05));

// ---------------------------------------------------------------- items (DB view: k w|a|b, level/rarity, dur %)
const NPC_PRICE_MINOR = { w: [300, 900, 2500, 6000], a: [0, 400, 1100, 2800], b: [0, 300, 900, 2200] };
const SCRAP_CR = { w: [300, 700, 1600, 3500], a: [0, 200, 500, 1200], b: [0, 150, 450, 1100] };
const tierScore = (it) => (it.k === "w" ? (it.r >= 2 ? 2 : it.r >= 1 ? 1 : 0) : it.r === 3 ? 2 : it.r === 2 ? 1 : 0);
/** A pistol (pi) is worth half a weapon of its rarity (the weakest gun, §22). */
const PISTOL_MULT = 0.5;
const refPrice = (it) => Math.round(NPC_PRICE_MINOR[it.k][it.r] * (it.pi ? PISTOL_MULT : 1) * (0.6 + 0.4 * it.dur / 100));
const refCr = (it) => SCRAP_CR[it.k][it.r] * (it.pi ? PISTOL_MULT : 1) * it.dur / 100;
let uid = 0;
const mk = (k, r, dur = 100, lock = 0, bound = false) => ({ id: ++uid, k, r, dur, lock, bound });
const mkPistol = (lock) => Object.assign(mk("w", 0, 100, lock), { pi: true });
const riskUnit = (it) => (!it.bound && it.dur >= (POOL.RISK_MIN_DUR_PCT ?? 0) ? 1 : 0);
function seedPiece(i) {
  const s = i % 3;
  if (s === 0) return rnd() < 0.12 ? mk("w", rnd() < 0.3 ? 3 : 2) : mk("w", rnd() < 0.25 ? 1 : 0);
  if (s === 1) return rnd() < 0.08 ? mk("a", 3) : mk("a", rnd() < 0.2 ? 2 : 1);
  return mk("b", rnd() < 0.15 ? 2 : 1);
}
/** The paid starter kit's uniques: STARTER_KIT.weapons pistols + armor Lv 1 (Lv 2 at its weight), all locked. */
function starterKit() {
  const lock = GIVEAWAY.LOCK_RAIDS;
  return [...STARTER_KIT.weapons.map(() => mkPistol(lock)), mk("a", rnd() < KIT_ARMOR2_P ? 2 : 1, 100, lock)];
}
const boundKit = () => [mk("w", 0, 100, 0, true), mk("a", 1, 100, 0, true), mk("b", 1, 100, 0, true)];
function primaryItem() {
  if (rnd() < 0.1) return pick([mk("w", rnd() < 0.3 ? 3 : 2), mk("a", 3)]);
  const s = Math.floor(rnd() * 3);
  return s === 0 ? mk("w", rnd() < 0.25 ? 1 : 0) : s === 1 ? mk("a", rnd() < 0.2 ? 2 : 1) : mk("b", rnd() < 0.15 ? 2 : 1);
}
const C = CONSUMABLES_CR;
const KIT_CR = { starter: 3 * C.ammo_light.cr + 3 * C.bandage.cr + C.medkit.cr, hunter: 6 * C.ammo_light.cr + 3 * C.bandage.cr + 2 * C.medkit.cr, pistol: 4 * C.ammo_light.cr + 4 * C.bandage.cr + C.medkit.cr, free: 0 };
/** CR-equivalent of the kit's ammo and meds (STARTER_KIT.stacks at CONSUMABLES_CR). */
const KIT_STACK_CR = STARTER_KIT.stacks.reduce((a, s) => a + (C[s.def] ? (s.qty / C[s.def].qty) * C[s.def].cr : 0), 0);

// ---------------------------------------------------------------- scenarios
const MIX = { rat: 0.3, poi: 0.4, boss: 0.15, full: 0.15 };
const ALT_DAY = Number(arg("alt-day", 10));
const ALT_N = Number(arg("alt-n", 300));
const SCEN = {
  base: { scale: 1 },
  lowdau: { dau: 150 },
  highdau: { dau: 3000 },
  altfarm: { scale: 1, alts: { kind: "farm", day: ALT_DAY, n: ALT_N } },
  afkbot: { scale: 1, bots: { kind: "afk", share: 0.05 } },
  tagtour: { scale: 1, bots: { kind: "tag", share: 0.10 } },
  cheaprisk: { scale: 1, alts: { kind: "cheap", day: ALT_DAY, n: ALT_N } },
  crash: { scale: 1, crashDay: 30 },
  noexpiry: { scale: 1, noExpiry: true },
  // 300 alts that each buy the daily cap of kits on their first day and churn them (repeatable-kit abuse check).
  kitfarm: { scale: 1, alts: { kind: "kit", day: ALT_DAY, n: ALT_N } },
};
const arrivalsOf = (day, scale, crashDay) =>
  crashDay !== undefined && day >= crashDay ? Math.round(8 * scale) : Math.round((day === 0 ? 300 : 120 * Math.exp(-day / 25) + 35) * scale);
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

function run(name) {
  const sc = SCEN[name];
  seed = SEED;
  uid = 0;
  const expiryOn = OPTS.expiry && !sc.noExpiry;
  const scale = sc.dau ? sc.dau / meanDau(1) : sc.scale;
  const players = [];
  let nextId = 1;
  let pool = [];
  for (let i = 0; i < 700; i++) { const it = seedPiece(i); it.dur = Math.round(55 + rnd() * 45); pool.push(it); }
  const treasury = { items: [], revenue: 0, revenueToday: 0, taxAcc: 0, primarySold: 0, taxSold: 0, expSold: 0, feeRev: 0, primRev: 0, taxRev: 0, expRev: 0, kitRev: 0, kitsSold: 0, expIn: 0, expInTop: 0 };
  let overhang = [];
  let autosellMult = 1;
  let prevActive = new Set();
  let poolEmptyStreak = 0, poolEmptyMaxStreak = 0;
  let startIdx = null;
  const tot = {
    destroyed: 0, boundDestroyed: 0, released: 0, returned: 0, placed: 0, captured: 0, leftPool: 0, bossKills: 0, bossEvents: 0, bossBag: 0, bossBagTop: 0, bossBagOut: 0,
    deaths: { pvp: 0, npc: 0 }, mia: 0, entries: 0, joins: 0, worldFull: 0, firstFull: 0, gaveUp: 0, kitsBought: 0, kitsFirst: 0, kitsAlt: 0, kitCapHits: 0, boundBp: 0,
    releaseViolations: 0, dailyViolations: 0, corpseLooted: 0, corpseExpired: 0, corpseLeft: 0, expiredUniques: 0,
  };
  const rows = [];
  const entryLog = []; // compact per-entry rows (kpis): [minute bucket, crRaw, kit, kind, extracted, tagCr, onMap, xp]
  const peakHumans = [];
  const allHumans = [];
  const tagTourAll = [];
  const weekly = [];
  let solStart = 0;
  /** Global cycle being run: pool items taken in it carry allocG (D20 untaxed returns, D21 bind rule). */
  let curG = -1;

  function newPlayer(day, kind = null) {
    const r = rnd();
    const type = kind ? "alt" : r < MIX.rat ? "rat" : r < MIX.rat + MIX.poi ? "poi" : r < MIX.rat + MIX.poi + MIX.boss ? "boss" : "full";
    const p = {
      id: nextId++, joined: day, kind, type, life: kind ? 999 : Math.max(2, -Math.log(Math.max(1e-9, rnd())) * 14),
      rate: (kind === "farm" || kind === "cheap" || kind === "kit" ? 6 : kind ? 4 : Math.exp(Math.log(2.2) + 0.6 * (rnd() * 2 - 1))) * (kind ? 1 : SENS.rate),
      cr: 1000, cons: 0, xp: 0, lvl: 1, items: [], sol: kind === "kit" ? KIT_PRICE * KIT_DAILY_MAX * 3 : kind ? 0 : chance(0.6) ? Math.round(rnd() * 3000) : 0, kitDay: -1, kitsToday: 0,
      raids: 0, lastRaid: -99, entries: 0, xpAware: !kind && chance(XP_AWARE), l5At: 0, l10At: 0, dayKey: -1, dayGrind: 0, dayFirst: false, dayPvp: 0, dayReleased: 0, dayXp: 0, weekXp: 0, weekKills: 0, weekNpc: 0,
    };
    solStart += p.sol; p.sol0 = p.sol;
    if (!kind) {
      // Day one: a player who can afford it buys a kit (KIT_BUY_P); the rest drop with the basic gear (or bound CR gear).
      if (chance(KIT_BUY_P) && buyKit(p, day)) tot.kitsFirst++;
    } else if (kind === "cheap") {
      // cheaprisk: one common unique at 50 % durability (a risk unit, tier 0), bought cheap on the market.
      p.items.push(mk("b", 1, 50));
    }
    return p;
  }

  /** Buy one starter kit with SOL (→ treasury); false when unaffordable, paused (--no-kits) or at the daily cap. */
  function buyKit(p, day) {
    if (!OPTS.kits || p.sol < KIT_PRICE) return false;
    if (p.kitDay !== day) { p.kitDay = day; p.kitsToday = 0; }
    if (p.kitsToday >= KIT_DAILY_MAX) { tot.kitCapHits++; return false; }
    p.kitsToday++;
    p.sol -= KIT_PRICE;
    treasury.revenueToday += KIT_PRICE;
    treasury.kitRev += KIT_PRICE; treasury.kitsSold++;
    tot.kitsBought++; if (p.kind) tot.kitsAlt++;
    p.items.push(...starterKit());
    p.cons += KIT_STACK_CR;
    return true;
  }
  const enterPool = (it, broke, taxable = true) => {
    if (it.bound) { tot.boundDestroyed++; return; }
    if (broke) it.dur -= POOL.BREAK_DUR_LOSS;
    if (it.dur <= 0) { tot.destroyed++; return; }
    pool.push(it);
    if (!taxable) return;
    const res = takeTreasuryTax(treasury.taxAcc, [{ uid: String(it.id), value: refCr(it) }]);
    treasury.taxAcc = res.acc;
    if (res.taken.length) { pool.pop(); it.src = "tax"; treasury.items.push(it); }
  };
  const toTreasury = (it) => {
    if (it.bound) { tot.boundDestroyed++; return; }
    it.src = "expire"; treasury.items.push(it); treasury.expIn++; tot.expiredUniques++;
    if (tierScore(it) === 2) treasury.expInTop++;
  };
  const takePool = (n, maxTier, bestFirst) => {
    if (n <= 0) return [];
    const cand = pool.map((it, i) => ({ it, i, s: tierScore(it), r: rnd() })).filter((c) => c.s <= maxTier);
    cand.sort((a, b) => (bestFirst ? b.s - a.s : 0) || a.r - b.r);
    const picked = cand.slice(0, n);
    const out = new Set(picked.map((c) => c.it));
    pool = pool.filter((it) => !out.has(it));
    for (const c of picked) c.it.allocG = curG;
    return picked.map((c) => c.it);
  };
  const dayOf = (p, day, d) => {
    if (p.dayKey === day) return;
    p.dayKey = day; p.dayGrind = 0; p.dayFirst = false; p.dayPvp = 0; p.dayReleased = 0; p.dayXp = 0;
  };

  // ------------------------------------------------------------ one cycle
  function runCycle(day, c, sessions, d) {
    const g = day * CYCLES_PER_DAY + c;
    curG = g;
    const bossKind = bossEventOf(100_000 + g, testHash);
    if (bossKind) { d.bossEvents++; tot.bossEvents++; }
    const boss = { kind: bossKind, alive: !!bossKind, killer: null, killAt: Infinity, bag: [], bagFilled: false };
    const ents = [];
    const onMap = new Set();
    const cyc = new Map(); // player → { entries, maxRisk, maxTier, released }
    let shardReleased = 0;
    const riskUsers = new Set();
    const placedItems = [];
    const corpses = [];
    const carryOut = [];
    // Event queue (small: a sorted array).
    const q = [];
    const push = (ev) => { let i = q.length; while (i > 0 && q[i - 1].t > ev.t) i--; q.splice(i, 0, ev); };
    for (const s of sessions) push({ t: s.t, type: "arrive", p: s.p, first: true, tries: s.tries ?? 0 });
    /** Junk stock left (fraction) at time t: taken = Σ earlier extracts' take × progress. */
    const stockLeft = (t) => {
      let taken = 0;
      for (const e of ents) if (e.exit === "extract" && e.t0 < t) taken += e.take * Math.min(1, (t - e.t0) / Math.max(0.01, e.t1 - e.t0));
      return Math.max(0, 1 - taken / MAP_STOCK);
    };
    const t34Left = (t) => {
      let o = 0;
      for (const e of ents) if (e.t0 < t) o += e.opens34 * Math.min(1, (t - e.t0) / Math.max(0.01, e.t1 - e.t0));
      return Math.exp(-o / T34);
    };
    const targetsAt = (t) => {
      let alive = CARRIERS;
      for (const e of ents) if (e.t0 < t && e.rec) alive -= Math.min(1, (e.rec.killsBy?.marauder ?? 0) * 0.15);
      return Math.max(0, Math.round(ELIGIBLE * t34Left(t) + Math.max(0, alive)));
    };

    function admit(p, t, first, tries) {
      dayOf(p, day, d);
      tot.joins++; d.joins++;
      let cs = cyc.get(p);
      if (!cs) { cs = { entries: 0, maxRisk: 0, maxTier: 0, released: 0 }; cyc.set(p, cs); }
      if (cs.entries >= WORLD.MAX_ENTRIES_PER_CYCLE || t >= CLOSE_MIN) return;
      const humans = [...onMap].filter((e) => e.t1 > t).length;
      if (humans >= WORLD.CAPACITY) {
        tot.worldFull++; d.worldFull++;
        if (first) { tot.firstFull++; if (tries < 2) carryOut.push({ p, tries: tries + 1 }); else tot.gaveUp++; }
        return;
      }
      cs.entries++;
      p.raids++; p.entries++; p.lastRaid = day;
      tot.entries++; d.entries++;
      allHumans.push(humans);
      if (isPeak(c)) peakHumans.push(humans);
      // Loadout (v5 rules): bound shop for a player with no weapon, gear with p 0.75 when CR allow.
      const kind = p.kind;
      const best = (k) => p.items.filter((it) => it.k === k).sort((a, b) => b.r - a.r || b.dur - a.dur)[0];
      // No weapon: rebuy a starter kit with SOL (KIT_REBUY_P), else the bound CR shop, else the basic gear.
      if (!kind && !best("w") && chance(KIT_REBUY_P) && buyKit(p, day)) d.kits++;
      if (kind === "kit" && !best("w")) { if (buyKit(p, day)) d.kits++; }
      if (!kind && !best("w") && OPTS.boundShop) {
        const price = boundKitCr(p.lvl);
        if (p.cr >= price + KIT_CR.starter * 0.5 && chance(0.75)) { p.cr -= price; d.crKitBought += price; p.items.push(...boundKit()); }
      }
      // A kit has no backpack: the outfitter's bound backpack_1 for CR (a CR sink), when affordable.
      if (!kind && best("w") && !best("b") && OPTS.boundShop && p.cr >= offerCr("backpack_1") + KIT_CR.pistol * 0.5 && chance(0.75)) {
        p.cr -= offerCr("backpack_1"); d.crKitBought += offerCr("backpack_1"); tot.boundBp++; p.items.push(mk("b", 1, 100, 0, true));
      }
      const lo = [];
      let kit = "free";
      if (kind === "cheap") {
        const it = p.items[0];
        if (it) { lo.push(it); p.items.splice(0, 1); }
      } else if (!kind || kind === "kit") {
        const w = best("w"), a = best("a");
        const hunter = !!w && !w.pi && !!a && w.r >= 1 && a.r >= 2;
        const pistol = !!w && !!w.pi;
        const kitCr = hunter ? KIT_CR.hunter : pistol ? KIT_CR.pistol : KIT_CR.starter;
        if (!!w && p.cr + p.cons >= kitCr * 0.5 && (kind === "kit" || chance(0.75))) {
          for (const k of ["w", "a", "b"]) { const it = best(k); if (it) { lo.push(it); p.items.splice(p.items.indexOf(it), 1); } }
          // Pistol kit: the second pistol rides in w2 (the bench's "pistol" loadout).
          if (pistol) { const w2 = best("w"); if (w2?.pi) { lo.push(w2); p.items.splice(p.items.indexOf(w2), 1); } }
          const fromStock = Math.min(p.cons, kitCr); p.cons -= fromStock;
          const buy = Math.min(p.cr, kitCr - fromStock); p.cr -= buy; d.consBought += buy;
          d.geared++; p.lastGeared = day;
          kit = hunter ? "hunter" : pistol ? "pistol" : "starter";
        }
      }
      if (kit === "free") d.freeKitRaids++;
      if (kit === "pistol") entryKitCount.pistol++;
      // Record (strategy:kit); boss maps: boss-type entries are attempts.
      let rec, attempt = false, attemptKills = false;
      if (kind === "afk") rec = null;
      else if (kind === "tag") rec = pick(bucket("rat", "free"));
      else if (kind === "farm" || kind === "cheap") rec = pick(bucket("full", "free"));
      else if (kind === "kit") rec = pick(bucket("full", kit));
      else if (p.type === "boss" && boss.kind && boss.alive) {
        // An attempt: kills with the v5 band × the harness group multiplier; the record is drawn to match.
        attempt = true;
        const kills = chance(Math.min(0.95, bandOf(boss.kind, kit) * BOSS_MULT));
        const rs = bossRecords(boss.kind, kit, true);
        const fit = rs.filter((x) => x.bosses.some((b) => b.kind === boss.kind && b.fate === "human") === kills);
        rec = pick(fit.length ? fit : rs);
        attemptKills = kills;
      }
      else if (p.type === "boss" && boss.kind) rec = pick(bossRecords(boss.kind, kit, false));
      else if (p.type === "boss") rec = pick(bossRecords(pick(BOSS_KINDS.filter((k) => BOSSES[k].enabled)), kit, false));
      else rec = pick(bucket(STRAT_OF[p.type], kit));
      const r = stockLeft(t);
      const e = {
        p, kit, lo, t0: t, t1: t, exit: "extract", killedBy: "", rec, r, take: 0, opens34: 0, gain: [], tags: [], kills: [], fights: 0, winner: null,
        risk: lo.reduce((a, it) => a + riskUnit(it), 0), maxTier: 0, pool: [], placeAt: Infinity, ver: 0, kind, attempt, bossKill: false, humans,
        junk: 0, consFound: 0, consOut: 0, containers: 0, mar: 0, grd: 0,
      };
      e.maxTier = lo.filter((it) => riskUnit(it)).reduce((m, it) => Math.max(m, tierScore(it)), 0);
      // Timing and outcome.
      const left = CYCLE_MIN - 0.5 - t;
      if (kind === "afk") { e.exit = "mia"; e.t1 = CYCLE_MIN; }
      else {
        // On-map time: alts churn (out after 8–9 min for the extract XP), taggers search a few minutes, the rest
        // follow their record, cut toward the arm on a stripped map (r), and leave by the last call before the wipe.
        let dur0;
        const alt = kind === "farm" || kind === "cheap" || kind === "kit";
        if (alt) dur0 = Math.min(rec.minutes, 9);
        else if (kind === "tag") dur0 = Math.max(ARM_MIN + 0.2, Math.min(rec.minutes, 6));
        else if (attemptKills) dur0 = Math.max(rec.minutes, (rec.bosses.find((b) => b.kind === boss.kind)?.atMin ?? 0) + 0.5);
        else dur0 = rec.exit === "extract" ? Math.max(ARM_MIN + 0.2, ARM_MIN + 0.2 + (rec.minutes - ARM_MIN - 0.2) * r) : rec.minutes;
        if (p.xpAware && rec.exit === "extract" && dur0 < XP.MIN_ONMAP_MS / MIN) dur0 = XP.MIN_ONMAP_MS / MIN + 0.1;
        const dur = Math.min(dur0, left);
        const trunc = dur / Math.max(0.01, dur0);
        e.t1 = t + dur;
        e.exit = rec.exit === "dead" && trunc >= 1 ? "dead" : "extract";
        if (e.exit === "dead") e.killedBy = "npc";
        if (!kind && chance(MIA_RATE)) { e.exit = "mia"; e.t1 = CYCLE_MIN; }
        const share = (alt ? Math.min(1, dur0 / Math.max(0.01, rec.minutes)) : 1) * trunc;
        e.junk = kind === "tag" ? 0 : rec.haul.junkCr * SENS.junk * r * share;
        e.take = e.junk;
        e.consFound = rec.cons.foundCr * SENS.found * r * share;
        e.consOut = rec.haul.consumables.cr * SENS.found * r * share;
        e.containers = Math.round((rec.containers?.total ?? 0) * r * share);
        e.opens34 = ((rec.containers?.byTier?.T3 ?? 0) + (rec.containers?.byTier?.T4 ?? 0)) * share;
        e.mar = rec.killsBy?.marauder ?? 0;
        e.grd = rec.killsBy?.guard ?? 0;
        d.found += e.consFound; d.used += rec.cons.usedCr;
        d.npcKills += e.mar + e.grd;
      }
      // Boss attempt: the first sampled kill takes the boss.
      if (attempt && rec && boss.alive) {
        const f = rec.bosses.find((b) => b.kind === boss.kind);
        if (attemptKills && e.exit !== "mia") {
          const at = t + Math.max(0.5, f?.atMin ?? 0);
          if (at <= e.t1 && at < boss.killAt) { boss.alive = false; boss.killAt = at; boss.killer = e; e.bossKill = true; }
        }
        d.attempts++;
      }
      // Pool release (raids/enter step 6) with the real rule; the tier match on the user's cycle max tier.
      if (e.risk >= 1) riskUsers.add(p);
      const targets = targetsAt(t);
      const plan = poolReleaseForEntry({
        poolSize: pool.length, entryRisk: e.risk, userCycleMaxRisk: cs.maxRisk, userCycleReleased: cs.released, userDayReleased: p.dayReleased,
        shardReleased, riskUsers: riskUsers.size, atMs: t * MIN, entryCloseMs: CLOSE_MIN * MIN, targets, k: RISK_K,
      });
      cs.maxRisk = Math.max(cs.maxRisk, e.risk);
      cs.maxTier = Math.max(cs.maxTier, e.maxTier);
      e.pool = takePool(plan.n, cs.maxTier, false);
      cs.released += e.pool.length; p.dayReleased += e.pool.length; shardReleased += e.pool.length;
      if (cs.released > Math.round(RISK_K * cs.maxRisk)) tot.releaseViolations++;
      if (p.dayReleased > POOL.USER_DAILY_MAX) tot.dailyViolations++;
      d.released += e.pool.length; tot.released += e.pool.length;
      if (kind === "cheap" || kind === "farm" || kind === "kit") d.altReleased += e.pool.length;
      e.placeAt = t + APPLY_MIN;
      // Boss bag (step 7): once, while the boss lives, gated by the shard's risk and the pool.
      if (boss.kind && !boss.bagFilled && (boss.alive || boss.killAt > t)) {
        let riskSum = 0, anyTop = false;
        for (const [, s] of cyc) { riskSum += s.maxRisk; anyTop ||= s.maxTier === 2; }
        const fp = bossFillPlan({ slots: BOSSES[boss.kind].poolSlots, shardRiskSum: riskSum, anyTopRisk: anyTop, poolSize: pool.length, topInPool: pool.filter((it) => tierScore(it) === 2).length, filled: false });
        if (fp.n > 0) {
          const bestItems = fp.maxTop > 0 ? takePool(Math.min(fp.n, fp.maxTop), 2, true) : [];
          boss.bag = [...bestItems, ...takePool(fp.n - bestItems.length, Math.min(fp.maxTier, 1), true)];
          boss.bagFilled = boss.bag.length > 0;
          tot.bossBag += boss.bag.length; tot.bossBagTop += boss.bag.filter((it) => tierScore(it) === 2).length;
        }
      }
      // PvP: encounters with humans on the map now.
      const others = [...onMap].filter((o) => o.t1 > t);
      const lamType = p.type === "poi" && (rec?.containers?.byTier?.T3 || rec?.containers?.byTier?.T4) ? "t34" : p.type;
      const k = kind === "afk" ? 0 : poisson((PVP.LAMBDA_FULL_LOBBY[lamType] ?? 0.4) * SENS.lambda * others.length / 23);
      for (let i = 0; i < k && others.length; i++) {
        const o = pick(others);
        const te = t + rnd() * Math.max(0.1, Math.min(e.t1, o.t1) - t);
        if (te >= e.t1 || te >= o.t1 || e.exit === "dead" && e.t1 <= te) continue;
        const pa = PVP.POWER[e.kit] + (p.lvl >= 10 ? 0.3 : 0) - (kind === "afk" ? 9 : 0);
        const pb = PVP.POWER[o.kit] + (o.p.lvl >= 10 ? 0.3 : 0) - (o.kind === "afk" ? 9 : 0);
        const eWins = chance(logistic(PVP.K * (pa - pb + gauss() * PVP.SKILL_SD)));
        const [w, l] = eWins ? [e, o] : [o, e];
        w.fights++; l.fights++; d.fights++;
        const lJunk = l.junk * Math.min(1, (te - l.t0) / Math.max(0.01, l.t1 - l.t0));
        w.junk += lJunk * PVP_LOOT_HAUL * PVP.LOOT_IF_EXTRACT; w.take += 0;
        l.exit = "dead"; l.killedBy = "human"; l.winner = w; l.t1 = te; l.junk = 0; l.take = 0; l.ver++;
        w.kills.push({ lvl: l.p.lvl, ageDays: day - l.p.joined });
        if (boss.killer === l && boss.killAt > te) { boss.alive = true; boss.killAt = Infinity; boss.killer = null; l.bossKill = false; }
        if (l === o) push({ t: o.t1, type: "exit", e: o, ver: o.ver });
      }
      ents.push(e);
      onMap.add(e);
      push({ t: e.t1, type: "exit", e, ver: e.ver });
    }

    function exitOf(e) {
      onMap.delete(e);
      // Re-entry (D5).
      const p = e.p;
      const pr = e.kind === "farm" || e.kind === "cheap" || e.kind === "kit" ? 1 : e.kind ? 0 : e.exit === "dead" ? 0.4 : e.exit === "extract" ? 0.2 : 0;
      if (chance(pr)) { const t = e.t1 + 1 + rnd(); if (t < CLOSE_MIN) push({ t, type: "arrive", p, first: false, tries: 0 }); }
    }

    while (q.length) {
      const ev = q.shift();
      if (ev.type === "arrive") admit(ev.p, ev.t, ev.first, ev.tries);
      else if (ev.type === "exit" && ev.ver === ev.e.ver && onMap.has(ev.e)) exitOf(ev.e);
    }
    // ---- settle the cycle (every entry's timing is final now)
    // Pool items: placed at entry + 8 min (or at death), returned on an early extract, else captured / left.
    const extractors = ents.filter((e) => e.exit === "extract");
    const humanMinAfter = (tp) => extractors.reduce((a, e) => a + Math.max(0, e.t1 - Math.max(e.t0, tp)), 0);
    for (const e of ents) {
      for (const it of e.pool) {
        const tp = e.exit === "dead" ? Math.min(e.placeAt, e.t1) : e.placeAt;
        if (e.exit === "extract" && e.t1 < e.placeAt) { tot.returned++; d.returned++; enterPool(it, false, false); continue; }
        if (tp >= CYCLE_MIN || targetsAt(tp) < 1) { tot.leftPool++; enterPool(it, false, false); continue; }
        tot.placed++; d.placed++;
        const hm = humanMinAfter(tp);
        if (hm > 0 && chance(PLACE_CAPTURE * Math.min(1, hm / HUMAN_MIN_REF))) {
          let roll = rnd() * hm;
          let captor = extractors[0];
          for (const x of extractors) { roll -= Math.max(0, x.t1 - Math.max(x.t0, tp)); if (roll <= 0) { captor = x; break; } }
          captor.gain.push(it); tot.captured++; d.captured++;
          if (captor.kind) d.altUniques++;
        } else { tot.leftPool++; enterPool(it, false, false); }
      }
    }
    // Boss: the killer gets the bag if it extracts; otherwise the bag returns to the pool untaxed.
    if (boss.kind && boss.killer) { d.bossKills++; tot.bossKills++; }
    if (boss.bag.length) {
      if (boss.killer && boss.killer.exit === "extract") { boss.killer.gain.push(...boss.bag); tot.bossBagOut += boss.bag.length; }
      else for (const it of boss.bag) enterPool(it, false, false);
    }
    // Bodies (A6): the PvP killer, another human, taggers, else expiry → treasury (or the wipe → pool).
    const taggers = ents.filter((e) => e.kind === "tag" && e.exit === "extract");
    for (const e of ents) {
      if (e.exit !== "dead") continue;
      const items = [];
      for (const it of [...e.lo, ...e.gain]) {
        if (!it.bound && chance(BREAK)) enterPool(it, true, true);
        else items.push(it);
      }
      e.lo = []; e.gain = [];
      const tag = { lvl: e.p.lvl };
      let looter = null, killerLoot = false;
      if (e.winner && e.winner.exit === "extract" && chance(PVP.LOOT_IF_EXTRACT)) { looter = e.winner; killerLoot = true; }
      else if (chance(CORPSE_LOOT)) {
        const cand = extractors.filter((x) => x !== e && x.kind !== "tag" && x.t1 > e.t1 && x.t0 < e.t1 + CORPSE_MIN);
        if (cand.length) looter = pick(cand);
      }
      if (!looter) { const tg = taggers.filter((x) => x.t1 > e.t1 && x.t0 < e.t1 + CORPSE_MIN); if (tg.length && chance(0.6)) looter = pick(tg); }
      if (looter) {
        tot.corpseLooted++;
        looter.tags.push({ lvl: tag.lvl, full: killerLoot });
        looter.gain.push(...items);
      } else if (expiryOn && e.t1 + CORPSE_MIN <= CYCLE_MIN) {
        tot.corpseExpired++;
        for (const it of items) toTreasury(it);
      } else {
        tot.corpseLeft++;
        for (const it of items) enterPool(it, false, true);
      }
      if (e.killedBy === "human") { d.pvpDeaths++; tot.deaths.pvp++; } else { d.npcDeaths++; tot.deaths.npc++; }
    }
    // Outcomes per entry.
    for (const e of ents) {
      const p = e.p;
      // Ranked PvP (D24 review): victims level ≥ 5, account ≥ 72 h; paid ≤ PVP_DAILY_MAX a day.
      const ranked = e.kills.filter((k) => k.lvl >= XP.PVP_VICTIM_MIN_LEVEL && k.ageDays * 86_400_000 >= XP.PVP_VICTIM_MIN_AGE_MS).length;
      const paidPvp = Math.max(0, Math.min(ranked, XP.PVP_DAILY_MAX - p.dayPvp));
      p.dayPvp += paidPvp;
      p.weekKills += ranked;
      const exitType = e.exit;
      const onMapMs = (e.t1 - e.t0) * MIN;
      const freeKit = e.lo.length === 0 || e.kit === "free";
      const junkPaid = exitType === "extract" ? e.junk * (freeKit ? FREE_KIT_AUTOSELL : 1) : 0;
      const tagCr = exitType === "extract" ? e.tags.reduce((a, tg) => a + dogTagCr(tg.lvl) * (tg.full ? 1 : DOG_TAG.NON_KILLER_MULT), 0) : 0;
      const xp = e.kind === "afk" ? { total: 0, grind: 0 } : xpForExit({
        exit: exitType, onMapMs, haulCr: Math.round(junkPaid * autosellMult), containers: e.containers, marauders: e.mar, guards: e.grd,
        bosses: e.bossKill ? 1 : 0, rankedPvp: paidPvp, grindToday: p.dayGrind, firstExtractToday: !p.dayFirst,
      });
      p.dayGrind += xp.grind;
      if (exitType === "extract" && onMapMs >= XP.MIN_ONMAP_MS) p.dayFirst = true;
      p.xp += xp.total; p.dayXp += xp.total; p.weekXp += xp.total; p.weekNpc += e.mar + e.grd + (e.bossKill ? 1 : 0);
      const lvl0 = p.lvl;
      p.lvl = levelForXp(p.xp);
      if (lvl0 < 5 && p.lvl >= 5 && !p.l5At) p.l5At = p.entries;
      if (lvl0 < 10 && p.lvl >= 10 && !p.l10At) p.l10At = p.entries;
      d.used += e.fights * PVP.FIGHT_CONS_CR;
      const crRaw = junkPaid + tagCr;
      entryLog.push([Math.floor(e.t0 / 5) * 5, Math.round(crRaw), e.kit, e.kind ?? p.type, exitType === "extract" ? 1 : 0, Math.round(tagCr), +(onMapMs / MIN).toFixed(1), xp.total]);
      if (exitType === "extract") {
        d.extracts++;
        const cr = Math.round((junkPaid + tagCr) * autosellMult);
        p.cr += cr; d.junkCr += cr; d.tagCr += Math.round(tagCr * autosellMult);
        if (e.kind === "farm" || e.kind === "cheap" || e.kind === "kit") { d.altCr += cr; d.altRaids++; }
        if (e.kind === "tag") tagTourAll.push(Math.round(tagCr));
        p.cons += Math.max(0, e.consOut - e.fights * PVP.FIGHT_CONS_CR);
        d.foundExt += e.consFound;
        for (const it of e.lo) {
          if (it.k === "a") it.dur -= 10 + rnd() * 35; else if (it.k === "w") it.dur -= 2 + rnd() * 4; else it.dur -= 1 + rnd() * 3;
          if (it.lock > 0) it.lock--;
          if (it.dur <= 0) tot.destroyed++; else p.items.push(it);
        }
        // D21: a pool unique (allocated in this cycle) extracted by a risk-free entry arrives bound.
        const riskFree = e.risk === 0;
        for (const it of e.gain) { if (riskFree && it.allocG === g) it.bound = true; p.items.push(it); if (e.kind && !it.bound) d.altTradable++; }
      } else if (exitType === "mia") {
        tot.mia++; d.mia++;
        for (const it of [...e.lo, ...e.gain]) enterPool(it, false, true);
        if (e.kind === "afk") d.botXp.push(0);
      }
      if (e.kind === "farm" || e.kind === "cheap" || e.kind === "kit") d.altEntries++;
    }
    return carryOut;
  }

  const entryKitCount = { pistol: 0 };
  for (let day = 0; day < DAYS; day++) {
    treasury.revenueToday = 0;
    const kitSold0 = treasury.kitsSold, kitRev0 = treasury.kitRev;
    const arrivals = arrivalsOf(day, scale, sc.crashDay);
    for (let i = 0; i < arrivals; i++) players.push(newPlayer(day));
    if (sc.alts && day === sc.alts.day) for (let i = 0; i < sc.alts.n; i++) players.push(newPlayer(day, sc.alts.kind));
    if (sc.bots && day === 0) {
      // afkbot / tagtour: accounts sized so their entries are `share` of all entries (≈ 1.3 entries per human session).
      const n = Math.round((sc.bots.share / (1 - sc.bots.share)) * meanDau(scale) * 2.2 * 1.3 / 4);
      for (let i = 0; i < n; i++) players.push(newPlayer(day, sc.bots.kind));
    }
    const crashMul = sc.crashDay !== undefined && day >= sc.crashDay ? 0.6 : 1;
    const active = players.filter((p) => day - p.joined < p.life * crashMul);
    const activeSet = new Set(active);
    for (const p of prevActive) if (!activeSet.has(p) && !p.kind && p.lvl >= MARKET.SELL_UNLOCK_LEVEL && chance(0.35)) {
      const keep = []; for (const it of p.items) { if (it.lock > 0 || it.bound) keep.push(it); else overhang.push({ it, s: p }); } p.items = keep;
    }
    prevActive = activeSet;
    const humansActive = active.filter((p) => !p.kind);
    const dau = humansActive.length;
    // Sessions (first entries) → cycles by the hour profile; one session per player per cycle.
    const byCycle = Array.from({ length: CYCLES_PER_DAY }, () => []);
    for (const p of active) {
      const n = poisson(p.rate);
      const used = new Set();
      for (let i = 0; i < n; i++) {
        let c = pickCycle(!!p.kind);
        for (let k = 0; k < 4 && used.has(c); k++) c = pickCycle(!!p.kind);
        if (used.has(c)) continue;
        used.add(c);
        byCycle[c].push({ p, t: p.kind === "tag" ? 25 + rnd() * (CLOSE_MIN - 25 - 0.1) : entryMinute() });
      }
    }
    const d = {
      entries: 0, joins: 0, worldFull: 0, junkCr: 0, tagCr: 0, consBought: 0, listFees: 0, found: 0, used: 0, extracts: 0, released: 0, returned: 0, placed: 0, captured: 0,
      bossKills: 0, bossEvents: 0, attempts: 0, geared: 0, altCr: 0, altRaids: 0, altEntries: 0, altReleased: 0, altUniques: 0, altTradable: 0, pvpDeaths: 0, npcDeaths: 0, mia: 0,
      fights: 0, npcKills: 0, crKitBought: 0, foundExt: 0, freeKitRaids: 0, p2p: 0, botXp: [], kits: 0,
    };
    let carry = [];
    for (let c = 0; c < CYCLES_PER_DAY; c++) {
      const sessions = [...byCycle[c], ...carry.map((x) => ({ p: x.p, t: OPEN_MIN + rnd() * 4, tries: x.tries }))];
      carry = runCycle(day, c, sessions, d);
    }
    tot.gaveUp += carry.length;
    // Daily XP (alts / bots) and week boundaries.
    const altXp = active.filter((p) => (p.kind === "farm" || p.kind === "cheap" || p.kind === "kit") && p.lastRaid === day).map((p) => p.dayXp);
    const botXp = active.filter((p) => p.kind === "afk" && p.lastRaid === day).map((p) => p.dayXp);
    const humanXp = humansActive.filter((p) => p.lastRaid === day).map((p) => p.dayXp);
    if (day % 7 === 6) {
      const hs = players.filter((p) => !p.kind);
      const all = players.filter((p) => p.weekKills > 0 || p.weekNpc > 0);
      weekly.push({
        week: (day + 1) / 7, topKills: pctl(all.map((p) => p.weekKills), 0.999), topNpc: pctl(all.map((p) => p.weekNpc), 0.999),
        top10Kills: [...all].sort((a, b) => b.weekKills - a.weekKills).slice(0, 10).map((p) => `${p.kind ?? p.type}:${p.weekKills}`).join(" "),
        top10Npc: [...all].sort((a, b) => b.weekNpc - a.weekNpc).slice(0, 10).map((p) => `${p.kind ?? p.type}:${p.weekNpc}`).join(" "),
        topLevel: [...players].sort((a, b) => b.xp - a.xp).slice(0, 10).map((p) => `${p.kind ?? p.type}:L${p.lvl}`).join(" "),
        humansL5: hs.filter((p) => p.lvl >= 5).length,
      });
      for (const p of players) { p.weekKills = 0; p.weekNpc = 0; p.weekXp = 0; }
    }

    // Market (opens day 3), an order book (v5 model, unchanged): treasury lots (tax + A6 expiry) ask max(ref, ref × idx).
    const tradable = active.reduce((a, p) => a + (p.kind ? 0 : p.items.filter((i) => !i.bound).length), 0);
    const perActive = tradable / Math.max(1, dau);
    const priceIdx = Math.pow(2 / Math.max(0.3, perActive), 0.8);
    let trades = 0, primary = 0;
    if (day >= 3) {
      if (startIdx === null) startIdx = priceIdx;
      const book = [];
      for (const it of treasury.items) book.push({ it, s: null, price: Math.round(refPrice(it) * Math.max(1, priceIdx)) });
      for (const o of overhang) book.push({ it: o.it, s: o.s, dump: true, price: Math.max(1, Math.round(refPrice(o.it) * priceIdx * 0.9)) });
      for (const sl of active) {
        if (sl.kind || sl.lvl < MARKET.SELL_UNLOCK_LEVEL) continue;
        for (const k of ["w", "a", "b"]) {
          const mine = sl.items.filter((i) => i.k === k).sort((x, y) => y.r - x.r || y.dur - x.dur);
          for (const it of mine.slice(1)) {
            if (it.bound || it.lock > 0 || !chance(MARKET_LIST_P)) continue;
            book.push({ it, s: sl, price: Math.max(1, Math.round(refPrice(it) * priceIdx * (0.9 + 0.2 * rnd()))) });
          }
        }
      }
      book.sort((x, y) => x.price - y.price);
      for (const b of shuffle(active.filter((p) => !p.kind && p.sol > 0))) {
        if (!chance(MARKET_BUY_P)) continue;
        const bestR = (k) => b.items.reduce((m, i) => (i.k === k && i.r > m ? i.r : m), -1);
        const l = book.find((x) => !x.sold && x.s !== b && x.it.r > bestR(x.it.k) && x.price <= b.sol);
        if (!l) continue;
        if (l.s && !l.dump) {
          const cr = MARKET.LISTING_FEE_CR[Math.min(3, l.it.r)];
          if (l.s.cr < cr) continue;
          l.s.cr -= cr; d.listFees += cr;
        }
        l.sold = true;
        b.sol -= l.price;
        if (l.s) {
          const fee = Math.ceil(l.price * MARKET.FEE_BPS / 10_000);
          l.s.sol += l.price - fee;
          l.s.solEarned = (l.s.solEarned ?? 0) + l.price - fee;
          treasury.revenueToday += fee; treasury.feeRev += fee; d.p2p++;
          if (!l.dump) l.s.items.splice(l.s.items.indexOf(l.it), 1);
        } else {
          treasury.revenueToday += l.price;
          if (l.it.src === "expire") { treasury.expRev += l.price; treasury.expSold++; } else { treasury.taxRev += l.price; treasury.taxSold++; }
        }
        b.items.push(l.it); trades++;
      }
      const soldSet = new Set(book.filter((x) => x.sold).map((x) => x.it));
      treasury.items = treasury.items.filter((it) => !soldSet.has(it));
      overhang = overhang.filter((o) => !soldSet.has(o.it));
      if (OPTS.primary && day >= Number(arg("prim-day", 14)) && perActive < (arg("prim-target") !== undefined ? 99 : 2.5)) {
        const rich = active.filter((p) => !p.kind && p.sol > 500);
        const T = arg("prim-target"); const n = T !== undefined ? Math.min(rich.length, Math.max(0, Math.round((Number(T) * dau - tradable) / 7)), Math.round(dau * 0.15)) : Math.min(rich.length, Math.round(dau * PRIMARY_SHARE));
        for (let i = 0; i < n; i++) {
          const b = pick(rich); const it = primaryItem(); const price = Math.round(refPrice(it) * (flag("prim-fixed") ? Number(arg("prim-mult", 1)) : Math.max(1, priceIdx)));
          if (b.sol < price) continue;
          b.sol -= price; b.items.push(it); treasury.revenueToday += price; treasury.primRev += price; primary++;
        }
        treasury.primarySold += primary;
      }
    }
    treasury.revenue += treasury.revenueToday;
    const vets = active.filter((p) => !p.kind && day - p.joined >= 7 && day - p.lastRaid <= 7 && p.lastGeared !== undefined && day - p.lastGeared <= 7).map((p) => p.cr);
    const vetMed = med(vets);
    if (OPTS.regulator) autosellMult = nextAutosellMult(autosellMult, vetMed, vets.length);
    poolEmptyStreak = pool.length === 0 ? poolEmptyStreak + 1 : 0;
    poolEmptyMaxStreak = Math.max(poolEmptyMaxStreak, poolEmptyStreak);
    const crs = humansActive.map((p) => p.cr);
    const deaths = d.pvpDeaths + d.npcDeaths;
    const sink = d.consBought + d.listFees + d.crKitBought;
    rows.push({
      day, dau, entries: d.entries, joins: d.joins, worldFull: +(d.worldFull / Math.max(1, d.joins)).toFixed(3), mia: +(d.mia / Math.max(1, d.entries)).toFixed(3),
      geared: +(d.geared / Math.max(1, d.entries)).toFixed(2), ext: +(d.extracts / Math.max(1, d.entries)).toFixed(2),
      itemsPerActive: +perActive.toFixed(2), priceIdx: +priceIdx.toFixed(2), priceVsStart: startIdx ? +(priceIdx / startIdx).toFixed(2) : null,
      revenue: treasury.revenueToday, trades, p2p: d.p2p, primary, pool: pool.length, poolTop: pool.filter((i) => tierScore(i) === 2).length,
      released: d.released, returned: d.returned, placed: d.placed, captured: d.captured, bossEvents: d.bossEvents, bossKills: d.bossKills, attempts: d.attempts,
      crMed: Math.round(med(crs)), crP99: Math.round(pctl(crs, 0.99)), vetMed: Math.round(vetMed), mult: +autosellMult.toFixed(2),
      faucet: d.junkCr, tags: d.tagCr, sink, faucetSink: +(d.junkCr / Math.max(1, sink)).toFixed(2),
      consFound: Math.round(d.found), consUsed: Math.round(d.used), foundUsed: +(d.found / Math.max(1, d.used)).toFixed(2), consBought: d.consBought,
      foundUsedExt: +(d.foundExt / Math.max(1, d.used)).toFixed(2), freeKitShare: +(d.freeKitRaids / Math.max(1, d.entries)).toFixed(2),
      pvpDeaths: d.pvpDeaths, npcDeaths: d.npcDeaths, pvpShare: +(d.pvpDeaths / Math.max(1, deaths)).toFixed(2), fights: d.fights, npcKills: d.npcKills,
      crKitBought: d.crKitBought, altCr: d.altCr, altEntries: d.altEntries, altCrPerEntry: d.altRaids ? Math.round(d.altCr / d.altRaids) : 0, altReleased: d.altReleased,
      altUniques: d.altUniques, altTradable: d.altTradable, altXpMed: med(altXp), altXpMax: pctl(altXp, 1), botXpMax: pctl(botXp, 1), humanXpMed: med(humanXp),
      treasuryItems: treasury.items.length, expIn: treasury.expIn,
      kits: treasury.kitsSold - kitSold0, kitRev: treasury.kitRev - kitRev0, pistolShare: +(entryKitCount.pistol / Math.max(1, d.entries)).toFixed(2),
      altSolSpent: active.filter((p) => p.kind === "kit").reduce((a, p) => a + (p.sol0 - p.sol), 0),
      altItemValue: active.filter((p) => p.kind === "kit").reduce((a, p) => a + p.items.filter((i) => !i.bound).reduce((b, i) => b + refPrice(i), 0), 0),
    });
    entryKitCount.pistol = 0;
  }
  const solNow = players.reduce((a, p) => a + p.sol, 0) + treasury.revenue;
  if (arg("dump-players")) writeFileSync(arg("dump-players"), JSON.stringify(players.filter((p) => !p.kind).map((p) => ({ type: p.type, sol0: p.sol0, sol: p.sol, entries: p.entries, lvl: p.lvl, items: p.items.filter((i) => !i.bound).map((i) => refPrice(i)), life: p.life, earned: p.solEarned ?? 0 }))));
  const humansAll = players.filter((p) => !p.kind);
  return {
    name, scale: +scale.toFixed(3), rows, tot, weekly,
    treasury: { revenue: treasury.revenue, feeRev: treasury.feeRev, primRev: treasury.primRev, taxRev: treasury.taxRev, expRev: treasury.expRev, kitRev: treasury.kitRev, kitsSold: treasury.kitsSold, primarySold: treasury.primarySold, taxSold: treasury.taxSold, expSold: treasury.expSold, expIn: treasury.expIn, expInTop: treasury.expInTop },
    solConserved: solNow === solStart, poolEmptyMaxStreak,
    kpi: kpis(rows, entryLog, peakHumans, allHumans, humansAll, players, tot, treasury, tagTourAll),
  };
}

/** The §8.5 numbers of one run. */
function kpis(rows, log, peakHumans, allHumans, humans, players, tot, treasury, tagTour) {
  const from14 = rows.filter((x) => x.day >= 14);
  const m = (f, rs = from14) => +mean(rs.map(f)).toFixed(3);
  const cr = (filter) => { const xs = log.filter(filter).map((x) => x[1]); return { n: xs.length, mean: Math.round(mean(xs)), median: med(xs) }; };
  const ord = (x) => !["farm", "cheap", "afk", "tag"].includes(x[3]);
  const early = cr((x) => ord(x) && x[0] < 5);
  const late = cr((x) => ord(x) && x[0] >= 25);
  const earlyGeared = cr((x) => ord(x) && x[0] < 5 && x[2] !== "free");
  const lateGeared = cr((x) => ord(x) && x[0] >= 25 && x[2] !== "free");
  const curve = Object.fromEntries([0, 5, 10, 15, 20, 25, 30].map((b) => [b, Math.round(mean(log.filter((x) => ord(x) && x[0] === b).map((x) => x[1])))]));
  const xpPerEntry = Math.round(mean(log.filter(ord).map((x) => x[7])));
  const tagFree = log.filter((x) => x[2] === "free" && x[0] >= 25 && ord(x) && x[4]).map((x) => x[5]);
  const l5 = humans.filter((p) => p.l5At > 0).map((p) => p.l5At);
  const l10 = humans.filter((p) => p.l10At > 0).map((p) => p.l10At);
  // Kaplan–Meier median: a player who never reached the level is censored at their entry count.
  const km = (key) => {
    const obs = humans.filter((p) => p.entries > 0).map((p) => (p[key] > 0 ? [p[key], 1] : [p.entries, 0])).sort((a, b) => a[0] - b[0]);
    let atRisk = obs.length, S = 1;
    for (let i = 0; i < obs.length;) {
      const n = obs[i][0];
      let dth = 0, all = 0;
      while (i < obs.length && obs[i][0] === n) { dth += obs[i][1]; all++; i++; }
      if (dth) { S *= 1 - dth / atRisk; if (S <= 0.5) return n; }
      atRisk -= all;
    }
    return null;
  };
  const byType = {};
  for (const t of ["rat", "poi", "boss", "full"]) { const xs = log.filter((x) => x[3] === t).map((x) => x[7]); byType[t] = Math.round(mean(xs)); }
  const lv = {};
  for (const p of humans) { const b = p.lvl >= 15 ? "15+" : p.lvl >= 10 ? "10-14" : p.lvl >= 5 ? "5-9" : "1-4"; lv[b] = (lv[b] ?? 0) + 1; }
  return {
    crEarly: early, crLate: late, crEarlyGeared: earlyGeared, crLateGeared: lateGeared, lateShare: early.mean ? +(late.mean / early.mean).toFixed(3) : 0, curve,
    faucetSink14: m((x) => x.faucetSink), itemsPerActive14: m((x) => x.itemsPerActive), itemsPerActiveEnd: rows.at(-1)?.itemsPerActive,
    poolMin: Math.min(...rows.map((x) => x.pool)), poolEnd: rows.at(-1)?.pool, poolMax: Math.max(...rows.map((x) => x.pool)), poolTopMin: Math.min(...rows.map((x) => x.poolTop)), poolTopEnd: rows.at(-1)?.poolTop,
    releaseViolations: tot.releaseViolations, dailyViolations: tot.dailyViolations,
    tagFreeLateMedian: med(tagFree), tagFreeLateN: tagFree.length, tagTourMedian: med(tagTour), tagTourMean: Math.round(mean(tagTour)), tagTourN: tagTour.length,
    altXpMed: med(rows.filter((x) => x.altEntries > 0).map((x) => x.altXpMed)), altXpMax: Math.max(0, ...rows.map((x) => x.altXpMax)), botXpMax: Math.max(0, ...rows.map((x) => x.botXpMax)),
    humanXpPerPlayDay: med(rows.filter((x) => x.day >= 14).map((x) => x.humanXpMed)),
    entriesToL5: { median: med(l5), n: l5.length, of: humans.length, km: km("l5At") }, entriesToL10: { median: med(l10), n: l10.length, km: km("l10At") }, levels: lv, xpPerEntry, xpPerEntryByType: byType,
    mia: +(tot.mia / Math.max(1, tot.entries)).toFixed(3), worldFull: +(tot.worldFull / Math.max(1, tot.joins)).toFixed(4), firstFull: tot.firstFull, gaveUp: tot.gaveUp,
    medHumansPeak: med(peakHumans), medHumansAll: med(allHumans), foundUsed14: m((x) => x.foundUsed), pvpShare14: m((x) => x.pvpShare),
    entriesPerDay14: Math.round(m((x) => x.entries)), dau14: Math.round(m((x) => x.dau)),
    bossKillRate: tot.bossEvents ? +(tot.bossKills / tot.bossEvents).toFixed(3) : 0, attemptsPerEvent: tot.bossEvents ? +(rows.reduce((a, x) => a + x.attempts, 0) / tot.bossEvents).toFixed(2) : 0,
    expiredPerDay: +(treasury.expIn / DAYS).toFixed(2), expiredTopPerDay: +(treasury.expInTop / DAYS).toFixed(2), expRevPerDay: Math.round(treasury.expRev / DAYS),
    releasedPerDay: Math.round(tot.released / DAYS), capturedPerDay: Math.round(tot.captured / DAYS), returnedPerDay: Math.round(tot.returned / DAYS),
    kitsPerDay14: +m((x) => x.kits).toFixed(1), kitsPerDau14: +m((x) => x.kits / Math.max(1, x.dau)).toFixed(3), kitRevShare: +(treasury.kitRev / Math.max(1, treasury.revenue)).toFixed(3),
    revenuePerDay14: Math.round(m((x) => x.revenue)), pistolEntryShare14: m((x) => x.pistolShare), freeEntryShare14: m((x) => x.freeKitShare), crPerDauDay14: Math.round(m((x) => (x.faucet + x.tags) / Math.max(1, x.dau))),
    kitfarmEnd: rows.at(-1)?.altSolSpent ? { solSpent: rows.at(-1).altSolSpent, tradableRefValue: rows.at(-1).altItemValue } : null,
  };
}

// ---------------------------------------------------------------- report
const scen = arg("scenario", "all");
const names = scen === "all" ? Object.keys(SCEN) : scen.split(",");
for (const n of names) if (!SCEN[n]) throw new Error(`--scenario: unknown ${n} (one of ${Object.keys(SCEN).join("|")}|all)`);
const results = names.map(run);
console.log(`data ${DATA} (${files.length} files; PvE buckets ${[...PVE].map(([k, v]) => `${k}:${v.length}`).join(" ")}; lobby records ${LOBBY.length}); K ${RISK_K}; ` +
  `world calibration ${WCAL.src} (${WCAL.shards} shards): map stock ${MAP_STOCK} CR, place capture ${PLACE_CAPTURE}, corpse loot ${CORPSE_LOOT}, human-min ref ${HUMAN_MIN_REF}, ` +
  `boss group mult ${BOSS_MULT} (${WCAL.bossKills ?? "-"} kills / ${WCAL.bossExpected ?? "-"} expected from ${WCAL.bossAttempts ?? "-"} attempts); ` +
  `MIA ${MIA_RATE}; expiry ${OPTS.expiry}; xp-aware ${OPTS.xpAware}; peak ×${PEAK} night ×${NIGHT}; capacity ${WORLD.CAPACITY}; ` +
  `primary ${OPTS.primary}; starter kit ${OPTS.kits ? `${KIT_PRICE} units (${SIM_PER_MINOR}/minor), ≤ ${KIT_DAILY_MAX}/day, buy ${KIT_BUY_P} rebuy ${KIT_REBUY_P}` : "off"}; bound shop ${OPTS.boundShop ? `on (${boundKitCr(1)} / ${boundKitCr(5)} CR)` : "off"}; free-kit autosell ×${FREE_KIT_AUTOSELL}; ` +
  `regulator ${OPTS.regulator}; PvP ${PVP_SOURCE} ${JSON.stringify(PVP.LAMBDA_FULL_LOBBY)}${SET ? `; --set ${JSON.stringify(SET)}` : ""}`);
const pickDays = [6, 13, 29, 59, DAYS - 1].filter((x, i, a) => x < DAYS && a.indexOf(x) === i);
for (const r of results) {
  console.log(`\n=== ${r.name} (arrival scale ${r.scale}) ===`);
  console.table(r.rows.filter((x) => pickDays.includes(x.day)).map((x) => ({
    d: x.day + 1, dau: x.dau, ent: x.entries, full: x.worldFull, mia: x.mia, "it/act": x.itemsPerActive, pIdx: x.priceIdx, rev: x.revenue,
    pool: x.pool, top: x.poolTop, rel: x.released, "ret/plc/cap": `${x.returned}/${x.placed}/${x.captured}`, boss: `${x.bossKills}/${x.bossEvents}`, crMed: x.crMed, mult: x.mult,
    "f/s": x.faucetSink, "cons f/u": x.foundUsed, pvp: x.pvpShare, tre: x.treasuryItems, kits: x.kits, ...(x.altEntries ? { "alt CR/e": x.altCrPerEntry, "alt XP": x.altXpMed } : {}),
  })));
  console.log(`kpi ${JSON.stringify(r.kpi)}`);
  console.log(`SOL conserved (no game payout) ${r.solConserved}; pool max empty streak ${r.poolEmptyMaxStreak}; treasury ${JSON.stringify(r.treasury)}; totals ${JSON.stringify(r.tot)}`);
  console.log(`weekly boards ${JSON.stringify(r.weekly.slice(-2))}`);
}
const jsonOut = arg("json");
if (jsonOut) writeFileSync(jsonOut, JSON.stringify({ data: DATA, k: RISK_K, opts: OPTS, wcal: WCAL, mapStock: MAP_STOCK, placeCapture: PLACE_CAPTURE, corpseLoot: CORPSE_LOOT, set: SET, pvp: PVP, pvpCalibration: PVP_CAL, results }, null, 1));
const csvDir = arg("csv");
if (csvDir) {
  mkdirSync(csvDir, { recursive: true });
  for (const r of results) {
    const cols = Object.keys(r.rows[0] ?? {});
    writeFileSync(join(csvDir, `econ-${r.name}.csv`), [cols.join(","), ...r.rows.map((x) => cols.map((c) => x[c] ?? "").join(","))].join("\n") + "\n");
  }
  console.log(`wrote per-day CSVs to ${csvDir}`);
}
