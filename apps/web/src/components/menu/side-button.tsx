"use client";

import { forwardRef } from "react";
import clsx from "clsx";
import { FallbackImg } from "./fallback-img";

/** Lobby art icon (step S10) and the sprite used until it exists. */
export interface MenuIcon {
  src: string;
  fallback: string;
}

export const MENU_ICONS = {
  inventory: { src: "/lobby/menu_inventory.png", fallback: "/sprites/backpack_2.png" },
  shop: { src: "/lobby/menu_shop.png", fallback: "/sprites/chest_rare.png" },
  info: { src: "/lobby/menu_info.png", fallback: "/sprites/junk_keycard.png" },
  news: { src: "/lobby/menu_news.png", fallback: "/sprites/junk_battery.png" },
  leaderboards: { src: "/lobby/menu_leaderboards.png", fallback: "/sprites/junk_dogtag.png" },
  friends: { src: "/lobby/menu_friends.png", fallback: "/sprites/player.png" },
  /** Daily tasks and rewards. */
  tasks: { src: "/lobby/menu_quests.png", fallback: "/sprites/crate.png" },
  guilds: { src: "/lobby/menu_guilds.png", fallback: "/sprites/sandbags.png" },
  /** Alpha Pass (the tasks sheet's Pass tab). */
  pass: { src: "/lobby/menu_pass.png", fallback: "/sprites/junk_dogtag.png" },
} as const satisfies Record<string, MenuIcon>;

/** Padlock sticker for locked tiles. */
export function LockSticker({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={clsx("drop-shadow-[0_2px_0_#000]", className)} aria-hidden>
      <path d="M7 10V7.5a5 5 0 0 1 10 0V10" fill="none" stroke="#000" strokeWidth="5" strokeLinecap="round" />
      <path d="M7 10V7.5a5 5 0 0 1 10 0V10" fill="none" stroke="#e5e7eb" strokeWidth="2.4" strokeLinecap="round" />
      <rect x="4" y="10" width="16" height="12" rx="3" fill="#fbbf24" stroke="#000" strokeWidth="2.5" />
      <circle cx="12" cy="15.5" r="1.8" fill="#000" />
    </svg>
  );
}

/**
 * Main-menu tile (Brawl Stars layout): a chunky square button with a bevel and a hard shadow, the
 * icon filling most of it and a short outlined label over its bottom edge; lime while its panel is
 * open. Sizes: 104 px on desktops (88 px below 800 px tall), 64 px on landscape phones (58 px at
 * ≤ 380 px tall), 72 px in the portrait fallback. `locked` tiles (Guilds) stay focusable with
 * aria-disabled, a grey icon and a padlock, and only toast on click. `dot` = unread marker,
 * `ariaLabel` = the full name when the visible label is short ("Gear" → Inventory), `hotkey` =
 * desktop key hint.
 */
export const SideButton = forwardRef<
  HTMLButtonElement,
  {
    label: string;
    icon: MenuIcon;
    onClick: () => void;
    ariaLabel?: string;
    active?: boolean;
    locked?: boolean;
    dot?: boolean;
    hotkey?: string;
  }
>(function SideButton({ label, icon, onClick, ariaLabel, active = false, locked = false, dot = false, hotkey }, ref) {
  const name = ariaLabel ?? label;
  return (
    <button
      ref={ref}
      type="button"
      onClick={onClick}
      aria-disabled={locked || undefined}
      aria-haspopup={locked ? undefined : "dialog"}
      aria-expanded={locked ? undefined : active}
      aria-label={locked ? `${name}, coming soon` : dot ? `${name}, new` : name}
      data-on={active || undefined}
      data-locked={locked || undefined}
      className={clsx(
        "menu-tile h-[4.5rem] w-[4.5rem] focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-zooa-lime/80 focus-visible:ring-offset-2 focus-visible:ring-offset-black",
        "md:h-[5.5rem] md:w-[5.5rem] [@media(min-width:1024px)_and_(min-height:800px)]:h-[6.5rem] [@media(min-width:1024px)_and_(min-height:800px)]:w-[6.5rem]",
        "short:!h-16 short:!w-16 tiny:!h-[3.6rem] tiny:!w-[3.6rem]",
        locked && "cursor-not-allowed",
      )}
    >
      <FallbackImg
        src={icon.src}
        fallback={icon.fallback}
        className={clsx(
          "pointer-events-none absolute left-1/2 top-[44%] h-[78%] w-[78%] -translate-x-1/2 -translate-y-1/2 object-contain drop-shadow-[0_3px_0_rgba(0,0,0,0.6)]",
          locked && "opacity-55 grayscale",
        )}
      />
      <span
        className={clsx(
          "menu-label pointer-events-none absolute inset-x-0 -bottom-1.5 text-center text-[0.8rem] leading-none tracking-wide md:text-[0.95rem] short:!text-[0.78rem] tiny:!text-[0.72rem]",
          locked ? "text-white/70" : "text-white",
        )}
        aria-hidden
      >
        <span className="optical-center">{label}</span>
      </span>
      {locked && <LockSticker className="absolute -right-2 -top-2 h-7 w-7 short:h-6 short:w-6" />}
      {dot && !locked && (
        <span className="absolute -right-2 -top-2 grid h-[1.35rem] w-[1.35rem] place-items-center rounded-full border-[3px] border-black bg-rose-500 shadow-[0_2px_0_#000]" aria-hidden>
          <span className="h-1.5 w-1.5 rounded-full bg-white" />
        </span>
      )}
      {hotkey && !locked && (
        <span className="toon-key absolute left-1 top-1 h-5 min-w-5 text-xs opacity-80 [@media(hover:none)]:hidden short:hidden" aria-hidden>
          {hotkey}
        </span>
      )}
    </button>
  );
});
