/**
 * GameAudio: the GameSystem that turns the match into sound (WP-A1). It is the only audio module
 * the renderer touches (through SYSTEM_FACTORIES → `createGameAudioSystem`).
 *
 * Sources of sound (critique.md "Sound contract" + "Shot, hit and event routing"):
 *  - `ev.snd` (shared decodeSoundMsg): every remote non-UI sound, gunshots included. Hidden entries
 *    carry only (sector, band, occluded) → playHidden; visible ones carry a sessionId → playAt on the
 *    position we already render. The ShotMsg itself only drives tracers, except our own echo.
 *  - `ev.hits` / `ev.kills` / `ev.chest`: impacts (exact positions are already public to us),
 *    hitmarker / kill confirm, container lids.
 *  - Our own sounds never come back from the server (listener == source is skipped), so they are
 *    derived locally: footsteps from predicted travel (Stride + surfaceAt), reload/heal/switch/
 *    roll/search/extract from SelfState transitions, own gunshots from the ShotMsg echo or, with no
 *    latency, from the optional `getGameAudio().localShot()` hook the input code may call.
 *  - Ambience and thunder from the deterministic environment (ambience.ts).
 *
 * Pure decision helpers are exported and tested in game-audio.test.ts; the class only wires them to
 * the engine. Nothing here allocates per frame except on state transitions.
 */
import {
  ACT,
  GRENADE_SOUND,
  MATCH,
  SoundKind,
  WEAPONS,
  WEAPON_IDS,
  baseSoundRadius,
  buildBushIndex,
  bushIndexAt,
  countOccluders,
  decodeSoundMsg,
  effectiveSoundRadius,
  envConfigOf,
  envSchedule,
  getCollisionIndex,
  getWallIndex,
  isIndoor,
  raycastSolids,
  sampleEnv,
  surfaceAt,
  terrainByteAt,
  type BattleState,
  type BushIndex,
  type CollisionIndex,
  type ContainerKind,
  type DecodedSound,
  type EnvConfig,
  type EnvSample,
  type EventsMsg,
  type MapData,
  type ShotMsg,
  type Strike,
  type WeaponId,
} from "@extract/shared";
import type { GameContext, GameSystem } from "../systems";
import { hudPhase } from "../hud";
import { AMBIENCE, AmbientDirector, emptyEnvSource, rememberEnvSource, sameEnvSource } from "./ambience";
import { AudioEngine, type PlayOpts, type Voice } from "./engine";
import { Stride, footstepLayers, materialFromVariant, materialOfTerrain, type Layer } from "./footsteps";
import type { SfxId } from "./recipes";
import { clamp } from "./spatial";

// ---------------------------------------------------------------- constants

/** Remote players are drawn ~100 ms in the past (renderer INTERP_DELAY_MS); visible sounds follow. */
export const REMOTE_SOUND_DELAY_S = 0.1;
/** Server and client positions differ a little; never drop a sound the server said we hear. */
export const RANGE_SLACK = 1.15;
/** A ShotMsg echo within this window of a local shot was already played by `localShot`. */
export const LOCAL_ECHO_WINDOW_MS = 400;
/** Being hit harder than this muffles the mix for a moment (immersion memo). */
export const HIT_MUFFLE_MIN_DMG = 25;
export const HIT_MUFFLE = { cutoff: 900, holdMs: 250, releaseMs: 400 } as const;
export const DEATH_MUFFLE = { cutoff: 400, rampS: 1.5 } as const;
export const LOW_HP = { threshold: 35, floor: 10, slowMs: 1000, fastMs: 550, maxBoostDb: 8 } as const;
/** Our own extract alarm repeats like the server's (SOUND.EXTRACT_REPEAT_MS) so we hear what others hear. */
export const SELF_SIREN_DB = -6;
export const SELF_SIREN_REPEAT_MS = 2500;
export const SEARCH_REPEAT_MS = 1500;
/** Bullet travel to a wall is audible as a delay, but never longer than this. */
export const WALL_IMPACT_MAX_DELAY_S = 0.5;
/** Inventory poll for the pickup / drop sounds. */
export const INV_POLL_MS = 100;
/** No drop sound while a reload / heal / throw may be consuming an item (plus this slack). */
export const CONSUME_QUIET_MS = 600;
/** Pump / bolt after a shotgun or sniper shot. */
export const RACK_AFTER_SHOT_S: Partial<Record<WeaponId, number>> = { shotgun: 0.35, sniper: 0.5 };

// ---------------------------------------------------------------- pure helpers

