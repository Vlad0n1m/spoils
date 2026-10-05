/**
 * Death recap ("who killed you and with what"): every runtime keeps a small ring buffer of the hits
 * it took (combat.ts damagePlayer → recordHit); on a human's death death.ts builds a DeathRecap from
 * it (buildRecap) and match.ts puts it into the personal OutcomeMsg.
 *
 * Fog: the recap is a snapshot of the death tick and never changes afterwards. It carries only what
 * the dead player is entitled to:
 * - the killer's name, role and killing weapon (the kill feed has them already) plus the weapon's
 *   rarity and whether the killer is in a party / a guest;
 * - the distance only when the victim saw the killer in the death tick (vision row of the last
 *   tick, as the client's own KILLED BY card), never otherwise;
 * - the killer's HP only when the victim hit the killer within DEATH_RECAP.WINDOW_MS (you know you
 *   were trading shots);
 * - other human attackers are never named ("raider" / "party"), NPC attackers by their role name.
 */

import { BOSSES, DEATH_RECAP, NPC_ROLE, type DeathRecap, type KillWeapon, type RecapSource, type RecapWho } from "@extract/shared";
import type { Match } from "./match.js";
import type { PlayerRuntime } from "./types.js";

/** One hit taken. */
export interface HitRecord {
  at: number;
  /** Attacker (null = own grenade with nobody to credit / unknown). */
  src: PlayerRuntime | null;
  weapon: KillWeapon | "";
  /** Weapon rarity (-1 for grenades / unknown). */
  rarity: number;
  /** HP lost after armor. */
  dmg: number;
}

/** Fixed-size ring of the last DEATH_RECAP.MAX_HITS hits (oldest overwritten first). */
export class HitRing {
  private readonly buf: HitRecord[] = [];
  private head = 0;

  constructor(readonly cap: number = DEATH_RECAP.MAX_HITS) {}

  push(h: HitRecord): void {
    if (this.buf.length < this.cap) this.buf.push(h);
    else {
      this.buf[this.head] = h;
      this.head = (this.head + 1) % this.cap;
    }
  }

  /** Hits with at >= since, oldest first. */
  since(since: number): HitRecord[] {
    const n = this.buf.length;
    const out: HitRecord[] = [];
    for (let i = 0; i < n; i++) {
      const h = this.buf[(this.head + i) % n]!;
      if (h.at >= since) out.push(h);
    }
    return out;
  }

  get size(): number {
    return this.buf.length;
  }

  clear(): void {
    this.buf.length = 0;
    this.head = 0;
  }
}

/** combat.ts damagePlayer: remember a hit `rt` took (any runtime: the killer's ring tells whether the victim hit them). */
export function recordHit(m: Match, rt: PlayerRuntime, src: PlayerRuntime | null, weapon: KillWeapon | "", rarity: number, dmg: number): void {
  (rt.hits ??= new HitRing()).push({ at: m.clock, src: src === rt ? null : src, weapon, rarity: weapon === "grenade" ? -1 : rarity, dmg });
}

const round = (v: number) => Math.round(v);

/**
 * Pure aggregation (exported for tests): the hits of the window grouped per (source, weapon,
 * rarity), biggest damage first; past `maxLines` the rest folds into one "other" line.
 */
export function aggregateSources(
  hits: readonly HitRecord[],
  label: (src: PlayerRuntime | null) => { who: RecapWho; name: string; role: number },
  maxLines: number = DEATH_RECAP.MAX_SOURCES,
): RecapSource[] {
  const groups = new Map<string, RecapSource & { first: number }>();
  const ids = new Map<PlayerRuntime, number>();
  hits.forEach((h, i) => {
    const sid = h.src ? (ids.get(h.src) ?? (ids.set(h.src, ids.size), ids.size - 1)) : -1;
    const key = `${sid}|${h.weapon}|${h.rarity}`;
    const g = groups.get(key);
    if (g) {
      g.dmg += h.dmg;
      g.hits++;
      return;
    }
    groups.set(key, { ...label(h.src), weapon: h.weapon, rarity: h.rarity, dmg: h.dmg, hits: 1, first: i });
  });
  const all = [...groups.values()].sort((a, b) => b.dmg - a.dmg || a.first - b.first);
  const keep = all.length > maxLines ? all.slice(0, maxLines - 1) : all;
  const rest = all.length > maxLines ? all.slice(maxLines - 1) : [];
  const out: RecapSource[] = keep.map(({ first: _f, ...s }) => ({ ...s, dmg: round(s.dmg) }));
  if (rest.length > 0) {
    out.push({
      who: "other", name: "", role: 0, weapon: "", rarity: -1,
      dmg: round(rest.reduce((n, s) => n + s.dmg, 0)),
      hits: rest.reduce((n, s) => n + s.hits, 0),
    });
  }
  return out;
}

