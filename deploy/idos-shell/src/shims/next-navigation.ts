/** next/navigation for the static iDos client (vite.config.ts alias): only what the lobby uses. */
import { useMemo, useSyncExternalStore } from "react";
import { isPlayHref, subscribeNavigation } from "../nav";
import { externalHref } from "../api";

export function useSearchParams(): URLSearchParams {
  const search = useSyncExternalStore(subscribeNavigation, () => window.location.search);
  return useMemo(() => new URLSearchParams(search), [search]);
}

export function usePathname(): string {
  return "/play";
}

export function navigate(href: string, replace = false): void {
  if (isPlayHref(href)) {
    const url = href.startsWith("?") ? `/play${href}` : href;
    if (replace) window.history.replaceState(null, "", url);
    else window.history.pushState(null, "", url);
    return;
  }
  window.open(externalHref(href), "_blank", "noopener");
}

export function useRouter() {
  return useMemo(
    () => ({
      push: (href: string) => navigate(href),
      replace: (href: string) => navigate(href, true),
      back: () => window.history.back(),
      forward: () => window.history.forward(),
      refresh: () => {},
      prefetch: () => {},
    }),
    [],
  );
}

export function redirect(href: string): never {
  navigate(href, true);
  throw new Error(`redirect ${href}`);
}
export const permanentRedirect = redirect;
export function notFound(): never {
  throw new Error("not found");
}
