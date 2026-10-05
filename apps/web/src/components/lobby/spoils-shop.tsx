"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Paged } from "@/components/paged";
import type { IdosClientSession } from "@/lib/idos/client-session";
import { idosTicket } from "@/lib/idos/client-session";
import { SPOILS_SWAP_URL, formatSpoils, formatUsdCents } from "@/lib/idos/shop-rules";
import type { ShopQuote, ShopQuotes } from "@/lib/idos/shop";
import { api, ApiCallError, newRequestId } from "./use-lobby";

/** Quotes and the balance refresh this often (the server caches the token price for the same 60 s). */
const REFRESH_MS = 60_000;

const ICON: Readonly<Record<string, string>> = {
  crate_common: "/sprites/chest_common.png",
  crate_rare: "/sprites/chest_rare.png",
  crate_epic: "/sprites/chest_epic.png",
  starter_kit: "/sprites/crate_military.png",
  cr_pack: "/sprites/junk_toolbox.png",
  supporter: "/sprites/junk_goldchain.png",
  patron: "/sprites/chest_legendary.png",
};

const REASON: Readonly<Record<NonNullable<ShopQuote["reason"]>, string>> = {
  sold_out: "Sold out",
  daily_limit: "Daily limit reached",
  paused: "Paused",
  no_price: "No price right now",
};

interface BuyOk {
  status: "delivered";
  message: string;
}

/**
 * Shop · SPOILS (iDos edition, inside the iDos client only): the player's SPOILS game balance, the
 * products of the SPOILS shop priced in dollars and SPOILS (lib/idos/shop-rules.ts), and Buy. A buy
 * sends the iDos session ticket of this moment (lib/idos/client-session.ts) with a request id; when
 * iDos does not answer, the same request id is kept for the next click, so the retry continues the
 * same order instead of paying again. Quotes and balance refresh every 60 s.
 */
