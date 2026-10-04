"use client";

import { EQUIP_KEYS, FREE_KIT, itemDef, type LoadoutEntry } from "@extract/shared";
import clsx from "clsx";
import { draftFromLocked, pruneDraft } from "@/lib/lobby/loadout-model";
import type { StashResponse } from "@/lib/lobby/api-types";
import { describeItem } from "@/lib/items-ui";

const SLOT_LABEL: Record<string, string> = { w1: "Weapon 1", w2: "Weapon 2", armor: "Armor", bp: "Backpack" };

/** What PLAY would lock: the locked loadout, else the saved draft pruned against the stash. */
export function loadoutOf(s: StashResponse | null): LoadoutEntry[] {
  if (!s) return [];
  return s.active ? draftFromLocked(s.active.entries) : pruneDraft(s.draft ?? [], s);
}

/** Uniques PLAY puts at risk. */
export function atRiskOf(entries: readonly LoadoutEntry[]): number {
  return entries.filter((e) => e.itemId).length;
}

const SLOT = "relative grid h-16 w-16 shrink-0 place-items-center rounded-xl border-[3px] border-black shadow-[inset_0_2px_0_rgba(255,255,255,0.25),0_3px_0_#000] short:h-[3.4rem] short:w-[3.4rem]";

/** One square of the gear plate: the sprite on its rarity colour, a count and a durability bar. */
function Slot({ def, rarity, dur, qty, label }: { def: string; rarity?: number; dur?: number; qty?: number; label?: string }) {
  const d = describeItem({ def, rarity });
  const durPct = dur === undefined ? null : Math.max(0, Math.min(100, dur));
  return (
    <span className={SLOT} style={{ background: `radial-gradient(circle at 50% 35%, ${d.color}ee, ${d.color}66 75%)` }} title={label ?? d.name}>
      {/* eslint-disable-next-line @next/next/no-img-element -- tiny static sprites */}
      <img src={d.icon} alt="" draggable={false} className="pointer-events-none h-[72%] w-[72%] select-none object-contain drop-shadow-[0_2px_0_rgba(0,0,0,0.55)]" />
      {qty !== undefined && qty > 1 && (
        <span className="menu-label absolute -bottom-1.5 -right-1 text-base leading-none tabular-nums text-white [text-shadow:none]">
          <span className="optical-center">×{qty}</span>
        </span>
      )}
      {durPct !== null && (
        <span className="absolute inset-x-1.5 bottom-1 h-1.5 overflow-hidden rounded-full border border-black bg-black/60">
          <span className={clsx("block h-full", durPct < 25 ? "bg-rose-400" : durPct < 60 ? "bg-amber-300" : "bg-zooa-lime")} style={{ width: `${durPct}%` }} />
        </span>
      )}
    </span>
  );
}

function EmptySquare({ label }: { label: string }) {
  return (
    <span className={clsx(SLOT, "border-dashed border-white/30 bg-black/35 shadow-none")}>
      <span className="font-body px-1 text-center text-[0.6rem] font-bold uppercase leading-tight tracking-wider text-white/45">{label}</span>
    </span>
  );
}

const PLATE = "menu-chip flex items-center gap-2 bg-[#141a29]/90 p-2 short:gap-1.5 short:p-1.5";

/** Pencil "EDIT" button closing the plate (opens Inventory · Loadout). */
function EditButton({ onClick, label = "Edit" }: { onClick: () => void; label?: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={`${label} loadout`}
      className="menu-chip h-16 flex-col justify-center gap-0.5 bg-[linear-gradient(180deg,#f0ff7a,#ccff00_55%,#a6d400)] px-3 text-black focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-white/70 short:h-[3.4rem] short:px-2.5"
    >
      <svg viewBox="0 0 24 24" className="h-6 w-6 short:h-5 short:w-5" aria-hidden>
        <path d="M4 20l1.2-4.8L15.6 4.8a2 2 0 0 1 2.8 0l.8.8a2 2 0 0 1 0 2.8L8.8 18.8z" fill="#fff" stroke="#000" strokeWidth="2.4" strokeLinejoin="round" />
        <path d="M13.5 7l3.5 3.5" stroke="#000" strokeWidth="2.2" />
      </svg>
      <span className="text-sm leading-none tracking-wide short:text-xs">
        <span className="optical-center">{label}</span>
      </span>
      <span className="toon-key absolute -right-2 -top-2 h-5 min-w-5 text-[0.6rem] [@media(hover:none)]:hidden" aria-hidden>
        I
      </span>
    </button>
  );
}

/**
 * Gear plate under the hero (Brawl Stars layout): what PLAY would lock as a row of chunky squares —
 * the four equipment slots, then meds / ammo / grenades as counted squares — and a lime EDIT that
 * opens Inventory · Loadout. Guests and empty loadouts show the free kit with a FREE KIT tab.
 * Registered users without the starter kit get a "Claim free kit" button that opens the stash (where
 * the free and the tradable kit are offered).
 */
