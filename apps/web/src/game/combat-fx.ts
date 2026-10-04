/**
 * Combat feel (presentation only): the pure curves behind the shooter / hit / kill feedback and
 * the kill pop system.
 *
 *  - recoil:        the gun and the body jump back along the aim on every shot (PlayerView.kick),
 *                   per weapon (SPRITE_RECOIL_PX), then spring back;
 *  - hit flash:     a white silhouette over a damaged sprite for ~130 ms (PlayerView.flashHit);
 *  - HP reveal:     enemy HP bars appear above a target the local player hit, hold 2 s, fade out
 *                   (bosses and party mates always show theirs);
 *  - damage chip:   the HP the bar just lost stays as a white chip that drains after a short beat;
 *  - damage numbers: hits on the same target within DMG_NUM.STACK_MS add up into one number that
 *                   pops again, coloured by armor / size of the hit (Effects.damageNumber);
 *  - zoom punch:    the camera zooms in 3% and settles on a kill (CameraRig.punch);
 *  - kill pop:      "MARAUDER DOWN" / "+name" with a skull under the top of the screen, with a
 *                   streak counter for kills in a row (createKillPopSystem).
 *
 * The fog rules stay with the callers: everything here only animates what the client already sees.
 */

import { Container, Graphics, Text } from "pixi.js";
import { NPC_ROLE, type EventsMsg, type WeaponId } from "@extract/shared";
import type { GameContext, GameSystem } from "./systems";

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

// ---------------------------------------------------------------- recoil

/** How far (world px) the gun and the body jump back on a shot. */
export const SPRITE_RECOIL_PX: Record<WeaponId, number> = {
  pistol: 3, rifle: 2.5, shotgun: 6, sniper: 7,
  smg: 1.8, lmg: 3, revolver: 5, crossbow: 2,
};

export const RECOIL_ANIM = { ATTACK_MS: 25, RETURN_TAU_MS: 60, END_MS: 260 } as const;

/** Recoil displacement (0..px) `ageMs` after a shot: a fast jump back, an exponential return. */
export function recoilOffset(ageMs: number, px: number): number {
  if (!(ageMs >= 0) || ageMs >= RECOIL_ANIM.END_MS || !(px > 0)) return 0;
  if (ageMs < RECOIL_ANIM.ATTACK_MS) return px * (ageMs / RECOIL_ANIM.ATTACK_MS);
  return px * Math.exp(-(ageMs - RECOIL_ANIM.ATTACK_MS) / RECOIL_ANIM.RETURN_TAU_MS);
}

// ---------------------------------------------------------------- hit flash

export const HIT_FLASH = { PEAK: 0.85, MS: 130 } as const;

/** Alpha of the white hit silhouette `ageMs` after a hit (0 when over). */
export function hitFlashAlpha(ageMs: number): number {
  if (!(ageMs >= 0) || ageMs >= HIT_FLASH.MS) return 0;
  const k = ageMs / HIT_FLASH.MS;
  return HIT_FLASH.PEAK * (1 - k) * (1 - k);
}

// ---------------------------------------------------------------- HP bar reveal + chip

export const HP_REVEAL = { HOLD_MS: 2000, FADE_MS: 450, CHIP_HOLD_MS: 220, CHIP_DRAIN_MS: 380 } as const;

/** Bar alpha `sinceHitMs` after the local player last hit this target (Infinity = never). */
export function hpBarAlpha(sinceHitMs: number): number {
  if (!(sinceHitMs >= 0)) return 0;
  if (sinceHitMs <= HP_REVEAL.HOLD_MS) return 1;
  return clamp01(1 - (sinceHitMs - HP_REVEAL.HOLD_MS) / HP_REVEAL.FADE_MS);
}

/**
 * Where the white damage chip ends (as an HP fraction) `ageMs` after the bar dropped from `from`
 * to `to`: it holds, then drains down to `to`.
 */
export function chipFraction(from: number, to: number, ageMs: number): number {
  if (!(from > to)) return to;
  if (ageMs <= HP_REVEAL.CHIP_HOLD_MS) return from;
  const k = clamp01((ageMs - HP_REVEAL.CHIP_HOLD_MS) / HP_REVEAL.CHIP_DRAIN_MS);
  const e = k * k * (3 - 2 * k);
  return from + (to - from) * e;
}

// ---------------------------------------------------------------- damage numbers

export const DMG_NUM = {
  LIFE_MS: 900,
  /** A hit on the same target this soon after the last one adds to its number. */
  STACK_MS: 550,
  /** At or above this total the number turns orange and grows (sniper, shotgun point blank). */
  BIG: 35,
  RISE_PX: 38,
  POP_MS: 110,
  /** Colours: flesh, armor ate part of it, a big hit, damage taken by the local player. */
  COLOR: { flesh: 0xffe066, armor: 0x8fd0ff, big: 0xff9a3c, taken: 0xff5252 },
} as const;

