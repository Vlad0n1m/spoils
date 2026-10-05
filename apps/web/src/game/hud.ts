/**
 * Builds the HudSnapshot (src/game/types.ts) from the synced state, and the store React reads it
 * through. Pure: no Pixi, no DOM, no React.
 *
 * v2: the public Player (state.players, LOS-filtered) carries only hp / alive / position; the
 * inventory, timers, kills and extract mask come from the owner-only SelfState
 * (state.self.get(selfKey)). Player counts come from BattleState.aliveCount / totalPlayers because
 * state.players now only holds the players this client can see.
 */

import {
  ARMOR,
  CONTAINER_STATE,
  GRENADE_DEF,
  HEAL,
  ITEM_FLAG,
  BOSSES,
  MATCH,
  PLAYER,
  WORLD,
  POCKET_SLOTS,
  BACKPACK_SLOTS,
  RARITY_NAMES,
  ROLL,
  INPUT_DT_MS,
  SEARCH,
  DROP,
  isSupplyDropId,
  isSupplyDropKey,
  isCacheId,
  isCacheKey,
  CACHE,
  CRACK,
  crackSafes,
  gateClosed,
  lockedRooms,
  SOLID,
  WEAPONS,
  XP,
  bpLevelOf,
  containerOpenMs,
  extractOpenAtFor,
  countOf,
  hasLineOfSight,
  itemDef,
  junkCredits,
  storageKeys,
  type BattleState,
  type BossKind,
  type CollisionIndex,
  type ContainerSpot,
  type Extract,
  type HealKind,
  type InvItem,
  type MapData,
  type Player,
  type SelfState,
  type SlotStore,
} from "@extract/shared";
import { containerTitle } from "../lib/items-ui";
import type { ExtractStatus } from "./entities";
import type { HudBoss, HudExtract, HudSelf, HudSlot, HudSnapshot, KillFeedEntry, WipeWarn } from "./types";
import { bodyTitle, type KillTally } from "./npc-labels";
import type { KnownEmpty } from "./known-empty";

export function extractStatus(e: Pick<Extract, "openAt" | "closeAt">, clockMs: number): ExtractStatus {
  if (e.closeAt > 0 && clockMs >= e.closeAt) return "closed";
  return clockMs >= e.openAt ? "open" : "waiting";
}

/**
 * WORLD v6 (D8): status of extract `e` for THIS player — the map-level openAt / closeAt from the
 * state plus the personal arm (SelfState.extractArmAt, `enteredAt + EXTRACT_ARM_MS`).
 */
export function personalExtractStatus(
  e: Pick<Extract, "openAt" | "closeAt">,
  self: { extractArmAt?: number } | null | undefined,
  clockMs: number,
): ExtractStatus {
  return extractStatus({ openAt: extractOpenAtFor(e, self), closeAt: e.closeAt }, clockMs);
}

/**
 * The HUD phase for this player: "drop" until their own extracts arm (D8), "open" after, "ended"
 * once the map wiped. Legacy matches (armAt 0) follow BattleState.phase.
 */
export function hudPhase(statePhase: string, clockMs: number, armAt: number): HudSnapshot["phase"] {
  if (statePhase === "ended") return "ended";
  if (statePhase === "drop" || clockMs < armAt) return "drop";
  return "open";
}

/** A wipe warning banner stays this long after its threshold is crossed. */
export const WIPE_WARN_SHOW_MS = 8_000;
/** The top timer turns urgent in the last 5 minutes before the wipe. */
export const WIPE_URGENT_MS = 5 * 60_000;

/**
 * The wipe warning (D2) just crossed at `leftMs` before the wipe: 600 / 300 / 60 (seconds) for
 * WIPE_WARN_SHOW_MS after WORLD.WARN_AT_MS, else 0. Derived from the clock, no server message.
 */
