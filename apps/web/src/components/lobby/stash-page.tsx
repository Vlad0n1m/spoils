"use client";

import { useState } from "react";
import Link from "next/link";
import { GIVEAWAY, GIVEAWAY_KIT, itemDef, levelForXp, xpToNext } from "@extract/shared";
import type { StashItemDto, StashResponse } from "@/lib/lobby/api-types";
import { describeItem, fmtCr } from "@/lib/items-ui";
import { formatMinor } from "@/lib/market/config";
import { ItemCard } from "./item-card";
import { StashList, uniqueBadge } from "./stash-list";
import { panelHref } from "@/lib/lobby/panels";
import { ListDialog } from "./list-dialog";
import { api, type Resource } from "./use-lobby";

/**
 * Stash tab (inventory memo "stash-page"): wallet (CR + market balance), level, the starter-kit
 * claim, every unique with rarity / durability / state, ammo and med stacks, an item drawer with
 * the Sell action. The junker moved to Shop · Traders (WORLD v6); a link points there.
 */
export function StashPage({ res }: { res: Resource<StashResponse> }) {
  const stash = res.data!;
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selling, setSelling] = useState<StashItemDto | null>(null);
  const [claiming, setClaiming] = useState<"free" | "paid" | null>(null);
  const [note, setNote] = useState<{ text: string; ok: boolean } | null>(null);
  const selected = stash.uniques.find((u) => u.id === selectedId) ?? null;

  const claim = async (paid: boolean) => {
    setClaiming(paid ? "paid" : "free");
    setNote(null);
    try {
      const r = await api<{ bound?: boolean }>("/api/stash/starter", { method: "POST", body: { paid } });
      await res.reload();
      setNote({
        ok: true,
        text: r?.bound
          ? "Starter kit added to your stash (bound: yours to use, not to sell). Equip it in the Loadout tab."
          : "Tradable starter kit added to your stash. It unlocks for the market after you extract with it. Equip it in the Loadout tab.",
      });
    } catch (e) {
      setNote({ ok: false, text: e instanceof Error ? e.message : "Claim failed" });
    } finally {
      setClaiming(null);
    }
  };

  // xp is cumulative; show progress inside the current level.
  const lvl = levelForXp(stash.xp);
  let rest = stash.xp;
  for (let l = 1; l < lvl; l++) rest -= xpToNext(l);
  const need = xpToNext(lvl);

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
      <div className="flex flex-col gap-6 lg:col-span-8">
        <section className="toon-panel grid grid-cols-2 gap-4 bg-[#161b28]/95 p-5 sm:grid-cols-4">
          <Stat label="Credits" value={fmtCr(stash.credits)} tone="text-amber-300" />
          <Stat
            label={`Wallet (${stash.market.currency})`}
            value={formatMinor(stash.balance).replace(` ${stash.market.currency}`, "")}
            tone="text-zooa-lime"
            extra={
              <Link
                href="/wallet"
                className="font-body relative text-xs text-white/55 underline-offset-4 before:absolute before:-inset-x-2 before:-inset-y-3.5 before:content-[''] hover:text-white hover:underline"
              >
                Top up
              </Link>
            }
          />
          <Stat
            label="Level"
            value={String(stash.level)}
            extra={
              <span className="mt-1 block h-2 overflow-hidden rounded-full border border-black bg-black/50" title={`${rest} / ${need} XP`}>
                <span className="block h-full bg-sky-300" style={{ width: `${Math.max(0, Math.min(100, (rest / need) * 100))}%` }} />
              </span>
            }
          />
          <Stat label="Raids" value={String(stash.matchesPlayed)} />
        </section>

        {!stash.starterClaimed && (
          <section className="toon-panel relative overflow-hidden bg-zooa-lime p-5 text-black">
            <div className="flex flex-wrap items-center gap-4">
              <div className="flex -space-x-3">
                {["rifle", "armor_1", "backpack_1"].map((def) => (
                  <span key={def} className="grid h-14 w-14 place-items-center rounded-2xl border-[3px] border-black bg-white shadow-[0_3px_0_#000]">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={describeItem({ def }).icon} alt="" className="h-10 w-10 object-contain" draggable={false} />
                  </span>
                ))}
              </div>
              <div className="min-w-0 flex-1">
                <h2 className="text-2xl tracking-wide">Claim your starter kit</h2>
                <p className="font-body text-sm">
                  A weapon, armor, a backpack, ammo, meds and {fmtCr(GIVEAWAY_KIT.cr)}. Free kit: yours to use, not to sell. Tradable
                  kit ({formatMinor(GIVEAWAY.KIT_PRICE_MINOR)}, while the giveaway lasts): the same gear, sellable on the market
                  after you extract with it. One kit per account.
                </p>
              </div>
              <div className="flex w-full flex-wrap gap-3">
                <button type="button" onClick={() => claim(false)} disabled={claiming !== null} className="toon-btn-ghost min-h-12 px-6 text-lg">
                  <span className="optical-center">{claiming === "free" ? "Claiming…" : "Free kit"}</span>
                </button>
                <button type="button" onClick={() => claim(true)} disabled={claiming !== null} className="toon-btn-ghost min-h-12 px-6 text-lg">
                  <span className="optical-center">
                    {claiming === "paid" ? "Buying…" : `Tradable · ${formatMinor(GIVEAWAY.KIT_PRICE_MINOR)}`}
                  </span>
                </button>
              </div>
            </div>
          </section>
        )}
        {note && (
          <p role="status" className={note.ok ? "font-body -mt-2 text-sm text-zooa-lime" : "font-body -mt-2 text-sm text-rose-300"}>
            {note.text}
          </p>
        )}

        <section className="toon-panel bg-[#161b28]/95 p-5">
          <header className="flex items-baseline justify-between">
            <h2 className="toon-text-thin text-2xl tracking-wide text-white">Stash</h2>
            <p className="font-body text-xs text-white/55">
              {/* Every tile the grid shows: the uniques plus one per ammo/med stack. */}
              {stash.uniques.length + Object.keys(stash.stacks).length}{" "}
              {stash.uniques.length + Object.keys(stash.stacks).length === 1 ? "item" : "items"}
            </p>
          </header>
          <div className="mt-4">
            <StashList
              uniques={stash.uniques}
              stacks={stash.stacks}
              selectedId={selectedId}
              onPickUnique={(u) => setSelectedId(u.id === selectedId ? null : u.id)}
              emptyHint="Your stash is empty. Claim the starter kit, buy gear on the Market, or extract with loot."
            />
          </div>
        </section>
      </div>

      <div className="flex flex-col gap-6 lg:col-span-4">
        <ItemDrawer
          item={selected}
          stash={stash}
          onSell={(u) => setSelling(u)}
        />
        <section className="toon-panel flex items-center gap-4 bg-[#161b28]/95 p-5">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/sprites/ammo.png" alt="" className="h-12 w-12 shrink-0 object-contain" draggable={false} />
          <div className="min-w-0">
            <h2 className="toon-text-thin text-xl tracking-wide text-white">Need ammo or meds?</h2>
            <Link
              href={panelHref({ panel: "shop", tab: "traders" })}
              className="font-body mt-1 inline-flex min-h-11 items-center text-sm font-semibold text-zooa-lime underline-offset-4 hover:underline"
            >
              Buy them for CR in Shop · Traders →
            </Link>
          </div>
        </section>
      </div>

      {selling && (
        <ListDialog
          item={selling}
          market={stash.market}
          credits={stash.credits}
          onClose={() => setSelling(null)}
          onListed={async () => {
            setSelling(null);
            setNote({ ok: true, text: "Listed. Manage your lots in the Market tab." });
            await res.reload();
          }}
        />
      )}
    </div>
  );
}

