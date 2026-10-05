/**
 * The lobby page to reload into ("back to the menu", sign-out). "/play" on our own site; the iDos
 * edition's static client (deploy/idos-shell) runs from another path on the iDos title subdomain and
 * names it in window.__SPOILS_PLAY_URL__.
 */
export function playPageUrl(): string {
  if (typeof window === "undefined") return "/play";
  return (window as { __SPOILS_PLAY_URL__?: string }).__SPOILS_PLAY_URL__ ?? "/play";
}
