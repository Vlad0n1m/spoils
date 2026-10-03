/**
 * NPCs (NPC MODEL v5: "humans + NPCs, no player-bots"). Owner's rule: no bot may behave like a
 * player. A match holds real humans and NPCs only, and every NPC holds a place on the map:
 *
 * - boss + guards (loot economy v4, boss.ts): a squad of type "boss" at a BossSpot;
 * - marauders (NPC_ROLE.MARAUDER): squads of 1–3 at a MapData.npcPosts post (POI yard, zone gate,
 *   road camp in the wilds), rolled per match by the shared rollNpcSpawns.
 *
 * NPCs never loot (containers, corpses, ground), never extract (extractMask 0), never roam outside
 * leash + chase, never respawn, never heal (except the boss, v4), never fight another NPC (one
 * "locals" faction; NPC → NPC bullets do no damage, combat.ts). Their gear is FREE (never in a
 * corpse, never extracted, never in the ledger); what they drop is a small non-FREE bag
 * (rollNpcLoot, boss / guard drops) plus at most one stowed pool unique on a T3/T4 marauder
 * (carrier, allocated by the web from the same risk-tied release — never minted).
 *
 * NpcBrain drives its Player through exactly the same pipeline as a client (InputSamples at
 * INPUT_HZ, reload / switch / heal intents) and gets no extra powers: sight is the server vision
 * matrix (m.vision, NPC rows capped at NPC.VIEW_RANGE_CAP while calm and NPC.VIEW_RANGE_ALERT while
 * alerted or under fire; a muzzle flash is seen to VISION.RANGE), hearing is the per-listener
 * quantized delivery (sound.ts heardBy), a hit comes with the quantized "damage from" direction.
 *
 * v5 review fixes (no free kills from outside an NPC's reach): an alerted NPC sees as far as a
 * human, engages to its weapon's full range, a shotgun NPC carries a FREE pistol sidearm for targets
 * beyond shotgun range, and an NPC hit by someone it cannot see or cannot reach breaks line of sight
 * (COVER) instead of standing at its chase edge; the boss only heals when nobody hit it recently;
 * during the peace window a human walking into the post is fought, not just watched.
 *
 * FSM (one for every role; boss / guard specifics from v4 on the same base):
 *   IDLE        hold the post or walk the patrol; look around every NPC.IDLE_LOOK_MS.
 *   SUSPICIOUS  a heard step / roll / reload / loot / search sound, a shot beyond the alert radius,
 *               or a sighting during the peace window: turn to the source and step toward it
 *               (inside the leash) for NPC.SUSPICIOUS_MS.
 *   COMBAT      a visible enemy: fire only with a confirmed line of sight (never at a sound), react
 *               after reactMs, aim error × sloppiness, rifle bursts; shotgun closes in, sniper keeps
 *               distance; chase up to leash + NPC.CHASE_EXTRA_PX while the target is in sight.
 *   COVER       under fire from someone it cannot see, or out of its reach (beyond weapon range and
 *               the chase radius): move to the nearest spot within NPC.COVER_SEARCH_PX (inside the
 *               chase radius) with no line of fire to the threat and hold it facing the threat;
 *               no such spot: juke sideways. Ends NPC.UNDER_FIRE_MS after the last hit.
 *   SEARCH      lost sight (or a squad alert): walk to the last-known position (clamped to the chase
 *               radius) and sweep ±NPC.SEARCH_SWEEP_DEG for NPC.SEARCH_MS; in a marauder squad of 2+
 *               the first living member keeps the post while the others search.
 *   RETURN      walk back to the post; IDLE on arrival. HP does not regenerate.
 * Squad alert (sight after the peace window, a hit, a shot heard within the squad's alert radius):
 * the whole squad gets alertUntil / alertAt and its members think on the next step. It never
 * propagates to another squad: other squads react only to what they hear themselves.
 *
 * Cost (§2.6): a squad with no living human within NPC.WAKE_PX and no alert is dormant (no think,
 * no movement, no hearing, no vision row; it stays a target). Awake NPCs decide every NPC.THINK_MS
 * within NPC.LOD_PX of a human (or in contact) and every NPC.LOD_THINK_MS otherwise, while steering
 * along the current route stays at 10 Hz.
 */

import {
  BOSSES,
  BOSS_AI,
  INPUT_DT_MS,
  ITEM_FLAG,
  MARAUDER,
  NPC,
  NPC_CARRIER,
  NPC_ROLE,
  PLAYER,
  SOLID,
  SOUND,
  SoundKind,
  WEAPONS,
  ammoDefOf,
  bandMid,
  baseSoundRadius,
  circleIsFree,
  hasLineOfSight,
  itemDef,
  npcCarrierKey,
  npcClassOfPost,
  npcLeashPx,
  quantizeFa,
  rollMarauderKit,
  rollNpcLoot,
  sectorAngle,
  weaponVariant,
  zoneAt,
  type BossKind,
  type BossSpot,
  type InvItem,
  type ItemLike,
  type MarauderKit,
  type NpcClass,
  type NpcCounts,
  type NpcPost,
  type NpcSquadSpawn,
  type NpcSummary,
} from "@extract/shared";
import { activeWeapon, ammoCount, fixActive, placeItem, syncPublic, weaponDefOf } from "./bag.js";
import { equipBoss, equipGuard, finishNpcHealIfDue, giveSidearm, guardCount, startNpcHeal, stow } from "./boss.js";
import { envNow } from "./environment.js";
import { cloneItem, makeItem } from "./items.js";
import type { Match } from "./match.js";
import type { Pt } from "./nav.js";
import { heardBy } from "./sound.js";
import type { PlayerRuntime } from "./types.js";
import { Walker } from "./walker.js";

/** During the peace window an NPC shoots back only at someone who hit it this recently. */
export const NPC_RETALIATE_MS = 3_000;
/** Chance to roll when hit (÷ sloppiness, capped 0.6), guards and marauders; the boss never rolls. */
export const NPC_ROLL_ON_HIT = 0.35;
/** Chance to roll when a gunshot cracks right next to the NPC (÷ sloppiness). */
const ROLL_ON_BURST = 0.2;
/** Aim error half-width: base + per 1000 px of distance + extra for a target moving at full speed. */
const AIM_ERR_BASE = 0.1;
const AIM_ERR_PER_1000PX = 0.12;
const AIM_ERR_MOVING = 0.1;
/** Semi-auto NPCs never press faster than this, whatever the weapon allows. */
const MIN_PRESS_INTERVAL_MS = 420;
/** A hit / shot older than this no longer keeps the boss from healing. */
const NPC_HEAL_CALM_MS = 2500;
/** Boss: idles within this distance of its spot (it "holds the room"). */
const BOSS_HOLD_PX = 220;
/** Searching: walk (Shift) for the last stretch; "arrived" this close. */
const SNEAK_RANGE = 650;
const ARRIVE_PX = 90;
/** Suspicious: how far toward a noise an NPC steps (inside its leash). */
const SUSPICIOUS_STEP_PX = 260;
/** A re-sighting of the same enemy within this keeps the NPC's reaction (no new reactMs delay). */
const ENEMY_MEMORY_MS = 3000;
/** Engage range as a share of the active weapon's range (bullets fly the full range). */
const ENGAGE_RANGE_FRAC = 1;
/** COVER: re-pick the spot at most this often (threat moved / spot no longer covered). */
const COVER_REPICK_MS = 1500;
/** How often dormancy / LOD distances are refreshed. */
const WAKE_CHECK_MS = 250;
/** Breadcrumb spacing of the way home, and the most kept. */
const TRAIL_STEP_PX = 100;
const TRAIL_MAX = 120;
/** Walking home may cut a corner this far beyond the chase radius (never more). */
const HOME_SLACK_PX = 30;

/** How interesting a heard sound kind is (0 / absent = ignored). Shots are handled as alerts. */
const HEAR_PRIO: Partial<Record<SoundKind, number>> = {
  [SoundKind.step]: 2,
  [SoundKind.stepBush]: 2,
  [SoundKind.roll]: 2,
  [SoundKind.shot]: 4,
  [SoundKind.reload]: 2,
  [SoundKind.heal]: 1,
  [SoundKind.loot]: 2,
  [SoundKind.search]: 2,
  [SoundKind.extract]: 1,
  [SoundKind.hurt]: 3,
  [SoundKind.death]: 3,
  [SoundKind.bodyFall]: 2,
  [SoundKind.dryFire]: 1,
  [SoundKind.switch]: 1,
};

