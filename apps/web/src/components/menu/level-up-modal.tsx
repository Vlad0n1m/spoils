"use client";

import { useEffect, useRef } from "react";
import clsx from "clsx";
import type { WearableKind } from "@extract/shared";
import type { RewardItem } from "@/lib/lobby/levels";
import { playUi } from "@/game/audio/ui-sounds";
import { LevelBadge } from "./level-badge";
import { Confetti, RewardCard, WearButton } from "./reward-art";
import { PagerArrow, useCarousel } from "@/components/paged";

const WEARABLE = new Set<string>(["title", "color", "frame", "skin"]);

/**
 * New level (WORLD v6 spec §6.6): a burst and turning rays behind the new level shield, "LEVEL 8",
 * then the level's rewards flip in one by one as drawn cards (`rewardsBetween` from
 * lib/lobby/levels.ts: features, then titles, name colours and badge frames) with Wear on the
 * cosmetics when `canWear`. The coin sound once. Escape or "Nice!" closes it; "All rewards"
 * (`onRewards`) closes it and opens the rewards screen. Reduced motion: no rays, burst or flips.
 */
export function LevelUpModal({
  level,
  rewards,
  nick,
  canWear,
  onClose,
  onRewards,
}: {
  level: number;
  rewards: RewardItem[];
  nick: string;
  canWear?: boolean;
  onClose: () => void;
  onRewards?: () => void;
}) {
  const ok = useRef<HTMLButtonElement>(null);
  const { ref: track, edge, by, handlers } = useCarousel<HTMLDivElement>();
  useEffect(() => {
    playUi("coin");
    ok.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-[70] grid place-items-center p-4 short:p-2" role="dialog" aria-modal="true" aria-labelledby="levelup-title">
      <div className="absolute inset-0 bg-black/75" onClick={onClose} aria-hidden />
      <div className="toon-panel relative max-h-[calc(100dvh-2rem)] w-full max-w-[56rem] overflow-hidden bg-[radial-gradient(circle_at_50%_18%,#2b3a1a,#161b28_60%)] px-5 pb-5 pt-6 text-center animate-pop-in motion-reduce:animate-none short:max-h-[calc(100dvh-1rem)] short:px-3 short:pb-3 short:pt-3">
        {/* Rays turning behind the shield, and a one-off burst. */}
        <div className="pointer-events-none absolute left-1/2 top-[4.5rem] h-0 w-0 short:top-8" aria-hidden>
          <span
            className="rw-rays absolute -left-[260px] -top-[260px] h-[520px] w-[520px] rounded-full opacity-60 motion-reduce:hidden"
            style={{
              background: "repeating-conic-gradient(rgba(204,255,0,0.22) 0deg 9deg, transparent 9deg 24deg)",
              WebkitMaskImage: "radial-gradient(circle, #000 15%, transparent 65%)",
              maskImage: "radial-gradient(circle, #000 15%, transparent 65%)",
            }}
          />
          <span className="rw-burst absolute -left-[110px] -top-[110px] h-[220px] w-[220px] rounded-full bg-[radial-gradient(circle,#f4ffb0,rgba(204,255,0,0.5)_40%,transparent_70%)]" />
          <Confetti count={22} />
        </div>
        <div className="relative flex flex-col items-center short:flex-row short:justify-center short:gap-3">
          <LevelBadge level={level} size="lg" className="rw-pop scale-125 short:scale-90" />
          <div>
            <p className="font-body mt-4 text-sm font-bold uppercase tracking-[0.3em] text-white/85 short:mt-0 short:text-xs">Level up!</p>
            <h2 id="levelup-title" className="toon-text text-6xl leading-none tracking-wide text-zooa-lime md:text-7xl short:!text-4xl">
              <span className="optical-center">LEVEL {level}</span>
            </h2>
          </div>
        </div>
        {rewards.length > 0 ? (
          <>
            <p className="font-body relative mt-3 text-sm font-semibold text-white/85 short:sr-only">
              {rewards.length === 1 ? "You unlocked" : `You unlocked ${rewards.length} rewards`}
            </p>
            {/* A carousel when the cards don't fit the width: ‹ › and swipe, never a scrollbar. */}
            <div className="relative -mx-5 mt-2 short:-mx-3 short:mt-1">
            <PagerArrow dir={-1} disabled={edge.start} onClick={() => by(-1)} className="absolute left-1 top-1/2 z-[3] -translate-y-1/2 shadow-[0_4px_0_#000] disabled:hidden" />
            <PagerArrow dir={1} disabled={edge.end} onClick={() => by(1)} className="absolute right-1 top-1/2 z-[3] -translate-y-1/2 shadow-[0_4px_0_#000] disabled:hidden" />
            <div ref={track} {...handlers} className="rw-track relative overflow-hidden px-5 pb-2 pt-3 [touch-action:pan-y] short:px-3">
              <div className="mx-auto flex w-max gap-3">
                {rewards.map((it, i) => (
                  <RewardCard
                    key={it.label}
                    item={it}
                    state="owned"
                    nick={nick}
                    level={level}
                    className="rw-flip-in"
                    style={{ animationDelay: `${450 + i * 140}ms` }}
                    footer={canWear && it.id && WEARABLE.has(it.kind) ? <WearButton kind={it.kind as WearableKind} id={it.id} /> : undefined}
                  />
                ))}
              </div>
            </div>
            </div>
          </>
        ) : (
          <p className="font-body relative mt-4 text-sm text-white/80">Keep raiding: your rank on the Level board just went up.</p>
        )}
        <div className={clsx("relative mt-4 flex flex-col gap-2 short:mt-2 short:flex-row-reverse", "sm:flex-row-reverse sm:justify-center")}>
          <button ref={ok} type="button" onClick={onClose} className="toon-btn min-h-12 w-full short:min-h-11 text-xl tracking-wide sm:w-56">
            <span className="optical-center">Nice!</span>
          </button>
          {onRewards && (
            <button type="button" onClick={onRewards} className="toon-btn-ghost min-h-12 w-full short:min-h-11 text-base tracking-wide sm:w-56">
              <span className="optical-center">All rewards</span>
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
