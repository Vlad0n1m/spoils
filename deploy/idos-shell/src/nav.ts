/**
 * The web app keeps its lobby panels in the URL as /play?panel=…&tab=… (components/menu/main-menu.tsx,
 * history API). Here the page is wherever iDos serves index.html ("/" live, "/v/<build>/index.html"
 * for the test copy), so /play is mapped onto that path in pushState / replaceState, and the
 * next/navigation shim re-renders on every such change.
 */

const PLAY = "/play";
/** The path the bundle was loaded from: the "/play" of this build. */
const indexPath = window.location.pathname;
const EVENT = "spoils:navigate";

/** "/play", "/play?…", "/play#…" → the index path with the same query / hash; anything else unchanged. */
export function mapPlayUrl(url: string | URL | null | undefined): string | URL | null | undefined {
  if (typeof url !== "string") return url;
  if (url === PLAY || url.startsWith(`${PLAY}?`) || url.startsWith(`${PLAY}#`)) return indexPath + url.slice(PLAY.length);
  return url;
}

export function isPlayHref(href: string): boolean {
  return href === PLAY || href.startsWith(`${PLAY}?`) || href.startsWith(`${PLAY}#`) || href.startsWith("?");
}

export function installNavigation(): void {
  const h = window.history;
  const push = h.pushState.bind(h);
  const replace = h.replaceState.bind(h);
  h.pushState = (data: unknown, unused: string, url?: string | URL | null) => {
    push(data, unused, mapPlayUrl(url));
    window.dispatchEvent(new Event(EVENT));
  };
  h.replaceState = (data: unknown, unused: string, url?: string | URL | null) => {
    replace(data, unused, mapPlayUrl(url));
    window.dispatchEvent(new Event(EVENT));
  };
}

export function subscribeNavigation(cb: () => void): () => void {
  window.addEventListener("popstate", cb);
  window.addEventListener(EVENT, cb);
  return () => {
    window.removeEventListener("popstate", cb);
    window.removeEventListener(EVENT, cb);
  };
}

/** The page itself (a reload target instead of "/play"). */
export function playUrl(): string {
  return indexPath;
}
