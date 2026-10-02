/**
 * Search targets (critique "How containers are modelled", inventory memo §2): static containers
 * (MapData.containers by index, never schema entities; state carries only containerState[i]) and
 * corpses (state.corpses, AOI-filtered). Both are take-only and searched Tarkov-style:
 *
 *   F → session { key, readyAt = clock + open delay } → once ready the searcher's StateView gets
 *   the `loot` entry (c<idx> / k<corpseId>) → items reveal one by one (revealMs each) into
 *   ContainerLoot.slots["<index>"], shared by every ready searcher and only ever increasing.
 *
 * Unrevealed items never leave the server (cheat-proof: nothing to read from client memory), and a
 * loot entry is only ever in the views of its current ready searchers. Two looters cooperate or
 * race: every op runs inside the room's single-threaded message loop, so the first take wins and
 * the loser gets INV_ERR "gone"; both UIs update from the next patch (no extra messages).
 *
 * Contents of static containers roll lazily on first open and are deterministic in
 * (matchSeed, idx) alone, so the open order never changes what is inside and an audit can re-roll:
 * - fungibles (junk / ammo / meds) from the shared CONTAINER_LOOT tables (rollContainerFungibles);
 * - uniques: live mode = the lost-pool allocation from raids/start (registered in the ledger at
 *   match start); demo mode = minted from CHEST_TABLES (registered as "minted" when rolled).
 *
 * A session closes on SEARCH_CLOSE, distance > SEARCH.CANCEL_RANGE (checked every tick; 128 vs the
 * 96 px open range is the hysteresis), firing (combat.ts), roll start, death, extract, disconnect
 * and match end. Movement and damage do not close it (prediction stays untouched).
 */

import {
  BACKPACK_SLOTS,
  CHEST_TABLES,
  CONTAINER_STATE,
  ContainerLoot,
  Corpse,
  ITEM_FLAG,
  SEARCH,
  SOLID,
  SOUND,
  SoundKind,
  accepts,
  containerLootKey,
  containerOpenMs,
  corpseLootKey,
  hasLineOfSight,
  isSlotKey,
  itemDef,
  lootRollToItem,
  mulberry32,
  pickWeighted,
  planPlace,
  revealMs,
  rollContainerFungibles,
  type ContainerSpot,
  type InvErrCode,
  type InvItem,
  type InvMoveMsg,
  type ItemLike,
  type Rarity,
  type SettledItem,
  type SlotKey,
} from "@extract/shared";
import { cancelReload } from "./actions.js";
import { applyPlan, fixActive, placeItem, syncPublic, takeOpToken } from "./bag.js";
import { dropSpot, spawnGroundItem } from "./inventory.js";
import { isTrackedUnique, makeItem, toInv, toPlain } from "./items.js";
import type { Match } from "./match.js";
import { emitSound } from "./sound.js";
import type { PlayerRuntime } from "./types.js";

/** Seed of the demo unique rolls of one container (independent of the fungible stream). */
function uniqueSeed(matchSeed: number, idx: number): number {
  return (Math.imul((matchSeed ^ 0x2545f491) >>> 0, 0x9e3779b1) ^ Math.imul(idx + 7, 0xc2b2ae35)) >>> 0;
}

/** Demo chest rarity of a container tier (legacy map: tier = v1 chest rarity + 1). */
export function demoChestRarity(spot: ContainerSpot): Rarity {
  return Math.max(0, Math.min(3, spot.tier - 1)) as Rarity;
}

/** One searchable thing (a static container once opened, or a corpse). Server-only. */
export interface SearchTarget {
  /** Loot map key: c<idx> / k<corpseId>. */
  key: string;
  kind: "container" | "corpse";
  /** MapData.containers index; -1 for corpses. */
  idx: number;
  corpse: Corpse | null;
  /** Roster index of the dead player (corpses), -1 otherwise. */
  owner: number;
  x: number;
  y: number;
  openMs: number;
  /**
   * Every item in slot order (index = loot slot key). Items at index >= loot.revealed are still
   * hidden and live only here; revealed ones live in loot.slots (the truth from then on).
   */
  items: ItemLike[];
  /** Plain copy of the contents at creation (ledger / conservation audits). */
  initial: ItemLike[];
  loot: ContainerLoot;
  /** Players with an open session on this target. */
  searchers: Set<PlayerRuntime>;
  /** Searchers whose open delay has passed (their view holds the loot entry). */
  ready: Set<PlayerRuntime>;
  /** Roster indexes that searched it at least once (RaidStats counters count each target once). */
  searchedBy: Set<number>;
}