export function gunSfx(w: string | undefined): SfxId {
  switch (w) {
    case "rifle":
      return "gun_rifle";
    case "shotgun":
      return "gun_shotgun";
    case "sniper":
      return "gun_sniper";
    // Weapons v2.
    case "smg":
      return "gun_smg";
    case "lmg":
      return "gun_lmg";
    case "revolver":
      return "gun_revolver";
    case "crossbow":
      return "gun_crossbow";
    default:
      return "gun_pistol";
  }
}

/** Container lid by kind: wooden crates and stashes creak, cases and boxes latch, the safe clunks. */
export function containerOpenSfx(kind: ContainerKind | string | undefined): SfxId {
  switch (kind) {
    case "safe":
      return "chest_open_safe";
    case "toolbox":
    case "weapon_box":
    case "med_case":
    case "fridge":
    case "pc":
      return "chest_open_metal";
    default:
      return "chest_open";
  }
}

/**
 * Where a shot's bullet stops in a solid: the middle pellet raycast from the shooter's centre over
 * the weapon's range (the server raycasts from there too). Null when it flies out of range.
 */
export function wallImpact(idx: CollisionIndex, shot: Pick<ShotMsg, "cx" | "cy" | "a">, range: number): { x: number; y: number; dist: number } | null {
  if (!shot.a.length || !(range > 0)) return null;
  const a = shot.a[Math.floor(shot.a.length / 2)]!;
  const dx = Math.cos(a);
  const dy = Math.sin(a);
  const t = raycastSolids(idx, shot.cx, shot.cy, shot.cx + dx * range, shot.cy + dy * range);
  if (!(t >= 0 && t <= 1)) return null;
  // A hair before the face, so the occlusion ray from the listener does not start inside the wall.
  const dist = Math.max(0, t * range - 2);
  return { x: shot.cx + dx * dist, y: shot.cy + dy * dist, dist };
}

export interface SoundLayer extends Layer {
  /** Seconds after the sound's own start (multi-part sounds such as a reload). */
  at?: number;
}

/**
 * Which buffers one decoded sound plays. Step kinds reuse footstepLayers (material = variant,
 * wet splash, bush rustle). Kinds without a dedicated recipe borrow the closest one.
 */
export function layersForSound(kind: number, variant: number, wetness = 0): SoundLayer[] {
  switch (kind) {
    case SoundKind.step:
      return footstepLayers({ material: materialFromVariant(variant), wetness });
    case SoundKind.stepBush:
      return footstepLayers({ material: materialFromVariant(variant), wetness, bush: true });
    case SoundKind.roll:
      return [{ id: "roll", db: 0 }];
    case SoundKind.shot:
      return [{ id: gunSfx(WEAPON_IDS[variant]), db: 0 }];
    case SoundKind.reload:
      return [
        { id: "reload_out", db: 0 },
        { id: "reload_in", db: 0, at: 0.55 },
      ];
    case SoundKind.heal:
      return [{ id: variant === 1 ? "heal_medkit" : "heal_bandage", db: 0 }];
    case SoundKind.loot:
      return [{ id: "chest_open", db: 0 }];
    case SoundKind.search:
      return [{ id: "search", db: 0 }];
    case SoundKind.extract:
      return [{ id: "siren", db: 0 }];
    case SoundKind.hurt:
      return [{ id: "hit_flesh", db: -3 }];
    case SoundKind.death:
      return [{ id: "body_fall", db: 0 }];
    case SoundKind.bodyFall:
      return [{ id: "body_fall", db: -2 }];
    case SoundKind.dryFire:
      return [{ id: "dry_fire", db: 0 }];
    case SoundKind.switch:
      return [{ id: "weapon_switch", db: 0 }];
    // Weapons v2: grenade blast (a world sound) and the pin / a bounce off a wall.
    case SoundKind.explosion:
      return [{ id: "explosion", db: 0 }];
    case SoundKind.grenade:
      return [{ id: variant === GRENADE_SOUND.BOUNCE ? "grenade_bounce" : "grenade_pin", db: 0 }];
    default:
      return [];
  }
}

/**
 * Audible range (px) of a visible source, for spatialize(): the shared base radius × env.hear
 * (× the surface multiplier for steps) × RANGE_SLACK.
 */
export function visibleRange(kind: number, variant: number, walk: boolean, hear: number, stepRangeMult = 1): number {
  const isStep = kind === SoundKind.step || kind === SoundKind.stepBush;
  return effectiveSoundRadius(baseSoundRadius(kind as SoundKind, variant, walk), hear, isStep ? stepRangeMult : 1) * RANGE_SLACK;
}

