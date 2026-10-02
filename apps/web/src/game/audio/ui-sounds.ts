/**
 * UI sounds for React (menus, loadout, market, inventory). The only audio module React imports
 * besides settings.ts. Calls are fire-and-forget: before the first gesture or before the bank is
 * baked they are silent no-ops, never errors.
 */
import { AudioEngine } from "./engine";
import type { SfxId } from "./recipes";

export type UiSound = "click" | "hover" | "coin" | "error" | "equip";

export const UI_SOUND_IDS: Readonly<Record<UiSound, SfxId>> = {
  click: "ui_click",
  hover: "ui_hover",
  coin: "ui_coin",
  error: "ui_error",
  equip: "ui_equip",
};

/** Sweeping the mouse across a list would otherwise fire a hover tick per row per frame. */
export const HOVER_THROTTLE_MS = 50;

/** Returns a gate that allows at most one call per `ms` (pure; `now` injectable for tests). */
export function makeThrottle(ms: number): (now: number) => boolean {
  let last = -Infinity;
  return (now: number) => {
    if (now - last < ms) return false;
    last = now;
    return true;
  };
}

const hoverGate = makeThrottle(HOVER_THROTTLE_MS);

export function playUi(name: UiSound): void {
  if (typeof window === "undefined") return;
  if (name === "hover" && !hoverGate(performance.now())) return;
  const eng = AudioEngine.get();
  // Menus may be the first audio consumer: make sure the gesture unlock and the bake are running.
  eng.installUnlock();
  void eng.ensureBaked();
  eng.play(UI_SOUND_IDS[name], { bus: "ui" });
}

const API = {
  click: () => playUi("click"),
  hover: () => playUi("hover"),
  coin: () => playUi("coin"),
  error: () => playUi("error"),
  equip: () => playUi("equip"),
} as const;

/** Stable callbacks for onClick/onMouseEnter. No state, so no React hooks are needed inside. */
export function useUiSound(): typeof API {
  return API;
}
