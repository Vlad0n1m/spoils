"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import Link from "next/link";
import clsx from "clsx";
import { useLobby } from "@/lib/lobby/lobby-context";
import { AccountWalletEntry } from "@/components/wallet/account-wallet-entry";
import { BRAND } from "@/lib/brand";
import { useIdosFramed } from "./use-idos-frame";

const item =
  "font-body flex min-h-11 w-full items-center rounded-xl px-3 text-left text-sm font-semibold text-white/85 hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zooa-lime";

/**
 * Account menu (WORLD v6 spec §6.2): ☰ in the top bar. Signed in: nick, email, the linked Solana
 * wallet (short address + copy) or Connect wallet, Wallet, Economy stats, Sign out. Guest: Register
 * to keep your raider, Sign out. Signed out: Sign in, Register.
 * Closes on Escape (focus back to the button) and on an outside click.
 * iDos Games edition: the edition name heads the menu; inside the iDos frame Connect wallet is hidden
 * (idosgames.com handles wallets there and blocks wallet access in the frame).
 */
export function AccountMenu() {
  const { user, sessionKind } = useLobby();
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const id = useId();
  const idosFramed = useIdosFramed();

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (root.current && !root.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      setOpen(false);
      button.current?.focus();
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [open]);

  const signOut = useCallback(async () => {
    try {
      await fetch("/api/auth/logout", { method: "POST", credentials: "include" });
    } finally {
      // A full reload drops every per-account resource (stash, me/world, tickets) at once.
      window.location.assign("/play");
    }
  }, []);

  return (
    <div ref={root} className="relative">
      <button
        ref={button}
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-controls={id}
        aria-label="Account menu"
        className="grid h-11 w-11 place-items-center rounded-xl border-[3px] border-black bg-white text-black shadow-[0_3px_0_#000] transition-[transform,box-shadow] active:translate-y-[2px] active:shadow-[0_1px_0_#000] focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-zooa-lime/70"
      >
        <svg viewBox="0 0 20 20" className="h-5 w-5" aria-hidden>
          <path d="M3 5h14M3 10h14M3 15h14" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" />
        </svg>
      </button>
      {open && (
        <div
          id={id}
          className="toon-panel absolute right-0 top-full z-50 mt-2 w-64 bg-[#161b28] p-2 animate-panel-in motion-reduce:animate-none"
        >
          {BRAND.edition && (
            <p className="font-body px-3 pt-1 text-[11px] font-semibold uppercase tracking-wider text-zooa-lime/80">{BRAND.fullName}</p>
          )}
          {user ? (
            <div className="border-b-2 border-black/40 px-3 pb-3 pt-2">
              <p className="truncate text-base tracking-wide text-white">{user.nickname}</p>
              <p className="font-body mt-1 truncate text-xs lg:text-[0.8125rem] text-white/75">{sessionKind === "guest" ? "Guest · loot isn't kept" : user.email}</p>
            </div>
          ) : (
            <p className="font-body px-3 pb-3 pt-2 text-sm text-white/70">Not signed in</p>
          )}
          <nav className="mt-1 flex flex-col" aria-label="Account">
            {sessionKind === "user" && user && (
              <>
                {!idosFramed && <AccountWalletEntry userId={user.id} itemClassName={item} />}
                <Link href="/wallet" className={item}>
                  Wallet
                </Link>
                <Link href="/economy" className={item}>
                  Economy stats
                </Link>
              </>
            )}
            {sessionKind === "guest" && (
              <Link href="/auth/register?next=/play" className={clsx(item, "text-zooa-lime")}>
                Register to keep your raider
              </Link>
            )}
            {sessionKind === "anon" ? (
              <>
                <Link href="/auth/login?next=/play" className={item}>
                  Sign in
                </Link>
                <Link href="/auth/register?next=/play" className={item}>
                  Register
                </Link>
                <Link href="/economy" className={item}>
                  Economy stats
                </Link>
              </>
            ) : (
              <button type="button" onClick={() => void signOut()} className={item}>
                Sign out
              </button>
            )}
          </nav>
        </div>
      )}
    </div>
  );
}
