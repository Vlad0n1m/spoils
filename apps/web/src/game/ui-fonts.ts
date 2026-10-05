/**
 * The game UI's web fonts for canvas text (Pixi Text): Luckiest Guy for titles and caps, Nunito for
 * small readable text. next/font self-hosts them under hashed family names exposed as CSS variables
 * on <html> (layout.tsx: --font-luckiest-guy, --font-body); canvas text cannot read var(), so the
 * families are resolved from the computed style once, with system fallbacks.
 */

const FALLBACK_DISPLAY = "'Luckiest Guy', ui-rounded, 'Trebuchet MS', system-ui, sans-serif";
const FALLBACK_BODY = "Nunito, ui-rounded, 'Trebuchet MS', system-ui, sans-serif";

let cached: { display: string; body: string } | null = null;

function cssVar(name: string): string {
  if (typeof document === "undefined" || typeof getComputedStyle === "undefined") return "";
  try {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  } catch {
    return "";
  }
}

/** Font-family strings for canvas text: `display` (Luckiest Guy, caps) and `body` (Nunito). */
export function uiFonts(): { display: string; body: string } {
  if (cached) return cached;
  const d = cssVar("--font-luckiest-guy");
  const b = cssVar("--font-body");
  const fonts = {
    display: d ? `${d}, ${FALLBACK_DISPLAY}` : FALLBACK_DISPLAY,
    body: b ? `${b}, ${FALLBACK_BODY}` : FALLBACK_BODY,
  };
  // Only cache a resolved lookup (before hydration the variables may not be on <html> yet).
  if (d || b || typeof document === "undefined") cached = fonts;
  return fonts;
}

/**
 * Calls `cb` once both fonts are loaded (immediately-ish when they already are). Canvas text drawn
 * before a web font finishes loading keeps the fallback face until it is re-rendered, so the map
 * re-renders its labels from this callback.
 */
export function whenUiFontsReady(cb: () => void): void {
  if (typeof document === "undefined" || !document.fonts) return;
  const { display, body } = uiFonts();
  Promise.all([document.fonts.load(`20px ${display}`), document.fonts.load(`800 14px ${body}`), document.fonts.load(`900 14px ${body}`)])
    .then(() => cb())
    .catch(() => undefined);
}
