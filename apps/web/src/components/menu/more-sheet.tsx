"use client";

import { useEffect, useRef } from "react";
import Link from "next/link";
import { useLobby } from "@/lib/lobby/lobby-context";
import { FallbackImg } from "./fallback-img";
import { LockSticker, MENU_ICONS } from "./side-button";

const row =
  "font-body flex min-h-14 w-full items-center gap-3 rounded-2xl border-[3px] border-black bg-[#1d2333] px-4 text-left text-base font-semibold text-white shadow-[0_3px_0_#000] active:translate-y-[2px] active:shadow-[0_1px_0_#000] focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-zooa-lime/70";

/**
 * Phone "More" sheet (WORLD v6 spec §6.1): Info, Friends 🔒, Guilds 🔒, Wallet, Account. A bottom
 * sheet over the dock; Escape or the backdrop closes it.
 */
export function MoreSheet({ onClose, onInfo, onLocked }: { onClose: () => void; onInfo: () => void; onLocked: (what: "Friends" | "Guilds") => void }) {
  const { sessionKind } = useLobby();
  const first = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    first.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-40 md:hidden" role="dialog" aria-modal="true" aria-label="More">
      <div className="absolute inset-0 bg-black/55" onClick={onClose} aria-hidden />
      <div className="toon-panel absolute inset-x-2 bottom-2 flex flex-col gap-2 bg-[#121722] p-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))] animate-sheet-up motion-reduce:animate-none">
        <button ref={first} type="button" className={row} onClick={onInfo}>
          <FallbackImg src={MENU_ICONS.info.src} fallback={MENU_ICONS.info.fallback} className="h-8 w-8 object-contain" />
          Info · how to play
        </button>
        {(["Friends", "Guilds"] as const).map((w) => (
          <button key={w} type="button" aria-disabled="true" className={`${row} text-white/60`} onClick={() => onLocked(w)}>
            <span className="relative">
              <FallbackImg
                src={w === "Friends" ? MENU_ICONS.friends.src : MENU_ICONS.guilds.src}
                fallback={w === "Friends" ? MENU_ICONS.friends.fallback : MENU_ICONS.guilds.fallback}
                className="h-8 w-8 object-contain opacity-60 grayscale"
              />
              <LockSticker className="absolute -right-2 -top-2 h-4 w-4" />
            </span>
            {w} · coming soon
          </button>
        ))}
        {sessionKind === "user" && (
          <Link href="/wallet" className={row}>
            <span className="grid h-8 w-8 place-items-center text-xl text-sol-400" aria-hidden>
              ◆
            </span>
            Wallet
          </Link>
        )}
        <Link href={sessionKind === "anon" ? "/auth/login?next=/play" : "/economy"} className={row}>
          <span className="grid h-8 w-8 place-items-center text-xl text-amber-300" aria-hidden>
            ◎
          </span>
          {sessionKind === "anon" ? "Sign in" : "Economy stats"}
        </Link>
        <button type="button" onClick={onClose} className="toon-btn-ghost mt-1 min-h-12 text-base">
          <span className="optical-center">Close</span>
        </button>
      </div>
    </div>
  );
}
