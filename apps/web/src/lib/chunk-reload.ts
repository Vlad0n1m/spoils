/**
 * After a deploy the old JS chunks are gone, so a page opened before it fails on the next lazy import
 * ("Loading chunk 6528 failed"). Reload once to pick up the new build; a session flag stops a loop
 * when the chunk is missing for another reason.
 */
const KEY = "spoils:chunk-reload-at";

export function isChunkLoadError(e: unknown): boolean {
  const name = (e as { name?: unknown } | null)?.name;
  const msg = e instanceof Error ? e.message : typeof e === "string" ? e : "";
  return name === "ChunkLoadError" || /Loading (CSS )?chunk [\w-]+ failed/i.test(msg);
}

/** Reload the page for a chunk error unless it already did so in the last minute; true when it reloads. */
export function reloadOnChunkError(e: unknown): boolean {
  if (typeof window === "undefined" || !isChunkLoadError(e)) return false;
  try {
    const last = Number(sessionStorage.getItem(KEY) ?? 0);
    if (Date.now() - last < 60_000) return false;
    sessionStorage.setItem(KEY, String(Date.now()));
  } catch {
    /* storage blocked: still reload once */
  }
  window.location.reload();
  return true;
}