function Stat({ label, value, tone = "text-white", extra }: { label: string; value: string; tone?: string; extra?: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <p className="text-[0.65rem] uppercase tracking-[0.2em] text-white/50">{label}</p>
      <p className={`toon-text-thin mt-1.5 truncate text-2xl tabular-nums tracking-wide ${tone}`}>{value}</p>
      {extra && <div className="mt-1.5">{extra}</div>}
    </div>
  );
}

/** Why a unique cannot be listed right now, or null when it can. */
export function sellBlocker(u: StashItemDto, level: number, unlockLevel: number): string | null {
  if (u.state === "listed") return "Already listed — manage it in the Market tab.";
  if (u.state === "in_raid") return "Locked in your loadout or a raid.";
  if (u.bound) return "Trader-bound items can't be sold.";
  if (u.dur <= 0) return "Worn out — can't be sold.";
  if (u.lockRaids > 0) return `Starter-kit lock: extract with it ${u.lockRaids} more ${u.lockRaids === 1 ? "time" : "times"} to unlock trading.`;
  if (level < unlockLevel) return `Selling unlocks at level ${unlockLevel}.`;
  return null;
}

function ItemDrawer({ item, stash, onSell }: { item: StashItemDto | null; stash: StashResponse; onSell: (u: StashItemDto) => void }) {
  if (!item) {
    return (
      <section className="toon-panel bg-[#161b28]/95 p-5">
        <h2 className="toon-text-thin text-2xl tracking-wide text-white">Item</h2>
        <p className="font-body mt-3 text-sm text-white/55">Pick an item in your stash to see details or put it up for sale.</p>
      </section>
    );
  }
  const d = describeItem({ def: item.def, rarity: item.rarity });
  const def = itemDef(item.def);
  const blocker = sellBlocker(item, stash.level, stash.market.sellUnlockLevel);
  const b = uniqueBadge(item);
  return (
    <section className="toon-panel bg-[#161b28]/95 p-5">
      <div className="flex items-center gap-4">
        <ItemCard def={item.def} rarity={item.rarity} dur={item.dur} size="lg" badge={b?.text} badgeTone={b?.tone} />
        <div className="min-w-0">
          <h2 className="toon-text-thin truncate text-2xl tracking-wide text-white">{d.name}</h2>
          <p className="text-xs uppercase tracking-wider" style={{ color: d.color }}>
            {d.rarityName} {def?.cat}
          </p>
        </div>
      </div>
      <dl className="font-body mt-4 grid grid-cols-2 gap-y-1.5 text-sm">
        <dt className="text-white/55">Durability</dt>
        <dd className="text-right tabular-nums text-white">
          {Math.round(item.dur)}% <span className="text-white/40">/ {Math.round(item.maxDur)}</span>
        </dd>
        <dt className="text-white/55">Origin</dt>
        <dd className="text-right capitalize text-white">{item.origin}</dd>
        {item.lockRaids > 0 && (
          <>
            <dt className="text-white/55">Trade lock</dt>
            <dd className="text-right tabular-nums text-white">{item.lockRaids} raids</dd>
          </>
        )}
      </dl>
      <div className="mt-5 flex flex-col gap-2">
        <button type="button" onClick={() => onSell(item)} disabled={blocker !== null} className="toon-btn min-h-12 text-lg">
          <span className="optical-center">Sell on market</span>
        </button>
        {blocker && <p className="font-body text-sm text-white/60">{blocker}</p>}
        {item.state === "in_stash" && (
          <Link href={panelHref({ panel: "inventory", tab: "loadout" })} className="toon-btn-ghost min-h-11 text-sm">
            <span className="optical-center">Equip in loadout</span>
          </Link>
        )}
      </div>
    </section>
  );
}
