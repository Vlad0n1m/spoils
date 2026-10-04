/**
 * Touch mode (phones, tablets, the Android TWA): a coarse primary pointer, or forced with ?touch=1
 * (?touch=0 forces it off). Kept free of Pixi so the React HUD and the inventory overlay can ask the
 * same question as the renderer without pulling the game bundle into the lobby.
 */

export function shouldUseTouch(): boolean {
  if (typeof window === "undefined") return false;
  const q = new URLSearchParams(window.location.search).get("touch");
  if (q === "1") return true;
  if (q === "0") return false;
  return window.matchMedia?.("(pointer: coarse)").matches ?? false;
}