export function wipeWarnAt(leftMs: number): WipeWarn {
  for (const t of WORLD.WARN_AT_MS) {
    if (leftMs <= t && leftMs > t - WIPE_WARN_SHOW_MS) return (t / 1000) as WipeWarn;
  }
  return 0;
}

/** "Wipe in 10:00 — head for an extract". */
export function wipeWarnText(w: Exclude<WipeWarn, 0>): string {
  const m = Math.floor(w / 60);
  const s = w % 60;
  return `Wipe in ${m}:${String(s).padStart(2, "0")} — head for an extract`;
}

const isBossKind = (k: string): k is BossKind => Object.prototype.hasOwnProperty.call(BOSSES, k);

/** The map's event boss from BattleState (D13), null on a map without one. */
export function hudBoss(state: Pick<BattleState, "bossKind" | "bossZone" | "bossState">): HudBoss | null {
  if (!state.bossKind || !isBossKind(state.bossKind)) return null;
  if (state.bossState !== 1 && state.bossState !== 2) return null;
  return { kind: state.bossKind, zone: state.bossZone, state: state.bossState };
}

/** Boss toast: "BOSS EVENT · Foreman holds the Grain Elevator" / "Foreman is down". */
export function bossToastText(b: HudBoss): { title: string; sub: string } {
  const name = BOSSES[b.kind].name;
  if (b.state === 2) return { title: `${name} is down`, sub: "The boss of this map was taken down" };
  const zone = b.zone.trim();
  const where = zone ? ` holds ${/^the\s/i.test(zone) ? "" : "the "}${zone}` : " is on this map";
  return { title: "BOSS EVENT", sub: `${name}${where}` };
}

const EMPTY_SLOT: HudSlot = { weapon: "", rarity: 0, mag: 0, magSize: 0, free: false, broken: false };

function hudSlot(it: Pick<InvItem, "def" | "rarity" | "mag" | "flags"> | undefined): HudSlot {
  const w = it ? itemDef(it.def)?.weapon : undefined;
  if (!it || !w) return EMPTY_SLOT;
  return {
    weapon: w,
    rarity: it.rarity,
    mag: it.mag,
    magSize: WEAPONS[w].magSize,
    free: (it.flags & ITEM_FLAG.FREE) !== 0,
    broken: (it.flags & ITEM_FLAG.BROKEN) !== 0,
  };
}

/** The SelfState fields the HUD reads (a decoded SelfState satisfies it; tests pass plain objects). */
export type HudSelfState = Pick<
  SelfState,
  | "active" | "reloadUntil" | "healUntil" | "healKind" | "searching" | "searchReadyAt"
  | "extractStartedAt" | "extractedAt" | "kills" | "extractMask"
> & { slots: SlotStore<InvItem>; raidXp?: number };

/** Locally predicted movement state (Predictor) the HUD shows. */
export interface HudMovement {
  /** Remaining roll cooldown (Predictor.rollCooldownMs). */
  rollCooldownMs: number;
  rolling: boolean;
  walking: boolean;
}

const ROLL_CD_MS = ROLL.COOLDOWN_TICKS * INPUT_DT_MS;
/** readyAtMs is quantised so the slice does not change on every push while the clock estimate jitters. */
const ROLL_READY_QUANT_MS = 100;

/** Title of a search target from its loot key ("c<idx>" container, "k<corpseId>" corpse). */
export function searchTitle(key: string, map: Pick<MapData, "containers"> | null, state: Pick<BattleState, "corpses"> | null): string {
  if (key.startsWith("c")) {
    const spot = map?.containers[Number(key.slice(1))];
    return spot ? containerTitle(spot.kind) : "Container";
  }
  if (isSupplyDropKey(key)) return "Supply drop";
  if (isCacheKey(key)) return "Hidden cache";
  if (key.startsWith("k")) {
    // NPC bodies read by role ("Marauder's body"), never as a nickname.
    return bodyTitle(state?.corpses.get(key.slice(1))?.label);
  }
  return "";
}

