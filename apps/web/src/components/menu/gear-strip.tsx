"use client";

import { EQUIP_KEYS, FREE_KIT, itemDef, type LoadoutEntry } from "@extract/shared";
import clsx from "clsx";
import { draftFromLocked, pruneDraft } from "@/lib/lobby/loadout-model";
import type { StashResponse } from "@/lib/lobby/api-types";
import { EmptySlot, ItemCard } from "@/components/lobby/item-card";

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

function KitTile({ icon, label, note }: { icon: string; label: string; note: string }) {
  return (
    <li className="flex items-center gap-2.5 rounded-2xl border-[3px] border-black bg-[#161b28]/90 py-1.5 pl-1.5 pr-3 shadow-[0_3px_0_#000]">
      <span className="grid h-11 w-11 place-items-center rounded-xl border-2 border-black bg-zinc-300/80">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={icon} alt="" className="h-9 w-9 object-contain" draggable={false} />
      </span>
      <span className="min-w-0">
        <span className="block text-sm tracking-wide text-white">{label}</span>
        <span className="font-body mt-0.5 block text-xs text-white/65">{note}</span>
      </span>
    </li>
  );
}

/**
 * Gear strip under the hero (WORLD v6 spec §6.6): the four equipment slots of what PLAY would lock,
 * then meds / ammo and "Edit [I]"; any tile opens Inventory · Loadout. Guests and empty loadouts
 * show the free kit. Registered users without the starter kit get a pointer to it.
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
        <div className="font-body flex items-center justify-center gap-3 text-sm text-white/75">
          Couldn&apos;t load your stash.
          <button type="button" onClick={onRetry} className="toon-btn-ghost min-h-10 px-4 text-sm">
            <span className="optical-center">Retry</span>
          </button>
        </div>
      );
    }
    return (
      <ul className="flex justify-center gap-2" aria-busy="true" aria-label="Loading your loadout">
        {EQUIP_KEYS.map((k) => (
          <li key={k} className="h-16 w-16 animate-pulse rounded-xl border-[3px] border-black/60 bg-white/10 motion-reduce:animate-none" />
        ))}
      </ul>
    );
  }

  const entries = guest || !signedIn ? [] : loadoutOf(stash);
  if (entries.length === 0) {
    return (
      <div className="flex flex-col items-center gap-2">
        <ul className="flex flex-wrap justify-center gap-2" aria-label="You drop with the free kit">
          <KitTile icon="/sprites/pistol.png" label="Pistol" note="Free — never lost" />
          <KitTile icon="/sprites/ammo.png" label={`${FREE_KIT.AMMO_LIGHT} light ammo`} note="Pick up more" />
          <KitTile icon="/sprites/bandage.png" label={`${FREE_KIT.BANDAGES} bandage`} note="+25 HP" />
        </ul>
        {signedIn && !guest && stash && (
          <p className="font-body text-sm text-white/75">
            {stash.starterClaimed ? (
              <button type="button" onClick={onEdit} className="min-h-9 rounded-lg px-1 font-semibold text-zooa-lime underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zooa-lime">
                Set up your loadout
              </button>
            ) : (
              <button type="button" onClick={onStarter} className="min-h-9 rounded-lg px-1 font-semibold text-zooa-lime underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zooa-lime">
                Free starter kit waiting — claim it
              </button>
            )}
          </p>
        )}
      </div>
    );
  }

  const byKey = new Map(entries.map((e) => [e.key as string, e]));
  const supplies = entries.filter((e) => !e.itemId);
  const meds = supplies.filter((e) => itemDef(e.def)?.cat === "med").reduce((n, e) => n + e.qty, 0);
  const ammo = supplies.filter((e) => itemDef(e.def)?.cat === "ammo").reduce((n, e) => n + e.qty, 0);
  const locked = stash?.active?.status === "locked";

  return (
    <div className="flex flex-wrap items-center justify-center gap-x-3 gap-y-2">
      <ul className="flex items-end gap-2" aria-label="Your loadout">
        {EQUIP_KEYS.map((k) => {
          const e = byKey.get(k);
          const u = e?.itemId ? stash?.uniques.find((x) => x.id === e.itemId) : undefined;
          return (
            <li key={k}>
              {e ? (
                <ItemCard def={e.def} rarity={u?.rarity} dur={u?.dur} size="md" onClick={onEdit} title={`${itemDef(e.def)?.name ?? e.def} — edit loadout`} />
              ) : (
                <button type="button" onClick={onEdit} className="rounded-xl focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-zooa-lime/70" aria-label={`${SLOT_LABEL[k]}: empty — edit loadout`}>
                  <EmptySlot label={SLOT_LABEL[k] ?? k} size="md" />
                </button>
              )}
            </li>
          );
        })}
      </ul>
      <p className="font-body flex items-center gap-2 text-sm font-semibold text-white/80">
        {meds > 0 && <span>{meds} {meds === 1 ? "med" : "meds"}</span>}
        {ammo > 0 && <span>· {ammo} ammo</span>}
        {locked && <span className="rounded-md border-2 border-black bg-amber-300 px-1.5 text-xs text-black">Locked</span>}
        <button
          type="button"
          onClick={onEdit}
          className={clsx(
            "inline-flex min-h-9 items-center gap-1.5 rounded-lg px-1.5 text-zooa-lime underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zooa-lime",
          )}
        >
          Edit
          <span className="toon-key h-5 min-w-5 text-[0.6rem] [@media(hover:none)]:hidden" aria-hidden>
            I
          </span>
        </button>
      </p>
    </div>
  );
}
