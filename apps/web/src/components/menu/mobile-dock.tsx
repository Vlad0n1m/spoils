"use client";

import clsx from "clsx";
import type { LobbyPanel } from "@/lib/lobby/panels";
import { FallbackImg } from "./fallback-img";
import { MENU_ICONS, type MenuIcon } from "./side-button";

/**
 * Phone dock (WORLD v6 spec §6.1, < 768 px): five cells above PLAY — Inventory, Shop, News, Ranks
 * and More (Info, Friends, Guilds, Wallet, Account). Cells are ≥ 56 px tall.
 */
export function MobileDock({
  active,
  newsDot,
  onPanel,
  onMore,
  moreOpen,
}: {
  active: LobbyPanel | null;
  newsDot: boolean;
  onPanel: (p: LobbyPanel) => void;
  onMore: () => void;
  moreOpen: boolean;
}) {
  const cell = (key: string, label: string, icon: MenuIcon, on: boolean, onClick: () => void, dot = false, ariaLabel?: string) => (
    <li key={key} className="min-w-0 flex-1">
      <button
        type="button"
        onClick={onClick}
        aria-haspopup="dialog"
        aria-expanded={on}
        aria-label={ariaLabel ?? (dot ? `${label}, new` : label)}
        className={clsx(
          "relative flex min-h-14 w-full flex-col items-center justify-center gap-1 rounded-2xl border-[3px] border-black px-1 py-1.5 shadow-[0_3px_0_#000] active:translate-y-[2px] active:shadow-[0_1px_0_#000] focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-zooa-lime/70",
          on ? "bg-zooa-lime text-black" : "bg-[#1d2333]/90 text-white",
        )}
      >
        <FallbackImg src={icon.src} fallback={icon.fallback} className="h-8 w-8 object-contain drop-shadow-[0_2px_0_rgba(0,0,0,0.55)]" />
        <span className="text-[0.7rem] tracking-wide" aria-hidden>
          {label}
        </span>
        {dot && <span className="absolute right-1 top-1 h-3 w-3 rounded-full border-2 border-black bg-rose-500" aria-hidden />}
      </button>
    </li>
  );
  return (
    <nav aria-label="Menu" className="md:hidden">
      <ul className="flex gap-1.5">
        {cell("inventory", "Inventory", MENU_ICONS.inventory, active === "inventory", () => onPanel("inventory"))}
        {cell("shop", "Shop", MENU_ICONS.shop, active === "shop", () => onPanel("shop"))}
        {cell("news", "News", MENU_ICONS.news, active === "news", () => onPanel("news"), newsDot)}
        {cell("ranks", "Ranks", MENU_ICONS.leaderboards, active === "leaderboards", () => onPanel("leaderboards"), false, "Leaderboards")}
        {cell("more", "More", { src: "/sprites/junk_toolbox.png", fallback: "/sprites/junk_toolbox.png" }, moreOpen, onMore, false, "More: info, friends, guilds, wallet, account")}
      </ul>
    </nav>
  );
}
