/**
 * Builds the HudSnapshot (src/game/types.ts) from the synced state, and the store React reads it
 * through. Pure: no Pixi, no DOM, no React.
 */

import {
  ARMOR,
  hasLineOfSight,
  HEAL,
  MATCH,
  PLAYER,
  RARITY_NAMES,
  WEAPONS,
  type BattleState,
  type CollisionIndex,
  type Extract,
  type HealKind,
  type Player,
  type WeaponId,
  armorIsUpgrade,
} from "@extract/shared";
import type { ExtractStatus } from "./entities";
import type { HudSelf, HudSlot, HudSnapshot, KillFeedEntry } from "./types";

export function extractStatus(e: Pick<Extract, "openAt" | "closeAt">, clockMs: number): ExtractStatus {
  if (e.closeAt > 0 && clockMs >= e.closeAt) return "closed";
  return clockMs >= e.openAt ? "open" : "waiting";
}

function weaponDef(w: string) {
  return w in WEAPONS ? WEAPONS[w as WeaponId] : null;
}

function hudSlot(p: Player, i: number): HudSlot {
  const s = p.slots.at(i);
  const def = s ? weaponDef(s.weapon) : null;
  if (!s || !def) return { weapon: "", rarity: 0, mag: 0, magSize: 0, free: false };
  return { weapon: def.id, rarity: s.rarity, mag: s.mag, magSize: def.magSize, free: s.free };
}

export function buildHudSelf(p: Player, clockMs: number): HudSelf {
  const active: 0 | 1 = p.active === 1 ? 1 : 0;
  const slots: [HudSlot, HudSlot] = [hudSlot(p, 0), hudSlot(p, 1)];
  const activeDef = weaponDef(slots[active].weapon);
  const armorLevel = p.armor >= 1 && p.armor <= 3 ? (p.armor as 1 | 2 | 3) : 0;

  let reloading: HudSelf["reloading"] = null;
  if (p.reloadUntil > clockMs) {
    const dur = activeDef?.reloadMs ?? 0;
    reloading = { startMs: p.reloadUntil - dur, untilMs: p.reloadUntil };
  }
  let healing: HudSelf["healing"] = null;
  if (p.healUntil > clockMs && (p.healKind === "bandage" || p.healKind === "medkit")) {
    const kind = p.healKind as HealKind;
    healing = { kind, startMs: p.healUntil - HEAL[kind].MS, untilMs: p.healUntil };
  }
  const extracting =
    p.extractStartedAt > 0 && p.alive && p.extractedAt === 0
      ? { startedAtMs: p.extractStartedAt, channelMs: MATCH.EXTRACT_CHANNEL_MS }
      : null;

  return {
    alive: p.alive,
    hp: p.hp,
    maxHp: PLAYER.MAX_HP,
    armor: armorLevel,
    armorDur: armorLevel ? p.armorDur : 0,
    armorMax: armorLevel ? ARMOR[armorLevel].durability : 0,
    slots,
    active,
    ammo: { light: p.ammoLight, shell: p.ammoShell, heavy: p.ammoHeavy },
    bandages: p.bandages,
    medkits: p.medkits,
    reloading,
    healing,
    extracting,
    kills: p.kills,
    diedAt: p.diedAt,
    extractedAt: p.extractedAt,
  };
}

/** F only takes armor that beats what is worn — the same shared rule the server applies. */
export { armorIsUpgrade };

/**
 * Hint for F, mirroring the server's choice (inventory.interact): nearest unopened chest first,
 * otherwise the nearest weapon / armor upgrade on the ground within PLAYER.INTERACT_RADIUS. Only
 * targets in line of sight count when the collision index is known. Ties go to the later entry,
 * like the server's `<=` scan.
 */