/** Shot sound variant of the shotgun (a blast next to the NPC is a "burst"). */
const SHOTGUN_VARIANT = weaponVariant("shotgun");

export type NpcRoleName = "boss" | "guard" | "marauder";
export type NpcFsmState = "idle" | "suspicious" | "combat" | "search" | "return" | "cover";

/** A squad: a boss group (type "boss") or a marauder squad at one post. One shared alert. */
export interface NpcSquad {
  id: number;
  type: "boss" | "marauder";
  members: PlayerRuntime[];
  /** Squad alert: active until this clock, toward the last-known enemy position. */
  alertUntil: number;
  alertAt: Pt | null;
  /** Marauder squads: their post (null for boss groups). */
  post: NpcPost | null;
  /** Some living human within NPC.WAKE_PX of a member (or an alert): the squad thinks. */
  awake: boolean;
}

/** A boss group: the boss squad of a spawned BossSpot. */
export interface BossGroup extends NpcSquad {
  type: "boss";
  kind: BossKind;
  spot: BossSpot;
  /** Tier of the boss's zone (guard drops roll that tier's crate table). */
  tier: number;
  boss: PlayerRuntime;
  guards: PlayerRuntime[];
}

/** What an NPC brain knows about itself. */
export interface NpcInfo {
  role: NpcRoleName;
  squad: NpcSquad;
  /** Boss groups: the boss kind and group (null for marauders). */
  kind: BossKind | null;
  group: BossGroup | null;
  /** Index into BOSSES[kind].guards (-1 for the boss and marauders). */
  guardIdx: number;
  /** Member index inside the squad (marauders: carrier key npc:<post>.<member>). */
  member: number;
  /** Marauder class (null for boss / guards). */
  cls: NpcClass | null;
  /** Where it holds: its post spot, guard post or the BossSpot. */
  anchor: Pt;
  /** Leash radius around the anchor (calm, suspicious, search). */
  leash: number;
  /** Radius it may chase to while it sees its target (marauders: leash + NPC.CHASE_EXTRA_PX). */
  chase: number;
  /** Patrol route (first point = anchor); a single point = it holds. */
  route: Pt[];
  sloppiness: number;
  reactMs: readonly [number, number];
}

/** One NPC to create (match.ts turns it into a runtime at x / y). */
export interface NpcSpawn {
  nickname: string;
  x: number;
  y: number;
}

/** What a heard sound told the NPC: an estimated source position. */
interface HeardNote {
  kind: SoundKind;
  prio: number;
  angle: number;
  dist: number;
  x: number;
  y: number;
  at: number;
}

const ZERO_COUNTS = (): NpcCounts => ({ boss: 0, guard: 0, marauder: 0 });

/** Role name of an NPC runtime ("" for humans). */
export function npcRoleName(rt: PlayerRuntime): NpcRoleName | "" {
  switch (rt.pub.role) {
    case NPC_ROLE.BOSS: return "boss";
    case NPC_ROLE.GUARD: return "guard";
    case NPC_ROLE.MARAUDER: return "marauder";
    default: return "";
  }
}

/** Free standing spot for squad member `k` around `base` (member 0 stands on it). */
function memberSpot(m: Match, base: Pt, k: number): Pt {
  if (k === 0) return base;
  for (let a = 0; a < 12; a++) {
    const ang = k * 2.399963 + a * 0.5236;
    const r = 80 + 20 * (a % 4);
    const x = base.x + Math.cos(ang) * r;
    const y = base.y + Math.sin(ang) * r;
    if (x < 64 || y < 64 || x > m.map.width - 64 || y > m.map.height - 64) continue;
    if (circleIsFree(m.idx, x, y, PLAYER.RADIUS + 2) && hasLineOfSight(m.idx, base.x, base.y, x, y, SOLID.MOVE)) return { x, y };
  }
  return base;
}

export class NpcSystem {
  readonly squads: NpcSquad[] = [];
  /** Boss groups (also in `squads`). */
  readonly groups: BossGroup[] = [];
  /** NPC brains (empty when brains are off: rule tests drive NPC players by hand). */
  readonly brains: NpcBrain[] = [];
  private readonly infos = new Map<PlayerRuntime, NpcInfo>();
  private readonly brainOf = new Map<PlayerRuntime, NpcBrain>();
  private readonly spawned = ZERO_COUNTS();
  private readonly killed = ZERO_COUNTS();
  private wakeAt = 0;

  constructor(private readonly m: Match) {}

  info(rt: PlayerRuntime): NpcInfo | undefined {
    return this.infos.get(rt);
  }

  brain(rt: PlayerRuntime): NpcBrain | undefined {
    return this.brainOf.get(rt);
  }

  /** Every NPC runtime (bosses, guards, marauders) in spawn order. */
  runtimes(): PlayerRuntime[] {
    return [...this.infos.keys()];
  }

  /** NPC counts for the end report (spawned; killed by humans). */
  summary(): NpcSummary {
    return { spawned: { ...this.spawned }, killedByHumans: { ...this.killed } };
  }

  /** death.ts: a human killed this NPC. */
  creditKill(victim: PlayerRuntime): void {
    const r = npcRoleName(victim);
    if (r) this.killed[r]++;
  }

  /**
   * Alert the whole squad toward (x, y): boss groups for BOSS_AI.ALERT_MS, marauders for
   * NPC.SQUAD_ALERT_MS. Members think on their next step (never another squad).
   */
  alert(sq: NpcSquad, x: number, y: number): void {
    sq.alertUntil = this.m.clock + (sq.type === "boss" ? BOSS_AI.ALERT_MS : NPC.SQUAD_ALERT_MS);
    sq.alertAt = { x, y };
    this.wake(sq);
    for (const rt of sq.members) this.brainOf.get(rt)?.poke();
  }

  /** Create the boss groups of the spawned BossSpots (pool items from containerLoot "boss:<kind>"). */
  spawnBosses(spawned: readonly BossSpot[], add: (n: NpcSpawn) => PlayerRuntime): void {
    const m = this.m;
    let legacy = m.containers.takeLegacyBossPool();
    for (const spot of spawned) {
      const def = BOSSES[spot.kind];
      const tier = m.map.zones.find((z) => z.id === spot.zone)?.tier ?? zoneAt(m.map, spot.x, spot.y)?.tier ?? 0;
      const boss = add({ nickname: def.name, x: spot.x, y: spot.y });
      const group: BossGroup = {
        id: this.squads.length, type: "boss", members: [boss], alertUntil: 0, alertAt: null, post: null, awake: true,
        kind: spot.kind, spot, tier, boss, guards: [],
      };
      const pool = [...m.containers.takeBossPool(spot.kind), ...legacy];
      legacy = [];
      equipBoss(m, boss, spot.kind, pool);
      const bossAnchor = { x: spot.x, y: spot.y };
      this.register(boss, {
        role: "boss", squad: group, kind: spot.kind, group, guardIdx: -1, member: 0, cls: null,
        anchor: bossAnchor, leash: BOSS_AI.LEASH_BOSS_PX, chase: BOSS_AI.LEASH_BOSS_PX, route: [bossAnchor],
        sloppiness: BOSS_AI.BOSS_SLOPPINESS, reactMs: BOSS_AI.REACT_MS,
      });
      for (let i = 0; i < guardCount(spot); i++) {
        const post = spot.guards[i]!;
        const g = add({ nickname: def.guardName, x: post.x, y: post.y });
        equipGuard(m, g, spot.kind, i, tier);
        group.guards.push(g);
        group.members.push(g);
        const anchor = { x: post.x, y: post.y };
        const leash = BOSS_AI.LEASH_GUARD_PX;
        // Post ↔ boss room (the boss spot when it lies inside the leash, else the leash edge toward it).
        const room = clampTo(anchor, spot.x, spot.y, leash);
        this.register(g, {
          role: "guard", squad: group, kind: spot.kind, group, guardIdx: i, member: i + 1, cls: null,
          anchor, leash, chase: leash, route: [anchor, room],
          sloppiness: BOSS_AI.GUARD_SLOPPINESS, reactMs: BOSS_AI.REACT_MS,
        });
      }
      this.squads.push(group);
      this.groups.push(group);
    }
    // No boss spawned for legacy "boss" items: they stay listed in the containers (leftOnMap).
    if (legacy.length) m.containers.returnLegacyBossPool(legacy);
  }

