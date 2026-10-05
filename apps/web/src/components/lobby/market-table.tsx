"use client";

import { useEffect, useState } from "react";
import clsx from "clsx";
import type { ListingRowDto, ListingsResponse } from "@/lib/lobby/api-types";
import { describeItem } from "@/lib/items-ui";
import { formatMinor } from "@/lib/market/config";
import { MARKET_CATS, templateLabel, type MarketCat } from "@/lib/market/templates";
import { ItemCard } from "./item-card";
import { api, timeLeft, useResource } from "./use-lobby";
import { Paged } from "@/components/paged";

const CAT_LABEL: Record<MarketCat, string> = { all: "All", weapon: "Weapons", armor: "Armor", backpack: "Backpacks" };
const SORTS = [
  { id: "price_asc", label: "Cheapest" },
  { id: "price_desc", label: "Priciest" },
  { id: "newest", label: "Newest" },
  { id: "rarity", label: "Rarest" },
] as const;

/**
 * Market board (economy memo §7, v1): fixed-price lots, filters by category, sort, buy with a
 * confirm step. `canBuy` is false for guests / signed-out viewers (browse only). The lots page
 * (‹ ›, swipe) in the free height instead of scrolling.
 */
export function MarketTable({ canBuy, onBought, refreshKey }: { canBuy: boolean; onBought: () => void; refreshKey: number }) {
  const [cat, setCat] = useState<MarketCat>("all");
  const [sort, setSort] = useState<(typeof SORTS)[number]["id"]>("price_asc");
  const res = useResource<ListingsResponse>(`/api/market/listings?cat=${cat}&sort=${sort}`);
  const [confirm, setConfirm] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const { reload } = res;
  useEffect(() => {
    if (refreshKey > 0) void reload();
  }, [refreshKey, reload]);
  // Pending lots count down to visibility; tick every 5 s.
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 5_000);
    return () => window.clearInterval(t);
  }, []);

  const buy = async (l: ListingRowDto) => {
    setBusy(l.id);
    setMsg(null);
    try {
      await api("/api/market/buy", { body: { listingId: l.id } });
      setMsg({ ok: true, text: `Bought ${describeItem({ def: l.item.def, rarity: l.item.rarity }).name} for ${formatMinor(l.price)}. It's in your stash.` });
      onBought();
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : "Purchase failed" });
    } finally {
      setBusy(null);
      setConfirm(null);
      void reload();
    }
  };

  const rows = res.data?.listings ?? [];
  const balance = res.data?.balance ? BigInt(res.data.balance) : null;

  return (
    <section className="toon-panel flex min-h-0 flex-1 flex-col bg-[#161b28]/95 p-5 short:p-3">
      <header className="flex shrink-0 flex-wrap items-center justify-between gap-x-3 gap-y-2">
        <h2 className="toon-text-thin text-2xl tracking-wide text-white short:sr-only">Market</h2>
        <div className="flex flex-wrap items-center gap-1.5">
          {MARKET_CATS.map((c) => (
            <Chip key={c} active={cat === c} onClick={() => setCat(c)}>
              {CAT_LABEL[c]}
            </Chip>
          ))}
          <label className="sr-only" htmlFor="market-sort">
            Sort
          </label>
          <select
            id="market-sort"
            value={sort}
            onChange={(e) => setSort(e.target.value as typeof sort)}
            className="ml-1 rounded-full border-2 border-black bg-white px-3 py-1.5 text-xs lg:text-[0.8125rem] text-black [@media(pointer:coarse)]:min-h-11"
          >
            {SORTS.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label}
              </option>
            ))}
          </select>
        </div>
      </header>

      {msg && (
        <p role="status" className={clsx("font-body mt-3 shrink-0 rounded-xl border-2 border-black px-3 py-2 text-sm font-semibold text-black", msg.ok ? "bg-zooa-lime" : "bg-rose-300")}>
          {msg.text}
        </p>
      )}
      {res.error && <p className="font-body mt-4 shrink-0 text-sm text-rose-300">{res.error}</p>}
      {!res.error && rows.length === 0 && (
        <p className="font-body mt-6 shrink-0 rounded-2xl border-2 border-dashed border-white/15 p-6 text-center text-sm text-white/70">
          {res.loading ? "Loading listings…" : "Nothing for sale in this category yet."}
        </p>
      )}

      <Paged as="ul" className="mt-4 short:mt-2" gap={8} minCol={360} maxCols={2} resetKey={`${cat}:${sort}`} label="Market pages">
        {rows.map((l) => {
          const d = describeItem({ def: l.item.def, rarity: l.item.rarity });
          const pending = l.visibleAt > now;
          const short = balance !== null && balance < BigInt(l.price);
          return (
            <li
              key={l.id}
              className={clsx(
                "grid grid-cols-[auto_1fr_auto] items-center gap-3 rounded-2xl border-2 border-black bg-black/25 p-2.5 pr-3 sm:grid-cols-[auto_1fr_auto_auto] short:gap-2 short:p-1.5 short:pr-2",
                l.mine && "bg-sky-300/10",
              )}
            >
              <ItemCard def={l.item.def} rarity={l.item.rarity} dur={l.item.dur} size="sm" />
              <div className="min-w-0">
                <p className="truncate text-sm tracking-wide text-white">{d.name}</p>
                <p className="font-body truncate text-xs lg:text-[0.8125rem] text-white/70">
                  <span style={{ color: d.color }}>{d.rarityName}</span> · {Math.round(l.item.dur)}% durability ·{" "}
                  {l.isTreasury ? <span className="text-amber-300">Treasury</span> : l.mine ? "you" : l.seller}
                  <span className="hidden sm:inline"> · {timeLeft(l.expiresAt, now)} left</span>
                </p>
              </div>
              <p className="toon-text-thin text-right text-lg tabular-nums tracking-wide text-zooa-lime max-sm:col-span-3 max-sm:row-start-2 max-sm:text-left sm:text-xl short:!text-base">
                {formatMinor(l.price)}
              </p>
              <div className="max-sm:col-start-3 max-sm:row-start-1">
                {l.mine ? (
                  <span className="text-xs lg:text-[0.8125rem] uppercase tracking-wider text-sky-300">{pending ? `Live in ${Math.max(1, Math.ceil((l.visibleAt - now) / 1000))}s` : "Your listing"}</span>
                ) : !canBuy ? (
                  <span className="text-xs lg:text-[0.8125rem] uppercase tracking-wider text-white/70">Sign in</span>
                ) : confirm === l.id ? (
                  <div className="flex gap-1.5">
                    <button type="button" onClick={() => buy(l)} disabled={busy !== null} className="toon-btn min-h-9 px-3 text-sm [@media(pointer:coarse)]:min-h-11">
                      <span className="optical-center">{busy === l.id ? "…" : "Confirm"}</span>
                    </button>
                    <button type="button" onClick={() => setConfirm(null)} className="toon-btn-ghost min-h-9 px-3 text-sm [@media(pointer:coarse)]:min-h-11">
                      <span className="optical-center">✕</span>
                    </button>
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={() => setConfirm(l.id)}
                    disabled={short || busy !== null}
                    title={short ? "Not enough balance" : undefined}
                    className="toon-btn min-h-9 px-4 text-sm [@media(pointer:coarse)]:min-h-11"
                  >
                    <span className="optical-center">Buy</span>
                  </button>
                )}
              </div>
            </li>
          );
        })}
      </Paged>
    </section>
  );
}

