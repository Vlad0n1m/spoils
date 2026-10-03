// Economy population simulation (LOOT ECONOMY v4): N players over D days, fed by the loot-yield
// harness (apps/game-server/src/sim/econ/loot-yield.bench.ts) per-strategy raid records.
//
//   pnpm shared:build   # the sim imports the real rules from packages/shared/dist
//   node scripts/econ/econ-sim.mjs --data <harness out dir> [--scenario base|ratheavy|botfarm|lowdau|highdau|crash|all]
//        [--days 90] [--seed 7] [--json out.json] [--no-primary] [--no-giveaway-cap] [--no-regulator] [--k 1.0]
//
// What comes from where:
// - per raid: a harness record sampled for (strategy, kit, boss target, boss spawned?) gives survival,
//   junk CR (autosell × the daily multiplier), consumables found / used / extracted, boss kill;
// - per match: the lost pool is modelled explicitly: poolReleasePlanV4(P, R = Σ risk units, B = Σ slots of
//   the bosses rolled from BOSSES[k].spawnChance) — bosses first (top tier score first), the rest random to
//   T3/T4 containers. Boss items are captured only by a hunter whose sampled record killed that boss and
//   survived; container items by a human with the harness capture rate q (R = 24 runs) of its strategy;
//   everything else (bots, unlooted, leftOnMap) returns to the pool with no wear (as the server reports it);
// - deaths: BREAK_CHANCE_ON_DEATH 0.5 → pool with −POOL.BREAK_DUR_LOSS, else the body: a human killer
//   (lobby-size dependent share) who extracts takes it, otherwise leftOnMap → pool, no wear;
// - treasury: 1% tax (takeTreasuryTax), tax items and primary batches sold on the market, 5% P2P fee.
//   The game NEVER pays SOL: the only money moves are buyer → seller (−fee) and buyer → house.
// - CR: faucet = junk autosell; sinks = junker consumables (CONSUMABLES_CR) + CR listing fees; daily
//   regulator nextAutosellMult on the veterans' median.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const shared = await import(resolve(here, "../../packages/shared/dist/index.js"));
const { BOSSES, BOSS_KINDS, CONSUMABLES_CR, MARKET, POOL, AUTOSELL, GIVEAWAY, PROGRESSION, nextAutosellMult, levelForXp, takeTreasuryTax } = shared;
const BREAK = shared.BREAK_CHANCE_ON_DEATH ?? 0.5;

// ---------------------------------------------------------------- CLI
const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
const flag = (n) => argv.includes(`--${n}`);
const DATA = resolve(arg("data", "/tmp/extract-econ"));
const DAYS = Number(arg("days", 90));
const SEED = Number(arg("seed", 7));
const RISK_K = Number(arg("k", POOL.RISK_K));
const OPTS = { primary: !flag("no-primary"), giveawayCap: !flag("no-giveaway-cap"), regulator: !flag("no-regulator") };

// ---------------------------------------------------------------- harness data
function load(name) {
  const f = join(DATA, `yield-${name}.json`);
  if (!existsSync(f)) return null;
  return JSON.parse(readFileSync(f, "utf8")).records;
}
function need(name) {
  const r = load(name);
  if (!r || r.length === 0) throw new Error(`missing harness output yield-${name}.json in ${DATA}`);
  return r;
}
const REC = {
  "rat:starter": need("rat"),
  "rat:free": need("rat-free"),
  "poi:starter": need("poi"),
  "poi:free": need("poi-free"),
};
for (const k of BOSS_KINDS) {
  REC[`boss:${k}:starter`] = need(`boss-${k}`);
  REC[`boss:${k}:free`] = load(`boss-free-${k}`) ?? REC[`boss:${k}:starter`];
}
/** Records of a bucket stratified by whether boss `kind` spawned in them. */
function stratum(bucket, kind, spawned) {
  const all = REC[bucket];
  const s = all.filter((r) => r.bosses.some((b) => b.kind === kind) === spawned);
  return s.length ? s : all;
}
/** Per released container unique: chance a human of this strategy extracts it (harness R = 24 runs). */
function captureRate(names) {
  let got = 0, rel = 0, surv = 0, n = 0;
  for (const nm of names) {
    for (const r of load(nm) ?? []) {
      got += r.gained.filter((u) => u.origin === "pool").length;
      rel += r.pool.container;
      surv += r.survived ? 1 : 0;
      n++;
    }
  }
  const q = rel > 0 ? got / rel : 0;
  return { q, surv: n ? surv / n : 1, qGivenSurvived: n && surv ? q / (surv / n) : 0, got, rel };
}
const Q = {
  rat: captureRate(["rat-r24"]),
  poi: captureRate(["poi-r24"]),
  boss: captureRate(["boss-foreman-r24", "boss-commander-r24"]),
};