  /**
   * Create the marauder squads that rolled this match (rollNpcSpawns over `posts`). Each member:
   * FREE kit (rollMarauderKit), its non-FREE bag (rollNpcLoot) and, on a T3/T4 POI post, the pool
   * unique the web allocated to its carrier key (at most NPC_CARRIER.MAX_PER_NPC; stowed, never
   * worn or wielded). Carrier items of members that did not spawn stay in the containers (leftOnMap).
   */
  spawnSquads(spawns: readonly NpcSquadSpawn[], posts: readonly NpcPost[], add: (n: NpcSpawn) => PlayerRuntime): void {
    const m = this.m;
    const byId = new Map(posts.map((p) => [p.id, p]));
    for (const s of spawns) {
      const post = byId.get(s.postId);
      if (!post || s.members <= 0) continue;
      const cls = npcClassOfPost(post);
      const def = MARAUDER[cls];
      const leash = npcLeashPx(post);
      const kits = rollMarauderKit(m.lootSeed, post.id, s.members, cls);
      const squad: NpcSquad = { id: this.squads.length, type: "marauder", members: [], alertUntil: 0, alertAt: null, post, awake: true };
      const base: Pt = { x: post.x, y: post.y };
      const route: Pt[] = [base, ...post.patrol.map((q) => ({ x: q.x, y: q.y }))];
      // The squad sniper (top class, at most one) holds the post point farthest from the post anchor.
      const far = route.reduce((a, b) => (Math.hypot(b.x - base.x, b.y - base.y) > Math.hypot(a.x - base.x, a.y - base.y) ? b : a), base);
      for (let k = 0; k < s.members; k++) {
        const kit = kits[k]!;
        const sniper = kit.weapon === "sniper";
        const anchor = memberSpot(m, sniper ? far : base, sniper ? 0 : k);
        const rt = add({ nickname: def.name, x: anchor.x, y: anchor.y });
        this.equipMarauder(rt, post, k, cls, kit);
        squad.members.push(rt);
        // Patrol squads: members walk the route starting at different points; snipers hold.
        const own = sniper || route.length < 2 ? [anchor] : [anchor, ...route.slice(1)];
        const start = own.length > 1 ? k % own.length : 0;
        this.register(rt, {
          role: "marauder", squad, kind: null, group: null, guardIdx: -1, member: k, cls,
          anchor, leash, chase: leash + NPC.CHASE_EXTRA_PX, route: [...own.slice(start), ...own.slice(0, start)],
          sloppiness: def.sloppiness, reactMs: def.reactMs,
        });
      }
      this.squads.push(squad);
    }
  }

  private equipMarauder(rt: PlayerRuntime, post: NpcPost, member: number, cls: NpcClass, kit: MarauderKit): void {
    const m = this.m;
    const def = MARAUDER[cls];
    const p = rt.pub;
    p.role = NPC_ROLE.MARAUDER;
    p.hp = def.hp;
    p.maxHp = def.hp;
    const s = rt.self.slots;
    const free = ITEM_FLAG.FREE;
    s.set("w1", cloneItem(makeItem(kit.weapon, { rarity: kit.rarity, flags: free })));
    if (kit.armor > 0) s.set("armor", cloneItem(makeItem(`armor_${kit.armor}`, { flags: free })));
    s.set("bp", cloneItem(makeItem("backpack_1", { flags: free })));
    placeItem(rt, makeItem(ammoDefOf(kit.weapon), { qty: def.freeAmmo, flags: free }));
    giveSidearm(rt);
    // The bag: non-FREE, lootable from the corpse.
    for (const it of rollNpcLoot(m.lootSeed, post.id, member, cls)) placeItem(rt, makeItem(it.def, { qty: it.qty, rarity: it.rarity }));
    // A pool unique (carrier): T3/T4 POI posts only, at most one; never minted, never breaks.
    const carried = m.containers.takeCarrierPool(npcCarrierKey(post.id, member));
    if (carried.length) {
      const eligible = post.kind !== "road" && post.tier >= NPC_CARRIER.MIN_TIER;
      const keep = eligible ? carried.slice(0, NPC_CARRIER.MAX_PER_NPC) : [];
      const rest = carried.slice(keep.length);
      for (const it of keep) if (!stow(rt, it)) rest.push(it);
      if (rest.length) m.containers.returnCarrierPool(npcCarrierKey(post.id, member), rest);
    }
    rt.self.active = "w1";
    fixActive(rt);
    syncPublic(rt);
  }

  private register(rt: PlayerRuntime, info: NpcInfo): void {
    this.infos.set(rt, info);
    this.spawned[info.role]++;
  }

  /** Build the brains (after every NPC exists). */
  startBrains(): void {
    for (const [rt, info] of this.infos) {
      const b = new NpcBrain(this.m, rt, info, this);
      this.brains.push(b);
      this.brainOf.set(rt, b);
    }
  }

  private wake(sq: NpcSquad): void {
    if (sq.awake) return;
    sq.awake = true;
    for (const rt of sq.members) {
      rt.dormant = false;
      this.brainOf.get(rt)?.wake();
    }
  }

  /**
   * Dormancy and LOD distances (every WAKE_CHECK_MS): a squad wakes when a living human is within
   * NPC.WAKE_PX of any living member or it has an active alert; otherwise it sleeps (no brain
   * update, no vision row, no hearing). Brains cache their nearest-human distance for the LOD.
   */
  private refreshWake(): void {
    const m = this.m;
    const humans: Pt[] = [];
    for (const rt of m.allRuntimes()) if (!rt.isNpc && rt.pub.alive) humans.push(rt.pub);
    const wake2 = NPC.WAKE_PX * NPC.WAKE_PX;
    for (const sq of this.squads) {
      // A squad still busy (searching, walking home) stays awake until it is back on its post.
      let near = sq.alertUntil > m.clock || sq.members.some((rt) => rt.pub.alive && (this.brainOf.get(rt)?.busy ?? false));
      for (const rt of sq.members) {
        if (!rt.pub.alive) continue;
        let best = Infinity;
        for (const h of humans) {
          const d2 = (h.x - rt.pub.x) ** 2 + (h.y - rt.pub.y) ** 2;
          if (d2 < best) best = d2;
        }
        this.brainOf.get(rt)?.setHumanD2(best);
        if (best <= wake2) near = true;
      }
      if (near) this.wake(sq);
      else if (sq.awake) {
        sq.awake = false;
        for (const rt of sq.members) {
          rt.dormant = true;
          this.brainOf.get(rt)?.sleep();
          if (rt.pub.alive) m.vision.clearRow(rt.rosterIndex);
        }
      }
    }
  }

  /** Per step, before the match's reload / heal timers: NPC heals land (capped at maxHp), then brains. */
  update(dtMs: number): void {
    for (const rt of this.infos.keys()) finishNpcHealIfDue(this.m, rt);
    if (this.m.clock >= this.wakeAt) {
      this.wakeAt = this.m.clock + WAKE_CHECK_MS;
      this.refreshWake();
    }
    for (const b of this.brains) if (!b.rt.dormant) b.update(dtMs);
  }
}

/** (x, y) pulled back onto the circle of radius r around `a` when it lies outside. */
function clampTo(a: Pt, x: number, y: number, r: number): Pt {
  const d = Math.hypot(x - a.x, y - a.y);
  if (d <= r) return { x, y };
  const k = r / d;
  return { x: a.x + (x - a.x) * k, y: a.y + (y - a.y) * k };
}

export class NpcBrain {
  state: NpcFsmState = "idle";
  /** Probability per hit of a dodge roll (tests may set it to 0 / 1). */
  rollChance: number;

  private seq = 0;
  private inputAcc = 0;
  private thinkAcc: number = NPC.THINK_MS;
  private nextDecideAt = 0;
  private thinkCount = 0;
  private lodNow = false;
  private gone = false;
  private urgent = false;
  private humanD2 = Infinity;

  private aim = 0;
  private wantFire = false;
  private lastFire = false;
  private nextPressAt = 0;
  private burstUntil = 0;
  private pauseUntil = 0;