export class ContainerSystem {
  /** Live-mode pool uniques allocated to a container, by index (registered at match start). */
  private readonly pool = new Map<number, ItemLike[]>();
  /** Opened containers and every corpse, by loot key. */
  readonly targets = new Map<string, SearchTarget>();
  /** Corpses in creation order (nearestOpenable's index space after the static containers). */
  private readonly corpseList: SearchTarget[] = [];
  /** Targets with at least one searcher (stepSearches iterates only these). */
  private readonly active = new Set<SearchTarget>();

  constructor(private readonly m: Match) {
    const n = m.map.containers.length;
    for (let i = 0; i < n; i++) m.state.containerState.push(CONTAINER_STATE.UNTOUCHED);
  }

  /** Lost-pool items from raids/start ("boss" and unknown indexes are ignored until bosses exist). */
  allocatePool(containerLoot: Readonly<Record<string, SettledItem[]>>): void {
    for (const [key, items] of Object.entries(containerLoot)) {
      const idx = Number(key);
      if (!Number.isInteger(idx) || idx < 0 || idx >= this.m.map.containers.length) continue;
      const list = this.pool.get(idx) ?? [];
      for (const s of items) {
        if (!itemDef(s.def)) continue;
        const it = makeItem(s.def, { uid: s.uid, qty: s.qty, rarity: s.rarity, dur: s.dur, label: s.label, lvl: s.lvl });
        this.m.ledger.register(it, "pool");
        list.push(it);
      }
      this.pool.set(idx, list);
    }
  }

  /**
   * Contents of container `idx` (called once, on first open). Demo uniques are minted here, so a
   * container nobody opens never creates items.
   */
  roll(idx: number): ItemLike[] {
    const m = this.m;
    const spot = m.map.containers[idx]!;
    const out: ItemLike[] = [];
    if (m.mode === "demo") {
      const table = CHEST_TABLES[demoChestRarity(spot)];
      const rng = mulberry32(uniqueSeed(m.state.mapSeed, idx));
      for (let i = 0; i < table.rolls; i++) {
        const r = lootRollToItem(pickWeighted(rng, table.loot));
        const d = itemDef(r.def)!;
        if (d.unique) {
          const it = makeItem(r.def, { uid: m.newUid(), rarity: r.rarity });
          m.ledger.register(it, "minted");
          out.push(it);
        } else {
          out.push(makeItem(r.def, { qty: r.qty, rarity: r.rarity }));
        }
      }
    } else {
      out.push(...(this.pool.get(idx) ?? []));
      this.pool.delete(idx);
    }
    for (const f of rollContainerFungibles(m.state.mapSeed, idx, spot)) {
      out.push(makeItem(f.def, { qty: f.qty, rarity: f.rarity }));
    }
    return out;
  }

  private createTarget(t: Omit<SearchTarget, "loot" | "searchers" | "ready" | "searchedBy" | "initial">): SearchTarget {
    const loot = new ContainerLoot();
    // uint8 on the wire: a corpse holds ≤ 4 + 4 + 16 + 1 entries, a container a handful.
    loot.total = Math.min(255, t.items.length);
    if (t.items.length > 255) t.items.length = 255;
    const target: SearchTarget = {
      ...t,
      initial: t.items.map(toPlain),
      loot,
      searchers: new Set(),
      ready: new Set(),
      searchedBy: new Set(),
    };
    this.targets.set(t.key, target);
    this.m.state.loot.set(t.key, loot);
    return target;
  }

