import Link from "next/link";

/**
 * What Inventory and Shop · Traders show without a registered account: guests travel light,
 * signed-out viewers are asked to sign in. `next` = where to come back to after auth.
 */
export function Gate({ loading, guest, next }: { loading: boolean; guest: boolean; next: string }) {
  if (loading) return <div className="py-6" aria-busy="true" />;
  const back = encodeURIComponent(next);
  return (
    <div className="py-6">
      <div className="toon-panel mx-auto max-w-xl bg-[#161b28]/95 p-8 text-center">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/sprites/backpack_2.png" alt="" className="mx-auto h-20 w-20 animate-float-sm motion-reduce:animate-none" draggable={false} />
        <h2 className="toon-text mt-4 text-3xl tracking-wide text-zooa-lime">{guest ? "Guests travel light" : "Sign in for your stash"}</h2>
        <p className="font-body mx-auto mt-3 max-w-[44ch] text-base text-white/75">
          {guest
            ? "Guest raids use the free kit and loot isn't kept. Register to get a stash, a starter kit, a loadout and a rank."
            : "Your stash, loadout, traders and market listings live on your account."}
        </p>
        <div className="mt-6 flex flex-wrap justify-center gap-3">
          <Link href={`/auth/register?next=${back}`} className="toon-btn min-h-12 px-6 text-lg">
            <span className="optical-center">Register</span>
          </Link>
          {!guest && (
            <Link href={`/auth/login?next=${back}`} className="toon-btn-ghost min-h-12 px-6 text-base">
              <span className="optical-center">Sign in</span>
            </Link>
          )}
        </div>
      </div>
    </div>
  );
}

/** Stash still loading / failed, inside a panel. */
export function StashWait({ error, onRetry }: { error: string | null; onRetry: () => void }) {
  return (
    <div className="py-6">
      <div className="toon-panel bg-[#161b28]/95 p-8 text-center">
        <p className="font-body text-white/75">{error ?? "Loading your stash…"}</p>
        {error && (
          <button type="button" onClick={onRetry} className="toon-btn-ghost mt-4 min-h-11 px-5 text-sm">
            <span className="optical-center">Retry</span>
          </button>
        )}
      </div>
    </div>
  );
}