/** Heartbeat below 35 HP: 1.0 s → 0.55 s interval and -8 → 0 dB as HP falls to 10. */
export function heartbeatFor(hp: number): { intervalMs: number; db: number } | null {
  if (!(hp > 0) || hp >= LOW_HP.threshold) return null;
  const t = clamp((LOW_HP.threshold - hp) / (LOW_HP.threshold - LOW_HP.floor), 0, 1);
  return { intervalMs: LOW_HP.slowMs - (LOW_HP.slowMs - LOW_HP.fastMs) * t, db: LOW_HP.maxBoostDb * t };
}

/** Own extract channel: a beep every second, every half second in the last 3 s. */
export function extractBeepIntervalMs(remainingMs: number): number {
  return remainingMs > 3000 ? 1000 : 500;
}

/** Own reload: mag out at 15%, mag in at 70%, rack at 90% of the reload time (seconds from now). */
export function reloadCues(reloadMs: number): Array<{ id: SfxId; at: number }> {
  const d = Math.max(0, reloadMs) / 1000;
  return [
    { id: "reload_out", at: 0.15 * d },
    { id: "reload_in", at: 0.7 * d },
    { id: "rack", at: 0.9 * d },
  ];
}

/** The part of SelfState (+ public me) whose transitions make our own sounds. */
export interface SelfSnap {
  alive: boolean;
  hp: number;
  weapon: string;
  active: string;
  reloadUntil: number;
  healUntil: number;
  healKind: string;
  rollLeft: number;
  searching: string;
  extractStartedAt: number;
  extractedAt: number;
}

export function emptySnap(): SelfSnap {
  return { alive: true, hp: 100, weapon: "", active: "", reloadUntil: 0, healUntil: 0, healKind: "", rollLeft: 0, searching: "", extractStartedAt: 0, extractedAt: 0 };
}

export type SelfCue =
  | { k: "reload"; ms: number }
  | { k: "reloadCancel" }
  | { k: "heal"; kind: string }
  | { k: "switch" }
  | { k: "roll" }
  | { k: "searchStart"; key: string }
  | { k: "searchStop" }
  | { k: "extractStart" }
  | { k: "extractStop" }
  | { k: "extracted" }
  | { k: "died" }
  | { k: "revived" };

/**
 * Edge detection on our own state. The first snapshot after joining produces nothing, so a
 * reconnect in the middle of a reload or a heal does not replay its sounds. `clockMs` turns the
 * absolute reloadUntil into a remaining duration.
 */
export function selfCues(prev: SelfSnap | null, next: SelfSnap, clockMs: number, out: SelfCue[] = []): SelfCue[] {
  if (!prev) return out;
  if (prev.alive && !next.alive) out.push({ k: "died" });
  if (!prev.alive && next.alive) out.push({ k: "revived" });
  if (!next.alive) return out;

  const switched = prev.active !== "" && next.active !== "" && prev.active !== next.active;
  if (switched) out.push({ k: "switch" });
  if (next.reloadUntil > clockMs && next.reloadUntil !== prev.reloadUntil) out.push({ k: "reload", ms: next.reloadUntil - clockMs });
  else if (prev.reloadUntil > clockMs && (next.reloadUntil === 0 || switched)) out.push({ k: "reloadCancel" });
  if (next.healUntil > clockMs && next.healUntil !== prev.healUntil) out.push({ k: "heal", kind: next.healKind });
  if (next.rollLeft > 0 && prev.rollLeft === 0) out.push({ k: "roll" });
  if (next.searching !== prev.searching) {
    if (prev.searching !== "") out.push({ k: "searchStop" });
    if (next.searching !== "") out.push({ k: "searchStart", key: next.searching });
  }
  if (next.extractedAt > 0 && prev.extractedAt === 0) out.push({ k: "extracted" });
  else if (next.extractStartedAt > 0 && prev.extractStartedAt === 0) out.push({ k: "extractStart" });
  else if (next.extractStartedAt === 0 && prev.extractStartedAt > 0) out.push({ k: "extractStop" });
  return out;
}

/** Per-batch dedupe key: the same sfx from the same source plays once per server tick. */
export function sourceKey(d: DecodedSound): string {
  return d.hidden ? `h${d.a}:${d.b}` : `v${d.id}`;
}

// ---------------------------------------------------------------- local hook (optional)

