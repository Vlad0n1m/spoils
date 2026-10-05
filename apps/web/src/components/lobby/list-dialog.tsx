"use client";

import { useEffect, useId, useState } from "react";
import { templateKey, templateRefPriced } from "@extract/shared";
import type { HistoryResponse, MarketConfigDto, StashItemDto } from "@/lib/lobby/api-types";
import { formatMinor, parsePriceToMinor, saleBreakdown } from "@/lib/market/config";
import { templateLabel } from "@/lib/market/templates";
import { describeItem, fmtCr } from "@/lib/items-ui";
import { ItemCard } from "./item-card";
import { api } from "./use-lobby";

/**
 * Sell dialog (economy memo §7): fixed price in the market currency, with the fee breakdown
 * (seller fee in the currency + non-refundable CR listing fee), the price index and allowed band
 * when the template has enough trades, and the last sales of that template as a reference.
 */
export function ListDialog({
  item,
  market,
  credits,
  onClose,
  onListed,
}: {
  item: StashItemDto;
  market: MarketConfigDto;
  credits: number;
  onClose: () => void;
  onListed: () => void;
}) {
  const id = useId();
  const template = templateKey({ def: item.def, rarity: item.rarity });
  const [text, setText] = useState("");
  const [hist, setHist] = useState<HistoryResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const d = describeItem({ def: item.def, rarity: item.rarity });
  const feeCr = market.listingFeeCr[Math.max(0, Math.min(3, item.rarity))] ?? 0;

  useEffect(() => {
    if (!template) return;
    let live = true;
    api<HistoryResponse>(`/api/market/history?template=${encodeURIComponent(template)}`)
      .then((h) => live && setHist(h))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [template]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const price = parsePriceToMinor(text);
  const br = price ? saleBreakdown(price, market.feeBps) : null;
  const band = hist?.band;
  const outOfBand = price !== null && band ? price < BigInt(band.min) || (band.max !== null && price > BigInt(band.max)) : false;
  const canAffordFee = credits >= feeCr;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!price) return;
    setBusy(true);
    setErr(null);
    try {
      await api("/api/market/list", { body: { itemId: item.id, price: price.toString() } });
      onListed();
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : "Listing failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/70 p-4" role="dialog" aria-modal="true" aria-labelledby={`${id}-t`} onClick={onClose}>
      {/* Landscape phones: two columns (item and price | breakdown and buttons), so it fits the height;
          the faded scroll is only a fallback (e.g. under an on-screen keyboard). */}
      <form
        onSubmit={submit}
        onClick={(e) => e.stopPropagation()}
        className="toon-panel scroll-fade max-h-[92dvh] w-full max-w-md overflow-y-auto bg-[#161b28] p-6 short:grid short:max-w-3xl short:grid-cols-2 short:gap-x-5 short:p-4"
      >
        <div>
        <div className="flex items-center gap-4">
          <ItemCard def={item.def} rarity={item.rarity} dur={item.dur} size="lg" />
          <div className="min-w-0">
            <h2 id={`${id}-t`} className="toon-text-thin truncate text-2xl tracking-wide text-white">
              Sell {d.name}
            </h2>
            <p className="text-xs lg:text-[0.8125rem] uppercase tracking-wider" style={{ color: d.color }}>
              {d.rarityName} · {Math.round(item.dur)}% durability
            </p>
          </div>
        </div>

        <label htmlFor={`${id}-p`} className="mt-6 short:mt-4 block text-xs lg:text-[0.8125rem] uppercase tracking-[0.12em] text-white/75">
          Price ({market.currency})
        </label>
        <div className="mt-2 flex items-center gap-2">
          <input
            id={`${id}-p`}
            autoFocus
            inputMode="decimal"
            autoComplete="off"
            placeholder="0.00"
            value={text}
            onChange={(e) => setText(e.target.value)}
            className="w-full rounded-2xl border-[3px] border-black bg-white px-4 py-3 text-xl tabular-nums text-black placeholder:text-black/30 focus:outline-none focus:ring-4 focus:ring-zooa-lime/60"
          />
          <span className="text-lg text-white/70">{market.currency}</span>
        </div>
        {text && !price && <p className="font-body mt-1 text-sm text-rose-300">Enter an amount like 12.50 (max {market.decimals} decimals).</p>}
        </div>

        <div>
        <dl className="font-body mt-5 short:mt-0 grid grid-cols-[1fr_auto] gap-y-1.5 rounded-2xl border-2 border-black bg-black/30 p-4 text-sm">
          <dt className="text-white/75">Buyer pays</dt>
          <dd className="text-right tabular-nums text-white">{price ? formatMinor(price) : "—"}</dd>
          <dt className="text-white/75">Market fee ({(market.feeBps / 100).toFixed(market.feeBps % 100 ? 1 : 0)}%)</dt>
          <dd className="text-right tabular-nums text-white/80">{br ? `− ${formatMinor(br.fee)}` : "—"}</dd>
          <dt className="font-semibold text-white">You receive</dt>
          <dd className="text-right font-semibold tabular-nums text-zooa-lime">{br ? formatMinor(br.net) : "—"}</dd>
          <dt className="mt-2 text-white/75">Listing fee (not refunded)</dt>
          <dd className={canAffordFee ? "mt-2 text-right tabular-nums text-amber-300" : "mt-2 text-right tabular-nums text-rose-300"}>{fmtCr(feeCr)}</dd>
        </dl>

        {template && (
          <div className="font-body mt-4 text-sm text-white/75">
            <p>
              <span className="text-white/70">{templateLabel(template)}: </span>
              {hist?.index ? (
                <>
                  index <span className="tabular-nums text-white">{formatMinor(hist.index)}</span>
                  {band && (
                    <>
                      {" "}
                      · allowed {formatMinor(band.min)} – {band.max ? formatMinor(band.max) : "∞"}
                    </>
                  )}
                </>
              ) : !templateRefPriced(template) ? (
                "new item — no reference price yet, any price goes."
              ) : (
                "no price index yet — any price goes."
              )}
            </p>
            {hist && hist.trades.length > 0 && (
              <p className="mt-1 text-white/70">
                Last sales: {hist.trades.slice(0, 5).map((t) => `${formatMinor(t.price)} (${Math.round(t.dur)}%)`).join(" · ")}
              </p>
            )}
          </div>
        )}
        {outOfBand && <p className="font-body mt-2 text-sm text-rose-300">That price is outside the allowed band.</p>}
        {err && (
          <p className="font-body mt-3 text-sm font-semibold text-rose-300" role="alert">
            {err}
          </p>
        )}

        <div className="mt-6 flex gap-3 short:mt-4">
          <button type="button" onClick={onClose} className="toon-btn-ghost min-h-12 flex-1 text-base">
            <span className="optical-center">Cancel</span>
          </button>
          <button type="submit" disabled={!price || busy || outOfBand || !canAffordFee} className="toon-btn min-h-12 flex-1 text-lg">
            <span className="optical-center">{busy ? "Listing…" : "List for sale"}</span>
          </button>
        </div>
        </div>
      </form>
    </div>
  );
}
