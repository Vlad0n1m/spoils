/**
 * Landscape only on phones (the raid's HUD, sticks and camera are laid out for it): the web manifest
 * and the TWA ask for landscape, lockLandscape() asks the browser again when a raid starts or the
 * page goes fullscreen, and battle-screen.tsx covers the game with a "rotate your phone" overlay
 * while a touch device is held upright anyway (the lock is refused outside fullscreen / installed
 * apps, and iOS has no lock at all).
 */

/** A viewport this shape gets the rotate overlay on a touch device. */
export function isPortraitViewport(w: number, h: number): boolean {
  return w > 0 && h > 0 && h > w;
}

type LockableOrientation = ScreenOrientation & { lock?: (o: string) => Promise<void> };

/** Ask for landscape; every refusal (no API, not fullscreen, not allowed) is silently ignored. */
export function lockLandscape(): void {
  if (typeof screen === "undefined") return;
  const o = screen.orientation as LockableOrientation | undefined;
  if (!o || typeof o.lock !== "function") return;
  try {
    o.lock("landscape").catch(() => {});
  } catch {
    /* older engines throw synchronously */
  }
}

/** lockLandscape now and each time the page enters fullscreen; returns the cleanup. */
export function keepLandscape(): () => void {
  if (typeof document === "undefined") return () => {};
  lockLandscape();
  const onFs = () => {
    if (document.fullscreenElement) lockLandscape();
  };
  document.addEventListener("fullscreenchange", onFs);
  return () => document.removeEventListener("fullscreenchange", onFs);
}