/** Zero-latency hooks the input/prediction code may call; all are optional and idempotent-safe. */
export interface GameAudioLocal {
  /** Predicted local fire: plays our gunshot now; the ShotMsg echo is then skipped. */
  localShot(weapon: WeaponId): void;
  /** Trigger pulled on an empty magazine (no server echo exists for this one). */
  localDryFire(): void;
  /** Predicted roll start (the SelfState roll cue is then skipped). */
  localRoll(): void;
  /** Weapons v2: our grenade throw was sent (the server never echoes our own sounds). */
  localThrow(): void;
}

let activeSystem: GameAudioSystem | null = null;

/** The running GameAudio system, or null outside a match. */
export function getGameAudio(): GameAudioLocal | null {
  return activeSystem;
}

// ---------------------------------------------------------------- the system

class GameAudioSystem implements GameSystem, GameAudioLocal {
  readonly id = "audio";
  private eng: AudioEngine | null = null;
  private director: AmbientDirector | null = null;
  private disposed = false;

  private readonly stride = new Stride();
  private lastX = Number.NaN;
  private lastY = Number.NaN;

  private map: MapData | null = null;
  private bushes: BushIndex | null = null;
  private envCfg: EnvConfig | null = null;
  private readonly envSrc = emptyEnvSource();
  private strikes: readonly Strike[] = [];
  private env: EnvSample | null = null;
  private indoor = false;
  private nextAmbAt = 0;

  private prevSnap: SelfSnap | null = null;
  private snapA = emptySnap();
  private snapB = emptySnap();
  private readonly cues: SelfCue[] = [];
  private alive = true;
  private lowHp = false;
  private nextBeatAt = 0;
  private pendingReload: Array<{ v: Voice; startAt: number }> = [];
  private searchVoice: Voice | null = null;
  private nextSearchAt = 0;
  private extracting = false;
  private nextBeepAt = 0;
  private nextSirenAt = 0;
  private prevPhase = "";
  private walking = false;

  private localShots: number[] = [];
  private invQty = -1;
  private nextInvAt = 0;
  private quietDropsUntil = 0;
  private localRollAt = Number.NEGATIVE_INFINITY;

  // Per-batch scratch.
  private readonly played = new Set<string>();
  private readonly hitTargets = new Set<string>();
  private readonly hitShooters = new Set<string>();

  init(ctx: GameContext): void {
    const eng = AudioEngine.get();
    this.eng = eng;
    eng.installUnlock();
    void eng.ensureBaked();
    this.director = new AmbientDirector(eng);
    activeSystem = this;
    this.syncMap(ctx);
  }

  // ------------------------------------------------------------ frame

  frame(_dtMs: number, ctx: GameContext): void {
    const eng = this.eng;
    if (!eng || this.disposed) return;
    const state = ctx.state();
    if (!state || !this.syncMap(ctx)) return;
    const map = this.map!;
    const now = performance.now();
    const clock = ctx.clockMs();
    const pos = ctx.selfPos();
    eng.listener.facing = ctx.aim();

    this.syncEnv(state, map);
    if (now >= this.nextAmbAt && this.envCfg) {
      this.nextAmbAt = now + AMBIENCE.UPDATE_MS;
      this.env = sampleEnv(this.envCfg, clock);
      this.indoor = isIndoor(map, pos.x, pos.y);
      this.director?.update(this.env, this.indoor, pos.x, pos.y, this.strikes, now, clock);
    }

    // Own state transitions.
    const next = this.prevSnap === this.snapA ? this.snapB : this.snapA;
    this.readSnap(ctx, next);
    this.cues.length = 0;
    selfCues(this.prevSnap, next, clock, this.cues);
    for (const c of this.cues) this.onCue(c, now);
    this.prevSnap = next;

    this.walking = ctx.self()?.walking ?? false;
    this.ownSteps(next, pos.x, pos.y, now);
    this.lowHpTick(next, now);
    this.inventoryTick(ctx, next, now, clock);
    this.channelTick(next, now, clock);
    this.phaseTick(state, ctx, pos.x, pos.y, clock);
  }

  private syncMap(ctx: GameContext): boolean {
    const map = ctx.map();
    if (!map) return false;
    if (map !== this.map) {
      this.map = map;
      this.bushes = buildBushIndex(map.bushes, map.width, map.height);
      this.envCfg = null;
    }
    return true;
  }