/** Colour and font size of a damage number for `total` damage. */
export function damageNumberStyle(total: number, armor: boolean, taken: boolean): { color: number; size: number } {
  const t = Math.max(0, total);
  const size = Math.round(18 + Math.min(12, t / 6));
  if (taken) return { color: DMG_NUM.COLOR.taken, size };
  if (t >= DMG_NUM.BIG) return { color: DMG_NUM.COLOR.big, size: size + 2 };
  return { color: armor ? DMG_NUM.COLOR.armor : DMG_NUM.COLOR.flesh, size };
}

/**
 * Pose of a floating number: `age` since it was born (rise + fade), `popAge` since its value last
 * changed (scale pop: big, then settles with a small overshoot). Returns false when it is over.
 */
export function damageNumberPose(age: number, popAge: number, out: { dy: number; scale: number; alpha: number }): boolean {
  if (!(age >= 0) || age >= DMG_NUM.LIFE_MS) return false;
  const k = age / DMG_NUM.LIFE_MS;
  // Ease-out rise: fast first, then hangs.
  out.dy = -DMG_NUM.RISE_PX * (1 - (1 - k) * (1 - k));
  out.alpha = k < 0.62 ? 1 : 1 - (k - 0.62) / 0.38;
  const p = popAge / DMG_NUM.POP_MS;
  out.scale = p < 0 ? 1 : p < 1 ? 1.55 - 0.65 * p : 1 + 0.1 * Math.exp(-(p - 1) * 2.5) * Math.cos((p - 1) * 4);
  return true;
}

// ---------------------------------------------------------------- zoom punch

export const ZOOM_PUNCH = { AMOUNT: 0.03, ATTACK_MS: 45, TAU_MS: 120, END_MS: 700 } as const;

/** Extra zoom (fraction) `ageMs` after a kill: a quick push in and a smooth settle. */
export function zoomPunch(ageMs: number, amount: number = ZOOM_PUNCH.AMOUNT): number {
  if (!(ageMs >= 0) || ageMs >= ZOOM_PUNCH.END_MS) return 0;
  if (ageMs < ZOOM_PUNCH.ATTACK_MS) {
    const k = ageMs / ZOOM_PUNCH.ATTACK_MS;
    return amount * k * (2 - k);
  }
  return amount * Math.exp(-(ageMs - ZOOM_PUNCH.ATTACK_MS) / ZOOM_PUNCH.TAU_MS);
}

// ---------------------------------------------------------------- kill pop

export const KILL_POP = {
  POP_MS: 130,
  HOLD_MS: 1300,
  FADE_MS: 380,
  /** Kills closer together than this count as a streak ("x2"). */
  STREAK_MS: 4500,
  /** Pop centre, fraction of the screen height from the top (above the player)... */
  Y_FRAC: 0.3,
  /** ...and on short (landscape phone) screens below the player, clear of the event toasts. */
  SHORT_H: 520,
  SHORT_Y_FRAC: 0.67,
  NAME_MAX: 16,
  TINT: { human: 0xff4d4d, marauder: 0xffd166, guard: 0xffb347, boss: 0xff3b3b } as Record<string, number>,
} as const;

/** The pop's two lines for a kill: NPCs by role, humans by name. */
export function killPopLabel(victim: string, victimRole: number | undefined): { title: string; sub: string; tint: number } {
  if (victimRole === NPC_ROLE.MARAUDER) return { title: "MARAUDER DOWN", sub: "", tint: KILL_POP.TINT.marauder! };
  if (victimRole === NPC_ROLE.GUARD) return { title: "GUARD DOWN", sub: victim ? victim.toUpperCase() : "", tint: KILL_POP.TINT.guard! };
  if (victimRole === NPC_ROLE.BOSS) return { title: "BOSS DOWN", sub: victim ? victim.toUpperCase() : "", tint: KILL_POP.TINT.boss! };
  const n = (victim || "Raider").trim();
  const name = n.length > KILL_POP.NAME_MAX ? `${n.slice(0, KILL_POP.NAME_MAX - 1)}…` : n;
  return { title: `+${name}`, sub: "ELIMINATED", tint: KILL_POP.TINT.human! };
}

/** Streak count after a kill at `now` (the previous one at `lastAt` made it `count`). */
export function nextStreak(lastAt: number, count: number, now: number): number {
  return now - lastAt <= KILL_POP.STREAK_MS && count > 0 ? count + 1 : 1;
}

/** Pop pose `age` ms after the kill: scale overshoot in, hold, fade with a small rise. */
export function killPopPose(age: number, out: { scale: number; alpha: number; dy: number }): boolean {
  const end = KILL_POP.HOLD_MS + KILL_POP.FADE_MS;
  if (!(age >= 0) || age >= end) return false;
  if (age < KILL_POP.POP_MS) {
    const k = age / KILL_POP.POP_MS;
    out.scale = 1.6 - 0.6 * k * (2 - k);
    out.alpha = Math.min(1, k * 2.5);
  } else {
    out.scale = 1;
    out.alpha = age < KILL_POP.HOLD_MS ? 1 : 1 - (age - KILL_POP.HOLD_MS) / KILL_POP.FADE_MS;
  }
  out.dy = age < KILL_POP.HOLD_MS ? 0 : -14 * ((age - KILL_POP.HOLD_MS) / KILL_POP.FADE_MS);
  return true;
}