/** Open delay of a search target (the same function the server times it with). */
export function searchOpenMs(key: string, map: Pick<MapData, "containers"> | null): number {
  if (key.startsWith("c")) {
    const spot = map?.containers[Number(key.slice(1))];
    return spot ? containerOpenMs(spot) : SEARCH.OPEN_MS.tier[1]!;
  }
  if (isCacheKey(key)) return CACHE.OPEN_MS;
  return isSupplyDropKey(key) ? DROP.OPEN_MS : SEARCH.OPEN_MS.corpse;
}

export interface HudSelfInput {
  me: Pick<Player, "alive" | "hp" | "diedAt"> | null;
  self: HudSelfState;
  clockMs: number;
  move?: HudMovement | null;
  map?: Pick<MapData, "containers"> | null;
  state?: Pick<BattleState, "corpses"> | null;
}

export function buildHudSelf({ me, self, clockMs, move = null, map = null, state = null }: HudSelfInput): HudSelf {
  const s = self.slots;
  const active: 0 | 1 = self.active === "w2" ? 1 : 0;
  const slots: [HudSlot, HudSlot] = [hudSlot(s.get("w1")), hudSlot(s.get("w2"))];
  const activeW = slots[active].weapon;

  const armorIt = s.get("armor");
  const armorLevel = armorIt ? (itemDef(armorIt.def)?.armorLevel ?? 0) : 0;

  let reloading: HudSelf["reloading"] = null;
  if (self.reloadUntil > clockMs) {
    const dur = activeW ? WEAPONS[activeW].reloadMs : 0;
    reloading = { startMs: self.reloadUntil - dur, untilMs: self.reloadUntil };
  }
  let healing: HudSelf["healing"] = null;
  if (self.healUntil > clockMs && (self.healKind === "bandage" || self.healKind === "medkit")) {
    const kind = self.healKind as HealKind;
    healing = { kind, startMs: self.healUntil - HEAL[kind].MS, untilMs: self.healUntil };
  }
  const alive = me ? me.alive : false;
  const extracting =
    self.extractStartedAt > 0 && alive && self.extractedAt === 0
      ? { startedAtMs: self.extractStartedAt, channelMs: MATCH.EXTRACT_CHANNEL_MS }
      : null;

  const cd = Math.max(0, move?.rollCooldownMs ?? 0);
  const readyAtMs = cd > 0 ? Math.ceil((clockMs + cd) / ROLL_READY_QUANT_MS) * ROLL_READY_QUANT_MS : 0;

  let search: HudSelf["search"] = null;
  if (self.searching) {
    const readyAtMs = self.searchReadyAt;
    search = {
      key: self.searching,
      title: searchTitle(self.searching, map, state),
      startMs: readyAtMs - searchOpenMs(self.searching, map),
      readyAtMs,
    };
  }

  const bpLevel = bpLevelOf(s);
  const keys = storageKeys(s);
  let used = 0;
  const carried: InvItem[] = [];
  for (const k of keys) {
    const it = s.get(k);
    if (!it) continue;
    used++;
    if (!(it.flags & ITEM_FLAG.FREE)) carried.push(it);
  }

  return {
    alive,
    hp: me?.hp ?? 0,
    maxHp: PLAYER.MAX_HP,
    armor: armorLevel,
    armorDur: armorLevel && armorIt ? armorIt.dur : 0,
    armorMax: armorLevel ? ARMOR[armorLevel].durability : 0,
    slots,
    active,
    ammo: { light: countOf(s, "ammo_light"), shell: countOf(s, "ammo_shell"), heavy: countOf(s, "ammo_heavy"), bolt: countOf(s, "ammo_bolt") },
    bandages: countOf(s, "bandage"),
    medkits: countOf(s, "medkit"),
    grenades: countOf(s, GRENADE_DEF),
    reloading,
    healing,
    extracting,
    kills: self.kills,
    diedAt: me?.diedAt ?? 0,
    extractedAt: self.extractedAt,
    roll: { readyAtMs, cdStartMs: readyAtMs ? readyAtMs - ROLL_CD_MS : 0, rolling: move?.rolling ?? false },
    walking: move?.walking ?? false,
    search,
    bpLevel,
    storageUsed: used,
    storageCap: POCKET_SLOTS + (BACKPACK_SLOTS[bpLevel] ?? 0),
    creditsEstimate: junkCredits(carried),
    extractMask: self.extractMask || 0xff,
    raidXp: self.raidXp ?? 0,
  };
}