  private syncEnv(state: BattleState, map: MapData): void {
    // The env fields are immutable per match; compare them in place (no per-frame string key).
    if (this.envCfg && sameEnvSource(this.envSrc, state, map)) return;
    rememberEnvSource(this.envSrc, state, map);
    this.envCfg = envConfigOf(state, map);
    this.strikes = envSchedule(this.envCfg).strikes;
    this.nextAmbAt = 0;
    this.director?.resync();
  }

  private readSnap(ctx: GameContext, s: SelfSnap): void {
    const self = ctx.self();
    const me = ctx.me();
    // `me` disappears while dead or extracted; keep the last known liveness instead of guessing.
    s.alive = me ? me.alive : this.alive;
    s.hp = me ? me.hp : (this.prevSnap?.hp ?? 100);
    s.weapon = me ? me.weapon : (this.prevSnap?.weapon ?? "");
    s.active = self?.active ?? "";
    s.reloadUntil = self?.reloadUntil ?? 0;
    s.healUntil = self?.healUntil ?? 0;
    s.healKind = self?.healKind ?? "";
    s.rollLeft = self?.rollLeft ?? 0;
    s.searching = self?.searching ?? "";
    s.extractStartedAt = self?.extractStartedAt ?? 0;
    s.extractedAt = self?.extractedAt ?? 0;
    if (s.extractedAt > 0) s.alive = this.alive;
  }

  private onCue(c: SelfCue, now: number): void {
    const eng = this.eng!;
    switch (c.k) {
      case "died":
        this.setDead(true);
        break;
      case "revived":
        this.setDead(false);
        break;
      case "switch":
        this.cancelReload(now);
        eng.play("weapon_switch", { key: "self", priority: 4 });
        break;
      case "reload":
        this.quietDropsUntil = Math.max(this.quietDropsUntil, now + c.ms + CONSUME_QUIET_MS);
        this.cancelReload(now);
        for (const cue of reloadCues(c.ms)) {
          const v = eng.play(cue.id, { delay: cue.at, key: "self", priority: 4 });
          if (v) this.pendingReload.push({ v, startAt: now + cue.at * 1000 });
        }
        break;
      case "reloadCancel":
        this.cancelReload(now);
        break;
      case "heal":
        this.quietDropsUntil = Math.max(this.quietDropsUntil, now + 8000);
        eng.play(c.kind === "medkit" ? "heal_medkit" : "heal_bandage", { key: "self", priority: 4 });
        break;
      case "roll":
        this.stride.reset(now);
        if (now - this.localRollAt > LOCAL_ECHO_WINDOW_MS + 200) eng.play("roll", { key: "self", priority: 4 });
        break;
      case "searchStart":
        // Corpses (k<id>) get the zipper; containers rummage.
        this.searchVoice = eng.play(c.key.startsWith("k") ? "zipper" : "search", { key: "self", priority: 4 });
        this.nextSearchAt = now + SEARCH_REPEAT_MS;
        break;
      case "searchStop":
        this.searchVoice?.stop(0.15);
        this.searchVoice = null;
        this.nextSearchAt = 0;
        break;
      case "extractStart":
        this.extracting = true;
        this.eng!.play("extract_start", { priority: 5 });
        this.nextBeepAt = now + 350;
        this.nextSirenAt = now;
        break;
      case "extractStop":
        this.extracting = false;
        break;
      case "extracted":
        this.extracting = false;
        eng.play("extract_success", { priority: 5 });
        break;
    }
  }

  private cancelReload(now: number): void {
    // Only cues that have not started yet: a mag-in that is already sounding finishes naturally.
    for (const p of this.pendingReload) if (p.startAt > now) p.v.stop(0.02);
    this.pendingReload.length = 0;
  }

  private ownSteps(s: SelfSnap, x: number, y: number, now: number): void {
    const moved = Number.isFinite(this.lastX) ? Math.hypot(x - this.lastX, y - this.lastY) : 0;
    this.lastX = x;
    this.lastY = y;
    if (!s.alive || s.extractedAt > 0) return;
    if (s.rollLeft > 0) {
      // The roll has its own sound; restart the cadence when it ends.
      this.stride.reset(now);
      return;
    }
    if (!this.stride.add(moved, now)) return;
    const layers = footstepLayers({
      material: materialOfTerrain(terrainByteAt(this.map!, x, y)),
      wetness: this.env?.wetness ?? 0,
      indoor: this.indoor,
      bush: this.bushes ? bushIndexAt(this.bushes, x, y) >= 0 : false,
      self: true,
      walking: this.walking,
    });
    const pan = this.stride.foot === 0 ? -0.06 : 0.06;
    for (const l of layers) this.eng!.play(l.id, { db: l.db, pan, key: "self" });
  }