  /** Static container `idx` as a search target, rolled on first use (state → OPENED). */
  private containerTarget(idx: number, opener: PlayerRuntime): SearchTarget | null {
    const key = containerLootKey(idx);
    const have = this.targets.get(key);
    if (have) return have;
    const spot = this.m.map.containers[idx];
    if (!spot) return null;
    const t = this.createTarget({
      key, kind: "container", idx, corpse: null, owner: -1, x: spot.x, y: spot.y,
      openMs: containerOpenMs(spot), items: this.roll(idx),
    });
    this.m.state.containerState[idx] = CONTAINER_STATE.OPENED;
    // Lid creak: "someone was here" (containerState is public, the sound is positional).
    this.m.emit({ type: "chest", src: opener.rosterIndex, idx });
    emitSound(this.m, opener, SoundKind.loot, spot.x, spot.y);
    return t;
  }

  /**
   * The body of a player who just died, holding `items` in slot order. Synced to clients through
   * state.corpses (AOI-filtered); the contents only through the searchers' loot entry k<id>.
   */
  addCorpse(rt: PlayerRuntime, items: ItemLike[]): SearchTarget {
    const p = rt.pub;
    const c = new Corpse();
    c.id = String(rt.rosterIndex);
    c.x = p.x;
    c.y = p.y;
    c.label = rt.nickname;
    c.color = p.color;
    c.rot = p.aim;
    const t = this.createTarget({
      key: corpseLootKey(c.id), kind: "corpse", idx: -1, corpse: c, owner: rt.rosterIndex, x: p.x, y: p.y,
      openMs: SEARCH.OPEN_MS.corpse, items,
    });
    this.corpseList.push(t);
    this.m.state.corpses.set(c.id, c);
    return t;
  }

  corpseOf(rosterIndex: number): SearchTarget | undefined {
    return this.corpseList.find((t) => t.owner === rosterIndex);
  }

  corpses(): readonly SearchTarget[] {
    return this.corpseList;
  }

  /**
   * Nearest searchable thing within SEARCH.OPEN_RANGE and line of sight, or -1. Index space:
   * [0, containers.length) = static containers, then corpses in creation order. Emptied ones are
   * skipped; containers opened by others are still searchable (shared reveal).
   */
  nearestOpenable(rt: PlayerRuntime): number {
    const p = rt.pub;
    const m = this.m;
    let best = -1;
    let bestD = SEARCH.OPEN_RANGE * SEARCH.OPEN_RANGE;
    const consider = (i: number, x: number, y: number) => {
      const d = (x - p.x) ** 2 + (y - p.y) ** 2;
      if (d > bestD || !hasLineOfSight(m.idx, p.x, p.y, x, y, SOLID.MOVE)) return;
      best = i;
      bestD = d;
    };
    const n = m.map.containers.length;
    for (let i = 0; i < n; i++) {
      if (m.state.containerState[i] === CONTAINER_STATE.EMPTIED) continue;
      const c = m.map.containers[i]!;
      // Cheap box reject before the distance / LOS work (≈400 containers on the Steppe).
      if (Math.abs(c.x - p.x) > SEARCH.OPEN_RANGE || Math.abs(c.y - p.y) > SEARCH.OPEN_RANGE) continue;
      consider(i, c.x, c.y);
    }
    this.corpseList.forEach((t, k) => {
      if (!t.corpse!.empty) consider(n + k, t.x, t.y);
    });
    return best;
  }

  /** F on what nearestOpenable returned: start (or keep) a search session. */
  open(rt: PlayerRuntime, n: number): void {
    const nc = this.m.map.containers.length;
    const t = n < nc ? this.containerTarget(n, rt) : this.corpseList[n - nc];
    if (t) this.startSession(rt, t);
  }

  private startSession(rt: PlayerRuntime, t: SearchTarget): void {
    const m = this.m;
    if (!rt.pub.alive) return;
    // F again on the target being searched is a no-op (the panel is already open).
    if (rt.search?.key === t.key) return;
    closeSearch(m, rt, "switch");
    const readyAt = m.clock + t.openMs;
    rt.search = { key: t.key, readyAt };
    rt.self.searching = t.key;
    rt.self.searchReadyAt = readyAt;
    t.searchers.add(rt);
    this.active.add(t);
    if (!t.searchedBy.has(rt.rosterIndex)) {
      t.searchedBy.add(rt.rosterIndex);
      if (t.kind === "corpse") rt.stats.corpsesSearched++;
      else rt.stats.containersSearched++;
    }
    if (t.corpse && !t.corpse.opened) t.corpse.opened = true;
    emitSound(m, rt, SoundKind.search, rt.pub.x, rt.pub.y);
    rt.nextSearchSoundAt = m.clock + SOUND.SEARCH_REPEAT_MS;
    syncPublic(rt);
  }