export function GearStrip({
  stash,
  stashError,
  guest,
  signedIn,
  onEdit,
  onStarter,
  onRetry,
}: {
  stash: StashResponse | null;
  stashError: string | null;
  guest: boolean;
  signedIn: boolean;
  onEdit: () => void;
  onStarter: () => void;
  onRetry: () => void;
}) {
  if (signedIn && !guest && !stash) {
    if (stashError) {
      return (
        <div className={clsx(PLATE, "font-body px-4 text-sm font-semibold text-white/80")}>
          Couldn&apos;t load your stash.
          <button type="button" onClick={onRetry} className="menu-chip h-10 bg-white px-4 text-sm text-black">
            <span className="optical-center">Retry</span>
          </button>
        </div>
      );
    }
    return (
      <ul className={PLATE} aria-busy="true" aria-label="Loading your loadout">
        {EQUIP_KEYS.map((k) => (
          <li key={k} className={clsx(SLOT, "animate-pulse border-black/60 bg-white/10 shadow-none motion-reduce:animate-none")} />
        ))}
      </ul>
    );
  }

  const entries = guest || !signedIn ? [] : loadoutOf(stash);
  if (entries.length === 0) {
    const claim = signedIn && !guest && stash && !stash.starterClaimed;
    return (
      <div className="flex items-end gap-3 short:gap-2">
        <div className="relative">
          <span className="menu-label absolute -top-3 left-3 z-10 rounded-lg border-[3px] border-black bg-sky-400 px-2 py-0.5 text-[0.7rem] leading-none tracking-wider text-white [text-shadow:none] short:-top-2.5">
            <span className="optical-center">FREE KIT</span>
          </span>
          <ul className={PLATE} aria-label={`You drop with the free kit: pistol (never lost), ${FREE_KIT.AMMO_LIGHT} light ammo, ${FREE_KIT.BANDAGES} bandage`}>
            <li><Slot def="pistol" label="Pistol — free, never lost" /></li>
            <li><Slot def="ammo_light" qty={FREE_KIT.AMMO_LIGHT} label={`${FREE_KIT.AMMO_LIGHT} light ammo`} /></li>
            <li><Slot def="bandage" qty={FREE_KIT.BANDAGES} label={`${FREE_KIT.BANDAGES} bandage · +25 HP`} /></li>
            {signedIn && !guest && stash?.starterClaimed && (
              <li>
                <EditButton onClick={onEdit} label="Set up" />
              </li>
            )}
          </ul>
        </div>
        {claim && (
          <button
            type="button"
            onClick={onStarter}
            className="menu-chip h-[4.6rem] max-w-[8.5rem] flex-col justify-center bg-[linear-gradient(180deg,#fff27a,#ffd91f_45%,#ffb800)] px-3 text-center text-black focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-white/70 short:h-[4rem] short:max-w-[7.5rem]"
          >
            <span className="text-base leading-none tracking-wide short:text-sm">
              <span className="optical-center">Claim kit</span>
            </span>
            <span className="font-body mt-1 text-[0.7rem] font-bold leading-tight text-black/70">Free starter kit</span>
            <span className="absolute -right-2 -top-2 h-5 w-5 rounded-full border-[3px] border-black bg-rose-500" aria-hidden />
          </button>
        )}
      </div>
    );
  }

  const byKey = new Map(entries.map((e) => [e.key as string, e]));
  const supplies = entries.filter((e) => !e.itemId);
  const sum = (cat: string) => supplies.filter((e) => itemDef(e.def)?.cat === cat);
  const group = (cat: string) => {
    const list = sum(cat);
    return list.length ? { def: list[0]!.def, qty: list.reduce((n, e) => n + e.qty, 0) } : null;
  };
  const meds = group("med");
  const ammo = group("ammo");
  const nades = group("throwable");
  const locked = stash?.active?.status === "locked";

  return (
    <div className="relative">
      {locked && (
        <span className="menu-label absolute -top-3 left-3 z-10 rounded-lg border-[3px] border-black bg-amber-300 px-2 py-0.5 text-[0.7rem] leading-none tracking-wider text-black [text-shadow:none] [-webkit-text-stroke:0] short:-top-2.5">
          <span className="optical-center">LOCKED</span>
        </span>
      )}
      <ul className={PLATE} aria-label="Your loadout">
        {EQUIP_KEYS.map((k) => {
          const e = byKey.get(k);
          const u = e?.itemId ? stash?.uniques.find((x) => x.id === e.itemId) : undefined;
          return (
            <li key={k}>
              <button type="button" onClick={onEdit} className="block rounded-xl focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-zooa-lime/70" aria-label={e ? `${itemDef(e.def)?.name ?? e.def} — edit loadout` : `${SLOT_LABEL[k]}: empty — edit loadout`}>
                {e ? <Slot def={e.def} rarity={u?.rarity} dur={u?.dur} /> : <EmptySquare label={SLOT_LABEL[k] ?? k} />}
              </button>
            </li>
          );
        })}
        {[meds && { ...meds, n: meds.qty === 1 ? "med" : "meds" }, ammo && { ...ammo, n: "ammo" }, nades && { ...nades, n: nades.qty === 1 ? "grenade" : "grenades" }]
          .filter((x): x is { def: string; qty: number; n: string } => Boolean(x))
          .map((x) => (
            <li key={x.n} className="max-md:hidden short:hidden">
              <Slot def={x.def} qty={x.qty} label={`${x.qty} ${x.n}`} />
            </li>
          ))}
        <li>
          <EditButton onClick={onEdit} />
        </li>
      </ul>
    </div>
  );
}
