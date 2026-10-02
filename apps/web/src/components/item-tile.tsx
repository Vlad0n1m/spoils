"use client";

import clsx from "clsx";
import type { ItemRef } from "@extract/shared";
import { describeItem, rarityHex, rarityName } from "@/lib/items-ui";

/** Sprite in a rarity-colored frame. Used by the outcome overlay and the lobby board. */
export function ItemTile({
  item,
  size = "md",
  dim = false,
  showName = true,
}: {
  item: ItemRef;
  size?: "sm" | "md";
  /** Greyed out (e.g. broken items). */
  dim?: boolean;
  showName?: boolean;
}) {
  const { icon, name } = describeItem(item);
  const color = rarityHex(item.rarity);
  return (
    <div className={clsx("flex flex-col items-center gap-1.5", dim && "opacity-55 grayscale")}>
      <div
        className={clsx(
          "relative grid place-items-center rounded-xl border-[3px] border-black shadow-[0_3px_0_#000]",
          size === "md" ? "h-16 w-16" : "h-10 w-10",
        )}
        style={{
          background: `radial-gradient(circle at 50% 35%, ${color}cc, ${color}55 70%)`,
        }}
        title={`${name} (${rarityName(item.rarity)})`}
      >
        {/* eslint-disable-next-line @next/next/no-img-element -- tiny static sprites, no optimizer needed */}
        <img
          src={icon}
          alt=""
          className={clsx("pointer-events-none select-none object-contain", size === "md" ? "h-12 w-12" : "h-8 w-8")}
          draggable={false}
        />
      </div>
      {showName && (
        <div className="text-center leading-tight">
          <div className="text-[0.7rem] tracking-wide text-white">{name}</div>
          <div className="text-[0.6rem] uppercase tracking-wider" style={{ color }}>
            {rarityName(item.rarity)}
          </div>
        </div>
      )}
    </div>
  );
}
