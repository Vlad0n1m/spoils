"use client";

import Link from "next/link";
import { BRAND } from "@/lib/brand";
import { useLobby } from "@/lib/lobby/lobby-context";
import { fmtCr } from "@/lib/items-ui";
import { formatMinor } from "@/lib/market/config";
import { AudioSettingsButton } from "@/components/audio-settings";
import { AccountMenu } from "./account-menu";
import { CreditsPill, WalletPill } from "./currency-pill";
import { LevelBadge } from "./level-badge";
import { XpBar } from "./xp-bar";

/**
 * Main-menu top bar (WORLD v6 spec §6.2): SPOILS, level badge, nick + XP bar, CR / SOL pills,
 * audio, account. Guests see "Guest · loot isn't kept" + Register instead of the money; signed-out
 * viewers get Sign in. Phone: badge, nick, CR and ☰, with a 4 px XP bar under the bar.
 */
export function MenuTopBar({ onCredits }: { onCredits: () => void }) {
  const { user, sessionLoading, sessionKind, stash } = useLobby();
  const s = stash.data;
  const level = sessionKind === "user" ? (s ? s.level : null) : null;

  return (
    <header className="relative z-20 border-b-[3px] border-black bg-[#0d1119]/85 backdrop-blur">
      <div className="flex h-14 items-center gap-2 px-3 md:h-16 md:gap-3 md:px-5 [@media(max-height:500px)]:h-14">
        <Link
          href="/"
          className="toon-text-thin hidden shrink-0 text-2xl tracking-wide text-zooa-lime focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-zooa-lime/60 sm:block md:text-3xl"
        >
          <span className="optical-center">{BRAND.name}</span>
        </Link>

        <div className="flex min-w-0 flex-1 items-center gap-2.5 sm:ml-2 md:ml-4">
          {sessionLoading ? (
            <span className="h-10 w-48 animate-pulse rounded-xl bg-white/10 motion-reduce:animate-none" aria-hidden />
          ) : user ? (
            <>
              {sessionKind === "user" && <LevelBadge level={level} />}
              <div className="min-w-0">
                <p className="max-w-[9rem] truncate text-base tracking-wide text-white sm:max-w-[12rem] md:text-lg">{user.nickname}</p>
                {sessionKind === "user" ? (
                  <div className="mt-1 hidden md:block">
                    {s ? <XpBar xp={s.xp} /> : <span className="block h-3 w-40 animate-pulse rounded-full bg-white/10 motion-reduce:animate-none" />}
                  </div>
                ) : (
                  <p className="font-body mt-0.5 hidden text-xs text-white/60 sm:block">Guest · loot isn&apos;t kept</p>
                )}
              </div>
            </>
          ) : (
            <p className="font-body truncate text-sm text-white/70">Sign in to keep your raider, stash and rank</p>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-2">
          {sessionKind === "user" && (
            <>
              <CreditsPill value={s ? fmtCr(s.credits) : null} onClick={onCredits} />
              <WalletPill value={s ? formatMinor(s.balance) : null} className="hidden sm:inline-flex" />
            </>
          )}
          {sessionKind === "guest" && (
            <Link href="/auth/register?next=/play" className="toon-btn min-h-10 px-4 text-sm">
              <span className="optical-center">Register</span>
            </Link>
          )}
          {sessionKind === "anon" && !sessionLoading && (
            <Link href="/auth/login?next=/play" className="toon-btn min-h-10 px-4 text-sm">
              <span className="optical-center">Sign in</span>
            </Link>
          )}
          <AudioSettingsButton direction="down" align="right" className="hidden min-[400px]:block" />
          <AccountMenu />
        </div>
      </div>
      {sessionKind === "user" && s && (
        <div className="md:hidden">
          <XpBar xp={s.xp} variant="thin" />
        </div>
      )}
    </header>
  );
}