export function SpoilsShop({ session, onDelivered }: { session: IdosClientSession; onDelivered: () => void }) {
  const [quotes, setQuotes] = useState<ShopQuotes | null>(null);
  const [balance, setBalance] = useState<number | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [toast, setToast] = useState<{ ok: boolean; text: string } | null>(null);
  /** Request ids of buys whose outcome is unknown (iDos did not answer), per product. */
  const retryIds = useRef<Record<string, string>>({});

  const refresh = useCallback(async () => {
    try {
      setQuotes(await api<ShopQuotes>("/api/idos/shop"));
      setErr(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not load the shop.");
    }
    const ticket = idosTicket(session);
    if (!ticket) return setBalance(null);
    try {
      setBalance((await api<{ spoils: number }>("/api/idos/balance", { body: { ticket } })).spoils);
    } catch {
      setBalance(null);
    }
  }, [session]);

  useEffect(() => {
    void refresh();
    const t = window.setInterval(() => void refresh(), REFRESH_MS);
    return () => window.clearInterval(t);
  }, [refresh]);

  const buy = async (q: ShopQuote) => {
    const ticket = idosTicket(session);
    if (!ticket) return setToast({ ok: false, text: "Your iDos session has expired. Reload the game." });
    const requestId = retryIds.current[q.id] ?? newRequestId();
    retryIds.current[q.id] = requestId;
    setBusy(q.id);
    setToast(null);
    try {
      const r = await api<BuyOk>("/api/idos/shop/buy", { body: { product: q.id, requestId, ticket } });
      delete retryIds.current[q.id];
      setToast({ ok: true, text: `${q.name}: ${r.message}` });
      onDelivered();
    } catch (e) {
      // Unknown outcome: keep the request id so the next click continues the same order.
      if (!(e instanceof ApiCallError && e.code === "idos_unavailable")) delete retryIds.current[q.id];
      setToast({ ok: false, text: e instanceof Error ? e.message : "Purchase failed." });
    } finally {
      setBusy(null);
      void refresh();
    }
  };

  const perCent = quotes?.spoilsPerCent ?? null;

  return (
    <div className="mx-auto flex min-h-0 w-full max-w-5xl flex-1 flex-col gap-3 land:grid land:grid-cols-[minmax(13rem,1fr)_minmax(0,2.2fr)] land:grid-rows-[minmax(0,1fr)] land:gap-4 short:!gap-2">
      <section className="toon-panel flex shrink-0 flex-col gap-3 bg-[#161b28]/95 p-5 land:self-start short:gap-2 short:p-3">
        <p className="text-xs lg:text-[0.8125rem] uppercase tracking-[0.12em] text-white/70">SPOILS balance</p>
        <p className="toon-text-thin text-4xl tabular-nums tracking-wide text-zooa-lime short:text-3xl">
          {balance === null ? "—" : formatSpoils(balance)}
        </p>
        {perCent !== null && (
          <p className="font-body text-xs lg:text-[0.8125rem] text-white/70">1¢ ≈ {formatSpoils(perCent)} SPOILS at today&apos;s price</p>
        )}
        <a
          href={SPOILS_SWAP_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="toon-btn min-h-11 px-4 text-base"
        >
          <span className="optical-center">Get SPOILS</span>
        </a>
        <p className="font-body text-sm leading-relaxed text-white/75">
          Bought SPOILS must be deposited to your game balance on idosgames.com (the wallet on the game&apos;s page) before
          you can spend them here.
        </p>
      </section>

      <section className="toon-panel flex min-h-0 flex-1 flex-col bg-[#1b2234]/95 p-5 short:p-3">
        <header className="shrink-0">
          <h2 className="toon-text-thin text-2xl tracking-wide text-zooa-lime short:text-xl">SPOILS shop</h2>
          <p className="font-body text-sm text-white/75">Prices follow the token: set in dollars, paid in SPOILS.</p>
        </header>
        {err && !quotes && (
          <p role="alert" className="font-body mt-3 text-sm text-rose-300">
            {err}
          </p>
        )}
        {quotes && (
          <Paged className="mt-3 short:mt-2" gap={0} minCol={340} maxCols={2} label="SPOILS shop pages">
            <ul className="paged-group">
              {quotes.products.map((q) => {
                const short = balance !== null && q.spoils !== null && balance < q.spoils;
                return (
                  <li key={q.id} className="flex flex-wrap items-center gap-3 border-b-2 border-black/40 py-2.5 short:py-2">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={ICON[q.id] ?? "/sprites/crate.png"} alt="" className="h-12 w-12 shrink-0 object-contain" draggable={false} />
                    <div className="min-w-0 flex-1">
                      <p className="text-sm tracking-wide text-white">{q.name}</p>
                      <p className="font-body text-xs lg:text-[0.8125rem] text-white/70">{q.blurb}</p>
                      <p className="font-body text-xs lg:text-[0.8125rem] tabular-nums text-white/85">
                        {formatUsdCents(q.usdCents)}
                        {q.spoils !== null && <> · ≈{formatSpoils(q.spoils)} SPOILS</>}
                        {q.stock !== undefined && q.available && <span className="text-white/60"> · {q.stock} in the pool</span>}
                        {q.limit && q.available && (
                          <span className="text-white/60">
                            {" "}
                            · {q.limit.used}/{q.limit.max} today
                          </span>
                        )}
                        {!q.available && q.reason && <span className="text-rose-300"> · {REASON[q.reason]}</span>}
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => void buy(q)}
                      disabled={!q.available || busy !== null}
                      title={short ? "Not enough SPOILS on your game balance" : undefined}
                      className="toon-btn ml-auto min-h-10 min-w-[6.5rem] px-3 text-sm [@media(pointer:coarse)]:min-h-11"
                    >
                      <span className="optical-center">{busy === q.id ? "…" : "Buy"}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </Paged>
        )}
        {toast && (
          <p role="status" className={toast.ok ? "font-body mt-2 shrink-0 text-sm text-zooa-lime" : "font-body mt-2 shrink-0 text-sm text-rose-300"}>
            {toast.text}
          </p>
        )}
      </section>
    </div>
  );
}