const FONT = "ui-rounded, 'Trebuchet MS', system-ui, sans-serif";

class KillPopSystem implements GameSystem {
  readonly id = "kill-pop";
  private root: Container | null = null;
  private skull: Graphics | null = null;
  private title: Text | null = null;
  private sub: Text | null = null;
  private streak: Text | null = null;
  private bornAt = Number.NEGATIVE_INFINITY;
  private lastKillAt = Number.NEGATIVE_INFINITY;
  private count = 0;
  private readonly pose = { scale: 1, alpha: 0, dy: 0 };

  init(ctx: GameContext): void {
    const root = new Container();
    root.label = "kill-pop";
    root.eventMode = "none";
    root.visible = false;
    const skull = new Graphics();
    // A cartoon skull: dome, jaw, two eyes and a nose notch, dark outline for any background.
    skull.circle(0, -2, 13).fill(0xffffff).stroke({ width: 3, color: 0x1a1a1a });
    skull.roundRect(-8, 6, 16, 9, 3).fill(0xffffff).stroke({ width: 3, color: 0x1a1a1a });
    skull.circle(-5, -2, 4).fill(0x1a1a1a);
    skull.circle(5, -2, 4).fill(0x1a1a1a);
    skull.poly([0, 4, -2, 8, 2, 8]).fill(0x1a1a1a);
    skull.rect(-3, 10, 1.5, 5).fill(0x1a1a1a);
    skull.rect(1.5, 10, 1.5, 5).fill(0x1a1a1a);
    const mk = (size: number, weight: "900" | "800", spacing: number) =>
      new Text({
        text: "",
        style: { fontFamily: FONT, fontSize: size, fontWeight: weight, fill: 0xffffff, stroke: { color: 0x141414, width: 5 }, letterSpacing: spacing },
        resolution: 2,
      });
    const title = mk(28, "900", 2);
    title.anchor.set(0, 0.5);
    const sub = mk(13, "800", 3);
    sub.anchor.set(0.5, 0);
    sub.style.fill = 0xe9e9e9;
    const streak = mk(22, "900", 1);
    streak.anchor.set(0, 0.5);
    streak.style.fill = 0xffd166;
    root.addChild(skull, title, sub, streak);
    ctx.layers.screen.addChild(root);
    this.root = root;
    this.skull = skull;
    this.title = title;
    this.sub = sub;
    this.streak = streak;
  }

  onEvents(ev: EventsMsg, ctx: GameContext): void {
    if (!ev.kills || !this.root) return;
    const sid = ctx.room.sessionId;
    for (const m of ev.kills) {
      if (!m || m.killerId !== sid || !m.victimId || m.victimId === sid) continue;
      this.show(m.victim, m.victimRole, performance.now());
    }
  }

  /** Lay out the pop for a kill. */
  show(victim: string, victimRole: number | undefined, now: number): void {
    const title = this.title, sub = this.sub, streak = this.streak, skull = this.skull;
    if (!title || !sub || !streak || !skull) return;
    this.count = nextStreak(this.lastKillAt, this.count, now);
    this.lastKillAt = now;
    this.bornAt = now;
    const l = killPopLabel(victim, victimRole);
    title.text = l.title;
    title.style.fill = l.tint;
    sub.text = l.sub;
    sub.visible = !!l.sub;
    streak.text = this.count > 1 ? `x${this.count}` : "";
    streak.visible = this.count > 1;
    skull.tint = 0xffffff;
    // Skull + gap + title (+ gap + streak), centred on 0.
    const gap = 10;
    const w = 30 + gap + title.width + (streak.visible ? gap + streak.width : 0);
    let x = -w / 2;
    skull.position.set(x + 15, 0);
    x += 30 + gap;
    title.position.set(x, 0);
    x += title.width + gap;
    streak.position.set(x, 0);
    sub.position.set(0, 18);
  }

  frame(_dtMs: number, ctx: GameContext): void {
    const root = this.root;
    if (!root) return;
    if (!killPopPose(performance.now() - this.bornAt, this.pose)) {
      root.visible = false;
      return;
    }
    const cam = ctx.camera();
    root.visible = true;
    root.alpha = this.pose.alpha;
    root.scale.set(this.pose.scale);
    const yf = cam.height < KILL_POP.SHORT_H ? KILL_POP.SHORT_Y_FRAC : KILL_POP.Y_FRAC;
    root.position.set(Math.round(cam.width / 2), Math.round(cam.height * yf + this.pose.dy));
  }

  dispose(): void {
    this.root?.destroy({ children: true });
    this.root = this.skull = this.title = this.sub = this.streak = null;
  }
}

export function createKillPopSystem(): GameSystem {
  return new KillPopSystem();
}
