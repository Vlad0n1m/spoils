"use client";

import { useMemo, useState } from "react";
import clsx from "clsx";
import { itemDef, type ItemCat } from "@extract/shared";
import type { StashItemDto } from "@/lib/lobby/api-types";
import { ItemCard } from "./item-card";

export type StashFilter = "all" | Exclude<ItemCat, "junk">;
const FILTERS: Array<{ id: StashFilter; label: string }> = [
  { id: "all", label: "All" },
  { id: "weapon", label: "Weapons" },
  { id: "armor", label: "Armor" },
  { id: "backpack", label: "Packs" },
  { id: "ammo", label: "Ammo" },
  { id: "med", label: "Meds" },
];

/** Badge for a unique's state: why it can't be equipped or sold right now. */
export function uniqueBadge(u: StashItemDto): { text: string; tone: "sky" | "amber" | "rose" | "dark" } | undefined {
  if (u.state === "listed") return { text: "Listed", tone: "sky" };
  if (u.state === "in_raid") return { text: "Locked", tone: "amber" };
  if (u.dur <= 0) return { text: "Broken", tone: "rose" };
  if (u.bound) return { text: "Bound", tone: "dark" };
  if (u.lockRaids > 0) return { text: `Lock ${u.lockRaids}`, tone: "dark" };
  return undefined;
}

/**
 * Filterable stash grid (inventory memo "stash-list"): uniques with rarity, durability and state
 * badges, then ammo/med stacks with the quantity still free. Used by the Loadout board (click =
 * auto-place) and the Stash tab (click = select for selling).
 */
export function StashList({
  uniques,
  stacks,
  onPickUnique,
  onPickStack,
  selectedId,
  usedIds,
  emptyHint,
  compact = false,
}: {
  uniques: readonly StashItemDto[];
  /** def → qty available. */
  stacks: Readonly<Record<string, number>>;
  onPickUnique?: (u: StashItemDto) => void;
  onPickStack?: (def: string) => void;
  selectedId?: string | null;
  /** Uniques already placed (loadout): hidden from the list. */
  usedIds?: ReadonlySet<string>;
  emptyHint?: React.ReactNode;
  compact?: boolean;
}) {
  const [filter, setFilter] = useState<StashFilter>("all");
  const shownUniques = useMemo(
    () =>
      uniques.filter((u) => !usedIds?.has(u.id) && (filter === "all" || itemDef(u.def)?.cat === filter)),
    [uniques, usedIds, filter],
  );
  const shownStacks = useMemo(
    () =>
      Object.entries(stacks)
        .filter(([def]) => filter === "all" || itemDef(def)?.cat === filter)
        .sort(([a], [b]) => a.localeCompare(b)),
    [stacks, filter],
  );
  const empty = shownUniques.length === 0 && shownStacks.length === 0;
  return (
    <div>
      <div className="flex flex-wrap gap-1.5" role="tablist" aria-label="Stash filter">
        {FILTERS.map((f) => (
          <button
            key={f.id}
            type="button"
            role="tab"
            aria-selected={filter === f.id}
            onClick={() => setFilter(f.id)}
            className={clsx(
              "rounded-full border-2 border-black px-3 py-1.5 text-xs tracking-wide transition",
              filter === f.id ? "bg-zooa-lime text-black shadow-[0_2px_0_#000]" : "bg-black/30 text-white/75 hover:text-white",
            )}
          >
            {f.label}
          </button>
        ))}
      </div>
      {empty ? (
        <div className="font-body mt-5 rounded-2xl border-2 border-dashed border-white/15 p-5 text-center text-sm text-white/55">
          {emptyHint ?? "Nothing here yet."}
        </div>
      ) : (
        <ul className={clsx("mt-4 grid gap-x-2 gap-y-4", compact ? "grid-cols-[repeat(auto-fill,minmax(4.25rem,1fr))]" : "grid-cols-[repeat(auto-fill,minmax(5.5rem,1fr))]")}>
          {shownUniques.map((u) => {
            const b = uniqueBadge(u);
            return (
              <li key={u.id} className="flex justify-center pt-1">
                <ItemCard
                  def={u.def}
                  rarity={u.rarity}
                  dur={u.dur}
                  size={compact ? "sm" : "md"}
                  badge={b?.text}
                  badgeTone={b?.tone}
                  dim={u.state === "in_raid" || u.dur <= 0}
                  selected={selectedId === u.id}
                  showName={!compact}
                  onClick={onPickUnique ? () => onPickUnique(u) : undefined}
                />
              </li>
            );
          })}
          {shownStacks.map(([def, qty]) => (
            <li key={def} className="flex justify-center pt-1">
              <ItemCard
                def={def}
                qty={qty}
                size={compact ? "sm" : "md"}
                dim={qty <= 0}
                showName={!compact}
                title={`${itemDef(def)?.name ?? def} × ${qty}`}
                onClick={onPickStack && qty > 0 ? () => onPickStack(def) : undefined}
              />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
