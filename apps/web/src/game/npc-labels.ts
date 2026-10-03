/**
 * NPC MODEL v5, client side: every visible word about NPCs lives here, in one localized set.
 * Pure: no Pixi, no React. The renderer (entities.ts), the HUD kill feed, the death card and the
 * outcome screen all name NPCs through these helpers, so an NPC never shows a player-style
 * nickname, level or colour name.
 *
 * A match holds real humans plus NPCs: bosses and their guards (NPC_ROLE 1 / 2) and marauder
 * squads (NPC_ROLE 3) that hold POIs and road camps. NPCs are never "players" and are never
 * counted as such.
 */

import { BOSSES, BOSS_KINDS, NPC_ROLE, NPC_TAG, type BossKind } from "@extract/shared";

export type NpcLocale = "en" | "ru";
export type NpcRoleName = "boss" | "guard" | "marauder";

/** Display strings. Boss names stay proper names (BOSSES[kind].name) in every locale. */
export const NPC_LABELS = {
  en: {
    marauder: NPC_TAG.marauder,
    guard: "Guard",
    boss: "Boss",
    npc: "NPC",
    npcs: "NPCs",
    players: "Players",
    you: "You",
    killedBy: "Killed by",
    playersKilled: "Players killed",
    npcsKilled: "NPCs killed",
    bossShort: "boss",
  },
  ru: {
    marauder: NPC_TAG.ru,
    guard: "Охранник",
    boss: "Босс",
    npc: "NPC",
    npcs: "NPC",
    players: "Игроки",
    you: "Вы",
    killedBy: "Убит:",
    playersKilled: "Убито игроков",
    npcsKilled: "Убито NPC",
    bossShort: "босс",
  },
} as const satisfies Record<NpcLocale, Record<string, string>>;

export type NpcLabels = (typeof NPC_LABELS)[NpcLocale];

/** The page locale (<html lang>): "ru…" → ru, anything else (or no DOM, e.g. tests) → en. */
export function npcLocale(lang?: string | null): NpcLocale {
  const l = lang ?? (typeof document !== "undefined" ? document.documentElement?.lang : "") ?? "";
  return l.toLowerCase().startsWith("ru") ? "ru" : "en";
}

export function npcLabels(locale: NpcLocale = npcLocale()): NpcLabels {
  return NPC_LABELS[locale];
}

/** Player.role / KillMsg.*Role (NPC_ROLE) → role name, null for a human (0 / missing / unknown). */
export function npcRoleName(role: number | undefined | null): NpcRoleName | null {
  if (role === NPC_ROLE.BOSS) return "boss";
  if (role === NPC_ROLE.GUARD) return "guard";
  if (role === NPC_ROLE.MARAUDER) return "marauder";
  return null;
}

/**
 * NPC role from a display name alone (corpse labels, OutcomeMsg.killedBy). The server names NPCs
 * by their role display key: "Marauder", a guard name ("Elevator thug"), a boss name ("Foreman").
 */
export function npcRoleOfLabel(label: string): NpcRoleName | null {
  const n = label.trim().toLowerCase();
  if (!n) return null;
  if (n === NPC_TAG.marauder.toLowerCase() || n === NPC_TAG.ru.toLowerCase()) return "marauder";
  for (const k of BOSS_KINDS) {
    if (n === BOSSES[k].name.toLowerCase()) return "boss";
    if (n === BOSSES[k].guardName.toLowerCase()) return "guard";
  }
  return null;
}

/** Boss kind named by an NPC display name (boss or guard name), or null. */
export function bossKindOfLabel(label: string): BossKind | null {
  const n = label.trim().toLowerCase();
  for (const k of BOSS_KINDS) {
    if (n === BOSSES[k].name.toLowerCase() || n === BOSSES[k].guardName.toLowerCase()) return k;
  }
  return null;
}

/**
 * The name an NPC is shown under. Marauder: "Marauder" / "Мародёр" (never the raw nickname).
 * Guard: BOSSES[kind].guardName in English ("Elevator thug"), "Охранник" in Russian, "Guard" when
 * the kind is unknown. Boss: the UPPERCASE boss name. A human (role null) keeps `nickname`.
 */
export function npcDisplayName(
  role: NpcRoleName | null,
  kind: BossKind | null,
  nickname: string,
  locale: NpcLocale = npcLocale(),
): string {
  const L = NPC_LABELS[locale];
  if (role === "marauder") return L.marauder;
  if (role === "guard") return locale === "en" && kind ? BOSSES[kind].guardName : L.guard;
  if (role === "boss") return (kind ? BOSSES[kind].name : nickname || L.boss).toUpperCase();
  return nickname;
}

/** Display name from a role number and the name the server sent (kill feed, death card). */
export function npcNameOf(role: number | undefined | null, name: string, locale: NpcLocale = npcLocale()): string {
  const r = npcRoleName(role) ?? npcRoleOfLabel(name);
  return r ? npcDisplayName(r, bossKindOfLabel(name), name, locale) : name;
}

