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
 * - uniques: live mode = lost-pool items (legacy roster mode: the containerLoot allocation,
 *   registered in the ledger at match start; world maps: placed by pool-place.ts); demo mode = minted from CHEST_TABLES (registered as "minted" when rolled), only
 *   in containers of tier >= CONTAINER.DEMO_UNIQUE_MIN_TIER (v4 zoning, same as the live pool).
 * Boss pool items (containerLoot "boss:<kind>") and marauder carrier items ("npc:<post>.<member>") are held
 * here until npc.ts hands them to the NPC.
 *
 * A session closes on SEARCH_CLOSE, distance > SEARCH.CANCEL_RANGE (checked every tick; 128 vs the
 * 96 px open range is the hysteresis), firing (combat.ts), roll start, death, extract, disconnect
 * and match end. Movement and damage do not close it (prediction stays untouched).
 */

import {
  BACKPACK_SLOTS,
  CHEST_TABLES,
  CONTAINER,
  CONTAINER_STATE,
  ContainerLoot,
  Corpse,
  ITEM_FLAG,
  PLAYER,
  SEARCH,
  SOLID,
  SOUND,
  SoundKind,
  WORLD,
  accepts,
  bossKindOfLootKey,
  containerLootKey,
  containerOpenMs,
  corpseLootKey,
  hasLineOfSight,
  isSlotKey,
  itemDef,
  leaveVault,
  lootRollToItem,
  mulberry32,
  parseNpcCarrierKey,
  pickWeighted,
  planPlace,
  poolContainerEligible,
  revealMs,
  rollContainerFungibles,
  type BossKind,
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
  /** Corpses: the dead human's userId (own-corpse lock, D11); null for NPCs and containers. */
  ownerUser: string | null;
  /** Corpses: the dead runtime was an NPC (A6 expiry: pool items → pool, not treasury). */
  npcCorpse: boolean;
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
  /**
   * Searchers counted in RaidStats (searcherKey: the userId, so a re-entry of the same user does not
   * count the same target again). A search counts once its open delay has passed, not on the F press.
   */
  searchedBy: Set<string>;
  /** Truth of "fully revealed and nothing left" (the public flag waits for disclosure.ts). */
  emptied: boolean;
}

export class ContainerSystem {
  /** Live-mode pool uniques allocated to a container, by index (registered at match start / placed, v6). */
  private readonly pool = new Map<number, ItemLike[]>();
  /** WORLD v6 (D18): containers that got a placed pool item this cycle (one per container per cycle). */
  readonly poolPlaced = new Set<number>();
  /** WORLD v6 (A6): corpses in death order = expiry order (constant CORPSE_EXPIRE_MS), consumed from `expHead`. */
  private readonly expQueue: SearchTarget[] = [];
  private expHead = 0;
  /** Live-mode pool uniques allocated to a boss that has not taken them (yet / did not spawn). */
  private readonly bossPool = new Map<BossKind, ItemLike[]>();
  private readonly legacyBossPool: ItemLike[] = [];
  /** NPC MODEL v5: pool uniques allocated to a marauder carrier key "npc:<post>.<member>" not taken (yet / did not spawn). */
  private readonly carrierPool = new Map<string, ItemLike[]>();
  /** Opened containers and every corpse, by loot key. */
  readonly targets = new Map<string, SearchTarget>();
  /** Corpses in creation order (nearestOpenable's index space after the static containers). */
  private readonly corpseList: SearchTarget[] = [];
  /** Targets with at least one searcher (stepSearches iterates only these). */
  private readonly active = new Set<SearchTarget>();
  /**
   * The truth of every container's state. state.containerState is its public copy, updated only
   * once the players who changed it have left (disclosure.ts): a flip seen far away must not mark
   * a hidden player's live position.
   */
  private readonly truth: Uint8Array;

  constructor(private readonly m: Match) {
    const n = m.map.containers.length;
    this.truth = new Uint8Array(n).fill(CONTAINER_STATE.UNTOUCHED);
    for (let i = 0; i < n; i++) m.state.containerState.push(CONTAINER_STATE.UNTOUCHED);
  }

  /** Real state of container `idx` (rules and scripted humans; clients see the deferred public copy). */
  stateOf(idx: number): number {
    return this.truth[idx] ?? CONTAINER_STATE.UNTOUCHED;
  }

