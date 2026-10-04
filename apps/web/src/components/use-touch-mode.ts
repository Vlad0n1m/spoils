"use client";

import { useSyncExternalStore } from "react";
import { shouldUseTouch } from "@/game/touch-mode";

const noSubscribe = () => () => {};
const serverValue = () => false;

/**
 * Touch mode (coarse pointer, the Android TWA, ?touch=1): the same test the renderer uses to mount
 * the sticks and buttons, so the HUD and the inventory overlay switch to their touch layout with
 * them. Read once per mount; false while server rendering.
 */
export function useTouchMode(): boolean {
  return useSyncExternalStore(noSubscribe, shouldUseTouch, serverValue);
}