  /** Own pickups and drops: the total item count in our slots going up or down. */
  private inventoryTick(ctx: GameContext, s: SelfSnap, now: number, clock: number): void {
    if (now < this.nextInvAt) return;
    this.nextInvAt = now + INV_POLL_MS;
    const slots = ctx.self()?.slots;
    if (!slots || !s.alive || s.extractedAt > 0) {
      this.invQty = -1;
      return;
    }
    qtyAcc = 0;
    slots.forEach(countQty);
    const qty = qtyAcc;
    const prev = this.invQty;
    this.invQty = qty;
    if (prev < 0 || qty === prev) return;
    if (qty > prev) {
      this.eng!.play("item_pickup", { key: "self", priority: 3 });
      return;
    }
    const consuming = s.reloadUntil > clock || s.healUntil > clock || now < this.quietDropsUntil;
    if (!consuming) this.eng!.play("item_drop", { key: "self", priority: 3 });
  }

  private setDead(dead: boolean): void {
    const eng = this.eng!;
    this.alive = !dead;
    if (dead) {
      this.lowHp = false;
      this.extracting = false;
      this.cancelReload(Number.NEGATIVE_INFINITY);
      this.searchVoice?.stop(0.2);
      this.searchVoice = null;
      eng.setMuffleBase(DEATH_MUFFLE.cutoff, DEATH_MUFFLE.rampS);
    } else {
      eng.setMuffleBase(20000, 0.3);
    }
  }

  private lowHpTick(s: SelfSnap, now: number): void {
    const eng = this.eng!;
    const hb = s.alive && s.extractedAt === 0 ? heartbeatFor(s.hp) : null;
    const low = hb !== null;
    if (low !== this.lowHp) {
      this.lowHp = low;
      if (this.alive) eng.setLowHpMuffle(low);
      this.nextBeatAt = now;
    }
    if (hb && now >= this.nextBeatAt) {
      eng.play("heartbeat", { db: hb.db, priority: 5 });
      this.nextBeatAt = now + hb.intervalMs;
    }
  }

  private channelTick(s: SelfSnap, now: number, clock: number): void {
    const eng = this.eng!;
    if (this.searchVoice !== null || this.nextSearchAt > 0) {
      if (s.searching !== "" && now >= this.nextSearchAt) {
        this.searchVoice = eng.play(s.searching.startsWith("k") ? "rustle" : "search", { key: "self", priority: 3 });
        this.nextSearchAt = now + SEARCH_REPEAT_MS;
      }
    }
    if (!this.extracting || s.extractStartedAt === 0) return;
    if (now >= this.nextSirenAt) {
      eng.play("siren", { db: SELF_SIREN_DB, key: "self" });
      this.nextSirenAt = now + SELF_SIREN_REPEAT_MS;
    }
    if (now >= this.nextBeepAt) {
      const remaining = s.extractStartedAt + MATCH.EXTRACT_CHANNEL_MS - clock;
      if (remaining > 0) eng.play("extract_beep", { priority: 5 });
      this.nextBeepAt = now + extractBeepIntervalMs(remaining);
    }
  }

  private phaseTick(state: BattleState, ctx: GameContext, x: number, y: number, clock: number): void {
    // WORLD v6 (D8): the sting fires when THIS player's extracts arm (SelfState.extractArmAt).
    const phase = hudPhase(state.phase, clock, ctx.self()?.extractArmAt ?? 0);
    if (phase === this.prevPhase) return;
    const was = this.prevPhase;
    this.prevPhase = phase;
    if (was !== "drop" || phase !== "open" || !this.alive) return;
    // "Extracts are open": a distant siren from the nearest extract we may use.
    const map = this.map!;
    const mask = ctx.self()?.extractMask ?? 0xff;
    let best: { x: number; y: number } | null = null;
    let bestD = Infinity;
    map.extracts.forEach((e, i) => {
      if (mask && !(mask & (1 << i))) return;
      const d = Math.hypot(e.x - x, e.y - y);
      if (d < bestD) {
        bestD = d;
        best = e;
      }
    });
    const b = best as { x: number; y: number } | null;
    const pan = b ? clamp((b.x - x) / 2000, -1, 1) * 0.6 : 0;
    this.eng!.play("siren", { gain: 0.35, cutoff: 2500, pan, priority: 3 });
  }

  // ------------------------------------------------------------ events

