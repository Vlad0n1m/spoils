"use client";

import { useMemo, useState } from "react";
import clsx from "clsx";
import { itemDef, type ItemCat } from "@extract/shared";
import type { StashItemDto } from "@/lib/lobby/api-types";
import { ItemCard } from "./item-card";
import { PagedTiles, useShortScreen } from "@/components/paged";

export type StashFilter = "all" | Exclude<ItemCat, "junk">;
const FILTERS: Array<{ id: StashFilter; label: string }> = [
  { id: "all", label: "All" },
  { id: "weapon", label: "Weapons" },
  { id: "armor", label: "Armor" },
  { id: "backpack", label: "Packs" },
  { id: "ammo", label: "Ammo" },
  { id: "med", label: "Meds" },
  { id: "throwable", label: "Grenades" },
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
 * auto-place) and the Stash tab (click = select for selling). Fills the free height with as many
 * rows of tiles as fit and pages them (‹ ›, swipe) instead of scrolling; a new filter starts on
 * page one.
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
  // Landscape phones: the small tiles without names, so two or three rows fit the height.
  const shortScreen = useShortScreen();
  const small = compact || shortScreen;
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
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Landscape phones: one compact picker instead of two or three rows of chips, so the grid keeps the height. */}
      <label className="hidden shrink-0 short:block">
        <span className="sr-only">Stash filter</span>
        <select
          value={filter}
          onChange={(e) => setFilter(e.target.value as StashFilter)}
          className="font-body min-h-9 rounded-full border-2 border-black bg-zooa-lime px-3 text-sm font-bold text-black shadow-[0_2px_0_#000]"
        >
          {FILTERS.map((f) => (
            <option key={f.id} value={f.id}>
              {f.label}
            </option>
          ))}
        </select>
      </label>
      <div className="flex shrink-0 flex-wrap gap-1.5 short:hidden" role="tablist" aria-label="Stash filter">
        {FILTERS.map((f) => (
          <button
            key={f.id}
            type="button"
            role="tab"
            aria-selected={filter === f.id}
            onClick={() => setFilter(f.id)}
            className={clsx(
              // Touch: 44 px tall chips.
              "rounded-full border-2 border-black px-3 py-1.5 text-xs lg:text-[0.8125rem] tracking-wide transition [@media(pointer:coarse)]:min-h-11 [@media(pointer:coarse)]:px-4",
              filter === f.id ? "bg-zooa-lime text-black shadow-[0_2px_0_#000]" : "bg-black/30 text-white/75 hover:text-white",
            )}
          >
            {f.label}
          </button>
        ))}
      </div>
      {empty ? (
        <div className="font-body mt-5 shrink-0 rounded-2xl border-2 border-dashed border-white/15 p-5 text-center text-sm text-white/70">
          {emptyHint ?? "Nothing here yet."}
        </div>
      ) : (
        <PagedTiles className="mt-3 short:mt-2" gap={small ? 6 : 10} resetKey={filter} label="Stash pages">
          {shownUniques.map((u) => {
            const b = uniqueBadge(u);
            return (
              <li key={u.id} className={clsx("flex justify-center pt-1", small ? "w-14" : "w-[5.5rem]")}>
                <ItemCard
                  def={u.def}
                  rarity={u.rarity}
                  dur={u.dur}
                  size={small ? "sm" : "md"}
                  badge={b?.text}
                  badgeTone={b?.tone}
                  dim={u.state === "in_raid" || u.dur <= 0}
                  selected={selectedId === u.id}
                  showName={!small}
                  onClick={onPickUnique ? () => onPickUnique(u) : undefined}
                />
              </li>
            );
          })}
          {shownStacks.map(([def, qty]) => (
            <li key={def} className={clsx("flex justify-center pt-1", small ? "w-14" : "w-[5.5rem]")}>
              <ItemCard
                def={def}
                qty={qty}
                size={small ? "sm" : "md"}
                dim={qty <= 0}
                showName={!small}
                title={`${itemDef(def)?.name ?? def} × ${qty}`}
                onClick={onPickStack && qty > 0 ? () => onPickStack(def) : undefined}
              />
            </li>
          ))}
        </PagedTiles>
      )}
    </div>
  );
}
