/**
 * The in-raid wiring of haptics.ts: a GameSystem that reads the same client events the audio and
 * the hitmarker use and asks `haptic()` for a pattern. No server changes, nothing drawn.
 *
 *  - ev.hits: our own copy of a hit on us (HP lost) → "damage"; a hit we landed on a player or an NPC
 *    (including the shooter-only "hit confirmed" with an empty target) → "hit".
 *  - ev.kills: a kill by us → "kill".
 *  - SelfState: the item count in our slots going up → "loot"; extractedAt set → "extract".
 *  - HP falling under the heartbeat threshold (LOW_HP, game-audio) → "lowHp", once per dip.
 *  - The wipe warning thresholds (hud.ts wipeWarnAt, world maps only) → "wipe".
 *
 * Throttling lives in haptics.ts (HapticGate), so automatic fire does not buzz continuously.
 */
import { MATCH, type EventsMsg } from "@extract/shared";
import { LOW_HP } from "./audio/game-audio";
import { haptic, hapticsEnabled, hapticsSupported, resetHaptics } from "./haptics";
import { wipeWarnAt } from "./hud";
import type { GameContext, GameSystem } from "./systems";

/** Inventory poll for the pickup pattern (like the pickup sound). */
const INV_POLL_MS = 100;

let qtyAcc = 0;
function countQty(it: { qty: number }): void {
  qtyAcc += it.qty > 0 ? it.qty : 1;
}

class HapticsSystem implements GameSystem {
  readonly id = "haptics";
  /** Decided once: a desktop never pays for the per-frame reads. */
  private active = false;
  private invQty = -1;
  private nextInvAt = 0;
  private extracted = false;
  private low = false;
  private wipeWarn = 0;
  private started = false;

  init(): void {
    this.active = hapticsSupported();
    resetHaptics();
  }

  frame(_dtMs: number, ctx: GameContext): void {
    if (!this.active || !hapticsEnabled()) return;
    const self = ctx.self();
    const me = ctx.me();
    const now = performance.now();
    const extracted = (self?.extractedAt ?? 0) > 0;

    // The first frame only records the state: a reconnect mid-raid must not replay anything.
    if (!this.started) {
      this.started = true;
      this.extracted = extracted;
      this.low = lowHp(me?.alive ?? false, me?.hp ?? 100, extracted);
      this.wipeWarn = this.readWipeWarn(ctx);
      return;
    }

    if (extracted && !this.extracted) haptic("extract", now);
    this.extracted = extracted;

    const low = lowHp(me?.alive ?? false, me?.hp ?? 100, extracted);
    if (low && !this.low) haptic("lowHp", now);
    this.low = low;

    const warn = this.readWipeWarn(ctx);
    if (warn !== 0 && warn !== this.wipeWarn && me?.alive && !extracted) haptic("wipe", now);
    this.wipeWarn = warn;

    if (now >= this.nextInvAt) {
      this.nextInvAt = now + INV_POLL_MS;
      const slots = self?.slots;
      if (!slots || !me?.alive || extracted) {
        this.invQty = -1;
      } else {
        qtyAcc = 0;
        slots.forEach(countQty);
        const prev = this.invQty;
        this.invQty = qtyAcc;
        if (prev >= 0 && qtyAcc > prev) haptic("loot", now);
      }
    }
  }

  private readWipeWarn(ctx: GameContext): number {
    const state = ctx.state();
    // World maps only (entryCloseMs > 0): legacy roster matches have no wipe.
    if (!state || state.entryCloseMs <= 0 || state.phase === "ended") return 0;
    return wipeWarnAt((state.durationMs || MATCH.DURATION_MS) - ctx.clockMs());
  }

  onEvents(ev: EventsMsg, ctx: GameContext): void {
    if (!this.active || !hapticsEnabled()) return;
    const sid = ctx.room.sessionId;
    const now = performance.now();
    if (ev.kills) {
      for (const k of ev.kills) if (k.killerId === sid && k.victimId !== sid) haptic("kill", now);
    }
    if (ev.hits) {
      for (const h of ev.hits) {
        if (h.t === sid) {
          if (h.d > 0) haptic("damage", now);
        } else if (h.s === sid) {
          haptic("hit", now);
        }
      }
    }
  }

  dispose(): void {
    this.active = false;
    resetHaptics();
  }
}

/** Under the heartbeat threshold, alive and still on the map. */
export function lowHp(alive: boolean, hp: number, extracted: boolean): boolean {
  return alive && !extracted && hp > 0 && hp < LOW_HP.threshold;
}

export function createHapticsSystem(): GameSystem {
  return new HapticsSystem();
}