  onEvents(ev: EventsMsg, ctx: GameContext): void {
    const eng = this.eng;
    if (!eng || this.disposed) return;
    const state = ctx.state();
    const map = this.map;
    if (!state || !map) return;
    const sid = ctx.room.sessionId;
    const pos = ctx.selfPos();
    const now = performance.now();
    const hear = this.env?.hear ?? 1;
    this.played.clear();
    this.hitTargets.clear();

    if (ev.shots) {
      this.wallImpacts(ev, map, pos.x, pos.y, sid, hear);
      for (const s of ev.shots) {
        if (s.s !== sid) continue; // others' gunshots come from ev.snd
        if (this.consumeLocalShot(now)) continue;
        this.playOwnShot(s.w);
      }
    }

    if (ev.hits) {
      for (const h of ev.hits) {
        if (this.hitTargets.has(h.t)) continue; // shotgun pellets: one impact per target per tick
        this.hitTargets.add(h.t);
        const impact: SfxId = h.ar ? "hit_armor" : "hit_flesh";
        if (h.t === sid) {
          eng.play(impact, { key: "self", priority: 4 });
          if (h.d >= HIT_MUFFLE_MIN_DMG) eng.muffle(HIT_MUFFLE.cutoff, HIT_MUFFLE.holdMs, HIT_MUFFLE.releaseMs);
          continue;
        }
        const mine = h.s === sid;
        if (mine) eng.play("hitmarker", { bus: "ui" });
        eng.playAt(impact, {
          dx: h.x - pos.x,
          dy: h.y - pos.y,
          range: baseSoundRadius(SoundKind.hurt) * hear * RANGE_SLACK,
          db: mine ? -4 : 0,
          delay: mine ? 0 : REMOTE_SOUND_DELAY_S,
          key: h.t,
          priority: mine ? 4 : undefined,
        });
      }
    }

    if (ev.kills) {
      for (const k of ev.kills) {
        if (k.killerId === sid && k.victimId !== sid) eng.play("kill_confirm", { bus: "ui", delay: 0.08 });
        if (k.victimId === sid && this.alive) this.setDead(true);
      }
    }

    // Weapons v2: a blast we got a BoomMsg for plays at its exact spot; the hidden world sound of
    // the same blast in ev.snd is then skipped (one per BoomMsg).
    let boomsPlayed = 0;
    if (Array.isArray(ev.booms)) {
      for (const b of ev.booms) {
        if (!b || !Number.isFinite(b.x) || !Number.isFinite(b.y)) continue;
        boomsPlayed++;
        eng.playAt("explosion", {
          dx: b.x - pos.x,
          dy: b.y - pos.y,
          range: baseSoundRadius(SoundKind.explosion) * hear * RANGE_SLACK,
          key: `boom${b.id}`,
          priority: 5,
        });
      }
    }

    let chestOpens = 0;
    if (ev.chest) {
      const wallIdx = getWallIndex(map);
      for (const c of ev.chest) {
        const spot = map.containers[c.idx];
        if (!spot) continue;
        chestOpens++;
        if (this.played.has(`c${c.idx}`)) continue;
        this.played.add(`c${c.idx}`);
        eng.playAt(containerOpenSfx(spot.kind), {
          dx: spot.x - pos.x,
          dy: spot.y - pos.y,
          range: baseSoundRadius(SoundKind.loot) * hear * RANGE_SLACK,
          walls: countOccluders(wallIdx, pos.x, pos.y, spot.x, spot.y, 3),
          key: `c${c.idx}`,
        });
      }
    }

    if (ev.snd) {
      const wet = this.env?.wetness ?? 0;
      for (const d of decodeSoundMsg(ev.snd)) {
        // The chest event already played this lid at its exact spot.
        if (d.kind === SoundKind.loot && chestOpens > 0) {
          chestOpens--;
          continue;
        }
        if (d.kind === SoundKind.explosion && boomsPlayed > 0) {
          boomsPlayed--;
          continue;
        }
        if (!d.hidden && d.kind === SoundKind.hurt && this.hitTargets.has(d.id)) continue;
        const key = sourceKey(d);
        const layers = layersForSound(d.kind, d.variant, wet);
        for (const l of layers) {
          const dedupe = `${l.id}|${key}`;
          if (this.played.has(dedupe)) continue;
          this.played.add(dedupe);
          if (d.hidden) {
            // Retrigger cap per direction bucket: a hidden rifle burst cannot steal a step from elsewhere.
            eng.playHidden(l.id, { sector: d.a, band: d.b, occluded: d.occluded, db: l.db, delay: l.at, key });
          } else {
            const p = state.players.get(d.id);
            if (!p) continue; // not rendered (raced a view removal): mobility memo says drop
            const walk = (p.act & ACT.WALK) !== 0;
            const stepMult = surfaceAt(map, p.x, p.y).stepRangeMult;
            const opts: PlayOpts & { dx: number; dy: number; range: number } = {
              dx: p.x - pos.x,
              dy: p.y - pos.y,
              range: visibleRange(d.kind, d.variant, walk, hear, stepMult),
              db: l.db,
              delay: REMOTE_SOUND_DELAY_S + (l.at ?? 0),
              key: d.id,
            };
            eng.playAt(l.id, opts);
          }
        }
      }
    }
  }

