/**
 * Containers and bodies this client KNOWS are empty: it searched them itself and saw every slot
 * revealed with nothing takeable left (BROKEN copies on show do not count). Built only from the
 * searcher-only `loot` entries already in this client's view, so it adds no information the
 * server did not give this player. Contents only ever leave a container or a body (take-only), so
 * once empty a target stays empty: the set only grows.
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
  private readonly containers = new Set<number>();
  private readonly corpses = new Set<string>();
  /** Bumped whenever the set grows (cheap change check for views). */
  version = 0;

  /** Scan the loot entries in view (c<idx> / k<corpseId>; a handful at most). */
  observe(loot: { forEach(cb: (value: LootEntryLike, key: string) => void): void } | null | undefined): void {
    loot?.forEach((l, key) => {
      if (!lootLooksEmpty(l)) return;
      if (key.startsWith("c")) {
        const i = Number(key.slice(1));
        if (Number.isInteger(i) && i >= 0 && !this.containers.has(i)) {
          this.containers.add(i);
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