  /** Remove `rt` from its session's target (closeSearch does the player side). */
  leave(rt: PlayerRuntime, key: string): void {
    const t = this.targets.get(key);
    if (!t) return;
    t.searchers.delete(rt);
    if (t.ready.delete(rt) && !rt.isBot) this.m.emit({ type: "view", to: rt.rosterIndex, op: "remove", key });
    // Nobody past the delay any more: pause now (an inactive target is not stepped).
    if (t.ready.size === 0 && t.loot.nextRevealAt !== 0) t.loot.nextRevealAt = 0;
    if (t.searchers.size === 0) this.active.delete(t);
  }

  /** Per tick: cancel by range, open delays, reveals, search sounds. */
  step(): void {
    const m = this.m;
    const r2 = SEARCH.CANCEL_RANGE * SEARCH.CANCEL_RANGE;
    for (const t of [...this.active]) {
      for (const rt of [...t.searchers]) {
        const p = rt.pub;
        if (!p.alive || (p.x - t.x) ** 2 + (p.y - t.y) ** 2 > r2) {
          closeSearch(m, rt, p.alive ? "range" : "dead");
          continue;
        }
        if (!t.ready.has(rt) && m.clock >= rt.search!.readyAt) {
          t.ready.add(rt);
          if (!rt.isBot) m.emit({ type: "view", to: rt.rosterIndex, op: "add", key: t.key });
        }
        if (m.clock >= rt.nextSearchSoundAt) {
          emitSound(m, rt, SoundKind.search, p.x, p.y);
          rt.nextSearchSoundAt = m.clock + SOUND.SEARCH_REPEAT_MS;
        }
      }
      this.reveal(t);
    }
  }

  /** Reveal loop of one target: runs while at least one searcher is past the open delay. */
  private reveal(t: SearchTarget): void {
    const loot = t.loot;
    const clock = this.m.clock;
    if (t.ready.size === 0) {
      // Paused (nobody past the delay): progress already made stays, the current item restarts.
      if (loot.nextRevealAt !== 0) loot.nextRevealAt = 0;
      return;
    }
    if (loot.revealed < loot.total && loot.nextRevealAt === 0) loot.nextRevealAt = clock + revealMs(t.items[loot.revealed]!);
    while (loot.revealed < loot.total && clock >= loot.nextRevealAt) {
      const i = loot.revealed;
      loot.slots.set(String(i), toInv(t.items[i]!));
      loot.revealed = i + 1;
      loot.nextRevealAt = i + 1 < loot.total ? loot.nextRevealAt + revealMs(t.items[i + 1]!) : 0;
    }
    this.checkEmptied(t);
  }

  /** Fully revealed and nothing left: public "emptied" (lid / body renders empty). */
  checkEmptied(t: SearchTarget): void {
    if (t.loot.revealed < t.loot.total || t.loot.slots.size > 0) return;
    if (t.corpse) {
      if (!t.corpse.empty) t.corpse.empty = true;
    } else if (this.m.state.containerState[t.idx] !== CONTAINER_STATE.EMPTIED) {
      this.m.state.containerState[t.idx] = CONTAINER_STATE.EMPTIED;
    }
  }

  /** Everything still inside a target: hidden items plus what is revealed and not taken. */
  remaining(t: SearchTarget): ItemLike[] {
    const out: ItemLike[] = [];
    for (let i = 0; i < t.loot.total; i++) {
      if (i < t.loot.revealed) {
        const it = t.loot.slots.get(String(i));
        if (it) out.push(toPlain(it));
      } else {
        out.push(t.items[i]!);
      }
    }
    return out;
  }

  /**
   * Uniques still on the map inside containers and corpses (MatchEndReport.leftOnMap): unopened
   * live pool allocations plus the remaining contents of every target. Broken items never sit in
   * a corpse (they were reported lost at death).
   */
  leftInside(): ItemLike[] {
    const out = [...this.pool.values()].flat();
    for (const t of this.targets.values()) for (const it of this.remaining(t)) if (isTrackedUnique(it)) out.push(it);
    return out;
  }
}

