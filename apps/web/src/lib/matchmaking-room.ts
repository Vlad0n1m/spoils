import { MM_BATTLE_READY } from "@extract/shared";

/** The slice of a colyseus.js Room the matchmaking panel listens to. */
export interface MmRoomLike {
  onStateChange(cb: (state: unknown) => void): unknown;
  onMessage(type: string, cb: (msg: { battleRoomId?: unknown } | undefined) => void): unknown;
  onError(cb: (code: number, message?: string) => void): unknown;
  onLeave(cb: (code: number, reason?: string) => void): unknown;
}

export interface MmRoomHandlers {
  /** True once the search was cancelled or unmounted; later events are ignored. */
  isDisposed: () => boolean;
  onState: (state: unknown) => void;
  onBattleReady: (battleRoomId: string) => void;
  onError: (code: number, message?: string) => void;
  /** The room closed (kick / lobby closed) while still searching. */
  onClosed: (code: number, reason?: string) => void;
}

/**
 * colyseus.js keeps dispatching messages already in flight after `leave()`, so every handler checks
 * `isDisposed()` first: a battle_ready that lands after Cancel must not pull the player into a raid.
 */
export function wireMatchmakingRoom(room: MmRoomLike, h: MmRoomHandlers): void {
  let battleReady = false;
  room.onStateChange((state) => {
    if (!h.isDisposed()) h.onState(state);
  });
  room.onMessage(MM_BATTLE_READY, (msg) => {
    if (h.isDisposed() || battleReady || typeof msg?.battleRoomId !== "string") return;
    battleReady = true;
    h.onBattleReady(msg.battleRoomId);
  });
  room.onError((code, message) => {
    if (!h.isDisposed()) h.onError(code, message);
  });
  room.onLeave((code, reason) => {
    if (h.isDisposed() || battleReady) return;
    h.onClosed(code, reason);
  });
}