// ---------------------------------------------------------------- rng
let seed = SEED;
function rnd() { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }
const chance = (p) => rnd() < p;
const pick = (a) => a[Math.floor(rnd() * a.length)];
function poisson(l) { const L = Math.exp(-l); let k = 0, p = 1; do { k++; p *= rnd(); } while (p > L); return k - 1; }
function shuffle(a) { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }
const med = (a) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const pctl = (a, q) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(s.length * q))]; };

// ---------------------------------------------------------------- items (DB view: k w|a|b, level/rarity, dur %)
const NPC_PRICE_MINOR = { w: [300, 900, 2500, 6000], a: [0, 400, 1100, 2800], b: [0, 300, 900, 2200] };
const SCRAP_CR = { w: [300, 700, 1600, 3500], a: [0, 200, 500, 1200], b: [0, 150, 450, 1100] };
/** uniqueTierScore: weapon r>=2 / armor_3 / backpack_3 = 2; weapon r1 / level 2 = 1. */
const tierScore = (it) => (it.k === "w" ? (it.r >= 2 ? 2 : it.r >= 1 ? 1 : 0) : it.r === 3 ? 2 : it.r === 2 ? 1 : 0);
const refPrice = (it) => Math.round(NPC_PRICE_MINOR[it.k][it.r] * (0.6 + 0.4 * it.dur / 100));
const refCr = (it) => SCRAP_CR[it.k][it.r] * it.dur / 100;
let uid = 0;
const mk = (k, r, dur = 100, lock = 0) => ({ id: ++uid, k, r, dur, lock });
/** seed.ts rollPiece (pool seed): giveaway-like pieces, ~12% rarer weapons, 8% armor_3, 15% backpack_2. */
function seedPiece(i) {
  const s = i % 3;
  if (s === 0) return rnd() < 0.12 ? mk("w", rnd() < 0.3 ? 3 : 2) : mk("w", rnd() < 0.25 ? 1 : 0);
  if (s === 1) return rnd() < 0.08 ? mk("a", 3) : mk("a", rnd() < 0.2 ? 2 : 1);
  return mk("b", rnd() < 0.15 ? 2 : 1);
}
function giveawayKit() {
  return [mk("w", rnd() < 0.25 ? 1 : 0, 100, GIVEAWAY.LOCK_RAIDS), mk("a", rnd() < 0.2 ? 2 : 1, 100, GIVEAWAY.LOCK_RAIDS), mk("b", 1, 100, GIVEAWAY.LOCK_RAIDS)];
}
/** Primary batch item: like the giveaway, with ~10% top tier (design §5). */
function primaryItem() {
  if (rnd() < 0.1) return pick([mk("w", rnd() < 0.3 ? 3 : 2), mk("a", 3)]);
  const s = Math.floor(rnd() * 3);
  return s === 0 ? mk("w", rnd() < 0.25 ? 1 : 0) : s === 1 ? mk("a", rnd() < 0.2 ? 2 : 1) : mk("b", rnd() < 0.15 ? 2 : 1);
}

// ---------------------------------------------------------------- consumables
const KIT_CR = 2 * CONSUMABLES_CR.ammo_light.cr + CONSUMABLES_CR.ammo_light.cr + 3 * CONSUMABLES_CR.bandage.cr + CONSUMABLES_CR.medkit.cr; // 90 light + 3 bandages + medkit = 535

// ---------------------------------------------------------------- scenarios
const SCEN = {
  base: { mix: { rat: 0.3, poi: 0.5, boss: 0.2 }, scale: 1 },
  ratheavy: { mix: { rat: 0.7, poi: 0.2, boss: 0.1 }, scale: 1 },
  botfarm: { mix: { rat: 0.3, poi: 0.5, boss: 0.2 }, scale: 1, farm: { day: 10, n: 300 } },
  lowdau: { mix: { rat: 0.3, poi: 0.5, boss: 0.2 }, scale: 0.25 },
  highdau: { mix: { rat: 0.3, poi: 0.5, boss: 0.2 }, scale: 5 },
  crash: { mix: { rat: 0.3, poi: 0.5, boss: 0.2 }, scale: 1, crashDay: 30 },
};

