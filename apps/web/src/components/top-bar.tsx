"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { AudioSettingsButton } from "./audio-settings";
import { AuthButton } from "./auth-button";

function navLinkClass(active: boolean) {
  return [
    "text-sm tracking-wide transition",
    active ? "text-zooa-lime" : "text-white/70 hover:text-white",
  ].join(" ");
}

export function TopBar() {
  const path = usePathname();
  return (
    <header className="sticky top-0 z-50 border-b-[3px] border-black bg-[#0d1119]/85 backdrop-blur">
      <div className="mx-auto flex max-w-7xl items-center justify-between px-4 py-3 md:px-8">
        <Link href="/" className="toon-text-thin text-xl tracking-wide text-zooa-lime md:text-2xl">
          <span className="optical-center">EXTRACT</span>
        </Link>
        <nav className="flex items-center gap-3 text-sm md:gap-5">
          <Link href="/play" className={navLinkClass(path === "/play" || path.startsWith("/play/"))}>
            Play
          </Link>
          <Link href="/economy" className={navLinkClass(path === "/economy")}>
            Economy
          </Link>
          <AudioSettingsButton direction="down" align="right" />
          <AuthButton />
        </nav>
      </div>
    </header>
  );
}
