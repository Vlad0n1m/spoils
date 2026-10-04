"use client";

import { useEffect, useState } from "react";
import clsx from "clsx";
import type { ListingRowDto, ListingsResponse } from "@/lib/lobby/api-types";
import { describeItem } from "@/lib/items-ui";
import { formatMinor, saleBreakdown } from "@/lib/market/config";
import { ItemCard } from "./item-card";
import { api, timeAgo, timeLeft, useResource } from "./use-lobby";

const STATUS: Record<ListingRowDto["status"], { text: string; cls: string }> = {
  pending: { text: "Pending", cls: "bg-sky-300" },
  active: { text: "On sale", cls: "bg-zooa-lime" },
  sold: { text: "Sold", cls: "bg-amber-300" },
  cancelled: { text: "Withdrawn", cls: "bg-white/70" },
  expired: { text: "Expired", cls: "bg-white/50" },
};

/** The seller's lots: open ones with Cancel, then recent sold / withdrawn / expired ones. */
export function MyListings({ refreshKey, onChanged }: { refreshKey: number; onChanged: () => void }) {
  const res = useResource<ListingsResponse>("/api/market/listings?mine=1");
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const { reload } = res;
  useEffect(() => {
    if (refreshKey > 0) void reload();
  }, [refreshKey, reload]);

  const cancel = async (id: string) => {
    setBusy(id);
    setErr(null);
    try {
      await api("/api/market/cancel", { body: { listingId: id } });
      onChanged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Cancel failed");
    } finally {
      setBusy(null);
      void reload();
    }
  };

  const rows = res.data?.listings ?? [];
  const feeBps = res.data?.market.feeBps ?? 0;
  const now = Date.now();
  return (
    <section className="toon-panel bg-[#161b28]/95 p-5">
      <h2 className="toon-text-thin text-xl tracking-wide text-white">My listings</h2>
      {err && <p className="font-body mt-2 text-sm text-rose-300">{err}</p>}
      {rows.length === 0 ? (
        <p className="font-body mt-3 text-sm text-white/70">{res.loading ? "Loading…" : "Nothing listed. Pick an item in your Stash and press Sell."}</p>
      ) : (
        <ul className="mt-3 flex flex-col gap-2">
          {rows.slice(0, 12).map((l) => {
            const open = l.status === "active" || l.status === "pending";
            const st = open && l.visibleAt > now ? STATUS.pending : STATUS[l.status];
            return (
              <li key={l.id} className="flex items-center gap-2.5 rounded-xl border-2 border-black bg-black/25 p-2">
                <ItemCard def={l.item.def} rarity={l.item.rarity} dur={l.item.dur} size="sm" />
                <div className="min-w-0 flex-1">
                  <p className="flex items-center gap-2 text-sm tracking-wide text-white">
                    <span className="truncate">{describeItem({ def: l.item.def, rarity: l.item.rarity }).name}</span>
                    <span className={clsx("shrink-0 rounded-md border-2 border-black px-1.5 py-0.5 text-xs lg:text-[0.8125rem] uppercase tracking-wider text-black", st.cls)}>{st.text}</span>
                  </p>
                  <p className="font-body text-xs lg:text-[0.8125rem] text-white/70">
                    <span className="tabular-nums text-zooa-lime">{formatMinor(l.price)}</span>
                    {l.status === "sold" ? (
                      <> · you got {formatMinor(saleBreakdown(BigInt(l.price), feeBps).net)}</>
                    ) : open ? (
                      <> · {timeLeft(l.expiresAt, now)} left</>
                    ) : l.closedAt ? (
                      <> · {timeAgo(l.closedAt, now)}</>
                    ) : null}
                  </p>
                </div>
                {open && (
                  <button type="button" onClick={() => cancel(l.id)} disabled={busy !== null} className="toon-btn-ghost min-h-8 shrink-0 px-2.5 text-xs lg:text-[0.8125rem] [@media(pointer:coarse)]:min-h-11 [@media(pointer:coarse)]:px-3.5">
                    <span className="optical-center">{busy === l.id ? "…" : "Cancel"}</span>
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