  private rollSamples = 0;
  private rollDx = 0;
  private rollDy = 0;
  private hitSeenAt = -Infinity;
  private lookAngle = 0;
  private lookUntil = 0;
  private scanAt = 0;

  private heard: HeardNote | null = null;
  private suspicious: { x: number; y: number; until: number; step: boolean } | null = null;
  private search: { x: number; y: number; until: number; arrived: boolean; base: number; sweepAt: number; side: number } | null = null;

  private enemyId = "";
  /** Last enemy fought (a re-sighting within ENEMY_MEMORY_MS keeps the reaction: no new delay). */
  private lastEnemyId = "";
  private enemySeen: { x: number; y: number; at: number } | null = null;
  /** COVER: where it hides from `threat` (null = juke), and the juke direction / flip clock. */
  private cover: { x: number; y: number; threat: Pt; found: boolean; at: number } | null = null;
  /** Where the last hit came from (quantized direction × shooter distance), for COVER. */
  private threat: Pt | null = null;
  private jukeUntil = 0;
  private jukeSign = 1;
  private lastEnemyAt = -Infinity;
  private enemySpeed = 0;
  private reactAt = 0;
  private aimErr = 0;
  private aimErrUntil = 0;
  private strafe = 1;
  private strafeUntil = 0;
  private switchAt = 0;

  private routeIdx = 0;
  private idleUntil = 0;
  private dest: Pt | null = null;
  private readonly walker: Walker;
  /**
   * Breadcrumbs while away from the post (every TRAIL_STEP_PX beyond leash/2): the way home is the
   * way it came, so a planner route around a building can never drag it out of its chase radius.
   */
  private trail: Pt[] = [];
  /** This decision walks home (trail / anchor): exempt from the outward-step clamp. */
  private homeward = false;

  constructor(
    private readonly m: Match,
    readonly rt: PlayerRuntime,
    readonly info: NpcInfo,
    private readonly sys: NpcSystem,
  ) {
    this.walker = new Walker(m, rt);
    this.walker.onGiveUp = () => this.giveUp();
    this.rollChance = info.role === "boss" ? 0 : Math.min(0.6, NPC_ROLL_ON_HIT / info.sloppiness);
    this.aim = rt.pub.aim;
  }

  // ------------------------------------------------------------------ tick

  /**
   * Called once per server step with its dt (awake NPCs only). Input accumulator (mobility memo):
   * floor(acc / INPUT_DT_MS) samples per step, the remainder carried, so an NPC produces exactly
   * INPUT_HZ samples per second of match time like a real client.
   */
  update(dtMs: number): void {
    const p = this.rt.pub;
    if (!p.alive) {
      if (!this.gone) {
        this.gone = true;
        this.walker.forget();
      }
      return;
    }
    this.recordTrail();
    // Every step (cheap): what was heard in the last delivery, and whether we were just hit.
    const heardUrgent = this.listen();
    const hit = this.checkHit();
    const urgent = heardUrgent || hit || this.urgent;
    this.urgent = false;
    this.thinkAcc += dtMs;
    if (this.thinkAcc >= NPC.THINK_MS || urgent) {
      this.thinkAcc = 0;
      if (this.lodNow && !urgent && this.m.clock < this.nextDecideAt) {
        this.move();
      } else {
        this.thinkCount++;
        this.think();
        this.lodNow = this.computeLod();
        this.nextDecideAt = this.m.clock + (this.lodNow ? NPC.LOD_THINK_MS : NPC.THINK_MS);
      }
    }
    this.inputAcc += dtMs;
    const n = Math.floor((this.inputAcc + 1e-6) / INPUT_DT_MS);
    this.inputAcc = Math.max(0, this.inputAcc - n * INPUT_DT_MS);
    for (let i = 0; i < n; i++) this.emitInput();
  }

  /** Think on the next step (squad alert). */
  poke(): void {
    this.urgent = true;
  }

  /** Dormant: stand still (no inputs are sent while dormant). */
  sleep(): void {
    this.walker.stop();
    this.wantFire = false;
    this.rollSamples = 0;
  }

  /** Woken up: think at once, inputs start fresh. */
  wake(): void {
    this.inputAcc = 0;
    this.thinkAcc = NPC.THINK_MS;
    this.nextDecideAt = 0;
  }

  /** NpcSystem: squared distance to the nearest living human (LOD). */
  setHumanD2(d2: number): void {
    this.humanD2 = d2;
  }

  /** Pin the per-NPC random traits / facing (tests). */
  tune(t: { rollChance?: number; aim?: number }): void {
    if (t.rollChance !== undefined) this.rollChance = t.rollChance;
    if (t.aim !== undefined) {
      this.aim = t.aim;
      this.rt.pub.aim = t.aim;
      this.look(t.aim, 3000);
    }
  }

  /** Samples enqueued so far (tests: INPUT_HZ per second). */
  get samples(): number {
    return this.seq;
  }

  /** Full decisions taken so far (tests: LOD). */
  get thinks(): number {
    return this.thinkCount;
  }

  /** Deciding at the reduced LOD rate right now. */
  get lod(): boolean {
    return this.lodNow;
  }

  /** Not idle on its post (searching, suspicious, fighting or walking home): keeps its squad awake. */
  get busy(): boolean {
    return this.state !== "idle";
  }

  /** Current search point (tests / debug), or null. */
  get searching(): Pt | null {
    return this.search ? { x: this.search.x, y: this.search.y } : null;
  }

  private emitInput(): void {
    let fire = false;
    let roll = false;
    let mx = this.walker.mx;
    let my = this.walker.my;
    // Hard leash: never a step that takes it farther out once at its chase radius (walking home
    // gets a little slack for corners, but a stuck-detour never carries it away).
    if (mx !== 0 || my !== 0) {
      const p = this.rt.pub;
      const ox = p.x - this.info.anchor.x, oy = p.y - this.info.anchor.y;
      const edge = this.info.chase + (this.homeward ? HOME_SLACK_PX : -8);
      if (Math.hypot(ox, oy) > edge && mx * ox + my * oy > 0) {
        mx = 0;
        my = 0;
      }
    }
    if (this.rollSamples > 0) {
      // Repeat roll:true on a few samples like the client's input buffer; the server starts it
      // only when its cooldown allows (same rule as a player's Space).
      if (this.rt.self.rollLeft > 0) {
        this.rollSamples = 0;
      } else {
        roll = true;
        mx = this.rollDx;
        my = this.rollDy;
        this.rollSamples--;
      }
    }
    const def = weaponDefOf(activeWeapon(this.rt));
    if (this.wantFire && def && !roll) {
      const clock = this.m.clock;
      if (def.auto) {
        // Bursts of NPC.BURST.SHOTS rounds with NPC.BURST.PAUSE_MS pauses, never a laser.
        if (clock >= this.pauseUntil && clock < this.burstUntil) fire = true;
        else if (clock >= this.burstUntil && clock >= this.pauseUntil) {
          const shots = Math.round(this.rand(NPC.BURST.SHOTS[0], NPC.BURST.SHOTS[1]));
          this.burstUntil = clock + shots * def.fireIntervalMs;
          this.pauseUntil = this.burstUntil + this.rand(NPC.BURST.PAUSE_MS[0], NPC.BURST.PAUSE_MS[1]);
          fire = true;
        }
      } else if (!this.lastFire && clock >= this.nextPressAt) {
        fire = true;
        this.nextPressAt = clock + Math.max(def.fireIntervalMs, MIN_PRESS_INTERVAL_MS) + this.rand(40, 220) * this.info.sloppiness;
      }
    }
    this.lastFire = fire;
    this.m.enqueueInput(this.rt.id, { seq: ++this.seq, mx, my, aim: this.aim, fire, roll, walk: this.walker.walk && !roll && !fire });
  }

  // ------------------------------------------------------------------ senses

  private canSee(o: PlayerRuntime): boolean {
    return o.pub.alive && this.m.vision.sees(this.rt.rosterIndex, o.rosterIndex);
  }

  /** The squad's alert radius for heard gunshots. */
  private alertHearPx(): number {
    return this.info.squad.type === "boss" ? BOSS_AI.ALERT_HEAR_PX : NPC.SQUAD_ALERT_HEAR_PX;
  }

