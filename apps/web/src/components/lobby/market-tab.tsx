"use client";

import { useState } from "react";
import Link from "next/link";
import type { StashItemDto, StashResponse } from "@/lib/lobby/api-types";
import { fmtCr } from "@/lib/items-ui";
import { panelHref } from "@/lib/lobby/panels";
import { hasStashMarket } from "@/lib/lobby/stash-response";
import { SOL_ECONOMY } from "@/lib/edition";
import { ItemCard } from "./item-card";
import { ListDialog } from "./list-dialog";
import { MarketTable, RecentTrades } from "./market-table";
import { MyListings } from "./my-listings";
import type { Resource } from "./use-lobby";
import { PagedTiles, Segmented } from "@/components/paged";

type Side = "sell" | "mine" | "sales";
const SIDE: ReadonlyArray<{ id: Side; label: string }> = [
  { id: "sell", label: "Sell" },
  { id: "mine", label: "My lots" },
  { id: "sales", label: "Sales" },
];

/**
 * Shop · Market: the lot board, plus (registered users) wallet, a quick "sell from stash" picker,
 * the user's lots and recent sales. Guests and signed-out visitors can browse. The side column is a
 * switch (Sell · My lots · Sales) instead of a stack of cards to scroll.
 */
export function MarketTab({ stash, sessionLoading = false }: { stash: Resource<StashResponse> | null; sessionLoading?: boolean }) {
  const [refreshKey, setRefreshKey] = useState(0);
  const [selling, setSelling] = useState<StashItemDto | null>(null);
  const [side, setSide] = useState<Side>("sell");
  // The CR market rules come with /api/stash in both builds (the SOL wallet only in the main build).
  const s = stash?.data && hasStashMarket(stash.data) ? stash.data : null;
  const bump = () => {
    setRefreshKey((k) => k + 1);
    void stash?.reload();
  };
  const sellable = s
    ? s.uniques.filter((u) => u.state === "in_stash" && !u.bound && u.lockRaids === 0 && u.dur > 0)
    : [];
  const levelOk = s ? s.level >= s.market.sellUnlockLevel : false;

  return (
    // Landscape: the lots on the left, wallet + Sell · My lots · Sales on the right; nothing scrolls,
    // the lists page. Portrait phones stack them.
    <div className="flex min-h-0 flex-1 flex-col gap-3 land:grid land:grid-cols-[minmax(0,1.75fr)_minmax(15rem,1fr)] land:grid-rows-[minmax(0,1fr)] land:gap-4 short:!gap-2">
      <div className="flex min-h-0 flex-1 flex-col">
        <MarketTable canBuy={Boolean(s)} onBought={bump} refreshKey={refreshKey} />
      </div>
      <div className="flex min-h-0 flex-col gap-3 port:max-h-[45%] short:gap-2">
        {s ? (
          <>
            <section className="toon-panel shrink-0 bg-[#161b28]/95 px-4 py-3 short:px-3 short:py-1.5">
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-xs lg:text-[0.8125rem] uppercase tracking-[0.12em] text-white/70 short:hidden">Credits</p>
                  <p className="toon-text-thin mt-1 truncate text-2xl tabular-nums tracking-wide text-amber-300 short:mt-0 short:text-xl">{fmtCr(s.credits)}</p>
                  <p className="font-body mt-0.5 truncate text-xs lg:text-[0.8125rem] text-white/70 short:hidden">
                    Lots are priced in CR · {(s.market.feeBps / 100).toFixed(s.market.feeBps % 100 ? 1 : 0)}% fee on sales
                  </p>
                </div>
                {/* The on-chain SOL escrow is main-build only (the iDos edition blocks /onchain). */}
                {SOL_ECONOMY && (
                  <Link href="/onchain" className="toon-btn-ghost min-h-10 shrink-0 whitespace-nowrap px-4 text-sm [@media(pointer:coarse)]:min-h-11 short:!min-h-9">
                    <span className="optical-center">SOL market</span>
                  </Link>
                )}
              </div>
            </section>
            <Segmented options={SIDE} value={side} onChange={setSide} label="Your market" className="self-start" />
            {side === "sell" ? (
              <section className="toon-panel flex min-h-0 flex-1 flex-col bg-[#161b28]/95 p-4 short:p-3">
                <h2 className="sr-only">Sell</h2>
                {!levelOk ? (
                  <p className="font-body text-sm text-white/75">Selling unlocks at level {s.market.sellUnlockLevel}. Buying is open to everyone.</p>
                ) : sellable.length === 0 ? (
                  <p className="font-body text-sm text-white/75">
                    Nothing sellable in your stash. Starter-kit items unlock after you extract with them; gear in your loadout is locked.
                  </p>
                ) : (
                  <>
                    <p className="font-body shrink-0 text-xs text-white/70 short:hidden">Tap an item to list it.</p>
                    <PagedTiles className="mt-2 short:mt-0" gap={8} label="Sellable item pages">
                      {sellable.map((u) => (
                        <li key={u.id}>
                          <ItemCard def={u.def} rarity={u.rarity} dur={u.dur} size="sm" onClick={() => setSelling(u)} title="Sell this item" />
                        </li>
                      ))}
                    </PagedTiles>
                  </>
                )}
              </section>
            ) : side === "mine" ? (
              <MyListings refreshKey={refreshKey} onChanged={bump} className="flex-1" />
            ) : (
              <RecentTrades refreshKey={refreshKey} className="flex-1" />
            )}
          </>
        ) : sessionLoading || stash ? (
          <RecentTrades refreshKey={refreshKey} className="flex-1" />
        ) : (
          <>
            <section className="toon-panel shrink-0 bg-[#161b28]/95 p-4 short:p-3">
              <h2 className="toon-text-thin text-xl tracking-wide text-white short:text-lg">Trade gear</h2>
              <p className="font-body mt-2 text-sm text-white/75">
                Register to buy and sell weapons, armor and backpacks with other raiders.
              </p>
              <Link href={`/auth/register?next=${encodeURIComponent(panelHref({ panel: "shop" }))}`} className="toon-btn mt-3 min-h-12 w-full text-lg short:min-h-11">
                <span className="optical-center">Register</span>
              </Link>
            </section>
            <RecentTrades refreshKey={refreshKey} className="flex-1" />
          </>
        )}
      </div>

      {selling && s && (
        <ListDialog
          item={selling}
          market={s.market}
          credits={s.credits}
          onClose={() => setSelling(null)}
          onListed={() => {
            setSelling(null);
            bump();
          }}
        />
      )}
    </div>
  );
}
