"use client";

import { useEffect } from "react";
import { useLobby } from "@/lib/lobby/lobby-context";
import { panelHref } from "@/lib/lobby/panels";
import { fmtCr } from "@/lib/items-ui";
import { MarketTab } from "@/components/lobby/market-tab";
import { TraderJunker } from "@/components/lobby/trader-junker";
import { Gate, StashWait } from "./gate";

/**
 * Shop (WORLD v6 spec §6.3): Market (player and treasury lots for the market currency; anyone can
 * browse) and Traders (consumables and bound gear for CR, registered only). CR never converts to
 * SOL, and the Traders tab says so.
 */
export function ShopPanel({ tab }: { tab: string }) {
  const { registered, sessionLoading, sessionKind, stash } = useLobby();
  const { reload, mutate } = stash;
  useEffect(() => {
    if (registered) void reload();
  }, [registered, reload]);

  if (tab !== "traders") return <MarketTab stash={registered ? stash : null} sessionLoading={sessionLoading} />;
  if (!registered) return <Gate loading={sessionLoading} guest={sessionKind === "guest"} next={panelHref({ panel: "shop", tab: "traders" })} />;
  const s = stash.data;
  if (!s) return <StashWait error={stash.error} onRetry={() => void reload()} />;
  return (
    <div className="mx-auto grid max-w-4xl grid-cols-1 gap-6 lg:grid-cols-12">
      {/* self-start + sticky: the card keeps its height and the balance stays in view while the long
          trader list scrolls, instead of stretching into an empty column. */}
      <section className="toon-panel flex flex-col gap-3 bg-[#161b28]/95 p-5 lg:sticky lg:top-0 lg:col-span-4 lg:self-start">
        <p className="text-[0.65rem] uppercase tracking-[0.2em] text-white/55">Credits</p>
        <p className="toon-text-thin text-4xl tabular-nums tracking-wide text-amber-300">{fmtCr(s.credits)}</p>
        <p className="font-body text-sm leading-relaxed text-white/75">
          Earn CR by bringing junk out of a raid: it sells automatically when you extract. Spend it here on ammo, meds and
          bound gear.
        </p>
        <p className="font-body rounded-xl border-2 border-black bg-amber-300 px-3 py-2 text-sm font-bold text-black">
          Credits never convert to SOL.
        </p>
        <p className="font-body text-xs leading-relaxed text-white/60">
          Bound gear is yours to use but never to sell, and it is destroyed instead of entering the lost pool. Higher trader
          tiers unlock with your level.
        </p>
      </section>
      <div className="lg:col-span-8">
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
