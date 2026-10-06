/**
 * Safe-area insets of the screen (CSS px), for the parts of the raid that are laid out in canvas
 * coordinates. The game canvas is full-bleed (it draws under a landscape phone's camera cutout and
 * home indicator, viewport-fit=cover); everything the player reads or taps stays inside the safe
 * area: the React HUD and the touch controls through the --safe-* CSS variables (globals.css), the
 * canvas HUD (minimap, full map, party arrows) through safeInsets().
 *
 * The values come from a hidden probe element padded by the same --safe-* variables, so the DOM and
 * the canvas always agree (overriding the variables on :root simulates a notched phone on desktop).
 * Measured again whenever the window size changes (a turn of the phone), otherwise cached: cheap
 * enough to call every frame.
 */

export interface SafeInsets {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

export const NO_INSETS: Readonly<SafeInsets> = Object.freeze({ left: 0, right: 0, top: 0, bottom: 0 });

let probe: HTMLDivElement | null = null;
let measuredFor = "";
let current: SafeInsets = { ...NO_INSETS };

function px(v: string): number {
  const n = parseFloat(v);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
}

/** Re-read the insets now (the cached value is otherwise kept until the window size changes). */
export function refreshSafeInsets(): SafeInsets {
  if (typeof window === "undefined" || typeof document === "undefined" || !document.body) return current;
  if (!probe || !probe.isConnected) {
    probe = document.createElement("div");
    probe.setAttribute("data-safe-area-probe", "");
    probe.setAttribute("aria-hidden", "true");
    Object.assign(probe.style, {
      position: "fixed",
      left: "0",
      top: "0",
      width: "0",
      height: "0",
      visibility: "hidden",
      pointerEvents: "none",
      paddingLeft: "var(--safe-l, 0px)",
      paddingRight: "var(--safe-r, 0px)",
      paddingTop: "var(--safe-t, 0px)",
      paddingBottom: "var(--safe-b, 0px)",
    });
    document.body.appendChild(probe);
  }
  const cs = getComputedStyle(probe);
  current = { left: px(cs.paddingLeft), right: px(cs.paddingRight), top: px(cs.paddingTop), bottom: px(cs.paddingBottom) };
  measuredFor = `${window.innerWidth}x${window.innerHeight}`;
  return current;
}

/** Current safe-area insets (CSS px); all 0 on desktops and phones without a cutout. */
export function safeInsets(): SafeInsets {
  if (typeof window === "undefined") return current;
  if (measuredFor !== `${window.innerWidth}x${window.innerHeight}`) return refreshSafeInsets();
  return current;
}
