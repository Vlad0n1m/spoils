"use client";

import { useState } from "react";
import Link from "next/link";
import { STARTER_KIT, itemDef, levelForXp, xpToNext } from "@extract/shared";
import type { StashItemDto, StashResponse } from "@/lib/lobby/api-types";
import { describeItem, fmtCr } from "@/lib/items-ui";
import { MARKET_CURRENCY, formatMinor } from "@/lib/market/config";
import { ItemCard } from "./item-card";
import { StashList, uniqueBadge } from "./stash-list";
import { panelHref } from "@/lib/lobby/panels";
import { ListDialog } from "./list-dialog";
import { api, type Resource } from "./use-lobby";
import { Paged } from "@/components/paged";
import { EDITION_UI } from "@/lib/edition";
import type { StashMoneyDto } from "@/lib/lobby/api-types";
import { hasStashMoney } from "@/lib/lobby/stash-response";

/**
 * Stash tab (inventory memo "stash-page"): wallet (CR + market balance), level, the paid starter
 * kit (design §19), every unique with rarity / durability / state, ammo and med stacks, an item drawer with
 * the Sell action. The junker moved to Shop · Traders (WORLD v6); a link points there.
 */
export function StashPage({ res }: { res: Resource<StashResponse> }) {
  const stash = res.data!;
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selling, setSelling] = useState<StashItemDto | null>(null);
  const [buying, setBuying] = useState(false);
  const [note, setNote] = useState<{ text: string; ok: boolean } | null>(null);
  const selected = stash.uniques.find((u) => u.id === selectedId) ?? null;
  // Wallet, market rules and the kit offer: main build only (the iDos edition's /api/stash omits them).
  const money = hasStashMoney(stash) ? stash : null;

  const buyKit = async () => {
    setBuying(true);
    setNote(null);
    try {
      await api("/api/stash/starter", { method: "POST", body: {} });
      await res.reload();
      setNote({
        ok: true,
        text: "Starter kit added to your stash. Equip it in the Loadout tab. Its gear can be sold once you've extracted with it.",
      });
    } catch (e) {
      setNote({ ok: false, text: e instanceof Error ? e.message : "Purchase failed" });
    } finally {
      setBuying(false);
    }
  };

  // xp is cumulative; show progress inside the current level.
  const lvl = levelForXp(stash.xp);
  let rest = stash.xp;
  for (let l = 1; l < lvl; l++) rest -= xpToNext(l);
  const need = xpToNext(lvl);

  return (
    // Landscape: the stash grid (paged) on the left; on the right your numbers and the starter kit,
    // or the picked item. Nothing scrolls.
    <div className="flex min-h-0 flex-1 flex-col gap-3 land:grid land:grid-cols-[minmax(0,1.9fr)_minmax(15rem,1fr)] land:grid-rows-[minmax(0,1fr)] land:gap-4 short:!gap-2">
      <section className="toon-panel flex min-h-0 flex-1 flex-col bg-[#161b28]/95 p-5 short:p-3">
        <header className="flex shrink-0 items-baseline justify-between gap-3">
          <h2 className="toon-text-thin text-2xl tracking-wide text-white short:text-xl">Stash</h2>
          <p className="font-body text-xs lg:text-[0.8125rem] text-white/70">
            {/* Every tile the grid shows: the uniques plus one per ammo/med stack. */}
            {stash.uniques.length + Object.keys(stash.stacks).length}{" "}
            {stash.uniques.length + Object.keys(stash.stacks).length === 1 ? "item" : "items"}
          </p>
        </header>
        <div className="mt-3 flex min-h-0 flex-1 flex-col short:mt-2">
          <StashList
            uniques={stash.uniques}
            stacks={stash.stacks}
            selectedId={selectedId}
            onPickUnique={(u) => setSelectedId(u.id === selectedId ? null : u.id)}
            emptyHint={
              EDITION_UI.market
                ? "Your stash is empty. Buy a starter kit, buy gear on the Market, or extract with loot."
                : "Your stash is empty. Buy gear from the traders or extract with loot."
            }
          />
        </div>
      </section>

      <div className="flex min-h-0 flex-col gap-3 port:max-h-[50%] short:gap-2">
        {selected ? (
          <ItemDrawer item={selected} stash={stash} onSell={(u) => setSelling(u)} onClose={() => setSelectedId(null)} />
        ) : (
          <Paged gap={10} label="Stash summary pages">
            <section className="toon-panel grid grid-cols-2 gap-x-4 gap-y-3 bg-[#161b28]/95 p-4 short:gap-y-2 short:p-3">
              <Stat label="Credits" value={fmtCr(stash.credits)} tone="text-amber-300" />
              {EDITION_UI.walletBalance && money && (
              <Stat
                label={`Wallet (${MARKET_CURRENCY.code})`}
                value={formatMinor(money.balance).replace(` ${MARKET_CURRENCY.code}`, "")}
                tone="text-zooa-lime"
                extra={
                  <Link
                    href="/wallet"
                    className="font-body relative text-xs lg:text-[0.8125rem] text-white/70 underline-offset-4 before:absolute before:-inset-x-2 before:-inset-y-3.5 before:content-[''] hover:text-white hover:underline"
                  >
                    Top up
                  </Link>
                }
              />
              )}
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
            {EDITION_UI.starterKitSale && money && <StarterKitCard stash={money} buying={buying} onBuy={buyKit} />}
            {note && (
              <p role="status" className={note.ok ? "font-body text-sm text-zooa-lime" : "font-body text-sm text-rose-300"}>
                {note.text}
              </p>
            )}
            <p className="font-body text-sm text-white/70">
              {EDITION_UI.market ? "Pick an item to see details or put it up for sale." : "Pick an item to see its details."}
            </p>
            <section className="toon-panel flex items-center gap-3 bg-[#161b28]/95 px-4 py-2 short:px-3">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src="/sprites/ammo.png" alt="" className="h-10 w-10 shrink-0 object-contain" draggable={false} />
              <div className="min-w-0">
                <h2 className="text-base tracking-wide text-white">Need ammo or meds?</h2>
                <Link
                  href={panelHref({ panel: "shop", tab: "traders" })}
                  className="font-body inline-flex min-h-11 items-center text-sm font-semibold text-zooa-lime underline-offset-4 hover:underline"
                >
                  Shop · Traders →
                </Link>
              </div>
            </section>
          </Paged>
        )}
      </div>

      {EDITION_UI.market && money && selling && (
        <ListDialog
          item={selling}
          market={money.market}
          credits={stash.credits}
          onClose={() => setSelling(null)}
          onListed={async () => {
            setSelling(null);
            setNote({ ok: true, text: "Listed. Manage your listings in Shop · Market." });
            await res.reload();
          }}
        />
      )}
    </div>
  );
}