// ---------------------------------------------------------------------------------------------
// Colours (fixed, desaturated NPC palette: an NPC never takes a player colour index)
// ---------------------------------------------------------------------------------------------

/** Boss red / guard amber (v4) / marauder khaki. Rings, map skulls, kill-feed names. */
export const NPC_RING_COLOR: Record<NpcRoleName, number> = { boss: 0xff3b30, guard: 0xff922b, marauder: 0x8f8a5a };
/** Name-tag fill: the marauder khaki is too dark for text on the world, so its tag is lighter. */
export const NPC_TAG_COLOR: Record<NpcRoleName, number> = { boss: 0xff3b30, guard: 0xff922b, marauder: 0xd6cf9c };
/** Body tint (khaki "uniform" for guards, a duller olive for marauders; the boss has its own sprite). */
export const NPC_BODY_TINT: Record<NpcRoleName, number> = { boss: 0xff8a80, guard: 0xd8c08a, marauder: 0xa9a37c };
/** NPC corpse ring / tint (dead NPCs read "not a player" at a glance). */
export const NPC_CORPSE_TINT = 0x9a9578;

/** CSS hex for a 0xRRGGBB colour. */
export function cssHex(c: number): string {
  return `#${(c & 0xffffff).toString(16).padStart(6, "0")}`;
}

// ---------------------------------------------------------------------------------------------
// Kill feed / death card / outcome
// ---------------------------------------------------------------------------------------------

/** Who of an NPC kill row is shown how: `npc` = role name or null (a human). */
export interface FeedName {
  name: string;
  npc: NpcRoleName | null;
}

/**
 * Names of one kill-feed row. NPCs carry their role (badge + role colour); a marauder or guard kill
 * by the local player is a personal row ("You ✕ Marauder": only the killer receives it).
 */
export function killFeedNames(
  e: { killer: string; victim: string; killerRole?: number; victimRole?: number },
  selfNickname: string,
  locale: NpcLocale = npcLocale(),
): { killer: FeedName | null; victim: FeedName; personal: boolean } {
  const kr = npcRoleName(e.killerRole);
  const vr = npcRoleName(e.victimRole);
  const personal = !kr && !!e.killer && e.killer === selfNickname && (vr === "marauder" || vr === "guard");
  const killer: FeedName | null = e.killer
    ? { name: personal ? NPC_LABELS[locale].you : kr ? npcDisplayName(kr, bossKindOfLabel(e.killer), e.killer, locale) : e.killer, npc: kr }
    : null;
  const victim: FeedName = { name: vr ? npcDisplayName(vr, bossKindOfLabel(e.victim), e.victim, locale) : e.victim, npc: vr };
  return { killer, victim, personal };
}

/** The local player's kills this raid, from their own KillMsgs (NPC kills only reach the killer). */
export interface KillTally {
  players: number;
  /** Marauders + guards. */
  npcs: number;
  bosses: number;
}

export const EMPTY_TALLY: Readonly<KillTally> = { players: 0, npcs: 0, bosses: 0 };

/** Adds one KillMsg to the tally when `selfId` made the kill (never counts a suicide). */
export function tallyKill(t: KillTally, m: { killerId: string; victimId: string; victimRole?: number }, selfId: string): KillTally {
  if (!selfId || m.killerId !== selfId || m.victimId === selfId) return t;
  const r = npcRoleName(m.victimRole);
  if (r === "boss") return { ...t, bosses: t.bosses + 1 };
  if (r) return { ...t, npcs: t.npcs + 1 };
  return { ...t, players: t.players + 1 };
}

/** "NPCs killed" stat value: "5" or "5 (boss 1)" — bosses count as NPCs too. */
export function npcKillsLine(t: Pick<KillTally, "npcs" | "bosses">, locale: NpcLocale = npcLocale()): string {
  const n = t.npcs + t.bosses;
  return t.bosses > 0 ? `${n} (${NPC_LABELS[locale].bossShort} ${t.bosses})` : String(n);
}

/** Outcome line "Killed by Marauder" (OutcomeMsg.killedBy carries the NPC's display key). */
export function killedByLine(killedBy: string, locale: NpcLocale = npcLocale()): string {
  return `${NPC_LABELS[locale].killedBy} ${npcNameOf(undefined, killedBy, locale)}`;
}

/**
 * NPC role of a corpse from its label (Corpse has no role field): a role this client saw under that
 * name (Player.role while the NPC was in view, KillMsg.victimRole) wins, else the display-key match.
 */
export function corpseNpcRole(label: string, seen: ReadonlyMap<string, NpcRoleName>): NpcRoleName | null {
  return seen.get(label) ?? npcRoleOfLabel(label);
}

/** Search title of a body: "Vlad's body", "Marauder's body" (an NPC by its role name), "Body". */
export function bodyTitle(label: string | undefined | null, locale: NpcLocale = npcLocale()): string {
  if (!label) return "Body";
  const npc = npcRoleOfLabel(label);
  return `${npc ? npcDisplayName(npc, bossKindOfLabel(label), label, locale) : label}'s body`;
}
