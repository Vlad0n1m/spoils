"use client";

import clsx from "clsx";
import { describeItem } from "@/lib/items-ui";

/**
 * Lobby item tile: sprite in a rarity frame, durability bar (DB % — the lobby never sees raid
 * armor points), quantity badge and state ribbons. One component for stash, loadout and market so
 * an item looks the same everywhere outside the raid.
 */
export function ItemCard({
  def,
  rarity,
  dur,
  qty,
  size = "md",
  badge,
  badgeTone = "dark",
  dim = false,
  selected = false,
  onClick,
  title,
  showName = false,
}: {
  def: string;
  rarity?: number;
  /** 0..100 %, uniques only. */
  dur?: number;
  qty?: number;
  size?: "sm" | "md" | "lg";
  badge?: string;
  badgeTone?: "dark" | "lime" | "amber" | "sky" | "rose";
  dim?: boolean;
  selected?: boolean;
  onClick?: () => void;
  title?: string;
  showName?: boolean;
}) {
  const d = describeItem({ def, rarity });
  const box = size === "lg" ? "h-20 w-20" : size === "md" ? "h-16 w-16" : "h-12 w-12";
  const img = size === "lg" ? "h-14 w-14" : size === "md" ? "h-11 w-11" : "h-8 w-8";
  const durPct = dur === undefined ? null : Math.max(0, Math.min(100, dur));
  const Tag = onClick ? "button" : "div";
  return (
    <Tag
      type={onClick ? "button" : undefined}
      onClick={onClick}
      title={title ?? `${d.name} · ${d.rarityName}${durPct !== null ? ` · ${Math.round(durPct)}%` : ""}`}
      className={clsx(
        "group flex shrink-0 flex-col items-center gap-1 text-left",
        onClick && "cursor-pointer focus-visible:outline-none",
        dim && "opacity-50 grayscale",
      )}
    >
      <span
        className={clsx(
          "relative grid place-items-center rounded-xl border-[3px] border-black shadow-[0_3px_0_#000] transition-transform",
          box,
          onClick && "group-hover:-translate-y-0.5 group-active:translate-y-0.5 group-focus-visible:ring-4 group-focus-visible:ring-zooa-lime/70",
          selected && "ring-4 ring-zooa-lime",
        )}
        style={{ background: `radial-gradient(circle at 50% 35%, ${d.color}dd, ${d.color}55 72%)` }}
      >
        {/* eslint-disable-next-line @next/next/no-img-element -- tiny static sprites */}
        <img src={d.icon} alt="" draggable={false} className={clsx("pointer-events-none select-none object-contain drop-shadow-[0_2px_0_rgba(0,0,0,0.5)]", img)} />
        {qty !== undefined && qty > 1 && (
          <span className="absolute -bottom-1.5 -right-1.5 rounded-md border-2 border-black bg-white px-1 text-xs font-bold tabular-nums text-black">
            {qty}
          </span>
        )}
        {badge && (
          <span
            className={clsx(
              "absolute -left-1.5 -top-2 max-w-[115%] truncate rounded-md border-2 border-black px-1 py-0.5 text-[0.7rem] font-bold uppercase leading-none tracking-normal",
              badgeTone === "lime" && "bg-zooa-lime text-black",
              badgeTone === "amber" && "bg-amber-300 text-black",
              badgeTone === "sky" && "bg-sky-300 text-black",
              badgeTone === "rose" && "bg-rose-400 text-black",
              badgeTone === "dark" && "bg-black/85 text-white",
            )}
          >
            {badge}
          </span>
        )}
        {durPct !== null && (
          <span className="absolute inset-x-1.5 bottom-1 h-1.5 overflow-hidden rounded-full border border-black bg-black/60">
            <span
              className={clsx("block h-full", durPct < 25 ? "bg-rose-400" : durPct < 60 ? "bg-amber-300" : "bg-zooa-lime")}
              style={{ width: `${durPct}%` }}
            />
          </span>
        )}
      </span>
      {showName && (
        <span className="block max-w-[6rem] text-center">
          <span className="block truncate text-xs tracking-wide text-white">{d.name}</span>
          <span className="block text-xs font-semibold" style={{ color: d.color }}>
            {d.rarityName}
          </span>
        </span>
      )}
    </Tag>
  );
}

/** Empty slot frame with a caption (loadout doll). */
export function EmptySlot({ label, size = "md", onClick, active = false }: { label: string; size?: "sm" | "md" | "lg"; onClick?: () => void; active?: boolean }) {
  const box = size === "lg" ? "h-20 w-20" : size === "md" ? "h-16 w-16" : "h-12 w-12";
  return (
    <span
      onClick={onClick}
      className={clsx(
        "grid place-items-center rounded-xl border-[3px] border-dashed border-white/25 bg-black/25 px-0.5 text-center font-body text-xs font-semibold leading-tight text-white/70 lg:text-[0.8125rem]",
        box,
        active && "border-zooa-lime/70 text-zooa-lime/80",
      )}
    >
      {label}
    </span>
  );
}