  /**
   * Read the last sound delivery (sound.ts heardBy; NPC listeners never get the non-shot sounds of
   * other NPCs). Hidden entries carry only a sector and a distance band: the NPC estimates the
   * source at bandMid × the kind's radius (× env.hear; an occluded source is closer than it
   * sounds). A gunshot within the alert radius alerts the squad. Keeps the most interesting note
   * until the next decision. Returns true when something urgent was heard.
   */
  private listen(): boolean {
    const list = heardBy(this.m, this.rt.rosterIndex);
    if (list.length === 0) return false;
    const p = this.rt.pub;
    const hear = envNow(this.m).hear;
    const clock = this.m.clock;
    const alertPx = this.alertHearPx();
    let urgent = false;
    for (const s of list) {
      if (!s.hidden) {
        const src = this.m.runtime(s.id);
        if (!src || src === this.rt || src.isNpc) continue;
        const d = Math.hypot(src.pub.x - p.x, src.pub.y - p.y);
        if (s.kind === SoundKind.shot) {
          if (d <= alertPx) this.sys.alert(this.info.squad, src.pub.x, src.pub.y);
          // A visible shotgun blast right next to us: dive aside.
          if (s.variant === SHOTGUN_VARIANT && d < 300) this.tryRoll(Math.atan2(src.pub.y - p.y, src.pub.x - p.x), ROLL_ON_BURST / this.info.sloppiness);
          urgent = true;
        }
        // Seen sources are handled by sight.
        continue;
      }
      const prio = HEAR_PRIO[s.kind] ?? 0;
      if (prio <= 0) continue;
      const R = baseSoundRadius(s.kind, s.variant) * hear;
      const dist = (bandMid(s.b) * R) / (s.occluded ? SOUND.OCCLUSION_MULT : 1);
      const angle = sectorAngle(s.a);
      const x = p.x + Math.cos(angle) * dist;
      const y = p.y + Math.sin(angle) * dist;
      if (s.kind === SoundKind.shot && dist <= alertPx) {
        this.sys.alert(this.info.squad, x, y);
        urgent = true;
      }
      const h = this.heard;
      if (!h || prio > h.prio || (prio === h.prio && dist < h.dist)) this.heard = { kind: s.kind, prio, angle, dist, x, y, at: clock };
      if (prio >= 3 && s.b === 0) urgent = true;
      // A gunshot cracking right next to us from someone we cannot see: dive for cover.
      if (s.kind === SoundKind.shot && s.b === 0) this.tryRoll(angle, ROLL_ON_BURST / this.info.sloppiness);
    }
    return urgent;
  }

  /**
   * New damage since the last check: turn toward where it came from (the same quantized direction
   * a human's damage arc shows), alert the squad and maybe roll. Returns true on a new hit.
   */
  private checkHit(): boolean {
    const rt = this.rt;
    if (!(rt.lastHitAt > this.hitSeenAt)) return false;
    this.hitSeenAt = rt.lastHitAt;
    const by = rt.lastHitBy;
    if (!by || by.isNpc) return true;
    const p = rt.pub;
    const a = quantizeFa(Math.atan2(by.pub.y - p.y, by.pub.x - p.x));
    this.look(a, 1500);
    // Where the shot came from: the quantized direction at the shooter's distance (as a human
    // would judge it from the muzzle flash) — the squad converges there.
    const d = Math.hypot(by.pub.x - p.x, by.pub.y - p.y);
    this.threat = { x: p.x + Math.cos(a) * d, y: p.y + Math.sin(a) * d };
    this.sys.alert(this.info.squad, this.threat.x, this.threat.y);
    if (this.m.clock - rt.lastHitAt <= 300) this.tryRoll(a, this.rollChance);
    return true;
  }

  /**
   * Dodge roll perpendicular to a threat at `threat` (radians), when the roll is off cooldown (the
   * NPC reads its own SelfState like a player reads the HUD pie) and the dice say so.
   */
  private tryRoll(threat: number, chance: number): void {
    const s = this.rt.self;
    if (this.info.role === "boss" || s.rollCd > 0 || s.rollLeft > 0 || this.rollSamples > 0) return;
    if (this.m.rng() >= chance) return;
    const first = this.m.rng() < 0.5 ? 1 : -1;
    for (const sign of [first, -first]) {
      // Sideways and a little away from the threat; never off the chase radius.
      const a = threat + sign * (Math.PI / 2 + 0.3);
      const p = this.rt.pub;
      const to = { x: p.x + Math.cos(a) * 140, y: p.y + Math.sin(a) * 140 };
      if (Math.hypot(to.x - this.info.anchor.x, to.y - this.info.anchor.y) > this.info.chase) continue;
      if (this.walker.clear(a, 140)) {
        this.rollDx = Math.cos(a);
        this.rollDy = Math.sin(a);
        this.rollSamples = 3;
        return;
      }
    }
  }

  private look(angle: number, ms: number): void {
    this.lookAngle = angle;
    this.lookUntil = this.m.clock + ms;
  }

  /** Decide at the LOD rate: no human within NPC.LOD_PX and nothing going on around this NPC. */
  private computeLod(): boolean {
    const clock = this.m.clock;
    if (this.enemyId !== "" || clock - this.lastEnemyAt < 5000 || clock - this.rt.lastHitAt < 5000) return false;
    if (this.search || this.suspicious || this.info.squad.alertUntil > clock) return false;
    return this.humanD2 > NPC.LOD_PX * NPC.LOD_PX;
  }

  // ------------------------------------------------------------------ decisions

  private weaponAt(key: "w1" | "w2"): InvItem | undefined {
    const it = this.rt.self.slots.get(key);
    return it && itemDef(it.def)?.weapon ? it : undefined;
  }

  private rounds(it: InvItem | undefined): number {
    const def = weaponDefOf(it);
    return it && def ? it.mag + ammoCount(this.rt, def.ammo) : 0;
  }

  private armed(): boolean {
    return (["w1", "w2"] as const).some((k) => this.rounds(this.weaponAt(k)) > 0);
  }

  private dAnchor(x: number, y: number): number {
    return Math.hypot(x - this.info.anchor.x, y - this.info.anchor.y);
  }

  private think(): void {
    const rt = this.rt;
    const p = rt.pub;
    const s = rt.self;
    const clock = this.m.clock;
    const info = this.info;
    const sq = info.squad;
    this.walker.walk = false;
    this.wantFire = false;
    this.homeward = false;
    if (s.healUntil > 0) {
      // Patching up (the channel lands in boss.ts, capped at maxHp): stand still.
      this.walker.stop();
      return;
    }
    const underFire = this.underFire();
    // Alerted / under fire: the full human sight range for the next vision update (calm: the cap).
    rt.viewCap = underFire || sq.alertUntil > clock ? NPC.VIEW_RANGE_ALERT : NPC.VIEW_RANGE_CAP;
    const enemy = this.findEnemy();
    this.manageWeapons(enemy);
    if (enemy) this.sys.alert(sq, enemy.pub.x, enemy.pub.y);
    // The boss patches up only when nobody hit it recently (never while shot at from out of sight).
    const calm = clock - rt.lastHitAt > NPC_HEAL_CALM_MS;
    if (info.role === "boss" && p.hp < p.maxHp * BOSS_AI.HEAL_BELOW_FRAC && calm && startNpcHeal(this.m, rt)) {
      this.walker.stop();
      return;
    }
    if (enemy && this.armed()) {
      this.fight(enemy);
      return;
    }
    if (this.enemyId !== "") {
      // Lost sight mid-fight: the squad converges on the last-known position.
      const seen = this.enemySeen;
      if (seen) {
        this.sys.alert(sq, seen.x, seen.y);
        this.startSearch(seen.x, seen.y);
      }
      this.enemyId = "";
      this.enemySeen = null;
    }
    if (underFire && this.threat) {
      // Shot by someone it cannot see: get out of the line of fire (the squad searches).
      this.takeCover(this.threat);
      return;
    }
    this.cover = null;
    const w = activeWeapon(rt);
    const def = weaponDefOf(w);
    if (w && def && s.reloadUntil === 0 && w.mag < def.magSize * 0.6 && ammoCount(rt, def.ammo) > 0) this.m.reload(rt.id);
    this.processHeard();
    if (clock < NPC.PEACE_MS) this.peaceWatch();

    if (sq.alertUntil > clock && sq.alertAt) {
      const at = sq.alertAt;
      if (info.role === "boss") {
        // The boss holds its room and covers the threat direction.
        this.holdRoom(Math.atan2(at.y - p.y, at.x - p.x));
        this.state = "search";
        return;
      }
      if (!this.search || Math.hypot(this.search.x - at.x, this.search.y - at.y) > 150) this.startSearch(at.x, at.y);
      else this.search.until = Math.max(this.search.until, sq.alertUntil);
    }
    if (this.search) {
      this.doSearch();
      return;
    }
    if (this.suspicious && clock < this.suspicious.until) {
      this.doSuspicious();
      return;
    }
    this.suspicious = null;
    this.calm();
  }

