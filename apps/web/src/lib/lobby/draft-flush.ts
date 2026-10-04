/**
 * PLAY locks the loadout draft the web has saved (POST /api/world/join). The loadout board autosaves
 * its draft 600 ms after an edit, so a join right after an edit (armed auto-enter at the map's open,
 * the PLAY chip in a panel header) could lock the previous version and put at risk an item the player
 * had just taken off. The board registers a flusher here and tracks every draft save; `flushDraft()`
 * sends an edit still inside the debounce and waits for saves in flight before the join.
 */

type Flush = () => Promise<void>;

const flushers = new Set<Flush>();
const inflight = new Set<Promise<unknown>>();

/** Register the board's "send the pending edit now"; returns the unregister function. */
export function registerDraftFlush(f: Flush): () => void {
  flushers.add(f);
  return () => {
    flushers.delete(f);
  };
}

/** Track a draft save (PUT /api/loadout/draft) until it settles. Returns `p`. */
export function trackDraftSave<T>(p: Promise<T>): Promise<T> {
  inflight.add(p);
  const done = () => {
    inflight.delete(p);
  };
  p.then(done, done);
  return p;
}

/** Send any pending draft edit and wait for every draft save in flight. Never throws. */
export async function flushDraft(): Promise<void> {
  await Promise.all([...flushers].map((f) => f().catch(() => {})));
  await Promise.all([...inflight].map((p) => p.catch(() => {})));
}