/** Is state extract `e` allowed by the mask? Index = position of its id in MapData.extracts. */
export function extractAllowed(map: Pick<MapData, "extracts"> | null, mask: number, id: string): boolean {
  if (!map || mask === 0xff || mask === 0) return true;
  const i = map.extracts.findIndex((x) => x.id === id);
  return i < 0 || i > 7 ? true : (mask & (1 << i)) !== 0;
}

function itemLabel(def: string, rarity: number, qty: number): string {
  const d = itemDef(def);
  if (!d) return def;
  if (d.cat === "weapon") return `${d.name} (${RARITY_NAMES[rarity] ?? "common"})`;
  return qty > 1 ? `${d.name} ×${qty}` : d.name;
}

export interface InteractInput {
  state: Pick<BattleState, "containerState" | "corpses" | "items">;
  map: Pick<MapData, "containers"> | null;
  x: number;
  y: number;
  /** Map collision index for the line-of-sight check (null before the map is built). */
  idx?: CollisionIndex | null;
  /** Targets this client searched and saw empty (known-empty.ts): no prompt for them. */
  known?: Pick<KnownEmpty, "container" | "corpse"> | null;
  /**
   * In-raid objectives (null = off: BattleState.lockState empty): the full map (lockedRooms /
   * crackSafes) and what the player carries (a gate's key).
   */
  objectives?: { map: MapData; carries: (def: string) => boolean } | null;
}

/** Display name of an item def ("Radar office key"). */
function defName(def: string): string {
  return itemDef(def)?.name ?? def;
}

/**
 * Hint for F, mirroring the server's choice (Match.interact): the nearest searchable container
 * (not emptied) or corpse (not empty) within SEARCH.OPEN_RANGE wins; otherwise the nearest ground
 * item within PLAYER.INTERACT_RADIUS. Only targets in line of sight (MOVE mask, as the server)
 * count when the collision index is known. Ties go to the later entry, like the server's scan.
 */
