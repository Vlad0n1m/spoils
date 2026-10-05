/**
 * Own-shot prediction: the client draws (and sounds) its own shot on the input that fires it,
 * instead of one round trip plus up to a tick later when the server's ShotMsg echo arrives. The
 * server stays authoritative for bullets, hits and ammo; this only decides "a shot leaves now" with
 * the server's own rules (combat.ts tryFire) and then swallows the matching echo.
 *
 * Mirrors tryFire: semi-auto fires on a press, automatic while held; never while reloading or
 * rolling, never with an empty magazine; never faster than fireIntervalMs. What it cannot know (the
 * server's 150 ms press buffer, a shot quantized to a later tick) is simply not predicted: that
 * echo is drawn as before, so a missed prediction costs latency, never a phantom extra shot.
 */

import { INPUT_DT_MS, type WeaponDef } from "@extract/shared";

/** An echo this long after a predicted shot still belongs to it (RTT + tick + jitter). */
export const OWN_SHOT_ECHO_WINDOW_MS = 700;

export interface OwnShotInput {
  /** performance.now() of the input sample. */
  now: number;
  fire: boolean;
  prevFire: boolean;
  def: WeaponDef | null;
  /** Rounds in the active weapon's magazine as the last patch said. */
  mag: number;
  reloading: boolean;
  rolling: boolean;
}

export class OwnShotPredictor {
  private nextFireAt = -Infinity;
  /** Times of predicted shots whose echo has not arrived yet. */
  private pending: number[] = [];

  /** True when this input fires a shot; the caller draws it at once. */
  tryFire(i: OwnShotInput): boolean {
    this.expire(i.now);
    const def = i.def;
    if (!def || i.reloading || i.rolling) return false;
    const wants = def.auto ? i.fire : i.fire && !i.prevFire;
    if (!wants) return false;
    // Rounds the server has not taken off the magazine in a patch yet are already spent.
    if (i.mag - this.pending.length <= 0) return false;
    if (i.now < this.nextFireAt) return false;
    // Held automatic fire carries the schedule on when the shot left within one input step of being
    // due (the server does the same within one tick), so the held rate averages the interval.
    const due = this.nextFireAt;
    this.nextFireAt = (def.auto && i.now - due < INPUT_DT_MS ? due : i.now) + def.fireIntervalMs;
    this.pending.push(i.now);
    return true;
  }

  /** A ShotMsg of ours arrived: true when it is the echo of a predicted shot (already drawn). */
  consumeEcho(now: number): boolean {
    this.expire(now);
    if (!this.pending.length) return false;
    this.pending.shift();
    return true;
  }

  /** Death, respawn, weapon switch, reload start: nothing pending survives them. */
  reset(): void {
    this.pending.length = 0;
    this.nextFireAt = -Infinity;
  }

  get pendingCount(): number {
    return this.pending.length;
  }

  private expire(now: number): void {
    while (this.pending.length && now - this.pending[0]! > OWN_SHOT_ECHO_WINDOW_MS) this.pending.shift();
  }
}

/** Pellet angles for a predicted shot: the server rolls its own spread, these are cosmetic. */
export function predictedAngles(aim: number, def: WeaponDef, rnd: () => number = Math.random): number[] {
  const out: number[] = [];
  for (let i = 0; i < def.pellets; i++) out.push(aim + (rnd() * 2 - 1) * def.spread);
  return out;
}
