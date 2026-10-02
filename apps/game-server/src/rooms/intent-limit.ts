/**
 * Per-client token bucket for the cheap intent messages (INTERACT, RELOAD, SWITCH, HEAL, PING,
 * SEARCH_CLOSE). INPUT has its own budget (MAX_INPUT_BATCH + the movement allowance) and the INV_*
 * ops their sim bucket (bag.ts takeOpToken). Without this a client could send thousands of
 * SWITCH messages per second, each queueing a sound for every listener and an event, and stall the
 * shared room's tick for everyone. An honest client sends a handful per second.
 */

/** Sustained intents per second and burst size (wall clock: messages arrive between ticks). */
export const INTENTS_PER_SEC = 20;
export const INTENT_BURST = 20;

interface Bucket {
  tokens: number;
  at: number;
}

export class IntentLimiter {
  private readonly buckets = new WeakMap<object, Bucket>();

  constructor(
    private readonly perSec = INTENTS_PER_SEC,
    private readonly burst = INTENT_BURST,
    private readonly now: () => number = () => performance.now(),
  ) {}

  /** Spend one token of `client`'s bucket; false = drop the message. */
  take(client: object): boolean {
    const t = this.now();
    let b = this.buckets.get(client);
    if (!b) {
      b = { tokens: this.burst, at: t };
      this.buckets.set(client, b);
    }
    b.tokens = Math.min(this.burst, b.tokens + ((t - b.at) / 1000) * this.perSec);
    b.at = t;
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
  }
}