  private setState(idx: number, st: number, actors: Iterable<PlayerRuntime>): void {
    if (this.truth[idx] === st) return;
    this.truth[idx] = st;
    const spot = this.m.map.containers[idx]!;
    this.m.disclosure.defer(`c${idx}`, spot.x, spot.y, actors, () => {
      const v = this.truth[idx]!;
      if (this.m.state.containerState[idx] !== v) this.m.state.containerState[idx] = v;
    });
  }

  /**
   * Lost-pool items of a legacy roster match (MatchOptions.containerLoot), registered in the ledger as "pool":
   * - "<idx>": a static container (rolled into it on first open);
   * - bossLootKey(kind) = "boss:<kind>": that boss's bag (boss.ts takes them at spawn; a boss that
   *   did not spawn leaves them here → leftOnMap, back to the pool with no wear);
   * - legacy "boss" (pre-v4 web): given to the first boss that spawns, else leftOnMap;
   * - npcCarrierKey(post, member) = "npc:<post>.<member>" (v5): one stowed unique on that marauder
   *   (npc.ts takes it at spawn; a carrier that did not spawn leaves it here → leftOnMap, no wear).
   * Unknown keys / indexes are ignored (never registered: the web sweeps them back to the pool).
   */
  allocatePool(containerLoot: Readonly<Record<string, SettledItem[]>>): void {
    const toItems = (items: readonly SettledItem[]): ItemLike[] => {
      const out: ItemLike[] = [];
      for (const s of items) {
        if (!itemDef(s.def)) continue;
        const it = makeItem(s.def, { uid: s.uid, qty: s.qty, rarity: s.rarity, dur: s.dur, label: s.label, lvl: s.lvl });
        this.m.ledger.register(it, "pool");
        out.push(it);
      }
      return out;
    };
    for (const [key, items] of Object.entries(containerLoot)) {
      const kind = bossKindOfLootKey(key);
      if (kind) {
        this.bossPool.set(kind, [...(this.bossPool.get(kind) ?? []), ...toItems(items)]);
        continue;
      }
      if (key === "boss") {
        this.legacyBossPool.push(...toItems(items));
        continue;
      }
      if (parseNpcCarrierKey(key)) {
        this.carrierPool.set(key, [...(this.carrierPool.get(key) ?? []), ...toItems(items)]);
        continue;
      }
      const idx = Number(key);
      if (!/^\d+$/.test(key) || !Number.isInteger(idx) || idx < 0 || idx >= this.m.map.containers.length) continue;
      this.pool.set(idx, [...(this.pool.get(idx) ?? []), ...toItems(items)]);
    }
  }

  /** The pool items allocated to boss `kind` (removed from here: the boss carries them now). */
  takeBossPool(kind: BossKind): ItemLike[] {
    const out = this.bossPool.get(kind) ?? [];
    this.bossPool.delete(kind);
    return out;
  }

  /** The pool items allocated to marauder carrier `key` (removed from here: the NPC carries them now). */
  takeCarrierPool(key: string): ItemLike[] {
    const out = this.carrierPool.get(key) ?? [];
    this.carrierPool.delete(key);
    return out;
  }

  /** Carrier items an NPC could not take (over NPC_CARRIER.MAX_PER_NPC, not eligible): left on the map. */
  returnCarrierPool(key: string, items: ItemLike[]): void {
    this.carrierPool.set(key, [...(this.carrierPool.get(key) ?? []), ...items]);
  }

  /** Legacy "boss" key items (pre-v4 web), removed from here. */
  takeLegacyBossPool(): ItemLike[] {
    return this.legacyBossPool.splice(0);
  }

  /** Legacy items no boss took: they stay on the map (leftOnMap). */
  returnLegacyBossPool(items: ItemLike[]): void {
    this.legacyBossPool.push(...items);
  }

  /**
   * WORLD v6 (D18, pool-place.ts): may a released pool item go into container `idx` now? Untouched,
   * pool-eligible (kind + tier) and no pool item placed in it this cycle.
   */
  poolTargetOk(idx: number): boolean {
    const spot = this.m.map.containers[idx];
    return !!spot && poolContainerEligible(spot) && !this.poolPlaced.has(idx) && !this.pool.has(idx) &&
      this.stateOf(idx) === CONTAINER_STATE.UNTOUCHED && !this.targets.has(containerLootKey(idx));
  }

