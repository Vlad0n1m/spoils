"use client";

import { useEffect, useRef } from "react";
import Link from "next/link";
import clsx from "clsx";
import { useSession } from "@/lib/session-context";
import { PlayClient } from "@/components/play-client";
import { LoadoutBoard } from "./loadout-board";
import { StashPage } from "./stash-page";
import { MarketTab } from "./market-tab";
import { useStash } from "./use-lobby";
import { LOBBY_TABS, type LobbyTab } from "@/lib/lobby/tabs";

const LABEL: Record<LobbyTab, string> = { raid: "Raid", loadout: "Loadout", stash: "Stash", market: "Market" };

/**
 * /play lobby: tabs Raid | Loadout | Stash | Market (URL `/play?tab=…`, so tabs are linkable and
 * survive a reload). The stash is fetched once here and shared by the Loadout, Stash and Market
 * tabs; switching tabs refetches it so a purchase on one tab shows up on the next.
 */
export function LobbyShell({ tab }: { tab: LobbyTab }) {
  const { user, loading } = useSession();
  const registered = Boolean(user && !user.isGuest);
  const stash = useStash(registered);
  const { reload } = stash;
  // The resource loads itself on mount; refetch only when the player switches tabs afterwards.
  const firstTab = useRef(tab);
  useEffect(() => {
    if (firstTab.current === tab) return;
    firstTab.current = tab;
    if (registered && tab !== "raid") void reload();
  }, [tab, registered, reload]);

  return (
    <div className="mx-auto w-full max-w-7xl px-4 pt-5 md:px-6">
      <nav aria-label="Lobby" className="flex gap-1.5 overflow-x-auto pb-1">
        {LOBBY_TABS.map((t) => (
          <Link
            key={t}
            href={t === "raid" ? "/play" : `/play?tab=${t}`}
            scroll={false}
            aria-current={tab === t ? "page" : undefined}
            className={clsx(
              "shrink-0 rounded-2xl border-[3px] border-black px-3 py-2 text-sm tracking-wide transition-[transform,box-shadow] sm:px-5 sm:py-2.5 sm:text-base md:text-lg",
              tab === t
                ? "bg-zooa-lime text-black shadow-[0_4px_0_#000]"
                : "bg-[#1d2333]/90 text-white/75 shadow-[0_3px_0_#000] hover:text-white active:translate-y-[2px] active:shadow-[0_1px_0_#000]",
            )}
          >
            <span className="optical-center">{LABEL[t]}</span>
          </Link>
        ))}
      </nav>

      {tab === "raid" ? (
        // PlayClient brings its own container padding; pull it flush with the tab bar.
        <div className="-mx-4 md:-mx-6">
          <PlayClient />
        </div>
      ) : tab === "market" ? (
        <div className="py-6">
          <MarketTab stash={registered ? stash : null} sessionLoading={loading} />
        </div>
      ) : !registered ? (
        <Gate loading={loading} guest={Boolean(user?.isGuest)} tab={tab} />
      ) : !stash.data ? (
        <div className="py-6">
          <div className="toon-panel bg-[#161b28]/95 p-8 text-center">
            <p className="font-body text-white/65">{stash.error ?? "Loading your stash…"}</p>
            {stash.error && (
              <button type="button" onClick={() => void reload()} className="toon-btn-ghost mt-4 min-h-11 px-5 text-sm">
                <span className="optical-center">Retry</span>
              </button>
            )}
          </div>
        </div>
      ) : tab === "loadout" ? (
        <div className="py-6">
          <LoadoutBoard stash={stash.data} reload={reload} />
        </div>
      ) : (
        <div className="py-6">
          <StashPage res={stash} />
        </div>
      )}
    </div>
  );
}

function Gate({ loading, guest, tab }: { loading: boolean; guest: boolean; tab: LobbyTab }) {
  if (loading) return <div className="py-6" aria-busy="true" />;
  const next = encodeURIComponent(`/play?tab=${tab}`);
  return (
    <div className="py-6">
      <div className="toon-panel mx-auto max-w-xl bg-[#161b28]/95 p-8 text-center">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/sprites/backpack_2.png" alt="" className="mx-auto h-20 w-20 animate-float-sm" draggable={false} />
        <h2 className="toon-text mt-4 text-3xl tracking-wide text-zooa-lime">{guest ? "Guests travel light" : "Sign in for your stash"}</h2>
        <p className="font-body mx-auto mt-3 max-w-[44ch] text-base text-white/70">
          {guest
            ? "Guest raids use the free kit and loot isn't kept. Register to get a stash, a starter kit and a loadout."
            : "Your stash, loadout and market lots live on your account."}
        </p>
        <div className="mt-6 flex flex-wrap justify-center gap-3">
          <Link href={`/auth/register?next=${next}`} className="toon-btn min-h-12 px-6 text-lg">
            <span className="optical-center">Register</span>
          </Link>
          {!guest && (
            <Link href={`/auth/login?next=${next}`} className="toon-btn-ghost min-h-12 px-6 text-base">
              <span className="optical-center">Sign in</span>
            </Link>
          )}
        </div>
      </div>
    </div>
  );
}