export function interactHint({ state, map, x, y, idx = null, known = null, objectives = null }: InteractInput): string | null {
  const visible = (tx: number, ty: number) => !idx || hasLineOfSight(idx, x, y, tx, ty, SOLID.MOVE);
  const R = SEARCH.OPEN_RANGE;
  let bestD = R * R;
  let hint: string | null = null;
  const containers: readonly ContainerSpot[] = map?.containers ?? [];
  for (let i = 0; i < containers.length; i++) {
    const c = containers[i]!;
    const dx = c.x - x, dy = c.y - y;
    const d = dx * dx + dy * dy;
    if (d > bestD) continue;
    if ((state.containerState[i] ?? 0) === CONTAINER_STATE.EMPTIED || known?.container(i) || !visible(c.x, c.y)) continue;
    bestD = d;
    const crack = objectives && (state.containerState[i] ?? 0) === CONTAINER_STATE.UNTOUCHED && crackSafes(objectives.map).has(i);
    hint = crack ? `F — crack safe (${CRACK.MS / 1000} s, loud)` : `F — search ${containerTitle(c.kind)}`;
  }
  // In-raid objectives: a locked gate nearer than any container wins (Objectives.interact).
  if (objectives && idx) {
    const om = objectives.map;
    let gateD = 110 * 110;
    let gateHint: string | null = null;
    for (const l of lockedRooms(om)) {
      if (!gateClosed(idx, om, l.id)) continue;
      for (const g of l.doors) {
        const nx = Math.max(g.x, Math.min(x, g.x + g.w)), ny = Math.max(g.y, Math.min(y, g.y + g.h));
        const d = (nx - x) ** 2 + (ny - y) ** 2;
        if (d > gateD) continue;
        gateD = d;
        gateHint = objectives.carries(l.key) ? `F — unlock with ${defName(l.key)}` : `Locked — needs ${defName(l.key)}`;
      }
    }
    if (gateHint && (hint === null || gateD < bestD)) return gateHint;
  }
  state.corpses.forEach((k, id) => {
    if (k.empty || known?.corpse(id)) return;
    const d = (k.x - x) ** 2 + (k.y - y) ** 2;
    if (d > bestD || !visible(k.x, k.y)) return;
    bestD = d;
    hint = isSupplyDropId(id) ? "F — open supply drop" : isCacheId(id) ? "F — open hidden cache" : `F — search ${k.label ? `${k.label}'s body` : "body"}`;
  });
  if (hint) return hint;

  bestD = PLAYER.INTERACT_RADIUS * PLAYER.INTERACT_RADIUS;
  state.items.forEach((it) => {
    const d = (it.x - x) ** 2 + (it.y - y) ** 2;
    if (d > bestD || !itemDef(it.def) || !visible(it.x, it.y)) return;
    bestD = d;
    hint = `F — pick up ${itemLabel(it.def, it.rarity, it.qty)}`;
  });
  return hint;
}

export interface PlayerCounts {
  /** Players still on the map: alive and not extracted. */
  alive: number;
  /** Human roster size (NPCs never count as players), never shrinks. */
  total: number;
}

/** Players still on the map and the roster size, as the server counts them. */
export function countPlayers(state: Pick<BattleState, "aliveCount" | "totalPlayers">): PlayerCounts {
  return { alive: state.aliveCount, total: state.totalPlayers };
}

/**
 * Counts to show in the HUD. When the raid ends the server takes everyone still on the map off it
 * (timeout), and a closing room may clear the state — both would show "0/N" (or "0/0"). Keep the
 * last count taken while the raid was running instead; the roster size only ever grows.
 */
export function stickyCounts(
  prev: PlayerCounts | null,
  snap: Pick<HudSnapshot, "phase" | "aliveCount" | "totalPlayers">,
): PlayerCounts {
  const total = Math.max(prev?.total ?? 0, snap.totalPlayers);
  const live = snap.phase !== "ended" && snap.totalPlayers > 0;
  if (live || !prev) return { alive: snap.aliveCount, total };
  return { alive: prev.alive, total };
}

export interface HudInput {
  state: BattleState;
  sessionId: string;
  selfKey: string | null;
  /** Local (predicted) position, or the last known one after death / extraction. */
  selfPos: { x: number; y: number } | null;
  clockMs: number;
  killFeed: KillFeedEntry[];
  /** The local player's kills by victim kind (renderer tally of its own KillMsgs). */
  killTally?: KillTally;
  pingMs: number | null;
  /** Map collision index, for the interact hint's line-of-sight check (null before the map is built). */
  idx?: CollisionIndex | null;
  map?: MapData | null;
  move?: HudMovement | null;
  /** Targets this client searched and saw empty (known-empty.ts). */
  known?: Pick<KnownEmpty, "container" | "corpse"> | null;
  /** The local player's running objective channel (objectives.ts): replaces the F hint. */
  channel?: "unlock" | "crack" | null;
}

/** The bottom hint while an unlock / crack channel runs (the server breaks it on damage or moving). */
export function channelHint(kind: "unlock" | "crack"): string {
  return kind === "crack" ? "Cracking… (move or get hit to stop)" : "Unlocking… (move or get hit to stop)";
}

