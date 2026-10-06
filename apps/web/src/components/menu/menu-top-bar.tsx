"use client";

import { useEffect } from "react";
import Link from "next/link";
import clsx from "clsx";
import { BRAND } from "@/lib/brand";
import { useLobby } from "@/lib/lobby/lobby-context";
import { fmtCr } from "@/lib/items-ui";
import { formatMinor } from "@/lib/market/config";
import { AudioSettingsButton } from "@/components/audio-settings";
import { AccountMenu } from "./account-menu";
import { CreditsPill, WalletPill } from "./currency-pill";
import { nameColorHex, titleName } from "@/lib/lobby/levels";
import { LevelBadge } from "./level-badge";
import { useQuests } from "./quests-context";
import { XpBar } from "./xp-bar";
import { EDITION_UI } from "@/lib/edition";
import { SeekerBadge } from "@/components/seeker/seeker-badge";
import { loadSeeker, useSeekerVerified } from "@/components/seeker/seeker-store";

/**
 * Main-menu top bar (Brawl Stars layout): no strip, just chunky pieces over the art. Left: the
 * profile plate (level shield bulging out of it, nick in the equipped name colour, the equipped
 * title on wide screens, a chunky XP bar); it opens the rewards sheet. Right: CR and SOL pills with
 * "+", audio and the account menu (☰). Guests see "Guest · loot isn't kept" + Register instead of
 * the money; signed-out viewers get Sign in. The SPOILS logo only shows on wide screens. A linked
 * wallet holding a Seeker Genesis Token adds the Seeker badge after the nick (lib/seeker).
 */
export function MenuTopBar({ onCredits, onRewards }: { onCredits: () => void; onRewards: () => void }) {
  const { user, sessionLoading, sessionKind, stash } = useLobby();
  const { data: quests } = useQuests();
  const s = stash.data;
  const level = sessionKind === "user" ? (s ? s.level : null) : null;
  const worn = sessionKind === "user" ? (quests?.equipped ?? null) : null;
  const nickColor = nameColorHex(worn?.color);
  const title = titleName(worn?.title);
  const userId = sessionKind === "user" ? (user?.id ?? null) : null;
  useEffect(() => {
    if (userId) void loadSeeker(userId);
  }, [userId]);
  const seeker = useSeekerVerified() && userId !== null;

  const plate = "menu-chip min-w-0 bg-[#141a29]/95 py-1 pr-4 text-left";
  const nick = (
    <span className="flex min-w-0 items-baseline gap-2">
      <span
        className="menu-label min-w-0 truncate text-lg leading-none tracking-wide text-white short:text-base"
        style={nickColor ? { color: nickColor } : undefined}
      >
        {user?.nickname}
      </span>
      {seeker && <SeekerBadge compact className="self-center" />}
      {title && (
        <span className="font-body hidden max-w-[10rem] truncate text-xs lg:text-[0.8125rem] font-bold uppercase tracking-wider text-white/75 xl:inline">{title}</span>
      )}
    </span>
  );

  return (
    <header className="relative z-20 px-3 pt-[max(0.6rem,env(safe-area-inset-top))] md:px-4 short:px-2 short:pt-[max(0.4rem,env(safe-area-inset-top))]">
      <div className="flex h-14 items-center gap-3 port:gap-2 short:h-12 short:gap-2">
        <Link
          href="/"
          className="toon-text hidden shrink-0 text-3xl tracking-wide text-zooa-lime focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-zooa-lime/60 min-[1360px]:block"
        >
          <span className="optical-center">{BRAND.name}</span>
        </Link>

        <div className="flex min-w-0 flex-1 items-center">
          {sessionLoading ? (
            <span className="h-12 w-56 animate-pulse rounded-2xl bg-white/10 motion-reduce:animate-none" aria-hidden />
          ) : user && sessionKind === "user" ? (
            <button
              type="button"
              onClick={onRewards}
              aria-label={level !== null ? `${user.nickname}, level ${level} · rewards` : "Rewards"}
              aria-haspopup="dialog"
              className={clsx(plate, "ml-3 w-[clamp(12rem,24vw,18rem)] gap-2 pl-0 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-zooa-lime/60 port:w-full short:w-[13.5rem]")}
            >
              <LevelBadge level={level} frame={worn?.frame} className="-my-2 -ml-4 !h-[3.4rem] !w-12 shrink-0 short:!h-12 short:!w-11 [&_span]:!text-2xl" />
              <span className="flex min-w-0 flex-1 flex-col gap-1.5">
                {nick}
                {s ? <XpBar xp={s.xp} /> : <span className="block h-4 w-full animate-pulse rounded-full bg-white/10 motion-reduce:animate-none" />}
              </span>
            </button>
          ) : user ? (
            <div className={clsx(plate, "max-w-[18rem] flex-col items-start gap-1 pl-4")}>
              {nick}
              <span className="font-body text-xs lg:text-[0.8125rem] font-semibold text-white/75">Guest · loot isn&apos;t kept</span>
            </div>
          ) : (
            <p className={clsx(plate, "font-body min-h-11 max-w-[22rem] pl-4 text-sm font-semibold text-white/80")}>Sign in to keep your raider, stash and rank</p>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-3 port:gap-2 short:gap-2">
          {sessionKind === "user" && (
            <>
              <CreditsPill value={s ? fmtCr(s.credits) : null} onClick={onCredits} className="ml-3 port:ml-1" />
              {EDITION_UI.walletBalance && <WalletPill value={s?.balance !== undefined ? formatMinor(s.balance) : null} className="ml-3 port:hidden" />}
            </>
          )}
          {sessionKind === "guest" && (
            <Link href="/auth/register?next=/play" className="menu-chip h-11 bg-[linear-gradient(180deg,#f0ff7a,#ccff00_55%,#a6d400)] px-5 text-base text-black focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-zooa-lime/60 short:h-10">
              <span className="optical-center">Register</span>
            </Link>
          )}
          {sessionKind === "anon" && !sessionLoading && (
            <Link href="/auth/login?next=/play" className="menu-chip h-11 bg-[linear-gradient(180deg,#f0ff7a,#ccff00_55%,#a6d400)] px-5 text-base text-black focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-zooa-lime/60 short:h-10">
              <span className="optical-center">Sign in</span>
            </Link>
          )}
          <AudioSettingsButton direction="down" align="right" large className="hidden min-[400px]:block" />
          <AccountMenu />
        </div>
      </div>
    </header>
  );
}