function Chip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={clsx(
        "rounded-full border-2 border-black px-3 py-1.5 text-xs lg:text-[0.8125rem] tracking-wide transition [@media(pointer:coarse)]:min-h-11 [@media(pointer:coarse)]:px-4",
        active ? "bg-zooa-lime text-black shadow-[0_2px_0_#000]" : "bg-black/30 text-white/75 hover:text-white",
      )}
    >
      {children}
    </button>
  );
}

/** Recent trades (all templates): what things actually sell for. Paged, never scrolled. */
export function RecentTrades({ refreshKey, className }: { refreshKey: number; className?: string }) {
  const res = useResource<{ trades: Array<{ id: string; template: string; def: string; rarity: number; dur: number; price: string; at: number }> }>(
    "/api/market/history",
  );
  const { reload } = res;
  useEffect(() => {
    if (refreshKey > 0) void reload();
  }, [refreshKey, reload]);
  const trades = res.data?.trades ?? [];
  return (
    <section className={clsx("toon-panel flex min-h-0 flex-col bg-[#161b28]/95 p-5 short:p-3", className)}>
      <h2 className="toon-text-thin shrink-0 text-xl tracking-wide text-white short:text-lg">Recent sales</h2>
      {trades.length === 0 ? (
        <p className="font-body mt-3 text-sm text-white/70">{res.loading ? "Loading…" : "No sales yet — be the first."}</p>
      ) : (
        <Paged as="ul" className="mt-3 short:mt-2" flowClassName="font-body text-sm" gap={6} label="Recent sale pages">
          {trades.slice(0, 10).map((t) => (
            <li key={t.id} className="flex items-center gap-2">
              <ItemCard def={t.def} rarity={t.rarity} size="sm" />
              <span className="min-w-0 flex-1 truncate text-white/80">
                {templateLabel(t.template)} <span className="text-white/70">{Math.round(t.dur)}%</span>
              </span>
              <span className="tabular-nums text-zooa-lime">{formatMinor(t.price)}</span>
            </li>
          ))}
        </Paged>
      )}
    </section>
  );
}