  /** Hit by a living human within NPC.UNDER_FIRE_MS. */
  private underFire(): boolean {
    const by = this.rt.lastHitBy;
    return !!by && !by.isNpc && by.pub.alive && this.m.clock - this.rt.lastHitAt < NPC.UNDER_FIRE_MS;
  }

  /**
   * COVER: get out of the line of fire from `threat` — the nearest spot within
   * NPC.COVER_SEARCH_PX (inside the chase radius, reachable without leaving it) that a shot from
   * the threat cannot reach; hold it facing the threat. No such spot: juke sideways inside the
   * chase radius so blind fire keeps missing. Re-picked every COVER_REPICK_MS or when the threat moves.
   */
  private takeCover(threat: Pt): void {
    const clock = this.m.clock;
    const p = this.rt.pub;
    this.state = "cover";
    this.search = null;
    this.suspicious = null;
    this.dest = null;
    let c = this.cover;
    if (!c || clock - c.at > COVER_REPICK_MS || Math.hypot(c.threat.x - threat.x, c.threat.y - threat.y) > 250) {
      const spot = this.findCover(threat);
      c = this.cover = spot
        ? { x: spot.x, y: spot.y, threat, found: true, at: clock }
        : { x: p.x, y: p.y, threat, found: false, at: clock };
    }
    const face = Math.atan2(threat.y - p.y, threat.x - p.x);
    this.aim = face;
    if (c.found) {
      if (Math.hypot(c.x - p.x, c.y - p.y) <= 30) {
        this.walker.stop();
        return;
      }
      if (this.go(c.x, c.y, this.info.chase)) return;
      c.found = false;
    }
    if (clock >= this.jukeUntil) {
      this.jukeSign = this.m.rng() < 0.5 ? -1 : 1;
      this.jukeUntil = clock + this.rand(450, 1100);
    }
    let a = face + (this.jukeSign * Math.PI) / 2;
    const ahead = { x: p.x + Math.cos(a) * 80, y: p.y + Math.sin(a) * 80 };
    if (!this.walker.clear(a, 60) || this.dAnchor(ahead.x, ahead.y) > this.info.chase) {
      this.jukeSign = -this.jukeSign;
      a += Math.PI;
    }
    this.walker.heading(a);
  }

  /** Nearest covered spot from `threat` (see takeCover), rings of growing radius; null if none. */
  private findCover(threat: Pt): Pt | null {
    const m = this.m;
    const p = this.rt.pub;
    const pad = PLAYER.RADIUS;
    const covered = (x: number, y: number): boolean => {
      const d = Math.hypot(threat.x - x, threat.y - y);
      if (d < 1) return false;
      const px = (-(threat.y - y) / d) * pad, py = ((threat.x - x) / d) * pad;
      return !hasLineOfSight(m.idx, threat.x, threat.y, x, y, SOLID.SHOT) &&
        !hasLineOfSight(m.idx, threat.x, threat.y, x + px, y + py, SOLID.SHOT) &&
        !hasLineOfSight(m.idx, threat.x, threat.y, x - px, y - py, SOLID.SHOT);
    };
    if (covered(p.x, p.y)) return { x: p.x, y: p.y };
    for (const r of [110, 200, 300, NPC.COVER_SEARCH_PX]) {
      let best: Pt | null = null;
      let bestScore = Infinity;
      for (let k = 0; k < 16; k++) {
        const a = (k / 16) * Math.PI * 2;
        const x = p.x + Math.cos(a) * r;
        const y = p.y + Math.sin(a) * r;
        if (x < 64 || y < 64 || x > m.map.width - 64 || y > m.map.height - 64) continue;
        if (this.dAnchor(x, y) > this.info.chase - 20) continue;
        if (!circleIsFree(m.idx, x, y, PLAYER.RADIUS + 4) || !covered(x, y)) continue;
        // Prefer staying near its post.
        const score = this.dAnchor(x, y);
        if (score < bestScore) {
          best = { x, y };
          bestScore = score;
        }
      }
      if (best) return best;
    }
    return null;
  }

  /** The player who hit this NPC within NPC_RETALIATE_MS, if alive and not an NPC. */
  private recentAttacker(): PlayerRuntime | null {
    const by = this.rt.lastHitBy;
    if (!by || by.isNpc || !by.pub.alive || this.m.clock - this.rt.lastHitAt > NPC_RETALIATE_MS) return null;
    return by;
  }

  /**
   * The nearest visible human; never another NPC. Before NPC.PEACE_MS only a recent attacker or an
   * intruder: a human inside this NPC's post (its leash around the anchor) or within
   * NPC.PEACE_CLOSE_PX of it — the peace window protects spawns, not looting next to a camp.
   */
  private findEnemy(): PlayerRuntime | null {
    const p = this.rt.pub;
    const attacker = this.recentAttacker();
    const peace = this.m.clock < NPC.PEACE_MS;
    if (peace && attacker && this.canSee(attacker)) return attacker;
    let best: PlayerRuntime | null = null;
    let bestD = Infinity;
    for (const j of this.m.vision.row(this.rt.rosterIndex)) {
      const o = this.m.rosterRuntime(j);
      if (!o || !o.pub.alive || o.isNpc) continue;
      let d = Math.hypot(o.pub.x - p.x, o.pub.y - p.y);
      if (peace && d > NPC.PEACE_CLOSE_PX && this.dAnchor(o.pub.x, o.pub.y) > this.info.leash) continue;
      if (o.id === this.enemyId) d *= 0.7;
      if (o === attacker) d *= 0.5;
      if (d < bestD) {
        best = o;
        bestD = d;
      }
    }
    return best;
  }

  /** Peace window: a human in sight is watched (suspicious), never shot at. */
  private peaceWatch(): void {
    const p = this.rt.pub;
    for (const j of this.m.vision.row(this.rt.rosterIndex)) {
      const o = this.m.rosterRuntime(j);
      if (!o || !o.pub.alive || o.isNpc) continue;
      this.suspicious = { x: o.pub.x, y: o.pub.y, until: this.m.clock + NPC.SUSPICIOUS_MS, step: false };
      this.look(Math.atan2(o.pub.y - p.y, o.pub.x - p.x), 600);
      return;
    }
  }

  /** Turn toward the best sound heard since the last decision: SUSPICIOUS (no squad alert). */
  private processHeard(): void {
    const h = this.heard;
    this.heard = null;
    if (!h) return;
    const clock = this.m.clock;
    if (clock - h.at > 2000) return;
    this.look(h.angle + this.rand(-0.15, 0.15), 1600);
    if (this.search) return;
    const cur = this.suspicious;
    if (cur && clock < cur.until && Math.hypot(cur.x - h.x, cur.y - h.y) < 200) {
      cur.until = clock + NPC.SUSPICIOUS_MS;
      return;
    }
    this.suspicious = { x: h.x, y: h.y, until: clock + NPC.SUSPICIOUS_MS, step: true };
  }

  private startSearch(x: number, y: number): void {
    const p = this.rt.pub;
    this.state = "search";
    this.suspicious = null;
    this.search = {
      x, y, until: this.m.clock + NPC.SEARCH_MS, arrived: false,
      base: Math.atan2(y - p.y, x - p.x), sweepAt: 0, side: 1,
    };
  }

  /** Marauder squads of 2+: the first living member keeps the post while the others search. */
  private holdsPost(): boolean {
    if (this.info.role !== "marauder") return false;
    const alive = this.info.squad.members.filter((r) => r.pub.alive);
    return alive.length >= 2 && alive[0] === this.rt;
  }

