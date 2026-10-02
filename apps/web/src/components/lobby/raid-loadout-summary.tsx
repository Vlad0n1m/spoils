"use client";

import Link from "next/link";
import { FREE_KIT, itemDef } from "@extract/shared";
import { draftFromLocked, pruneDraft } from "@/lib/lobby/loadout-model";
import { ItemCard } from "./item-card";
import { useStash } from "./use-lobby";

/**
 * Raid card "what you drop with": the free kit for guests and empty loadouts, otherwise the saved
 * loadout (or the one already locked). Play on the Raid tab locks exactly this.
 */
export function RaidLoadoutSummary({ isGuest }: { isGuest: boolean }) {
  const stash = useStash(!isGuest);
  const s = stash.data;
  const entries = !s ? [] : s.active ? draftFromLocked(s.active.entries) : pruneDraft(s.draft ?? [], s);
  const gear = entries.filter((e) => e.itemId);
  const supplies = entries.filter((e) => !e.itemId);

  if (isGuest || (s && entries.length === 0)) {
    return (
      <div>
        <h2 className="text-sm uppercase tracking-[0.18em] text-white/55">You drop with the free kit</h2>
        <ul className="mt-3 flex flex-wrap gap-3">
          <KitTile icon="/sprites/pistol.png" label="Pistol" note="Free — never lost" />
          <KitTile icon="/sprites/ammo.png" label={`${FREE_KIT.AMMO_LIGHT} light ammo`} note="Auto-pickup more" />
          <KitTile icon="/sprites/bandage.png" label={`${FREE_KIT.BANDAGES} bandage`} note="+25 HP" />
        </ul>
        {!isGuest && s && (
          <p className="font-body mt-3 text-sm text-white/60">
            {s.starterClaimed ? (
              <>
                Want real gear?{" "}
                <Link href="/play?tab=loadout" className="text-zooa-lime underline-offset-4 hover:underline">
                  Set up your loadout
                </Link>
                .
              </>
            ) : (
              <>
                Free starter kit waiting:{" "}
                <Link href="/play?tab=stash" className="text-zooa-lime underline-offset-4 hover:underline">
                  claim it in your Stash
                </Link>
                .
              </>
            )}
          </p>
        )}
      </div>
    );
  }
  if (!s) {
    return <div className="h-[6.5rem]" aria-busy="true" />;
  }
  return (
    <div>
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-sm uppercase tracking-[0.18em] text-white/55">
          {s.active?.status === "locked" ? "Locked loadout" : s.active?.status === "in_raid" ? "Gear in raid" : "Your loadout"}
        </h2>
        <Link href="/play?tab=loadout" className="text-sm tracking-wide text-zooa-lime underline-offset-4 hover:underline">
          Edit
        </Link>
      </div>
      <ul className="mt-3 flex flex-wrap items-end gap-2.5">
        {gear.map((e) => {
          const u = s.uniques.find((x) => x.id === e.itemId);
          return (
            <li key={e.key}>
              <ItemCard def={e.def} rarity={u?.rarity} dur={u?.dur} size="md" />
            </li>
          );
        })}
        {supplies.map((e) => (
          <li key={e.key}>
            <ItemCard def={e.def} qty={e.qty} size="sm" title={`${itemDef(e.def)?.name ?? e.def} × ${e.qty}`} />
          </li>
        ))}
      </ul>
      <p className="font-body mt-3 text-xs text-white/55">
        {gear.length} {gear.length === 1 ? "item" : "items"} at risk. Die and each has a 50% chance to break; extract to keep it all.
      </p>
    </div>
  );
}

function KitTile({ icon, label, note }: { icon: string; label: string; note: string }) {
  return (
    <li className="flex items-center gap-3 rounded-2xl border-[3px] border-black bg-white/[0.06] py-2 pl-2 pr-4 shadow-[0_3px_0_#000]">
      <span className="grid h-12 w-12 place-items-center rounded-xl border-2 border-black bg-zinc-300/80">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={icon} alt="" className="h-10 w-10 object-contain" draggable={false} />
      </span>
      <span>
        <span className="block text-sm tracking-wide text-white">{label}</span>
        <span className="font-body mt-0.5 block text-xs text-white/60">{note}</span>
      </span>
    </li>
  );
}
