"use client";

import { useEffect, useRef } from "react";
import Link from "next/link";
import { guestPlayUiEnabled } from "@/lib/client-env";

/**
 * PLAY without a session (WORLD v6 spec §6.5, draft C §7.4): play as guest (when enabled), sign
 * in, or register. Escape and the backdrop close it.
 */
export function SignInSheet({ onClose, onGuest }: { onClose: () => void; onGuest: () => void }) {
  const title = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    title.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 grid place-items-end p-3 pl-[max(0.75rem,var(--safe-l))] pr-[max(0.75rem,var(--safe-r))] pb-[max(0.75rem,var(--safe-b))] sm:place-items-center" role="dialog" aria-modal="true" aria-labelledby="signin-sheet-title">
      <div className="absolute inset-0 bg-black/65" onClick={onClose} aria-hidden />
      <div className="toon-panel relative w-full max-w-md bg-[#161b28] p-6 text-center animate-sheet-up motion-reduce:animate-none md:p-8">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/sprites/player.png" alt="" className="mx-auto h-20 w-20 -rotate-12 animate-float-sm motion-reduce:animate-none" draggable={false} />
        <h2 ref={title} tabIndex={-1} id="signin-sheet-title" className="toon-text mt-3 text-4xl tracking-wide text-zooa-lime focus:outline-none">
          Ready to drop?
        </h2>
        <p className="font-body mx-auto mt-3 max-w-[40ch] text-base text-white/75">
          Guests drop with the basic gear and keep nothing. Register to keep your raider, stash, XP and rank.
        </p>
        <div className="mt-6 flex flex-col gap-3">
          {guestPlayUiEnabled && (
            <button type="button" onClick={onGuest} className="toon-btn min-h-14 text-xl tracking-wide">
              <span className="optical-center">Play as guest</span>
            </button>
          )}
          <Link href="/auth/register?next=/play" className={guestPlayUiEnabled ? "toon-btn-ghost min-h-12 text-base" : "toon-btn min-h-14 text-xl"}>
            <span className="optical-center">Register</span>
          </Link>
          <Link href="/auth/login?next=/play" className="toon-btn-ghost min-h-12 text-base">
            <span className="optical-center">Sign in</span>
          </Link>
          <button type="button" onClick={onClose} className="font-body mt-1 min-h-10 text-sm font-semibold text-white/75 underline-offset-4 hover:text-white hover:underline">
            Not now
          </button>
        </div>
      </div>
    </div>
  );
}
