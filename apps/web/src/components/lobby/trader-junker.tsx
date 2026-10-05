"use client";

import { useState } from "react";
import { BOUND_OFFERS, CONSUMABLES_CR, boundTraderLevel, itemDef, type ConsumableId } from "@extract/shared";
import { fmtCr } from "@/lib/items-ui";
import { ItemCard } from "./item-card";
import { api, newRequestId } from "./use-lobby";
import { Paged } from "@/components/paged";

const OFFERS = Object.entries(CONSUMABLES_CR) as Array<[ConsumableId, { qty: number; cr: number }]>;

interface BuyResponse {
  ok: true;
  applied: boolean;
  credits: number;
  qty: number;
  def: ConsumableId;
}

/**
 * The junker (critique cut 2: consumables only). Sells ammo and meds for CR; the same character
 * buys your junk at extraction, so the autosell "demand" multiplier is shown here too.
 */
export function TraderJunker({
  credits,
  stacks,
  autosellMult,
  level = 1,
  onBought,
  onBoundBought,
}: {
  credits: number;
  stacks: Readonly<Record<string, number>>;
  autosellMult: number;
  /** Player level: unlocks bound-trader offers (boundTraderLevel). */
  level?: number;
  onBought: (r: { credits: number; def: string; qty: number }) => void;
  /** A bound item was bought (new CR balance); the caller reloads the stash. */
  onBoundBought?: (credits: number) => void;
}) {
  const [packs, setPacks] = useState<Record<string, number>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);

  const buy = async (def: ConsumableId) => {
    const n = packs[def] ?? 1;
    setBusy(def);
    setMsg(null);
    try {
      const r = await api<BuyResponse>("/api/trader/buy", { body: { def, packs: n, requestId: newRequestId() } });
      onBought({ credits: r.credits, def: r.def, qty: r.qty });
      setMsg({ ok: true, text: `Bought ${CONSUMABLES_CR[def].qty * n} × ${itemDef(def)?.name ?? def}.` });
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : "Purchase failed" });
    } finally {
      setBusy(null);
    }
  };

  const buyBoundItem = async (def: string) => {
    setBusy(`bound:${def}`);
    setMsg(null);
    try {
      const r = await api<{ ok: true; credits: number }>("/api/trader/bound", { body: { def, requestId: newRequestId() } });
      onBoundBought?.(r.credits);
      setMsg({ ok: true, text: `Bought a bound ${itemDef(def)?.name ?? def}. It is yours to use, never to sell.` });
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : "Purchase failed" });
    } finally {
      setBusy(null);
    }
  };
  const tl = boundTraderLevel(level);

  return (
    <section className="toon-panel flex min-h-0 flex-1 flex-col bg-[#1b2234]/95 p-5 short:p-3">
      <header className="flex shrink-0 items-center gap-4 short:gap-3">
        <span className="grid h-14 w-14 shrink-0 place-items-center rounded-2xl border-[3px] border-black bg-amber-300 shadow-[0_3px_0_#000] short:h-11 short:w-11">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/sprites/junk_toolbox.png" alt="" className="h-10 w-10 object-contain" draggable={false} />
        </span>
        <div className="min-w-0">
          <h2 className="toon-text-thin text-2xl tracking-wide text-amber-300 short:text-xl">Junker</h2>
          <p className="font-body text-sm text-white/75">
            “Ammo, bandages, the good stuff. I buy your junk too.” Demand today{" "}
            <span className="font-semibold tabular-nums text-white">×{autosellMult.toFixed(2)}</span>
          </p>
        </div>
      </header>
      <Paged className="mt-3 short:mt-2" gap={0} minCol={340} maxCols={2} label="Trader pages">
      <ul className="paged-group">
        {OFFERS.map(([def, o]) => {
          const n = packs[def] ?? 1;
          const cost = o.cr * n;
          const afford = credits >= cost;
          return (
            <li key={def} className="flex flex-wrap items-center gap-3 border-b-2 border-black/40 py-2.5 short:py-2">
              <ItemCard def={def} qty={o.qty} size="sm" />
              <div className="min-w-0 flex-1">
                <p className="text-sm tracking-wide text-white">
                  {itemDef(def)?.name ?? def} <span className="text-white/70">× {o.qty}</span>
                </p>
                <p className="font-body text-xs lg:text-[0.8125rem] text-white/70">In stash: {stacks[def] ?? 0}</p>
              </div>
              <div className="ml-auto flex items-center gap-2">
              <div className="flex items-center gap-1" aria-label="Packs">
                <button
                  type="button"
                  aria-label="Fewer packs"
                  onClick={() => setPacks((p) => ({ ...p, [def]: Math.max(1, n - 1) }))}
                  className="grid h-7 w-7 place-items-center rounded-md border-2 border-black bg-white text-black shadow-[0_2px_0_#000] [@media(pointer:coarse)]:h-11 [@media(pointer:coarse)]:w-11"
                >
                  −
                </button>
                <span className="w-6 text-center text-sm tabular-nums text-white">{n}</span>
                <button
                  type="button"
                  aria-label="More packs"
                  onClick={() => setPacks((p) => ({ ...p, [def]: Math.min(20, n + 1) }))}
                  className="grid h-7 w-7 place-items-center rounded-md border-2 border-black bg-white text-black shadow-[0_2px_0_#000] [@media(pointer:coarse)]:h-11 [@media(pointer:coarse)]:w-11"
                >
                  +
                </button>
              </div>
              <button
                type="button"
                onClick={() => buy(def)}
                disabled={!afford || busy !== null}
                className="toon-btn min-h-10 min-w-[6.5rem] px-3 text-sm [@media(pointer:coarse)]:min-h-11"
              >
                <span className="optical-center tabular-nums">{busy === def ? "…" : fmtCr(cost)}</span>
              </button>
              </div>
            </li>
          );
        })}
      </ul>
      <div className="pb-1 pt-3">
        <h3 className="text-sm uppercase tracking-[0.12em] text-white/75">Bound gear</h3>
        <p className="font-body mt-1 text-xs lg:text-[0.8125rem] text-white/70">
          For CR. Bound gear can&apos;t be sold or traded and is destroyed when lost.
        </p>
      </div>
      <ul className="paged-group">
        {BOUND_OFFERS.map((o) => {
          const locked = o.traderLevel > tl;
          const afford = credits >= o.cr;
          return (
            <li key={`${o.def}:${o.rarity}`} className="flex flex-wrap items-center gap-3 border-b-2 border-black/40 py-2.5 short:py-2">
              <ItemCard def={o.def} qty={1} size="sm" />
              <div className="min-w-0 flex-1">
                <p className="text-sm tracking-wide text-white">{itemDef(o.def)?.name ?? o.def}</p>
                <p className="font-body text-xs lg:text-[0.8125rem] text-white/70">{locked ? `Unlocks at level ${(o.traderLevel - 1) * 5}` : "Bound · can't be sold"}</p>
              </div>
              <button
                type="button"
                onClick={() => buyBoundItem(o.def)}
                disabled={locked || !afford || busy !== null}
                className="toon-btn ml-auto min-h-10 min-w-[6.5rem] px-3 text-sm [@media(pointer:coarse)]:min-h-11"
              >
                <span className="optical-center tabular-nums">{busy === `bound:${o.def}` ? "…" : fmtCr(o.cr)}</span>
              </button>
            </li>
          );
        })}
      </ul>
      </Paged>
      {msg && (
        <p role="status" className={msg.ok ? "font-body mt-2 shrink-0 text-sm text-zooa-lime" : "font-body mt-2 shrink-0 text-sm text-rose-300"}>
          {msg.text}
        </p>
      )}
    </section>
  );
}
