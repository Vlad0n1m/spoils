"use client";

import { useState } from "react";
import Link from "next/link";
import type { StashItemDto, StashResponse } from "@/lib/lobby/api-types";
import { fmtCr } from "@/lib/items-ui";
import { formatMinor } from "@/lib/market/config";
import { panelHref } from "@/lib/lobby/panels";
import { ItemCard } from "./item-card";
import { ListDialog } from "./list-dialog";
import { MarketTable, RecentTrades } from "./market-table";
import { MyListings } from "./my-listings";
import type { Resource } from "./use-lobby";

/**
 * Shop · Market: the lot board, plus (registered users) wallet, a quick "sell from stash" picker,
 * the user's lots and recent sales. Guests and signed-out visitors can browse.
 */
export function MarketTab({ stash, sessionLoading = false }: { stash: Resource<StashResponse> | null; sessionLoading?: boolean }) {
  const [refreshKey, setRefreshKey] = useState(0);
  const [selling, setSelling] = useState<StashItemDto | null>(null);
  const s = stash?.data ?? null;
  const bump = () => {
    setRefreshKey((k) => k + 1);
    void stash?.reload();
  };
  const sellable = s
    ? s.uniques.filter((u) => u.state === "in_stash" && !u.bound && u.lockRaids === 0 && u.dur > 0)
    : [];
  const levelOk = s ? s.level >= s.market.sellUnlockLevel : false;

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
      <div className="lg:col-span-8">
        <MarketTable canBuy={Boolean(s)} onBought={bump} refreshKey={refreshKey} />
      </div>
      <div className="flex flex-col gap-6 lg:col-span-4">
        {s ? (
          <>
            <section className="toon-panel bg-[#161b28]/95 p-5">
              <div className="flex items-end justify-between gap-3">
                <div>
                  <p className="text-[0.65rem] uppercase tracking-[0.2em] text-white/50">Wallet</p>
                  <p className="toon-text-thin mt-1.5 text-3xl tabular-nums tracking-wide text-zooa-lime">{formatMinor(s.balance)}</p>
                  <p className="font-body mt-1 text-xs text-white/55">
                    {fmtCr(s.credits)} for listing fees · {(s.market.feeBps / 100).toFixed(s.market.feeBps % 100 ? 1 : 0)}% fee on sales
                  </p>
                </div>
                <Link href="/wallet" className="toon-btn-ghost min-h-10 shrink-0 whitespace-nowrap px-4 text-sm [@media(pointer:coarse)]:min-h-11">
                  <span className="optical-center">Top up</span>
                </Link>
              </div>
            </section>

            <section className="toon-panel bg-[#161b28]/95 p-5">
              <h2 className="toon-text-thin text-xl tracking-wide text-white">Sell</h2>
              {!levelOk ? (
                <p className="font-body mt-3 text-sm text-white/60">Selling unlocks at level {s.market.sellUnlockLevel}. Buying is open to everyone.</p>
              ) : sellable.length === 0 ? (
                <p className="font-body mt-3 text-sm text-white/60">
                  Nothing sellable in your stash. Starter-kit items unlock after you extract with them; gear in your loadout is locked.
                </p>
              ) : (
                <ul className="mt-4 grid grid-cols-[repeat(auto-fill,minmax(3.5rem,1fr))] gap-2">
                  {sellable.map((u) => (
                    <li key={u.id} className="flex justify-center">
                      <ItemCard def={u.def} rarity={u.rarity} dur={u.dur} size="sm" onClick={() => setSelling(u)} title="Sell this item" />
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <MyListings refreshKey={refreshKey} onChanged={bump} />
          </>
        ) : sessionLoading || stash ? null : (
          <section className="toon-panel bg-[#161b28]/95 p-5">
            <h2 className="toon-text-thin text-xl tracking-wide text-white">Trade gear</h2>
            <p className="font-body mt-3 text-sm text-white/65">
              Register to buy and sell weapons, armor and backpacks with other raiders.
            </p>
            <Link href={`/auth/register?next=${encodeURIComponent(panelHref({ panel: "shop" }))}`} className="toon-btn mt-4 min-h-12 w-full text-lg">
              <span className="optical-center">Register</span>
            </Link>
          </section>
        )}
        <RecentTrades refreshKey={refreshKey} />
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