  /**
   * SEARCH: walk to the last-known position (clamped to the chase radius; route never leaving it),
   * sneaking the last stretch, then sweep ±NPC.SEARCH_SWEEP_DEG until the search (and the squad
   * alert) run out; then RETURN.
   */
  private doSearch(): void {
    const sr = this.search!;
    const p = this.rt.pub;
    const clock = this.m.clock;
    const sq = this.info.squad;
    if (clock > sr.until && !(sq.alertUntil > clock)) {
      this.search = null;
      this.state = "return";
      this.calm();
      return;
    }
    this.state = "search";
    const face = Math.atan2(sr.y - p.y, sr.x - p.x);
    if (this.holdsPost()) {
      const a = this.info.anchor;
      if (Math.hypot(a.x - p.x, a.y - p.y) > 60) this.walker.navigate(a.x, a.y);
      else this.walker.stop();
      this.aim = clock < this.lookUntil ? this.lookAngle : face;
      return;
    }
    const to = clampTo(this.info.anchor, sr.x, sr.y, this.info.chase);
    const d = Math.hypot(to.x - p.x, to.y - p.y);
    if (!sr.arrived && d < ARRIVE_PX) {
      sr.arrived = true;
      sr.base = face;
      sr.sweepAt = 0;
    }
    if (sr.arrived) {
      this.walker.stop();
      if (clock >= sr.sweepAt) {
        sr.sweepAt = clock + this.rand(700, 1100);
        sr.side = -sr.side;
        this.aim = sr.base + sr.side * ((NPC.SEARCH_SWEEP_DEG * Math.PI) / 180) * this.rand(0.5, 1);
      }
      if (clock < this.lookUntil) this.aim = this.lookAngle;
      return;
    }
    this.walker.walk = d < SNEAK_RANGE;
    if (!this.go(to.x, to.y, this.info.chase)) sr.arrived = true;
    this.aim = clock < this.lookUntil ? this.lookAngle : face;
  }

  /** SUSPICIOUS: face the noise, step toward it (inside the leash, quietly). */
  private doSuspicious(): void {
    const su = this.suspicious!;
    const p = this.rt.pub;
    const clock = this.m.clock;
    this.state = "suspicious";
    const face = Math.atan2(su.y - p.y, su.x - p.x);
    this.aim = clock < this.lookUntil ? this.lookAngle : face;
    if (!su.step || this.info.role === "boss" || this.holdsPost()) {
      this.walker.stop();
      return;
    }
    const d = Math.hypot(su.x - p.x, su.y - p.y);
    const k = Math.min(1, SUSPICIOUS_STEP_PX / Math.max(1, d));
    const to = clampTo(this.info.anchor, p.x + (su.x - p.x) * k, p.y + (su.y - p.y) * k, this.info.leash);
    if (Math.hypot(to.x - p.x, to.y - p.y) < 40) {
      this.walker.stop();
      return;
    }
    this.walker.walk = true;
    this.go(to.x, to.y, this.info.leash);
  }

  /** The boss holds its room: back to the spot when it strayed, facing `look`. */
  private holdRoom(look: number): void {
    const p = this.rt.pub;
    const a = this.info.anchor;
    const d = Math.hypot(a.x - p.x, a.y - p.y);
    this.dest = d > BOSS_HOLD_PX ? a : null;
    if (this.dest) this.walker.navigate(a.x, a.y);
    else this.walker.stop();
    this.aim = this.m.clock < this.lookUntil ? this.lookAngle : look;
  }

  /**
   * RETURN / IDLE: back to the route (the post) after any excitement, then hold it or walk the
   * patrol, idling NPC.IDLE_LOOK_MS at each point and looking around.
   */
  private calm(): void {
    const p = this.rt.pub;
    const clock = this.m.clock;
    const info = this.info;
    if (this.state !== "idle" && this.state !== "return") this.state = "return";
    if (this.state === "return") {
      const a = info.route[this.routeIdx] ?? info.anchor;
      if (Math.hypot(a.x - p.x, a.y - p.y) > 60) {
        this.goHome(a);
        this.aim = clock < this.lookUntil ? this.lookAngle : Math.atan2(this.walker.my, this.walker.mx);
        return;
      }
      this.state = "idle";
      this.dest = null;
      this.idleUntil = clock + this.rand(NPC.IDLE_LOOK_MS[0], NPC.IDLE_LOOK_MS[1]);
    }
    const dest = this.dest;
    if (dest && Math.hypot(dest.x - p.x, dest.y - p.y) > 60) {
      this.walker.navigate(dest.x, dest.y);
      this.aim = clock < this.lookUntil ? this.lookAngle : Math.atan2(this.walker.my, this.walker.mx);
      return;
    }
    if (dest) {
      // Arrived: idle a while, looking around.
      this.dest = null;
      this.idleUntil = clock + this.rand(NPC.IDLE_LOOK_MS[0], NPC.IDLE_LOOK_MS[1]);
    }
    this.walker.stop();
    if (clock < this.lookUntil) this.aim = this.lookAngle;
    else if (clock >= this.scanAt) {
      this.scanAt = clock + this.rand(1200, 2600);
      this.aim += this.rand(-2, 2);
    }
    if (clock < this.idleUntil) return;
    let to: Pt | null = null;
    if (info.role === "boss") {
      const a = this.rand(-Math.PI, Math.PI);
      const r = this.rand(0, BOSS_HOLD_PX * 0.7);
      to = { x: info.anchor.x + Math.cos(a) * r, y: info.anchor.y + Math.sin(a) * r };
    } else if (info.route.length > 1) {
      this.routeIdx = (this.routeIdx + 1) % info.route.length;
      to = info.route[this.routeIdx]!;
    } else {
      // Holding the post: just look around again later.
      this.idleUntil = clock + this.rand(NPC.IDLE_LOOK_MS[0], NPC.IDLE_LOOK_MS[1]);
      if (Math.hypot(info.anchor.x - p.x, info.anchor.y - p.y) > 60) to = info.anchor;
    }
    if (to) {
      this.dest = to;
      this.walker.navigate(to.x, to.y);
    }
  }

  /** Between LOD decisions: keep walking the current route (no scans, no new decisions). */
  private move(): void {
    if (this.dest && this.rt.self.healUntil === 0) this.walker.navigate(this.dest.x, this.dest.y);
    else if (this.state === "return") this.goHome(this.info.route[this.routeIdx] ?? this.info.anchor);
    else this.walker.stop();
  }

  /**
   * Walk toward (x, y) inside radius r of the anchor. A route that would leave it (around a wall,
   * out of the building) is not taken: the NPC holds where it is. Returns true while moving.
   */
  private go(x: number, y: number, r: number): boolean {
    this.walker.navigate(x, y);
    for (const q of this.walker.ahead()) {
      if (this.dAnchor(q.x, q.y) > r + 100) {
        this.walker.stop();
        return false;
      }
    }
    return true;
  }

  /** Breadcrumbs of the way out (see `trail`); cleared back at the post. */
  private recordTrail(): void {
    const p = this.rt.pub;
    const d = this.dAnchor(p.x, p.y);
    if (d < 60) {
      if (this.trail.length) this.trail = [];
      return;
    }
    // Walking home consumes the trail; it never adds to it.
    if (d < this.info.leash * 0.5 || this.homeward) return;
    const last = this.trail[this.trail.length - 1];
    if (!last || Math.hypot(last.x - p.x, last.y - p.y) >= TRAIL_STEP_PX) {
      this.trail.push({ x: p.x, y: p.y });
      if (this.trail.length > TRAIL_MAX) this.trail.splice(0, this.trail.length - TRAIL_MAX);
    }
  }

  /** Walk home: back along the trail it came by, then to `to` (its post / route point). */
  private goHome(to: Pt): void {
    const p = this.rt.pub;
    this.homeward = true;
    while (this.trail.length > 0 && Math.hypot(this.trail[this.trail.length - 1]!.x - p.x, this.trail[this.trail.length - 1]!.y - p.y) < 50) this.trail.pop();
    const next = this.trail[this.trail.length - 1];
    // Inside half the leash the direct route home is safe.
    if (next && this.dAnchor(p.x, p.y) > this.info.leash * 0.5) this.walker.navigate(next.x, next.y);
    else this.walker.navigate(to.x, to.y);
  }

