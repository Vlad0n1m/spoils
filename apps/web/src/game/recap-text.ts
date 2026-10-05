/**
 * Death recap (OutcomeMsg.recap, server sim/recap.ts) as display text: the killer's name, the
 * weapon with its rarity, the distance, the killer's HP and the damage lines. Pure (no React), so the
 * outcome card and the tests share one wording. Everything shown is what the server put into the
 * recap: no position, no name of a non-killer human.
 */

import { RARITY_NAMES, WEAPONS, type DeathRecap, type RecapSource, type WeaponId } from "@extract/shared";
import { npcNameOf } from "./npc-labels";

/** "Rifle", "Grenade", "" (unknown). */
export function recapWeaponName(weapon: string): string {
  if (weapon === "grenade") return "Grenade";
  return weapon && weapon in WEAPONS ? WEAPONS[weapon as WeaponId].name : "";
}

/** "Rifle (epic)", "Grenade", "Rifle" when the rarity is unknown. */
export function recapWeaponLabel(weapon: string, rarity: number): string {
  const name = recapWeaponName(weapon);
  if (!name) return "";
  if (weapon === "grenade" || rarity < 0 || rarity > 3) return name;
  return `${name} (${RARITY_NAMES[rarity as 0 | 1 | 2 | 3].toLowerCase()})`;
}

/** The killer's display name: nickname, NPC role name ("Marauder", "FOREMAN"), or what killed you. */
export function recapKillerName(r: DeathRecap): string {
  const k = r.killer;
  if (k.kind === "human") return k.name || "Unknown raider";
  if (k.kind === "npc") return npcNameOf(k.role, k.name, "en");
  if (k.kind === "self") return "Your own grenade";
  return "Unknown";
}

/** "Rifle (epic) · 34 m" / "Grenade · unseen" (no distance: you did not see the killer). */
export function recapKillerSub(r: DeathRecap): string {
  const k = r.killer;
  const parts: string[] = [];
  if (k.kind === "self") return "No one else hit you";
  const w = recapWeaponLabel(k.weapon, k.rarity);
  if (w) parts.push(w);
  if (k.kind === "human" || k.kind === "npc") parts.push(k.distM !== undefined ? `${k.distM} m` : "unseen");
  return parts.join(" · ");
}

/** Who a damage line came from. */
export function recapSourceWho(s: RecapSource, r: DeathRecap): string {
  switch (s.who) {
    case "killer":
      return recapKillerName(r);
    case "party":
      return "Their squad";
    case "raider":
      return "Another raider";
    case "npc":
      return npcNameOf(s.role, s.name, "en");
    case "self":
      return "You";
    default:
      return "Others";
  }
}

/** "Rifle (epic) — 64 dmg, 3 hits" (the requested one-line form; the card lays it out in columns). */
export function recapSourceLine(s: RecapSource): string {
  const w = s.who === "other" ? "Other hits" : recapWeaponLabel(s.weapon, s.rarity) || "Hits";
  return `${w} — ${s.dmg} dmg${s.hits > 1 ? `, ${s.hits} hits` : ""}`;
}

/** "37 / 100 HP left" or null when the recap has no HP (you never hit the killer). */
export function recapKillerHp(r: DeathRecap): string | null {
  const k = r.killer;
  if (k.hp === undefined || !k.hpMax) return null;
  return `${k.hp} / ${k.hpMax} HP left`;
}

/** Badges next to the killer's name. */
export function recapBadges(r: DeathRecap): string[] {
  const out: string[] = [];
  if (r.killer.party) out.push("In a squad");
  if (r.killer.guest) out.push("Guest");
  return out;
}

/** "Killed by Viper", "Killed by MARAUDER": the after-raid card's line (LastRaidDto.killedBy). */
export function killedByText(name: string | undefined, role: number | undefined): string | null {
  if (!name) return null;
  return `Killed by ${npcNameOf(role ?? 0, name, "en")}`;
}