const KIT_ICONS = ["pistol", "armor_1", "ammo_light", "bandage", "medkit"] as const;
const KIT_TEXT = (() => {
  const n = STARTER_KIT.weapons.length;
  const qty = (def: string) => STARTER_KIT.stacks.find((x) => x.def === def)?.qty ?? 0;
  return `${n} pistols, armor (Lv 1, sometimes Lv 2), ${qty("ammo_light")} light ammo, ${qty("bandage")} bandages and a medkit.`;
})();

/**
 * The paid starter kit (design §19): always for sale, up to STARTER_KIT.DAILY_MAX a day. A big lime-edged card
 * while the stash holds no weapon, else a slim row; disabled when paused, at the daily cap or short of money.
 */
function StarterKitCard({ stash, buying, onBuy }: { stash: StashResponse & StashMoneyDto; buying: boolean; onBuy: () => void }) {
  const price = formatMinor(stash.kit.priceMinor);
  const left = Math.max(0, stash.kit.dailyMax - stash.kit.boughtToday);
  const short = BigInt(stash.balance) < BigInt(stash.kit.priceMinor);
  const blocked = stash.kit.paused ? "Sales are paused for a moment." : left === 0 ? "Daily limit reached — back tomorrow." : null;
  const noWeapon = !stash.uniques.some((u) => u.state !== "listed" && itemDef(u.def)?.cat === "weapon");
  const button = (
    <button type="button" onClick={onBuy} disabled={buying || blocked !== null} className="toon-btn-ghost min-h-12 w-full px-4 text-base short:min-h-11">
      <span className="optical-center">{buying ? "Buying…" : `Buy starter kit · ${price}`}</span>
    </button>
  );
  const status = blocked ?? (short ? (
    <>
      Not enough in your wallet.{" "}
      <Link href="/wallet" className="font-semibold text-zooa-lime underline underline-offset-4">
        Top up
      </Link>
    </>
  ) : `${left} of ${stash.kit.dailyMax} left today.`);
  if (!noWeapon) {
    return (
      <section className="toon-panel flex flex-col gap-3 bg-[#161b28]/95 p-4 short:gap-2 short:p-3">
        <div className="min-w-0 flex-1">
          <h2 className="toon-text-thin text-xl tracking-wide text-white">Starter kit</h2>
          <p className="font-body mt-1 text-sm text-white/85">{KIT_TEXT} <span className="text-white/75">{status}</span></p>
        </div>
        {button}
      </section>
    );
  }
  return (
    <section className="toon-panel relative overflow-hidden border-zooa-lime bg-[#161b28]/95 p-4 text-white short:p-3">
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex -space-x-3">
          {KIT_ICONS.map((def) => (
            <span key={def} className="grid h-12 w-12 place-items-center rounded-2xl border-[3px] border-black bg-white shadow-[0_3px_0_#000] short:h-10 short:w-10">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={describeItem({ def }).icon} alt="" className="h-8 w-8 object-contain short:h-7 short:w-7" draggable={false} />
            </span>
          ))}
        </div>
        <div className="min-w-0 flex-1">
          <h2 className="toon-text-thin text-2xl tracking-wide text-zooa-lime short:text-xl">Starter kit</h2>
          <p className="font-body text-sm leading-snug text-white/90 short:text-xs">
            {KIT_TEXT} Lost on death like any gear; sellable on the market once you&apos;ve extracted with it. No kit? You
            still drop with the basic gear.
          </p>
        </div>
        <div className="flex w-full flex-wrap items-center gap-3">
          {button}
          <p className="font-body text-sm text-white/80">{status}</p>
        </div>
      </div>
    </section>
  );
}