/**
 * The recap of `victim` (a human) killed by `killer` (null = own grenade / nobody) with `weapon`.
 * Call in the death tick, before the victim's vision row is cleared (Match.finishPlayer).
 */
export function buildRecap(m: Match, victim: PlayerRuntime, killer: PlayerRuntime | null, weapon: KillWeapon | ""): DeathRecap {
  const since = m.clock - DEATH_RECAP.WINDOW_MS;
  const hits = victim.hits?.since(since) ?? [];
  const by = killer && killer !== victim ? killer : null;
  const label = (src: PlayerRuntime | null): { who: RecapWho; name: string; role: number } => {
    if (!src || src === victim) return { who: "self", name: "", role: 0 };
    if (src === by) return { who: "killer", name: npcName(m, src), role: src.pub.role };
    if (src.isNpc) return { who: "npc", name: npcName(m, src), role: src.pub.role };
    if (by && by.partyId && src.partyId === by.partyId) return { who: "party", name: "", role: 0 };
    return { who: "raider", name: "", role: 0 };
  };
  const sources = aggregateSources(hits, label);
  const total = round(hits.reduce((n, h) => n + h.dmg, 0));

  let killerOut: DeathRecap["killer"];
  if (!by) {
    killerOut = { kind: weapon === "grenade" ? "self" : "none", name: "", role: 0, weapon, rarity: -1, party: false };
  } else {
    // The killing weapon's rarity: the last hit of the killer with that weapon in the window.
    let rarity = -1;
    for (const h of hits) if (h.src === by && h.weapon === weapon) rarity = h.rarity;
    killerOut = {
      kind: by.isNpc ? "npc" : "human",
      name: npcName(m, by),
      role: by.pub.role,
      weapon,
      rarity: weapon === "grenade" ? -1 : rarity,
      party: !by.isNpc && by.partyId !== "",
    };
    if (by.isNpc && by.pub.role === NPC_ROLE.BOSS) {
      const kind = m.npcs.info(by)?.kind;
      if (kind) killerOut.boss = kind;
    }
    if (!by.isNpc && by.guest) killerOut.guest = true;
    // Distance: only a killer the victim saw in the death tick (last tick's vision rows).
    if (m.vision.sees(victim.rosterIndex, by.rosterIndex)) {
      killerOut.distM = Math.max(1, Math.round(Math.hypot(by.pub.x - victim.pub.x, by.pub.y - victim.pub.y) / DEATH_RECAP.PX_PER_METER));
    }
    // The killer's HP: only when the victim hit them within the window (a trade the victim felt).
    const traded = by.hits?.since(since).some((h) => h.src === victim) ?? false;
    if (traded) {
      killerOut.hp = Math.max(0, Math.ceil(by.pub.hp));
      killerOut.hpMax = by.pub.maxHp;
    }
  }
  return { killer: killerOut, sources, total, windowMs: DEATH_RECAP.WINDOW_MS };
}

/** Display name of a runtime in a recap: a human's nickname, an NPC's role display key (boss: the boss name). */
function npcName(m: Match, rt: PlayerRuntime): string {
  if (rt.isNpc && rt.pub.role === NPC_ROLE.BOSS) {
    const kind = m.npcs.info(rt)?.kind;
    if (kind) return BOSSES[kind].name;
  }
  return rt.nickname;
}