  /**
   * Bullets that stop in a wall or prop: one impact per shot (the middle pellet), at the spot the
   * tracer already shows, after the bullet's travel time. Shots that hit a player this tick play
   * the flesh / armor impact instead.
   */
  private wallImpacts(ev: EventsMsg, map: MapData, lx: number, ly: number, sid: string, hear: number): void {
    const eng = this.eng!;
    const shots = ev.shots;
    if (!shots?.length) return;
    this.hitShooters.clear();
    if (ev.hits) for (const h of ev.hits) this.hitShooters.add(h.s);
    const idx = getCollisionIndex(map);
    const wallIdx = getWallIndex(map);
    const range = baseSoundRadius(SoundKind.hurt) * hear * RANGE_SLACK;
    for (const s of shots) {
      if (s.s && this.hitShooters.has(s.s)) continue;
      const def = WEAPONS[s.w];
      if (!def) continue;
      const p = wallImpact(idx, s, def.range);
      if (!p) continue;
      const mine = s.s === sid;
      const travel = def.bulletSpeed > 0 ? Math.min(WALL_IMPACT_MAX_DELAY_S, p.dist / def.bulletSpeed) : 0;
      eng.playAt("hit_wall", {
        dx: p.x - lx,
        dy: p.y - ly,
        range,
        walls: countOccluders(wallIdx, lx, ly, p.x, p.y, 3),
        delay: travel + (mine ? 0 : REMOTE_SOUND_DELAY_S),
        key: "wall",
      });
    }
  }

  private playOwnShot(w: string): void {
    const eng = this.eng!;
    eng.play(gunSfx(w), { key: "self", priority: 4 });
    const rack = RACK_AFTER_SHOT_S[w as WeaponId];
    if (rack !== undefined) eng.play("rack", { delay: rack, key: "self", priority: 3 });
  }

  private consumeLocalShot(now: number): boolean {
    while (this.localShots.length && now - this.localShots[0]! > LOCAL_ECHO_WINDOW_MS) this.localShots.shift();
    if (!this.localShots.length) return false;
    this.localShots.shift();
    return true;
  }

  // ------------------------------------------------------------ local hooks

  localShot(weapon: WeaponId): void {
    if (!this.eng || this.disposed || !WEAPONS[weapon]) return;
    this.localShots.push(performance.now());
    this.playOwnShot(weapon);
  }

  localDryFire(): void {
    this.eng?.play("dry_fire", { key: "self", priority: 4 });
  }

  localRoll(): void {
    if (!this.eng || this.disposed) return;
    this.localRollAt = performance.now();
    this.eng.play("roll", { key: "self", priority: 4 });
  }

  localThrow(): void {
    if (!this.eng || this.disposed) return;
    this.quietDropsUntil = Math.max(this.quietDropsUntil, performance.now() + 1500);
    this.eng.play("grenade_pin", { key: "self", priority: 4 });
  }

  // ------------------------------------------------------------ teardown

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (activeSystem === this) activeSystem = null;
    this.director?.dispose();
    this.director = null;
    const eng = this.eng;
    if (eng) {
      this.cancelReload(Number.NEGATIVE_INFINITY);
      eng.stopAll(0.2);
      // The engine is a singleton that outlives the match: leave its buses clean for the menu.
      eng.setMuffleBase(20000, 0.05);
      eng.setAmbienceMuffle(20000, 1, 0.05);
    }
    this.eng = null;
  }
}

// Allocation-free MapSchema.forEach callback for inventoryTick.
let qtyAcc = 0;
function countQty(it: { qty: number }): void {
  qtyAcc += it.qty > 0 ? it.qty : 1;
}

/** GameSystem factory for the renderer registry (systems.ts SYSTEM_FACTORIES). */
export function createGameAudioSystem(): GameSystem {
  return new GameAudioSystem();
}
