/**
 * Screen geometry shared by the canvas HUD (minimap.ts, world-events.ts), the React HUD
 * (components/hud.tsx) and the touch button layout (touch-controls.ts). Pure: no Pixi, so the React
 * HUD can place the extract pill next to the minimap without pulling the renderer in.
 */

/** Minimap is drawn at this size and scaled to the layout size. */
export const MINIMAP_BASE = 200;
/** Gap between the minimap and the top-right corner (px). */
export const MINIMAP_MARGIN = 16;

/**
 * Laid-out minimap side (px) for a screen; it sits MINIMAP_MARGIN from the top-right corner. Short
 * screens (landscape phones, < 480 px tall) go down to 100 px so more of the world stays visible.
 */
export function minimapSize(screenW: number, screenH: number): number {
  return Math.max(screenH < 480 ? 100 : 120, Math.min(MINIMAP_BASE, Math.min(screenW, screenH) * 0.24));
}

/** HUD v3 extract pill (top edge, left of the minimap): widest it gets on touch / desktop (px). */
export const EXTRACT_PILL_MAX_W = 228;
export const EXTRACT_PILL_MAX_W_DESKTOP = 300;
/** …and the bottom of it on touch (top 12 px + 32 px tall). */
export const EXTRACT_PILL_BOTTOM_TOUCH = 44;
