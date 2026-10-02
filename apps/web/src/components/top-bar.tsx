"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { AuthButton } from "./auth-button";
import { BalancePill } from "./balance-pill";

function navLinkClass(active: boolean) {
  return [
    "text-sm tracking-wide transition",
    active ? "text-zooa-lime" : "text-white/70 hover:text-white",
  ].join(" ");
}

export function TopBar() {
  const path = usePathname();
  return (
    <header className="sticky top-0 z-50 border-b border-white/10 bg-[#050807]/80 backdrop-blur">
      <div className="mx-auto flex max-w-7xl items-center justify-between px-4 py-3 md:px-8">
        <Link href="/" className="font-display text-lg tracking-wide text-white md:text-xl">
          <span className="optical-center">ZOOA</span>
        </Link>
        <nav className="flex items-center gap-3 md:gap-5 text-sm">
          <Link href="/play" className={navLinkClass(path === "/play" || path.startsWith("/play/"))}>
            Play
          </Link>
          <Link href="/wallet" className={navLinkClass(path === "/wallet" || path.startsWith("/wallet/"))}>
            Wallet
          </Link>
          <BalancePill />
          <AuthButton />
        </nav>
      </div>
    </header>
  );
}