export function interactHint(
  state: BattleState,
  x: number,
  y: number,
  me: Pick<Player, "armor" | "armorDur">,
  idx: CollisionIndex | null = null,
): string | null {
  const R = PLAYER.INTERACT_RADIUS;
  const visible = (tx: number, ty: number) => !idx || hasLineOfSight(idx, x, y, tx, ty);
  let chestD: number = R;
  let chestRarity = -1;
  state.chests.forEach((c) => {
    if (c.opened) return;
    const d = Math.hypot(c.x - x, c.y - y);
    if (d > chestD || !visible(c.x, c.y)) return;
    chestD = d;
    chestRarity = c.rarity;
  });
  if (chestRarity >= 0) return `F — open ${RARITY_NAMES[chestRarity] ?? "common"} chest`;

  let bestD: number = R;
  let hint: string | null = null;
  state.items.forEach((it) => {
    if (it.kind !== "weapon" && it.kind !== "armor") return;
    if (it.kind === "armor" && !armorIsUpgrade(me, it.armor, it.armorDur)) return;
    const d = Math.hypot(it.x - x, it.y - y);
    if (d > bestD || !visible(it.x, it.y)) return;
    if (it.kind === "weapon") {
      const def = weaponDef(it.weapon);
      if (!def) return;
      hint = `F — pick up ${def.name} (${RARITY_NAMES[it.rarity] ?? "common"})`;
    } else {
      const lvl = it.armor as 1 | 2 | 3;
      const max = ARMOR[lvl]?.durability;
      if (!max) return;
      hint = `F — pick up Armor L${lvl} (${Math.ceil(it.armorDur)}/${max})`;
    }
    bestD = d;
  });
  return hint;
}

export interface PlayerCounts {
  /** Players still on the map: alive and not extracted. */
  alive: number;
  /** Roster size (humans + bots), never shrinks. */
  total: number;
}

/** Players still on the map (alive, not extracted) and the roster size. */
export function countPlayers(state: BattleState): PlayerCounts {
  let alive = 0;
  let total = 0;
  state.players.forEach((p) => {
    total++;
    if (p.alive && p.extractedAt === 0) alive++;
  });
  return { alive, total };
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
  selfId: string;
  /** Local (predicted) position, or the last known one after death / extraction. */
  selfPos: { x: number; y: number } | null;
  clockMs: number;
  killFeed: KillFeedEntry[];
  pingMs: number | null;
  /** Map collision index, for the interact hint's line-of-sight check (null before the map is built). */
  idx?: CollisionIndex | null;
}

export function buildHud({ state, selfId, selfPos, clockMs, killFeed, pingMs, idx = null }: HudInput): HudSnapshot {
  const me = state.players.get(selfId) ?? null;
  const self = me ? buildHudSelf(me, clockMs) : null;
  const onMap = !!me && me.alive && me.extractedAt === 0;

  const { alive: aliveCount, total: totalPlayers } = countPlayers(state);

  let nearestExtract: HudSnapshot["nearestExtract"] = null;
  let extractOpenAtMs = Infinity;
  if (selfPos) {
    let best = Infinity;
    state.extracts.forEach((e) => {
      extractOpenAtMs = Math.min(extractOpenAtMs, e.openAt);
      const status = extractStatus(e, clockMs);
      if (status === "closed") return;
      const dx = e.x - selfPos.x;
      const dy = e.y - selfPos.y;
      const dist = Math.hypot(dx, dy);
      if (dist < best) {
        best = dist;
        nearestExtract = { dx, dy, dist, open: status === "open" };
      }
    });
  } else {
    state.extracts.forEach((e) => {
      extractOpenAtMs = Math.min(extractOpenAtMs, e.openAt);
    });
  }

  const phase = state.phase === "open" || state.phase === "ended" ? state.phase : "drop";
  return {
    phase,
    clockMs,
    durationMs: state.durationMs || MATCH.DURATION_MS,
    extractOpenAtMs: Number.isFinite(extractOpenAtMs) ? extractOpenAtMs : MATCH.EXTRACT_OPEN_AT_MS,
    self,
    aliveCount,
    totalPlayers,
    nearestExtract: onMap ? nearestExtract : null,
    interactHint: onMap && me && selfPos && phase !== "ended" ? interactHint(state, selfPos.x, selfPos.y, me, idx) : null,
    killFeed,
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