// ---------------------------------------------------------------- session API (match / room / bots)

/** Per-tick reveal loop of search sessions. Called by Match.step after inputs. */
export function stepSearches(m: Match): void {
  m.containers.step();
}

/** Close a player's search session, if any. Called on roll, fire, death, extract, leave, close. */
export function closeSearch(m: Match, rt: PlayerRuntime, _reason: string): void {
  const sess = rt.search;
  if (!sess) return;
  rt.search = null;
  m.containers.leave(rt, sess.key);
  if (rt.self.searching !== "") rt.self.searching = "";
  if (rt.self.searchReadyAt !== 0) rt.self.searchReadyAt = 0;
  syncPublic(rt);
}

/** The target of the player's current session (ready or not), if any. */
export function currentTarget(m: Match, rt: PlayerRuntime): SearchTarget | undefined {
  return rt.search ? m.containers.targets.get(rt.search.key) : undefined;
}

/** The highest occupied b-slot fits a backpack of `level`. */
function bagFitsLevel(s: { get(k: string): unknown }, level: number): boolean {
  const cap = BACKPACK_SLOTS[level] ?? 0;
  for (let i = cap; i < 16; i++) if (s.get(`b${i}`)) return false;
  return true;
}

interface TakeResult {
  code?: InvErrCode;
  placed: number;
}

/**
 * Move up to `qty` units of revealed slot `key` of target `t` into the player's inventory
 * (auto-place, or at `to`). Containers are take-only: an occupied `to` is a swap only in the sense
 * that the displaced item is auto-placed into storage, or dropped at the player's feet when there
 * is no room (FREE items just vanish).
 */
function takeSlot(m: Match, rt: PlayerRuntime, t: SearchTarget, key: string, qty: number, to?: SlotKey): TakeResult {
  const src = t.loot.slots.get(key)!;
  const item = toPlain(src);
  const s = rt.self.slots;
  const active = rt.self.active;
  let placed = 0;
  let touched = false;
  const plan = planPlace(s, item, qty, to);
  if (plan.ok) {
    if (plan.steps.some((st) => st.key === "bp") && !bagFitsLevel(s, itemDef(item.def)?.bpLevel ?? 0)) return { code: "bp_not_empty", placed: 0 };
    applyPlan(rt, item, plan);
    placed = plan.placed;
    touched = plan.steps.some((st) => st.key === active);
  } else if (plan.code === "full" && to && qty === item.qty && s.get(to)) {
    const d = itemDef(item.def)!;
    if (!accepts(to, d)) return { code: "bad_slot", placed: 0 };
    if (to === "bp" && !bagFitsLevel(s, d.bpLevel ?? 0)) return { code: "bp_not_empty", placed: 0 };
    const old = toPlain(s.get(to)!);
    const fresh = toInv(item);
    s.set(to, fresh);
    placed = item.qty;
    touched = to === active;
    if (!(old.flags & ITEM_FLAG.FREE)) {
      const r = placeItem(rt, old, old.qty);
      if (r.placed < old.qty) {
        const at = dropSpot(m, rt.pub.x, rt.pub.y, Math.floor(m.rng() * 12));
        spawnGroundItem(m, { ...old, qty: old.qty - r.placed }, at.x, at.y);
      }
    }
  } else {
    return { code: plan.code, placed: 0 };
  }
  if (placed >= src.qty) t.loot.slots.delete(key);
  else src.qty -= placed;
  fixActive(rt);
  if (touched || (rt.reloadKey !== "" && !s.get(rt.reloadKey))) cancelReload(rt);
  return { placed };
}

/** Common checks of a take: session, open delay. */
function sessionTarget(m: Match, rt: PlayerRuntime): SearchTarget | InvErrCode {
  const t = currentTarget(m, rt);
  if (!t) return "not_searching";
  if (!t.ready.has(rt) || m.clock < rt.search!.readyAt) return "not_ready";
  return t;
}

/**
 * INV_MOVE with from = "loot": take one revealed slot of the current session. Returns the error
 * code or null. The uid/def pair is the stale-click guard (the slot must still hold that item).
 */