  private giveUp(): void {
    if (this.search) this.search.arrived = true;
    else if (this.suspicious) this.suspicious = null;
    else if (this.dest) {
      this.dest = null;
      this.idleUntil = this.m.clock + this.rand(NPC.IDLE_LOOK_MS[0], NPC.IDLE_LOOK_MS[1]);
    }
  }

  // ------------------------------------------------------------------ combat

  private fight(ert: PlayerRuntime): void {
    const p = this.rt.pub;
    const e = ert.pub;
    const clock = this.m.clock;
    const info = this.info;
    const dx = e.x - p.x;
    const dy = e.y - p.y;
    const dist = Math.hypot(dx, dy);
    const angle = Math.atan2(dy, dx);
    this.state = "combat";
    if (ert.id !== this.enemyId) {
      // The same enemy seen again within ENEMY_MEMORY_MS (a flash, a peek): no new reaction delay.
      const remembered = ert.id === this.lastEnemyId && clock - this.lastEnemyAt < ENEMY_MEMORY_MS;
      this.enemyId = ert.id;
      this.lastEnemyId = ert.id;
      this.enemySeen = null;
      this.enemySpeed = 0;
      if (!remembered) this.reactAt = clock + this.rand(info.reactMs[0], info.reactMs[1]);
    }
    this.lastEnemyAt = clock;
    this.search = null;
    this.suspicious = null;
    this.dest = null;
    // Target speed from what the NPC saw (smoothed), not from hidden state.
    if (this.enemySeen && clock > this.enemySeen.at) {
      const v = Math.hypot(e.x - this.enemySeen.x, e.y - this.enemySeen.y) / ((clock - this.enemySeen.at) / 1000);
      this.enemySpeed = this.enemySpeed * 0.5 + Math.min(v, PLAYER.SPEED * 1.5) * 0.5;
    }
    this.enemySeen = { x: e.x, y: e.y, at: clock };
    if (clock >= this.aimErrUntil) {
      const moving = Math.min(1, this.enemySpeed / PLAYER.SPEED);
      const spread = (AIM_ERR_BASE + (dist / 1000) * AIM_ERR_PER_1000PX + moving * AIM_ERR_MOVING) * info.sloppiness;
      this.aimErr = (this.m.rng() * 2 - 1) * spread;
      this.aimErrUntil = clock + this.rand(180, 380);
    }
    this.aim = angle + this.aimErr;

    const def = weaponDefOf(activeWeapon(this.rt)) ?? WEAPONS.pistol;
    // Engage to (almost) the weapon's full range, within what it can see right now.
    const engage = Math.min(def.range * ENGAGE_RANGE_FRAC, Math.max(this.rt.viewCap, NPC.VIEW_RANGE_CAP));
    // Fire only with a confirmed line of fire right now (the published row has hysteresis).
    const los = hasLineOfSight(this.m.idx, p.x, p.y, e.x, e.y, SOLID.SHOT);
    this.wantFire = dist <= engage && clock >= this.reactAt && los;
    // Out of reach: beyond its engage range and it may not close in far enough (chase radius; a
    // guard never leaves its leash). Under fire from there: break line of sight instead of standing
    // at the edge as a target (v5 review: kiting at 870 px / a pistol at 520 px got 0 return fire).
    if (dist > engage && this.underFire()) {
      // Where it may get to: the boss holds its room (never advances); a guard closes in only on an
      // enemy inside its leash + 150 (v4); a marauder up to its chase radius.
      const advance = info.role === "marauder" || (info.role === "guard" && this.dAnchor(e.x, e.y) <= info.leash + 150);
      const reach = advance ? clampTo(info.anchor, e.x, e.y, info.chase) : { x: p.x, y: p.y };
      if (Math.hypot(e.x - reach.x, e.y - reach.y) > engage * 0.95) {
        this.wantFire = false;
        this.takeCover({ x: e.x, y: e.y });
        return;
      }
    }
    this.cover = null;

    // Pulled off its ground (rolled, pushed, chased too far): back toward the anchor first.
    if (this.dAnchor(p.x, p.y) > info.chase) {
      this.goHome(info.anchor);
      return;
    }
    if (info.role === "boss") {
      // The boss holds its room: strafes nowhere, never chases out of it.
      if (this.dAnchor(p.x, p.y) > BOSS_HOLD_PX) this.walker.navigate(info.anchor.x, info.anchor.y);
      else this.walker.stop();
      return;
    }
    const sniper = def.id === "sniper";
    const far = dist > engage * 0.85 || !los;
    if (far && !sniper) {
      // Close in, but only inside the chase radius (guards: their leash, and only toward an enemy
      // inside it, v4); a route around a wall must not drag it out.
      if (info.role === "guard" && this.dAnchor(e.x, e.y) > info.leash + 150) {
        this.walker.stop();
        return;
      }
      const to = clampTo(info.anchor, e.x, e.y, info.chase);
      if (Math.hypot(to.x - p.x, to.y - p.y) < 30) this.walker.stop();
      else this.go(to.x, to.y, info.chase);
      return;
    }
    if (clock >= this.strafeUntil) {
      this.strafe = this.m.rng() < 0.5 ? -1 : 1;
      this.strafeUntil = clock + this.rand(500, 1300);
    }
    // Preferred band: the shotgun closes in, the sniper keeps its distance.
    const [near, farBand] = def.id === "shotgun" ? [140, 260] : sniper ? [450, engage * 0.95] : [260, def.range * 0.6];
    const radial = dist < near ? -0.7 : dist > farBand ? 0.7 : 0;
    let a = Math.atan2(Math.sin(angle) * radial + Math.cos(angle) * this.strafe,
      Math.cos(angle) * radial - Math.sin(angle) * this.strafe);
    const ahead = { x: p.x + Math.cos(a) * 80, y: p.y + Math.sin(a) * 80 };
    if (!this.walker.clear(a, 60) || this.dAnchor(ahead.x, ahead.y) > info.chase) {
      this.strafe = -this.strafe;
      a += Math.PI;
      const back = { x: p.x + Math.cos(a) * 80, y: p.y + Math.sin(a) * 80 };
      if (this.dAnchor(back.x, back.y) > info.chase) {
        this.walker.stop();
        return;
      }
    }
    // The sniper fires standing (no strafing) unless the enemy is too close.
    if (sniper && radial >= 0) {
      this.walker.stop();
      return;
    }
    this.walker.heading(a);
  }

  /**
   * Weapon choice: an empty active weapon → the other one; with a target, a shotgun NPC switches
   * to its (FREE) sidearm for a target beyond shotgun range, and back to the shotgun up close.
   */
  private manageWeapons(enemy: PlayerRuntime | null): void {
    const p = this.rt.pub;
    const s = this.rt.self;
    if (s.reloadUntil > 0 || this.m.clock < this.switchAt) return;
    const active = activeWeapon(this.rt);
    const activeEmpty = this.rounds(active) <= 0;
    const dist = enemy ? Math.hypot(enemy.pub.x - p.x, enemy.pub.y - p.y) : 400;
    if (!activeEmpty) {
      const adef = weaponDefOf(active);
      if (!enemy || !adef) return;
      const other = (["w1", "w2"] as const).find((k) => k !== s.active && this.rounds(this.weaponAt(k)) > 0);
      const odef = other ? weaponDefOf(this.weaponAt(other)) : undefined;
      if (!other || !odef) return;
      const reachOut = adef.id === "shotgun" && dist > adef.range * 0.9 && odef.range > adef.range;
      const closeIn = odef.id === "shotgun" && adef.range > odef.range && dist < odef.range * 0.6;
      if (reachOut || closeIn) {
        this.m.switchSlot(this.rt.id, other);
        this.switchAt = this.m.clock + 900;
      }
      return;
    }
    for (const k of ["w1", "w2"] as const) {
      const w = this.weaponAt(k);
      if (!w || k === s.active || this.rounds(w) <= 0) continue;
      if (weaponDefOf(w)?.id === "shotgun" && dist > 330 && enemy) continue;
      this.m.switchSlot(this.rt.id, k);
      this.switchAt = this.m.clock + 900;
      return;
    }
  }

  private rand(min: number, max: number): number {
    return min + this.m.rng() * (max - min);
  }
}
