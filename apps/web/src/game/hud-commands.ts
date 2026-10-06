/**
 * Commands the React HUD sends to the running game (it has no handle on the renderer). The renderer
 * registers its handlers at start and clears them at stop; with no game running a call is a no-op.
 */
export interface HudCommands {
  /** Phones: a tap on a weapon card in the bottom bar draws that weapon (0 = slot 1, 1 = slot 2). */
  selectSlot(slot: 0 | 1): void;
}

let current: HudCommands | null = null;

export function setHudCommands(c: HudCommands | null): void {
  current = c;
}

export function hudSelectSlot(slot: 0 | 1): void {
  current?.selectSlot(slot);
}
