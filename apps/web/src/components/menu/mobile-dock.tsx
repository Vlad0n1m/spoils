"use client";

import clsx from "clsx";
import type { LobbyPanel } from "@/lib/lobby/panels";
import { FallbackImg } from "./fallback-img";
import { MENU_ICONS, type MenuIcon } from "./side-button";

/**
 * Phone dock (WORLD v6 spec §6.1, < 768 px): five cells above PLAY — Inventory, Shop, News, Ranks
 * and More (Info, Friends, Guilds, Wallet, Account). Cells are ≥ 56 px tall. `moreDot` = friend
 * requests or party invites waiting (Friends lives in More).
 */
export function MobileDock({
  active,
  newsDot,
  moreDot = false,
  onPanel,
  onMore,
  moreOpen,
}: {
  active: LobbyPanel | null;
  newsDot: boolean;
  moreDot?: boolean;
  onPanel: (p: LobbyPanel) => void;
  onMore: () => void;
  moreOpen: boolean;
}) {
  const cell = (key: string, label: string, icon: MenuIcon, on: boolean, onClick: () => void, dot = false, ariaLabel?: string) => (
    <li key={key} className="min-w-0 flex-1" data-coach={key === "inventory" || key === "shop" ? key : undefined}>
      <button
        type="button"
        onClick={onClick}
        aria-haspopup="dialog"
        aria-expanded={on}
        aria-label={ariaLabel ?? (dot ? `${label}, new` : label)}
        data-on={on || undefined}
        className={clsx(
          "menu-tile h-16 w-full focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-zooa-lime/70",
        )}
      >
        <FallbackImg src={icon.src} fallback={icon.fallback} className="pointer-events-none absolute left-1/2 top-[42%] h-11 w-11 -translate-x-1/2 -translate-y-1/2 object-contain drop-shadow-[0_2px_0_rgba(0,0,0,0.55)]" />
        <span className="menu-label absolute inset-x-0 -bottom-1 text-center text-[0.75rem] leading-none tracking-wide" aria-hidden>
          {label}
        </span>
        {dot && <span className="absolute -right-1.5 -top-1.5 h-[1.1rem] w-[1.1rem] rounded-full border-[3px] border-black bg-rose-500" aria-hidden />}
      </button>
    </li>
  );
  return (
    // Portrait phones only: the landscape layout has the tile grid instead (main-menu.tsx).
    <nav aria-label="Menu" className="land:hidden">
      <ul className="flex gap-2 pb-1">
        {cell("inventory", "Inventory", MENU_ICONS.inventory, active === "inventory", () => onPanel("inventory"))}
        {cell("shop", "Shop", MENU_ICONS.shop, active === "shop", () => onPanel("shop"))}
        {cell("news", "News", MENU_ICONS.news, active === "news", () => onPanel("news"), newsDot)}
        {cell("ranks", "Ranks", MENU_ICONS.leaderboards, active === "leaderboards", () => onPanel("leaderboards"), false, "Leaderboards")}
        {cell(
          "more",
          "More",
          { src: "/sprites/junk_toolbox.png", fallback: "/sprites/junk_toolbox.png" },
          moreOpen || active === "friends",
          onMore,
          moreDot,
          moreDot ? "More: info, friends (new), guilds, wallet, account" : "More: info, friends, guilds, wallet, account",
        )}
      </ul>
    </nav>
  );
}