function run(name) {
  const sc = SCEN[name];
  seed = SEED;
  uid = 0;
  const players = [];
  let nextId = 1;
  let giveawayLeft = GIVEAWAY.KITS;
  let pool = [];
  for (let i = 0; i < 700; i++) { const it = seedPiece(i); it.dur = Math.round(55 + rnd() * 45); pool.push(it); }
  const treasury = { items: [], revenue: 0, revenueToday: 0, taxAcc: 0, primarySold: 0, taxSold: 0, feeRev: 0, primRev: 0, taxRev: 0, everPaid: 0 };
  let overhang = [];
  let autosellMult = 1;
  let prevActive = new Set();
  let poolEmptyStreak = 0, poolEmptyMaxStreak = 0;
  let startIdx = null;
  const tot = { destroyed: 0, captured: { boss: 0, cont: 0 }, farmCaptured: 0, released: 0, bossKills: 0, freeKitBossItems: 0 };
  const rows = [];
  const solTotalStart = { v: 0 };

  function newPlayer(day, farm = false) {
    const r = rnd();
    const type = farm ? "rat" : r < sc.mix.rat ? "rat" : r < sc.mix.rat + sc.mix.poi ? "poi" : "boss";
    const p = {
      id: nextId++, joined: day, farm, type, life: farm ? 999 : Math.max(2, -Math.log(rnd()) * 14),
      rate: farm ? 6 : Math.exp(Math.log(2.2) + 0.6 * (rnd() * 2 - 1)), cr: 1000, cons: 0, xp: 0, lvl: 1, items: [],
      sol: farm ? 0 : chance(0.6) ? Math.round(rnd() * 3000) : 0, raids: 0, lastRaid: -99,
    };
    solTotalStart.v += p.sol;
    const kitOk = !farm && (OPTS.giveawayCap ? giveawayLeft > 0 : true);
    if (kitOk || (farm && !OPTS.giveawayCap)) { giveawayLeft--; p.items.push(...giveawayKit()); }
    return p;
  }

  const enterPool = (it, broke) => {
    if (broke) it.dur -= POOL.BREAK_DUR_LOSS;
    if (it.dur <= 0) { tot.destroyed++; return; }
    pool.push(it);
    // 1% treasury tax on entering value (takeTreasuryTax: whole items when the accumulator covers them).
    const res = takeTreasuryTax(treasury.taxAcc, [{ uid: String(it.id), value: refCr(it) }]);
    treasury.taxAcc = res.acc;
    if (res.taken.length) { pool.pop(); treasury.items.push(it); }
  };

  for (let day = 0; day < DAYS; day++) {
    // arrivals (economy memo §9 curve, scaled per scenario)
    let arrivals = Math.round((day === 0 ? 300 : 120 * Math.exp(-day / 25) + 35) * sc.scale);
    if (sc.crashDay !== undefined && day >= sc.crashDay) arrivals = Math.round(8 * sc.scale);
    for (let i = 0; i < arrivals; i++) players.push(newPlayer(day));
    if (sc.farm && day === sc.farm.day) for (let i = 0; i < sc.farm.n; i++) players.push(newPlayer(day, true));
    const crashMul = sc.crashDay !== undefined && day >= sc.crashDay ? 0.6 : 1;
    const active = players.filter((p) => day - p.joined < p.life * crashMul);
    const activeSet = new Set(active);
    // leaving players dump their stash on the market with p 0.35 (memo)
    for (const p of prevActive) if (!activeSet.has(p) && !p.farm && p.lvl >= MARKET.SELL_UNLOCK_LEVEL && chance(0.35)) {
      const keep = []; for (const it of p.items) (it.lock > 0 ? keep : overhang).push(it); p.items = keep;
    }
    prevActive = activeSet;
    const dau = active.filter((p) => !p.farm).length;
    const H = Math.max(1, Math.min(14, Math.round(dau * 0.01)));

    const tickets = [];
    for (const p of active) { const n = poisson(p.rate); for (let i = 0; i < n; i++) tickets.push(p); }
    shuffle(tickets);
    const d = { raids: tickets.length, junkCr: 0, consBought: 0, listFees: 0, found: 0, used: 0, extracts: 0, released: 0, capBoss: 0, capCont: 0, bossKills: 0, geared: 0, farmCr: 0 };
    treasury.revenueToday = 0;

    for (let m = 0; m < tickets.length; m += H) {
      const group = [...new Set(tickets.slice(m, m + H))];
      // loadouts + raid records
      const rs = group.map((p) => {
        p.raids++; p.lastRaid = day;
        const best = (k) => p.items.filter((it) => it.k === k).sort((a, b) => b.r - a.r || b.dur - a.dur)[0];
        const hasGun = !!best("w");
        const canKit = p.cr + p.cons >= KIT_CR * 0.5;
        const geared = !p.farm && hasGun && canKit && chance(0.75);
        const lo = [];
        if (geared) {
          for (const k of ["w", "a", "b"]) { const it = best(k); if (it) { lo.push(it); p.items.splice(p.items.indexOf(it), 1); } }
          const fromStock = Math.min(p.cons, KIT_CR); p.cons -= fromStock;
          const buy = Math.min(p.cr, KIT_CR - fromStock); p.cr -= buy; d.consBought += buy;
          d.geared++;
        }
        const kit = geared ? "starter" : "free";
        const target = p.type === "boss" ? pick(BOSS_KINDS) : null;
        return { p, lo, kit, target, rec: null, out: null };
      });
      // bosses (rolled per match), pool release (v4)
      const spawned = BOSS_KINDS.filter((k) => BOSSES[k].enabled && rnd() < BOSSES[k].spawnChance);
      const B = spawned.reduce((n, k) => n + BOSSES[k].poolSlots.length, 0);
      const R = rs.reduce((n, r) => n + r.lo.length, 0);
      const P = pool.length;
      const risk = Math.max(0, Math.min(P, POOL.MAX_PER_MATCH, Math.round(RISK_K * R)));
      const gate = R >= POOL.BOSS_MIN_RISK && P - risk > POOL.BOSS_MIN_POOL;
      const total = risk + (gate ? Math.max(0, Math.min(B, POOL.MAX_PER_MATCH) - risk) : 0);
      shuffle(pool);
      const bossTake = Math.min(B, total);
      const byScore = pool.map((it, i) => ({ it, i, s: tierScore(it) })).sort((a, b) => b.s - a.s || a.i - b.i);
      const bossItems = byScore.slice(0, bossTake).map((e) => e.it);
      const bset = new Set(bossItems);
      const contItems = pool.filter((it) => !bset.has(it)).slice(0, total - bossTake);
      const out = new Set([...bossItems, ...contItems]);
      pool = pool.filter((it) => !out.has(it));
      d.released += total;
      // boss slots: rankBossSlots order (min score desc, tougher boss first)
      const slots = [];
      for (const k of spawned) BOSSES[k].poolSlots.forEach((min, i) => slots.push({ k, min, hp: BOSSES[k].hp, i }));
      slots.sort((a, b) => b.min - a.min || b.hp - a.hp || a.i - b.i);
      const bag = Object.fromEntries(spawned.map((k) => [k, []]));
      bossItems.forEach((it, i) => bag[slots[i].k].push(it));

      // raid records
      for (const r of rs) {
        const bucket = r.p.type === "boss" ? `boss:${r.target}:${r.kit}` : `${r.p.type}:${r.kit}`;
        r.rec = r.p.type === "boss" ? pick(stratum(bucket, r.target, spawned.includes(r.target))) : pick(REC[bucket]);
        r.out = r.rec.exit;
        d.found += r.rec.cons.foundCr; d.used += r.rec.cons.usedCr;
      }
      // boss items: the first hunter of that boss whose record killed it
      const back = [];
      for (const k of spawned) {
        const items = bag[k];
        const killer = shuffle(rs.filter((r) => r.target === k)).find((r) => r.rec.bosses.some((b) => b.kind === k && b.fate === "human"));
        if (killer) { d.bossKills++; tot.bossKills++; }
        if (killer && killer.out === "extract") { killer.gain = [...(killer.gain ?? []), ...items]; d.capBoss += items.length; if (killer.kit === "free") tot.freeKitBossItems += items.length; }
        else if (killer) for (const it of items) back.push([it, chance(BREAK)]);
        else for (const it of items) back.push([it, false]);
      }
      // container items: per item, humans in random order with q(strategy | survived)
      for (const it of contItems) {
        let got = null;
        for (const r of shuffle([...rs])) {
          if (r.out !== "extract") continue;
          const q = Q[r.p.type].qGivenSurvived;
          if (chance(Math.min(0.95, q))) { got = r; break; }
        }
        if (got) { got.gain = [...(got.gain ?? []), it]; d.capCont++; if (got.p.farm) tot.farmCaptured++; }
        else back.push([it, false]);
      }
      for (const [it, broke] of back) enterPool(it, broke);
      // outcomes
      const pvp = Math.min(0.6, (rs.length - 1) / (rs.length - 1 + 10));
      for (const r of rs) {
        const p = r.p;
        p.xp += PROGRESSION.XP_RAID + (r.out === "extract" ? PROGRESSION.XP_EXTRACT : 0) + (r.rec.kills ?? 0) * PROGRESSION.XP_KILL + (r.rec.humanBossKills ?? 0) * PROGRESSION.XP_BOSS;
        p.lvl = levelForXp(p.xp);
        if (r.out === "extract") {
          d.extracts++;
          const cr = Math.round(r.rec.haul.junkCr * autosellMult);
          p.cr += cr; d.junkCr += cr; if (p.farm) d.farmCr += cr;
          p.cons += r.rec.haul.consumables.cr;
          for (const it of r.lo) {
            if (it.k === "a") it.dur -= 10 + rnd() * 35; else if (it.k === "w") it.dur -= 2 + rnd() * 4; else it.dur -= 1 + rnd() * 3;
            if (it.lock > 0) it.lock--;
            if (it.dur <= 0) tot.destroyed++; else p.items.push(it);
          }
          for (const it of r.gain ?? []) p.items.push(it);
        } else if (r.out === "timeout") {
          for (const it of [...r.lo, ...(r.gain ?? [])]) enterPool(it, false);
        } else {
          const killer = chance(pvp) ? pick(rs.filter((x) => x !== r && x.out === "extract")) : null;
          for (const it of [...r.lo, ...(r.gain ?? [])]) {
            if (chance(BREAK)) enterPool(it, true);
            else if (killer && chance(0.7)) killer.p.items.push(it);
            else enterPool(it, false);
          }
        }
      }
    }

    // market (opens day 3): P2P from sellers lvl >= SELL_UNLOCK_LEVEL with a spare, overhang first; fee 5%
    const tradable = active.reduce((a, p) => a + (p.farm ? 0 : p.items.length), 0);
    const perActive = tradable / Math.max(1, dau);
    const priceIdx = Math.pow(2 / Math.max(0.3, perActive), 0.8);
    let trades = 0, primary = 0;
    if (day >= 3) {
      if (startIdx === null) startIdx = priceIdx;
      const sellers = active.filter((p) => !p.farm && p.lvl >= MARKET.SELL_UNLOCK_LEVEL);
      const buyers = shuffle(active.filter((p) => !p.farm && p.sol > 0 && !p.items.some((i) => i.k === "w")));
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
            it = s.items.filter((i) => i.lock <= 0 && s.items.filter((j) => j.k === i.k).length >= 2).sort((x, y) => x.r - y.r)[0];
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
      // primary sales: daily from day 14 while items/active < 2.5, up to 8% DAU, ~10% top tier, price max(ref, ref × idx)
      if (OPTS.primary && day >= 14 && perActive < 2.5) {
        const rich = active.filter((p) => !p.farm && p.sol > 500);
        const n = Math.min(rich.length, Math.round(dau * 0.08));
        for (let i = 0; i < n; i++) {
          const b = pick(rich); const it = primaryItem(); const price = Math.round(refPrice(it) * Math.max(1, priceIdx));
          if (b.sol < price) continue;
          b.sol -= price; b.items.push(it); treasury.revenueToday += price; treasury.primRev += price; primary++;
        }
        treasury.primarySold += primary;
      }
    }
    treasury.revenue += treasury.revenueToday;

    // autosell regulator (daily cron): veterans = joined >= 7 days ago and raided in the last 7 days
    const vets = active.filter((p) => !p.farm && day - p.joined >= 7 && day - p.lastRaid <= 7).map((p) => p.cr);
    const vetMed = med(vets);
    if (OPTS.regulator) autosellMult = nextAutosellMult(autosellMult, vetMed, vets.length);

    poolEmptyStreak = pool.length === 0 ? poolEmptyStreak + 1 : 0;
    poolEmptyMaxStreak = Math.max(poolEmptyMaxStreak, poolEmptyStreak);
    const crs = active.filter((p) => !p.farm).map((p) => p.cr);
    tot.captured.boss += d.capBoss; tot.captured.cont += d.capCont; tot.released += d.released;
    rows.push({
      day, dau, H, raids: d.raids, geared: +(d.geared / Math.max(1, d.raids)).toFixed(2), ext: +(d.extracts / Math.max(1, d.raids)).toFixed(2),
      itemsPerActive: +perActive.toFixed(2), priceIdx: +priceIdx.toFixed(2), priceVsStart: startIdx ? +(priceIdx / startIdx).toFixed(2) : null,
      revenue: treasury.revenueToday, trades, primary, pool: pool.length, poolTop: pool.filter((i) => tierScore(i) === 2).length,
      released: d.released, capBoss: d.capBoss, capCont: d.capCont, bossKills: d.bossKills,
      crMed: med(crs), crP99: pctl(crs, 0.99), vetMed, mult: +autosellMult.toFixed(2),
      faucet: d.junkCr, sink: d.consBought + d.listFees, faucetSink: +(d.junkCr / Math.max(1, d.consBought + d.listFees)).toFixed(2),
      consFound: Math.round(d.found), consUsed: Math.round(d.used), consBought: d.consBought, farmCr: d.farmCr,
    });
  }
  const solNow = players.reduce((a, p) => a + p.sol, 0) + treasury.revenue;
  return { name, rows, tot, treasury: { revenue: treasury.revenue, feeRev: treasury.feeRev, primRev: treasury.primRev, taxRev: treasury.taxRev, primarySold: treasury.primarySold, taxSold: treasury.taxSold, everPaid: treasury.everPaid },
    solConserved: solNow === solTotalStart.v, poolEmptyMaxStreak, farm: sc.farm ? farmStats(players) : null };
}

