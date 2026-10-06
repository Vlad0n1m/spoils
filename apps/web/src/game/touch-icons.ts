/**
 * Inline SVG glyphs of the touch buttons (touch-controls.ts): one stroke style for all of them —
 * viewBox 24, round caps and joins, a white 2.4 px line over a 5 px black casing so each reads on
 * grass, sand and the dark night tint alike. No text: the aria-label carries the name.
 */

import type { TouchIconId } from "./touch-controls";

/** Path data per icon (drawn twice: the black casing, then the white line). */
const PATHS: Record<TouchIconId | "close" | "expand", string> = {
  // Dodge roll: a double chevron dash with speed lines.
  roll: "M9 6l6 6-6 6M15 6l6 6-6 6M3 9h3M2 15h4",
  // Use / pick up: an open hand reaching down.
  use: "M8 12V5.5a1.5 1.5 0 0 1 3 0V11M11 10.5V4.5a1.5 1.5 0 0 1 3 0V11M14 10.5V6a1.5 1.5 0 0 1 3 0v7c0 4-2.5 7-6 7-2.6 0-4-1.3-5.4-3.4L3.8 13.6a1.4 1.4 0 0 1 2.2-1.7L8 14",
  reload: "M19 12a7 7 0 1 1-2.05-4.95M19.5 3.5v5h-5",
  swap: "M4 8h13M13 4l4 4-4 4M20 16H7M11 12l-4 4 4 4",
  grenade: "M11 9.5a5.75 5.75 0 1 0 .01 0zM9 9.5V6.5h4v3M13 7l3.5-3M18.2 2.6a1.6 1.6 0 1 1-.01 0",
  bandage: "M5.6 14.6l9-9a3 3 0 0 1 4.2 4.2l-9 9a3 3 0 0 1-4.2-4.2zM9.5 10.5l4 4M12.2 9.6h.01M14.4 11.8h.01",
  medkit: "M4 8h16v11H4zM9 8V5.5h6V8M12 10.5v6M9 13.5h6",
  // Backpack: rounded body, top handle, front pocket.
  bag: "M8 7h8a3 3 0 0 1 3 3v10.5H5V10a3 3 0 0 1 3-3zM10 7V4.5h4V7M8.5 14h7v4h-7zM8.5 11h7",
  map: "M3.5 6.5l5.5-2 6 2 5.5-2v13l-5.5 2-6-2-5.5 2zM9 4.5v13M15 6.5v13",
  close: "M6 6l12 12M18 6L6 18",
  // Expand (the mark on the minimap: tap for the full map): four corners pointing out.
  expand: "M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5",
};

/** The icon as an SVG string sized to `pct` of its box. */
export function touchIconSvg(id: TouchIconId | "close" | "expand", pct = 62): string {
  const d = PATHS[id];
  return (
    `<svg viewBox="0 0 24 24" width="${pct}%" height="${pct}%" aria-hidden="true" style="overflow:visible;pointer-events:none">` +
    `<path d="${d}" fill="none" stroke="#000" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/>` +
    `<path d="${d}" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>` +
    `</svg>`
  );
}