  /** WORLD v6: put an (already registered) pool item into untouched container `idx` (rolled in on first open). */
  placePoolItem(idx: number, it: ItemLike): void {
    this.pool.set(idx, [...(this.pool.get(idx) ?? []), it]);
    this.poolPlaced.add(idx);
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
      const rng = mulberry32(uniqueSeed(m.lootSeed, idx));
      // v4 zoning: demo uniques only in T3/T4 containers, like the live pool (draws unchanged).
      const uniquesHere = spot.tier >= CONTAINER.DEMO_UNIQUE_MIN_TIER;
      for (let i = 0; i < table.rolls; i++) {
        const r = lootRollToItem(pickWeighted(rng, table.loot));
        const d = itemDef(r.def)!;
        if (d.unique) {
          if (!uniquesHere) continue;
          const it = makeItem(r.def, { uid: m.newUid(), rarity: r.rarity });
          m.ledger.register(it, "minted");
          out.push(it);
        } else {
          out.push(makeItem(r.def, { qty: r.qty, rarity: r.rarity }));
        }
      }
    }
    // Live allocations, and (WORLD v6) server-placed pool items in either mode.
    out.push(...(this.pool.get(idx) ?? []));
    this.pool.delete(idx);
    for (const f of rollContainerFungibles(m.lootSeed, idx, spot)) {
      out.push(makeItem(f.def, { qty: f.qty, rarity: f.rarity }));
    }
    return out;
  }

  private createTarget(t: Omit<SearchTarget, "loot" | "searchers" | "ready" | "searchedBy" | "initial" | "emptied" | "ownerUser" | "npcCorpse"> & Partial<Pick<SearchTarget, "ownerUser" | "npcCorpse">>): SearchTarget {
    const loot = new ContainerLoot();
    // uint8 on the wire: a corpse holds ≤ 4 + 4 + 16 + 1 entries, a container a handful.
    loot.total = Math.min(255, t.items.length);
    if (t.items.length > 255) t.items.length = 255;
    const target: SearchTarget = {
      ownerUser: null,
      npcCorpse: false,
      ...t,
      initial: t.items.map(toPlain),
      loot,
      searchers: new Set(),
      ready: new Set(),
      searchedBy: new Set(),
      emptied: false,
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
    this.setState(idx, CONTAINER_STATE.OPENED, [opener]);
    // Lid creak: heard as a quantized sound; the opener's viewers also get the chest event.
    this.m.emit({ type: "chest", src: opener.rosterIndex, idx });
    emitSound(this.m, opener, SoundKind.loot, spot.x, spot.y);
    return t;
  }

  /**
   * The body of a player who just died, holding `items` in slot order. Synced to clients through
   * state.corpses (AOI-filtered); the contents only through the searchers' loot entry k<id>.
   */
  addCorpse(rt: PlayerRuntime, items: ItemLike[]): SearchTarget {
    // A body killed mid-vault lies on the nearer side of the window, never inside it: interaction
    // line of sight (MOVE) cannot reach a point inside a window, so it would be unlootable.
    const p = rt.pub;
    const at = leaveVault(this.m.idx, p.x, p.y, PLAYER.RADIUS, rt.self.rollDx, rt.self.rollDy);
    const c = new Corpse();
    c.id = String(rt.rosterIndex);
    c.x = at.x;
    c.y = at.y;
    c.label = rt.nickname;
    c.color = p.color;
    c.rot = p.aim;
    // WORLD v6 (A6): the body and what is left in it vanish CORPSE_EXPIRE_MS after the death.
    if (this.m.world) c.expiresAt = this.m.clock + WORLD.CORPSE_EXPIRE_MS;
    const t = this.createTarget({
      key: corpseLootKey(c.id), kind: "corpse", idx: -1, corpse: c, owner: rt.rosterIndex, x: at.x, y: at.y,
      openMs: SEARCH.OPEN_MS.corpse, items, ownerUser: rt.isNpc ? null : rt.userId, npcCorpse: rt.isNpc,
    });
    this.corpseList.push(t);
    if (this.m.world) this.expQueue.push(t);
    this.m.state.corpses.set(c.id, c);
    return t;
  }

  /**
   * WORLD v6 (A6): remove every corpse whose time is up (expiry order = death order, so this only
   * looks at the head of the queue). Open searches close first (nothing is half-moved). Returns what
   * was still inside: tracked uniques by destination; fungibles are destroyed (not returned).
   */
  expireCorpses(clock: number): { treasury: ItemLike[]; pool: ItemLike[] } {
    const out = { treasury: [] as ItemLike[], pool: [] as ItemLike[] };
    while (this.expHead < this.expQueue.length) {
      const t = this.expQueue[this.expHead]!;
      if (t.corpse!.expiresAt > clock) break;
      this.expHead++;
      for (const rt of [...t.searchers]) closeSearch(this.m, rt, "expired");
      for (const it of this.remaining(t)) if (isTrackedUnique(it)) (t.npcCorpse ? out.pool : out.treasury).push(it);
      this.targets.delete(t.key);
      this.active.delete(t);
      const k = this.corpseList.indexOf(t);
      if (k >= 0) this.corpseList.splice(k, 1);
      this.m.state.loot.delete(t.key);
      if (this.m.state.corpses.get(t.corpse!.id) === t.corpse) this.m.state.corpses.delete(t.corpse!.id);
    }
    if (this.expHead > 64 && this.expHead * 2 > this.expQueue.length) {
      this.expQueue.splice(0, this.expHead);
      this.expHead = 0;
    }
    return out;
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
      if (this.truth[i] === CONTAINER_STATE.EMPTIED) continue;
      const c = m.map.containers[i]!;
      // Cheap box reject before the distance / LOS work (≈400 containers on the Steppe).
      if (Math.abs(c.x - p.x) > SEARCH.OPEN_RANGE || Math.abs(c.y - p.y) > SEARCH.OPEN_RANGE) continue;
      consider(i, c.x, c.y);
    }
    this.corpseList.forEach((t, k) => {
      if (!t.emptied && !this.ownBody(rt, t)) consider(n + k, t.x, t.y);
    });
    return best;
  }

  /**
   * WORLD v6 (D11): the corpse of the searcher's own earlier entry (same user, another runtime).
   * Never searchable by that user (InvErr "own_body"); alts still can (vulture rule later).
   */
  ownBody(rt: PlayerRuntime, t: SearchTarget): boolean {
    return t.ownerUser !== null && t.ownerUser === rt.userId && t.owner !== rt.rosterIndex;
  }

  /** An own body (ownBody) within open range and line of sight: F answers "own_body" when nothing else is there. */
  ownBodyNear(rt: PlayerRuntime): boolean {
    const p = rt.pub;
    return this.corpseList.some((t) => !t.emptied && this.ownBody(rt, t) &&
      (t.x - p.x) ** 2 + (t.y - p.y) ** 2 <= SEARCH.OPEN_RANGE ** 2 && hasLineOfSight(this.m.idx, p.x, p.y, t.x, t.y, SOLID.MOVE));
  }

  /**
   * Open the target with loot key `key` (c<idx> / k<corpseId>) if it is openable from where the
   * player stands (same range / line-of-sight / not-emptied rules as nearestOpenable). Scripted
   * test / bench humans use this instead of the generic F, which would open whatever is nearest.
   * Returns true if opened.
   */
  openKey(rt: PlayerRuntime, key: string): boolean {
    const m = this.m;
    const nc = m.map.containers.length;
    let n = -1;
    let x = 0, y = 0;
    if (/^c\d+$/.test(key)) {
      const idx = Number(key.slice(1));
      const spot = m.map.containers[idx];
      if (!spot || this.stateOf(idx) === CONTAINER_STATE.EMPTIED) return false;
      n = idx;
      x = spot.x;
      y = spot.y;
    } else {
      const k = this.corpseList.findIndex((t) => t.key === key);
      const t = this.corpseList[k];
      if (!t || t.emptied) return false;
      if (this.ownBody(rt, t)) {
        invErr(m, rt, "own_body", key);
        return false;
      }
      n = nc + k;
      x = t.x;
      y = t.y;
    }
    const p = rt.pub;
    if ((x - p.x) ** 2 + (y - p.y) ** 2 > SEARCH.OPEN_RANGE ** 2) return false;
    if (!hasLineOfSight(m.idx, p.x, p.y, x, y, SOLID.MOVE)) return false;
    this.open(rt, n);
    return true;
  }

  /** F on what nearestOpenable returned: start (or keep) a search session. */
  open(rt: PlayerRuntime, n: number): void {
    const nc = this.m.map.containers.length;
    const t = n < nc ? this.containerTarget(n, rt) : this.corpseList[n - nc];
    if (t) this.startSession(rt, t);
  }

  private startSession(rt: PlayerRuntime, t: SearchTarget): void {
    const m = this.m;
    // NPCs never open containers or search bodies (NPC MODEL v5).
    if (!rt.pub.alive || rt.isNpc) return;
    // F again on the target being searched is a no-op (the panel is already open).
    if (rt.search?.key === t.key) return;
    closeSearch(m, rt, "switch");
    const readyAt = m.clock + t.openMs;
    rt.search = { key: t.key, readyAt };
    rt.self.searching = t.key;
    rt.self.searchReadyAt = readyAt;
    t.searchers.add(rt);
    this.active.add(t);
    if (t.kind === "corpse" && this.ownBody(rt, t)) return;
    if (t.corpse && !t.corpse.opened) {
      const c = t.corpse;
      m.disclosure.defer(`o${t.key}`, t.x, t.y, [rt], () => {
        if (!c.opened) c.opened = true;
      });
    }
    emitSound(m, rt, SoundKind.search, rt.pub.x, rt.pub.y);
    rt.nextSearchSoundAt = m.clock + SOUND.SEARCH_REPEAT_MS;
    syncPublic(rt);
  }

  /** Remove `rt` from its session's target (closeSearch does the player side). */
  leave(rt: PlayerRuntime, key: string): void {
    const t = this.targets.get(key);
    if (!t) return;
    t.searchers.delete(rt);
    if (t.ready.delete(rt) && !rt.isNpc) this.m.emit({ type: "view", to: rt.rosterIndex, op: "remove", key });
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
          if (!rt.isNpc) m.emit({ type: "view", to: rt.rosterIndex, op: "add", key: t.key });
          this.countSearch(rt, t);
        }
        if (m.clock >= rt.nextSearchSoundAt) {
          emitSound(m, rt, SoundKind.search, p.x, p.y);
          rt.nextSearchSoundAt = m.clock + SOUND.SEARCH_REPEAT_MS;
        }
      }
      this.reveal(t);
    }
  }

  /**
   * RaidStats (XP containers line): a target counts for a searcher once its open delay has passed
   * (an F tap cancelled at once is no search), and once per user per match (a re-entry does not
   * count the targets this user already searched). An own body never counts.
   */
  private countSearch(rt: PlayerRuntime, t: SearchTarget): void {
    if (rt.isNpc || (t.kind === "corpse" && this.ownBody(rt, t))) return;
    const who = rt.userId ?? `r${rt.rosterIndex}`;
    if (t.searchedBy.has(who)) return;
    t.searchedBy.add(who);
    if (t.kind === "corpse") rt.stats.corpsesSearched++;
    else rt.stats.containersSearched++;
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

  /**
   * Fully revealed and nothing left: "emptied" (lid / body renders empty). The truth flips now; the
   * public flag once `actors` (default: the target's searchers) have left (disclosure.ts).
   */
  checkEmptied(t: SearchTarget, actors: Iterable<PlayerRuntime> = t.searchers): void {
    if (t.emptied || t.loot.revealed < t.loot.total || t.loot.slots.size > 0) return;
    t.emptied = true;
    const c = t.corpse;
    if (c) {
      this.m.disclosure.defer(`e${t.key}`, t.x, t.y, actors, () => {
        if (!c.empty) c.empty = true;
      });
    } else {
      this.setState(t.idx, CONTAINER_STATE.EMPTIED, actors);
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
   * live pool allocations (containers, bosses and carriers that did not spawn) plus the remaining contents
   * of every target. Broken items never sit in
   * a corpse (they were reported lost at death).
   */
  leftInside(): ItemLike[] {
    const out = [...this.pool.values(), ...this.bossPool.values(), ...this.carrierPool.values(), this.legacyBossPool].flat();
    for (const t of this.targets.values()) for (const it of this.remaining(t)) if (isTrackedUnique(it)) out.push(it);
    return out;
  }
}

// ---------------------------------------------------------------- session API (match / room / scripted humans)

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
        spawnGroundItem(m, { ...old, qty: old.qty - r.placed }, at.x, at.y, rt);
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
  m.containers.checkEmptied(t, [rt, ...t.searchers]);
}

// ---------------------------------------------------------------- room entry points

/** A living, acting human of a running match (the room's sessionId), else undefined. NPCs never loot. */
function actor(m: Match, sessionId: string): PlayerRuntime | undefined {
  if (m.ended) return undefined;
  const rt = m.runtime(sessionId);
  return rt?.pub.alive && !rt.isNpc ? rt : undefined;
}

function invErr(m: Match, rt: PlayerRuntime, code: InvErrCode, key?: string, taken?: number): InvErrCode {
  if (!rt.isNpc) {
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

/** Items of a corpse / container slot map as plain copies (tests, scripted humans). */
export function lootItems(t: SearchTarget): Array<{ key: string; item: ItemLike }> {
  return [...t.loot.slots.entries()]
    .sort(([a], [b]) => Number(a) - Number(b))
    .map(([key, it]: [string, InvItem]) => ({ key, item: toPlain(it) }));
}