function farmStats(players) {
  const f = players.filter((p) => p.farm);
  return { accounts: f.length, items: f.reduce((a, p) => a + p.items.length, 0), crMedian: med(f.map((p) => p.cr)), raids: f.reduce((a, p) => a + p.raids, 0) };
}

// ---------------------------------------------------------------- report
const scen = arg("scenario", "all");
const names = scen === "all" ? Object.keys(SCEN) : [scen];
const results = names.map(run);
console.log(`data ${DATA}; K ${RISK_K}; primary ${OPTS.primary}; giveaway cap ${OPTS.giveawayCap}; regulator ${OPTS.regulator}`);
console.log("container-unique capture q (per released container item):", Object.fromEntries(Object.entries(Q).map(([k, v]) => [k, `${v.got}/${v.rel} = ${v.q.toFixed(3)}`])));
const pickDays = [6, 29, 59, DAYS - 1];
for (const r of results) {
  console.log(`\n=== ${r.name} ===`);
  console.table(r.rows.filter((x) => pickDays.includes(x.day)).map((x) => ({
    d: x.day + 1, dau: x.dau, H: x.H, "it/act": x.itemsPerActive, pIdx: x.priceIdx, "p/start": x.priceVsStart, rev: x.revenue, prim: x.primary, trd: x.trades,
    pool: x.pool, top: x.poolTop, rel: x.released, "cap b/c": `${x.capBoss}/${x.capCont}`, crMed: x.crMed, crP99: x.crP99, mult: x.mult, "f/s": x.faucetSink,
    "cons f/u": `${x.consFound}/${x.consUsed}`,
  })));
  const from3 = r.rows.filter((x) => x.day >= 3);
  console.log(`revenue>0 every day from day 3: ${from3.every((x) => x.revenue > 0)} (zero days: ${from3.filter((x) => x.revenue <= 0).map((x) => x.day).join(",") || "-"}); ` +
    `pool max empty streak ${r.poolEmptyMaxStreak}; SOL conserved (no game payout) ${r.solConserved}; treasury ${JSON.stringify(r.treasury)}; totals ${JSON.stringify(r.tot)}` +
    (r.farm ? `; farm ${JSON.stringify(r.farm)}` : ""));
}
const jsonOut = arg("json");
if (jsonOut) writeFileSync(jsonOut, JSON.stringify({ data: DATA, k: RISK_K, opts: OPTS, q: Q, results }, null, 1));