function Stat({ label, value, tone = "text-white", extra }: { label: string; value: string; tone?: string; extra?: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <p className="text-xs lg:text-[0.8125rem] uppercase tracking-[0.12em] text-white/70">{label}</p>
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

function ItemDrawer({ item, stash, onSell, onClose }: { item: StashItemDto; stash: StashResponse; onSell: (u: StashItemDto) => void; onClose: () => void }) {
  const d = describeItem({ def: item.def, rarity: item.rarity });
  const def = itemDef(item.def);
  const market = EDITION_UI.market ? stash.market : undefined;
  const blocker = market ? sellBlocker(item, stash.level, market.sellUnlockLevel) : null;
  const b = uniqueBadge(item);
  return (
    <section className="toon-panel flex min-h-0 flex-col bg-[#161b28]/95 p-5 short:p-3">
      <div className="flex items-center gap-4 short:gap-3">
        <ItemCard def={item.def} rarity={item.rarity} dur={item.dur} size="lg" badge={b?.text} badgeTone={b?.tone} />
        <div className="min-w-0 flex-1">
          <h2 className="toon-text-thin truncate text-2xl tracking-wide text-white short:text-xl">{d.name}</h2>
          <p className="text-xs lg:text-[0.8125rem] uppercase tracking-wider" style={{ color: d.color }}>
            {d.rarityName} {def?.cat}
          </p>
        </div>
        <button type="button" onClick={onClose} aria-label="Close item details" className="menu-chip grid h-10 w-10 shrink-0 place-items-center bg-white text-black">
          <svg viewBox="0 0 20 20" className="h-4 w-4" aria-hidden>
            <path d="M5 5l10 10M15 5 5 15" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
          </svg>
        </button>
      </div>
      <dl className="font-body mt-4 grid grid-cols-2 gap-y-1.5 text-sm short:mt-2 short:gap-y-1">
        <dt className="text-white/70">Durability</dt>
        <dd className="text-right tabular-nums text-white">
          {Math.round(item.dur)}% <span className="text-white/70">/ {Math.round(item.maxDur)}</span>
        </dd>
        <dt className="text-white/70">Origin</dt>
        <dd className="text-right capitalize text-white">{item.origin}</dd>
        {item.lockRaids > 0 && (
          <>
            <dt className="text-white/70">Trade lock</dt>
            <dd className="text-right tabular-nums text-white">{item.lockRaids} raids</dd>
          </>
        )}
      </dl>
      <div className="mt-5 flex flex-col gap-2 short:mt-3">
        {market && (
          <>
            <button type="button" onClick={() => onSell(item)} disabled={blocker !== null} className="toon-btn min-h-12 text-lg short:min-h-11">
              <span className="optical-center">Sell on market</span>
            </button>
            {blocker && <p className="font-body text-sm text-white/75">{blocker}</p>}
          </>
        )}
        {item.state === "in_stash" && (
          <Link href={panelHref({ panel: "inventory", tab: "loadout" })} className="toon-btn-ghost min-h-11 text-sm">
            <span className="optical-center">Equip in loadout</span>
          </Link>
        )}
      </div>
    </section>
  );
}
