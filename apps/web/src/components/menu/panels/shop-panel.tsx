"use client";

import { useEffect } from "react";
import { useLobby } from "@/lib/lobby/lobby-context";
import { panelHref } from "@/lib/lobby/panels";
import { fmtCr } from "@/lib/items-ui";
import { MarketTab } from "@/components/lobby/market-tab";
import { TraderJunker } from "@/components/lobby/trader-junker";
import { SpoilsShop } from "@/components/lobby/spoils-shop";
import { Gate, StashWait } from "./gate";
import { EDITION_UI, SOL_ECONOMY } from "@/lib/edition";
import { idosClientSession } from "@/lib/idos/client-session";

/**
 * Shop (WORLD v6 spec §6.3): Market (player lots for CR, plus treasury lots in the main build; anyone
 * can browse), Traders (consumables and bound gear for CR, registered only) and, in the iDos edition
 * inside the iDos client, SPOILS (lib/idos/shop.ts: crates, kits, CR packs and donations paid with the
 * SPOILS token). CR never converts to money, and the Traders tab says so.
 */
export function ShopPanel({ tab }: { tab: string }) {
  const { registered, sessionLoading, sessionKind, stash } = useLobby();
  const { reload, mutate } = stash;
  useEffect(() => {
    if (registered) void reload();
  }, [registered, reload]);

  // SPOILS (iDos edition, inside the iDos client only: it pays with the iDos session's ticket).
  const idos = tab === "spoils" ? idosClientSession() : null;
  if (idos) {
    if (!registered) return <Gate loading={sessionLoading} guest={sessionKind === "guest"} next={panelHref({ panel: "shop", tab: "spoils" })} />;
    return <SpoilsShop session={idos} onDelivered={() => void reload()} />;
  }
  if (EDITION_UI.market && tab !== "traders" && tab !== "spoils") return <MarketTab stash={registered ? stash : null} sessionLoading={sessionLoading} />;
  if (!registered) return <Gate loading={sessionLoading} guest={sessionKind === "guest"} next={panelHref({ panel: "shop", tab: "traders" })} />;
  const s = stash.data;
  if (!s) return <StashWait error={stash.error} onRetry={() => void reload()} />;
  return (
    <div className="mx-auto flex min-h-0 w-full max-w-5xl flex-1 flex-col gap-3 land:grid land:grid-cols-[minmax(13rem,1fr)_minmax(0,2.2fr)] land:grid-rows-[minmax(0,1fr)] land:gap-4 short:!gap-2">
      {/* The balance stays beside the trader list; the rules fold away instead of filling the column. */}
      <section className="toon-panel flex shrink-0 flex-col gap-3 bg-[#161b28]/95 p-5 land:self-start short:gap-2 short:p-3">
        <p className="text-xs lg:text-[0.8125rem] uppercase tracking-[0.12em] text-white/70">Credits</p>
        <p className="toon-text-thin text-4xl tabular-nums tracking-wide text-amber-300 short:text-3xl">{fmtCr(s.credits)}</p>
        <p className="font-body rounded-xl border-2 border-black bg-amber-300 px-3 py-2 text-sm font-bold text-black">
          {SOL_ECONOMY ? "Credits never convert to SOL." : "Credits stay in the game: they never turn into money."}
        </p>
        <details className="font-body group text-sm leading-relaxed text-white/75">
          <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-2 font-semibold text-white/85 [&::-webkit-details-marker]:hidden">
            How credits work
            <span aria-hidden className="transition-transform group-open:rotate-90">›</span>
          </summary>
          <p>
            Earn CR by bringing junk out of a raid: it sells automatically when you extract. Spend it here on ammo, meds and
            bound gear.
          </p>
          <p className="mt-2 text-xs lg:text-[0.8125rem]">
            Bound gear is yours to use but can&apos;t be sold or traded, and it is gone for good if you lose it in a raid. Better
            trader gear unlocks as you level up.
          </p>
        </details>
      </section>
      <div className="flex min-h-0 flex-1 flex-col">
        <TraderJunker
          credits={s.credits}
          stacks={s.stacks}
          autosellMult={s.autosellMult}
          level={s.level}
          onBought={(r) => mutate((d) => ({ ...d, credits: r.credits, stacks: { ...d.stacks, [r.def]: r.qty } }))}
          onBoundBought={() => void reload()}
        />
      </div>
    </div>
  );
}
