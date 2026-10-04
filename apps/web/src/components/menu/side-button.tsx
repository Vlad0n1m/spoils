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
  /** Daily tasks and rewards: no lobby art yet (point `src` at /lobby/menu_tasks.png once it exists). */
  tasks: { src: "/sprites/crate.png", fallback: "/sprites/crate.png" },
  guilds: { src: "/lobby/menu_guilds.png", fallback: "/sprites/sandbags.png" },
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
 * Main-menu side button (WORLD v6 spec §6.1): a 104 px tile (116 px at ≥ 1440, 84 px on tablets)
 * with a 64 px icon and a Luckiest Guy label; lime while its panel is open. `locked` tiles (Guilds)
 * stay focusable with aria-disabled, show a grey icon, a padlock and a SOON ribbon, and
 * only toast on click. `dot` = unread marker (News; Friends: requests or party invites), `hotkey` =
 * desktop key hint.
 */
export const SideButton = forwardRef<
  HTMLButtonElement,
  {
    label: string;
    icon: MenuIcon;
    onClick: () => void;
    active?: boolean;
    locked?: boolean;
    dot?: boolean;
    hotkey?: string;
  }
>(function SideButton({ label, icon, onClick, active = false, locked = false, dot = false, hotkey }, ref) {
  return (
    <button
      ref={ref}
      type="button"
      onClick={onClick}
      aria-disabled={locked || undefined}
      aria-haspopup={locked ? undefined : "dialog"}
      aria-expanded={locked ? undefined : active}
      aria-label={locked ? `${label}, coming soon` : dot ? `${label}, new` : label}
      className={clsx(
        "toon-tile h-[5.25rem] w-[5.25rem] focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-zooa-lime/70 focus-visible:ring-offset-2 focus-visible:ring-offset-black lg:h-[6.5rem] lg:w-[6.5rem] min-[1440px]:h-[7.25rem] min-[1440px]:w-[7.25rem]",
        // Landscape phones: 72 px tiles (64 px at ≤ 400 px tall) so a column of four fits.
        "[@media(max-height:500px)]:h-[4.5rem] [@media(max-height:500px)]:w-[4.5rem] [@media(max-height:400px)]:!h-16 [@media(max-height:400px)]:!w-16",
        active && "!bg-zooa-lime text-black",
        locked && "cursor-not-allowed !bg-[#161b28]/90",
      )}
    >
      <FallbackImg
        src={icon.src}
        fallback={icon.fallback}
        className={clsx(
          "object-contain drop-shadow-[0_3px_0_rgba(0,0,0,0.55)]",
          locked
            ? "-mt-5 h-8 w-8 opacity-60 grayscale lg:h-11 lg:w-11 [@media(max-height:500px)]:-mt-4 [@media(max-height:500px)]:h-7 [@media(max-height:500px)]:w-7"
            : "-mt-1 h-10 w-10 lg:h-16 lg:w-16 [@media(max-height:500px)]:h-8 [@media(max-height:500px)]:w-8",
        )}
      />
      <span
        className={clsx(
          "text-xs tracking-wide lg:text-[0.95rem] [@media(max-height:500px)]:text-[0.6rem] [@media(max-height:500px)]:tracking-normal [@media(max-height:400px)]:!text-[0.55rem]",
          locked && "text-white/60",
        )}
        aria-hidden
      >
        <span className="optical-center">{label}</span>
      </span>
      {locked && (
        <>
          <LockSticker className="absolute -right-2 -top-2 h-6 w-6" />
          <span className="toon-ribbon" aria-hidden>
            SOON
          </span>
        </>
      )}
      {dot && !locked && (
        <span className="absolute -right-1.5 -top-1.5 h-4 w-4 rounded-full border-[3px] border-black bg-rose-500" aria-hidden />
      )}
      {hotkey && !locked && (
        <span className="toon-key absolute left-1.5 top-1.5 h-5 min-w-5 text-[0.6rem] [@media(hover:none)]:hidden" aria-hidden>
          {hotkey}
        </span>
      )}
    </button>
  );
});
