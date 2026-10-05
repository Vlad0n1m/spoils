/**
 * Containers and bodies this client KNOWS are empty: it searched them itself and saw every slot
 * revealed with nothing takeable left (BROKEN copies on show do not count). Built only from the
 * searcher-only `loot` entries already in this client's view, so it adds no information the
 * server did not give this player. Contents only ever leave a container or a body (take-only), so
 * once empty a target stays empty — except a container a WORLD v6 hot zone or late refill turns
 * UNTOUCHED again (observe forgets it, see below).
 *
 * Why: the public CONTAINER_STATE.EMPTIED / Corpse.empty flip waits until the players who emptied
 * it have left (disclosure.ts, fog), so without this the player standing at a box they just emptied
 * would still get the "F — search" prompt, the USE button and an un-dimmed sprite.
 */

import { CONTAINER_STATE, ITEM_FLAG } from "@extract/shared";

export interface LootEntryLike {
  total: number;
  revealed: number;
  slots: { forEach(cb: (value: { flags: number }, key: string) => void): void };
}

/** Fully revealed and nothing takeable left. */
export function lootLooksEmpty(l: LootEntryLike): boolean {
  if (l.revealed < l.total) return false;
  let takeable = false;
  l.slots.forEach((it) => {
    if (!(it.flags & ITEM_FLAG.BROKEN)) takeable = true;
  });
  return !takeable;
}

export class KnownEmpty {
  /**
   * Known-empty containers → "armed": the public state has been seen past UNTOUCHED (OPENED /
   * EMPTIED) since. Only an armed container that turns public UNTOUCHED again was refilled; an
   * unarmed one is UNTOUCHED only because the public flip of our own opening still waits for us to
   * walk away (disclosure.ts), and forgetting it then would bring back the glow and the F prompt.
   */
  private readonly containers = new Map<number, boolean>();
  private readonly corpses = new Set<string>();
  /** Bumped whenever the set grows (cheap change check for views). */
  version = 0;

  /**
   * Scan the loot entries in view (c<idx> / k<corpseId>; a handful at most). `containerState`
   * (BattleState.containerState): a known-empty container whose public state went past UNTOUCHED
   * and then back to UNTOUCHED was refilled (WORLD v6 hot zone or late refill, world-events.ts) and
   * is forgotten, so it draws untouched again.
   */
  observe(
    loot: { forEach(cb: (value: LootEntryLike, key: string) => void): void } | null | undefined,
    containerState?: { readonly [i: number]: number } | null,
  ): void {
    if (containerState) {
      for (const [i, armed] of this.containers) {
        const pub = containerState[i];
        if (pub === undefined) continue;
        if (pub !== CONTAINER_STATE.UNTOUCHED) {
          if (!armed) this.containers.set(i, true);
        } else if (armed) {
          this.containers.delete(i);
          this.version++;
        }
      }
    }
    loot?.forEach((l, key) => {
      if (!lootLooksEmpty(l)) return;
      if (key.startsWith("c")) {
        const i = Number(key.slice(1));
        if (Number.isInteger(i) && i >= 0 && !this.containers.has(i)) {
          const pub = containerState?.[i];
          this.containers.set(i, pub !== undefined && pub !== CONTAINER_STATE.UNTOUCHED);
          this.version++;
        }
      } else if (key.startsWith("k")) {
        const id = key.slice(1);
        if (!this.corpses.has(id)) {
          this.corpses.add(id);
          this.version++;
        }
      }
    });
  }

  container(i: number): boolean {
    return this.containers.has(i);
  }

  corpse(id: string): boolean {
    return this.corpses.has(id);
  }

  /** The state to draw / hint container i with: the public one, or EMPTIED when known empty. */
  containerState(i: number, pub: number): number {
    return this.containers.has(i) ? CONTAINER_STATE.EMPTIED : pub;
  }

  /** Forget everything (a new map / cycle). */
  clear(): void {
    this.containers.clear();
    this.corpses.clear();
    this.version++;
  }
}