/** interactHint's objectives input: on only while BattleState.lockState lists the map's locks. */
function objectivesOf(state: BattleState, map: MapData | null, priv: SelfState | null): InteractInput["objectives"] {
  if (!map || !priv || !(state.lockState?.length > 0)) return null;
  return {
    map,
    carries: (def) => {
      for (const it of priv.slots.values()) if (it.def === def) return true;
      return false;
    },
  };
}

export function buildHud({
  state, sessionId, selfKey, selfPos, clockMs, killFeed, killTally, pingMs, idx = null, map = null, move = null, known = null, channel = null,
}: HudInput): HudSnapshot {
  const me = state.players.get(sessionId) ?? null;
  const priv = selfKey ? (state.self.get(selfKey) ?? null) : null;
  // Before the public entry arrives (join) there is nothing to show yet: the loader stays up.
  const self = priv && (me || priv.extractedAt > 0) ? buildHudSelf({ me, self: priv, clockMs, move, map, state }) : null;
  const onMap = !!self && self.alive && self.extractedAt === 0;
  const mask = self?.extractMask ?? 0xff;

  const { alive: aliveCount, total: totalPlayers } = countPlayers(state);

  let extractOpenAtMs = Infinity;
  const extracts: HudExtract[] = [];
  state.extracts.forEach((e) => {
    extractOpenAtMs = Math.min(extractOpenAtMs, e.openAt);
    if (!selfPos || !extractAllowed(map, mask, e.id)) return;
    const status = personalExtractStatus(e, priv, clockMs);
    if (status === "closed") return;
    const dx = e.x - selfPos.x;
    const dy = e.y - selfPos.y;
    const name = map?.extracts.find((x) => x.id === e.id)?.name ?? e.id;
    extracts.push({ id: e.id, name, dx, dy, dist: Math.hypot(dx, dy), open: status === "open" });
  });
  extracts.sort((a, b) => a.dist - b.dist);
  const n0 = extracts[0];
  const nearestExtract: HudSnapshot["nearestExtract"] = n0 ? { dx: n0.dx, dy: n0.dy, dist: n0.dist, open: n0.open } : null;

  const armAt = priv?.extractArmAt ?? 0;
  const phase = hudPhase(state.phase, clockMs, armAt);
  const canInteract = onMap && selfPos && phase !== "ended" && !priv?.searching;
  const durationMs = state.durationMs || MATCH.DURATION_MS;
  // World maps only (entryCloseMs > 0): legacy roster matches have no wipe.
  const world = state.entryCloseMs > 0;
  return {
    phase,
    clockMs,
    durationMs,
    extractOpenAtMs: armAt || (Number.isFinite(extractOpenAtMs) ? extractOpenAtMs : MATCH.EXTRACT_OPEN_AT_MS),
    wipeWarn: world && phase !== "ended" ? wipeWarnAt(durationMs - clockMs) : 0,
    boss: hudBoss(state),
    enteredAtMs: priv?.enteredAt ?? 0,
    self,
    aliveCount,
    totalPlayers,
    nearestExtract: onMap ? nearestExtract : null,
    extracts: onMap ? extracts : [],
    interactHint: canInteract && channel ? channelHint(channel) : canInteract ? interactHint({ state, map, x: selfPos!.x, y: selfPos!.y, idx, known, objectives: objectivesOf(state, map, priv) }) : null,
    killFeed,
    ...(killTally ? { killTally } : {}),
    pingMs,
  };
}

/* ------------------------------------------------------------------ HUD store */

/** React commits at most this often (perf budget HUD_COMMITS_PER_S = 10). */
export const HUD_PUBLISH_INTERVAL_MS = 100;
/** How far clockNow() extrapolates past the last snapshot (a stalled renderer must not run timers away). */
const CLOCK_EXTRAPOLATE_MAX_MS = 250;

