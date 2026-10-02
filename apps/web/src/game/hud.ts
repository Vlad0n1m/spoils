/** Builds the HudSnapshot (src/game/types.ts) from the synced state. Pure: no Pixi, no DOM. */

import {
  ARMOR,
  HEAL,
  MATCH,
  PLAYER,
  RARITY_NAMES,
  WEAPONS,
  type BattleState,
  type Extract,
  type HealKind,
  type Player,
  type WeaponId,
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

/**
 * Hint for F, mirroring the server's choice: nearest unopened chest first, otherwise the
 * nearest weapon / armor on the ground within PLAYER.INTERACT_RADIUS.
 */
export function interactHint(state: BattleState, x: number, y: number): string | null {
  const R = PLAYER.INTERACT_RADIUS;
  let chestD = Infinity;
  let chestRarity = -1;
  state.chests.forEach((c) => {
    if (c.opened) return;
    const d = Math.hypot(c.x - x, c.y - y);
    if (d <= R && d < chestD) {
      chestD = d;
      chestRarity = c.rarity;
    }
  });
  if (chestRarity >= 0) return `F — open ${RARITY_NAMES[chestRarity] ?? "common"} chest`;

  let bestD = Infinity;
  let hint: string | null = null;
  state.items.forEach((it) => {
    if (it.kind !== "weapon" && it.kind !== "armor") return;
    const d = Math.hypot(it.x - x, it.y - y);
    if (d > R || d >= bestD) return;
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

export interface HudInput {
  state: BattleState;
  selfId: string;
  /** Local (predicted) position, or the last known one after death / extraction. */
  selfPos: { x: number; y: number } | null;
  clockMs: number;
  killFeed: KillFeedEntry[];
  pingMs: number | null;
}

export function buildHud({ state, selfId, selfPos, clockMs, killFeed, pingMs }: HudInput): HudSnapshot {
  const me = state.players.get(selfId) ?? null;
  const self = me ? buildHudSelf(me, clockMs) : null;
  const onMap = !!me && me.alive && me.extractedAt === 0;

  let aliveCount = 0;
  let totalPlayers = 0;
  state.players.forEach((p) => {
    totalPlayers++;
    if (p.alive && p.extractedAt === 0) aliveCount++;
  });

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
    interactHint: onMap && selfPos && phase !== "ended" ? interactHint(state, selfPos.x, selfPos.y) : null,
    killFeed,
    pingMs,
  };
}