export function takeFromLoot(m: Match, rt: PlayerRuntime, msg: InvMoveMsg): InvErrCode | null {
  const t = sessionTarget(m, rt);
  if (typeof t === "string") return t;
  const idx = /^\d{1,3}$/.test(msg.key) ? Number(msg.key) : -1;
  if (idx < 0 || idx >= t.loot.total) return "gone";
  const src = t.loot.slots.get(msg.key);
  if (!src) return idx >= t.loot.revealed ? "not_revealed" : "gone";
  if (src.uid !== msg.uid || src.def !== msg.def) return "gone";
  if (src.flags & ITEM_FLAG.BROKEN) return "broken";
  if (msg.to !== undefined && !isSlotKey(msg.to)) return "bad_slot";
  const qty = msg.qty ?? src.qty;
  if (!Number.isInteger(qty) || qty < 1 || qty > src.qty) return "bad_slot";
  const r = takeSlot(m, rt, t, msg.key, qty, msg.to);
  if (r.code) return r.code;
  afterTake(m, rt, t);
  return null;
}

/**
 * INV_TAKE_ALL: every revealed, takeable slot in index order with auto-place. Stacks may be taken
 * partially; whatever does not fit stays. Returns how many slots were (partly) taken and "full"
 * when something was left behind for lack of room.
 */
export function takeAll(m: Match, rt: PlayerRuntime): { code: InvErrCode | null; taken: number } {
  const t = sessionTarget(m, rt);
  if (typeof t === "string") return { code: t, taken: 0 };
  let taken = 0;
  let full = false;
  const keys = [...t.loot.slots.keys()].sort((a, b) => Number(a) - Number(b));
  for (const key of keys) {
    const it = t.loot.slots.get(key);
    if (!it || it.flags & ITEM_FLAG.BROKEN) continue;
    const want = it.qty;
    const r = takeSlot(m, rt, t, key, want);
    if (r.placed > 0) taken++;
    if (r.code || r.placed < want) full = true;
  }
  if (taken > 0) afterTake(m, rt, t);
  return { code: full ? "full" : null, taken };
}

function afterTake(m: Match, rt: PlayerRuntime, t: SearchTarget): void {
  syncPublic(rt);
  emitSound(m, rt, SoundKind.loot, rt.pub.x, rt.pub.y);
  m.containers.checkEmptied(t);
}

// ---------------------------------------------------------------- room entry points

/** A living, acting player of a running match (the room's sessionId), else undefined. */
function actor(m: Match, sessionId: string): PlayerRuntime | undefined {
  if (m.ended) return undefined;
  const rt = m.runtime(sessionId);
  return rt?.pub.alive ? rt : undefined;
}

function invErr(m: Match, rt: PlayerRuntime, code: InvErrCode, key?: string, taken?: number): InvErrCode {
  if (!rt.isBot) {
    const msg: { code: InvErrCode; key?: string; taken?: number } = { code };
    if (key !== undefined) msg.key = key;
    if (taken !== undefined) msg.taken = taken;
    m.emit({ type: "invErr", to: rt.rosterIndex, msg });
  }
  return code;
}

/** INV_MOVE from a search session (rate-limited; errors are answered with INV_ERR). */
export function invTakeOp(m: Match, sessionId: string, msg: InvMoveMsg): InvErrCode | null {
  const rt = actor(m, sessionId);
  if (!rt) return "dead";
  if (!takeOpToken(rt, m.clock)) return invErr(m, rt, "rate");
  const code = takeFromLoot(m, rt, msg);
  return code ? invErr(m, rt, code, msg.key) : null;
}

/** INV_TAKE_ALL (one rate token for the whole batch). */
export function invTakeAllOp(m: Match, sessionId: string): InvErrCode | null {
  const rt = actor(m, sessionId);
  if (!rt) return "dead";
  if (!takeOpToken(rt, m.clock)) return invErr(m, rt, "rate");
  const r = takeAll(m, rt);
  return r.code ? invErr(m, rt, r.code, undefined, r.taken) : null;
}

/** Items of a corpse / container slot map as plain copies (tests, bots). */
export function lootItems(t: SearchTarget): Array<{ key: string; item: ItemLike }> {
  return [...t.loot.slots.entries()]
    .sort(([a], [b]) => Number(a) - Number(b))
    .map(([key, it]: [string, InvItem]) => ({ key, item: toPlain(it) }));
}