/**
 * External store between the renderer (pushes a HudSnapshot ~30×/s through `onHud`) and React
 * (reads with useSyncExternalStore). Publishing is throttled to one per HUD_PUBLISH_INTERVAL_MS
 * with a trailing flush, so the newest snapshot always lands. Components select small slices
 * and re-render only when theirs changed; progress bars and countdowns animate on rAF through
 * `clockNow()` instead of re-rendering React.
 */
export interface HudStore {
  /** Renderer → store, any rate. */
  push(snapshot: HudSnapshot): void;
  /** Last published snapshot (stable between publishes, as useSyncExternalStore requires). */
  getSnapshot(): HudSnapshot;
  subscribe(listener: () => void): () => void;
  /** Match clock now, extrapolated from the newest pushed snapshot (for rAF-driven leaves). */
  clockNow(): number;
  /** Cancels a pending trailing publish. The store stays usable. */
  dispose(): void;
}

export interface HudStoreDeps {
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  intervalMs?: number;
}

export function createHudStore(initial: HudSnapshot, deps: HudStoreDeps = {}): HudStore {
  const now = deps.now ?? (() => performance.now());
  const setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = deps.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  const interval = deps.intervalMs ?? HUD_PUBLISH_INTERVAL_MS;

  let published = initial;
  let latest = initial;
  let latestAt = now();
  let lastPublishAt = -Infinity;
  let timer: unknown = null;
  const listeners = new Set<() => void>();

  const publish = () => {
    timer = null;
    lastPublishAt = now();
    if (published === latest) return;
    published = latest;
    for (const l of [...listeners]) l();
  };

  return {
    push(snapshot) {
      latest = snapshot;
      latestAt = now();
      if (timer !== null) return; // the trailing flush will publish the newest one
      const wait = lastPublishAt + interval - latestAt;
      if (wait <= 0) publish();
      else timer = setTimer(publish, wait);
    },
    getSnapshot: () => published,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    clockNow: () => latest.clockMs + Math.min(CLOCK_EXTRAPOLATE_MAX_MS, Math.max(0, now() - latestAt)),
    dispose() {
      if (timer !== null) clearTimer(timer);
      timer = null;
    },
  };
}

/** Equality for selected slices: same keys with Object.is-equal values (one level deep). */
export function shallowEqual<T>(a: T, b: T): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a) as Array<keyof T>;
  if (ka.length !== Object.keys(b).length) return false;
  for (const k of ka) {
    if (!Object.prototype.hasOwnProperty.call(b, k) || !Object.is(a[k], b[k])) return false;
  }
  return true;
}

/**
 * Structural equality for plain JSON-like data (HudSelf, slots, …). The renderer rebuilds
 * these objects on every push, so identity says nothing about whether the HUD must re-render.
 */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  for (const k of ka) {
    if (!Object.prototype.hasOwnProperty.call(b, k)) return false;
    if (!deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])) return false;
  }
  return true;
}

/**
 * Whole seconds until an extract earns XP (shared XP.MIN_ONMAP_MS on the map), 0 once it does or
 * when the entry time is unknown (RETENTION.md: the 8-minute rule must show in the raid itself; the
 * HUD's extract compass counts it down for registered players).
 */
export function extractXpLeftS(enteredAtMs: number, clockMs: number): number {
  if (!(enteredAtMs > 0)) return 0;
  return Math.max(0, Math.ceil((enteredAtMs + XP.MIN_ONMAP_MS - clockMs) / 1000));
}

/** An extract before XP.MIN_ONMAP_MS on the map: no extract / haul XP (shared xpForExit). */
export function earlyExtract(o: { exit: string; atMs: number }, enteredAtMs: number): boolean {
  return o.exit === "extract" && enteredAtMs > 0 && o.atMs - enteredAtMs < XP.MIN_ONMAP_MS;
}
