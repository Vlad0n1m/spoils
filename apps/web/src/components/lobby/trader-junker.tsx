"use client";

import { useState } from "react";
import { CONSUMABLES_CR, itemDef, type ConsumableId } from "@extract/shared";
import { fmtCr } from "@/lib/items-ui";
import { ItemCard } from "./item-card";
import { api, newRequestId } from "./use-lobby";

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
  onBought,
}: {
  credits: number;
  stacks: Readonly<Record<string, number>>;
  autosellMult: number;
  onBought: (r: { credits: number; def: string; qty: number }) => void;
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

  return (
    <section className="toon-panel bg-[#1b2234]/95 p-5">
      <header className="flex items-center gap-4">
        <span className="grid h-14 w-14 shrink-0 place-items-center rounded-2xl border-[3px] border-black bg-amber-300 shadow-[0_3px_0_#000]">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/sprites/junk_toolbox.png" alt="" className="h-10 w-10 object-contain" draggable={false} />
        </span>
        <div className="min-w-0">
          <h2 className="toon-text-thin text-2xl tracking-wide text-amber-300">Junker</h2>
          <p className="font-body text-sm text-white/65">
            “Ammo, bandages, the good stuff. I buy your junk too.” Demand today{" "}
            <span className="font-semibold tabular-nums text-white">×{autosellMult.toFixed(2)}</span>
          </p>
        </div>
      </header>
      <ul className="mt-5 divide-y-2 divide-black/40">
        {OFFERS.map(([def, o]) => {
          const n = packs[def] ?? 1;
          const cost = o.cr * n;
          const afford = credits >= cost;
          return (
            <li key={def} className="flex flex-wrap items-center gap-3 py-3">
              <ItemCard def={def} qty={o.qty} size="sm" />
              <div className="min-w-0 flex-1">
                <p className="text-sm tracking-wide text-white">
                  {itemDef(def)?.name ?? def} <span className="text-white/45">× {o.qty}</span>
                </p>
                <p className="font-body text-xs text-white/50">In stash: {stacks[def] ?? 0}</p>
              </div>
              <div className="ml-auto flex items-center gap-2">
              <div className="flex items-center gap-1" aria-label="Packs">
                <button
                  type="button"
                  aria-label="Fewer packs"
                  onClick={() => setPacks((p) => ({ ...p, [def]: Math.max(1, n - 1) }))}
                  className="grid h-7 w-7 place-items-center rounded-md border-2 border-black bg-white text-black shadow-[0_2px_0_#000]"
                >
                  −
                </button>
                <span className="w-6 text-center text-sm tabular-nums text-white">{n}</span>
                <button
                  type="button"
                  aria-label="More packs"
                  onClick={() => setPacks((p) => ({ ...p, [def]: Math.min(20, n + 1) }))}
                  className="grid h-7 w-7 place-items-center rounded-md border-2 border-black bg-white text-black shadow-[0_2px_0_#000]"
                >
                  +
                </button>
              </div>
              <button
                type="button"
                onClick={() => buy(def)}
                disabled={!afford || busy !== null}
                className="toon-btn min-h-10 min-w-[6.5rem] px-3 text-sm"
              >
                <span className="optical-center tabular-nums">{busy === def ? "…" : fmtCr(cost)}</span>
              </button>
              </div>
            </li>
          );
        })}
      </ul>
      {msg && (
        <p role="status" className={msg.ok ? "font-body mt-2 text-sm text-zooa-lime" : "font-body mt-2 text-sm text-rose-300"}>
          {msg.text}
        </p>
      )}
    </section>
  );
}
