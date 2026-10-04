"use client";

import { useEffect, useRef } from "react";
import { playUi } from "@/game/audio/ui-sounds";
import { LevelBadge } from "./level-badge";

const CONFETTI = ["#CCFF00", "#fbbf24", "#4cc9ff", "#f43f5e", "#b07bff", "#ffffff"];

/**
 * New level (WORLD v6 spec §6.6): "LEVEL 8" with what it unlocks (`unlocksBetween` from
 * lib/lobby/levels.ts: features, then titles, name colours and badge frames), CSS-only confetti, the
 * coin sound once. Escape or "Nice!" closes it; "Wear rewards" (`onRewards`) closes it and opens the
 * rewards sheet.
 */
export function LevelUpModal({
  level,
  unlocks,
  onClose,
  onRewards,
}: {
  level: number;
  unlocks: string[];
  onClose: () => void;
  onRewards?: () => void;
}) {
  const ok = useRef<HTMLButtonElement>(null);
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
    <div className="fixed inset-0 z-[70] grid place-items-center p-4" role="dialog" aria-modal="true" aria-labelledby="levelup-title">
      <div className="absolute inset-0 bg-black/70" onClick={onClose} aria-hidden />
      {/* Landscape phones (≤ 500 px tall): no big badge, smaller heading, and the card scrolls when a
          level brings many rewards. */}
      <div className="toon-panel relative max-h-[calc(100dvh-2rem)] w-full max-w-sm overflow-y-auto overscroll-contain bg-[#161b28] p-7 text-center animate-pop-in motion-reduce:animate-none [@media(max-height:500px)]:max-w-md [@media(max-height:500px)]:p-4">
        <div className="pointer-events-none absolute inset-0 motion-reduce:hidden" aria-hidden>
          {Array.from({ length: 12 }, (_, i) => (
            <span
              key={i}
              className="absolute h-3 w-3 rounded-sm border-2 border-black animate-pop-in"
              style={{
                left: `${8 + ((i * 37) % 84)}%`,
                top: `${6 + ((i * 53) % 30)}%`,
                background: CONFETTI[i % CONFETTI.length],
                transform: `rotate(${(i * 47) % 90}deg)`,
                animationDelay: `${120 + i * 60}ms`,
              }}
            />
          ))}
        </div>
        <LevelBadge level={level} size="lg" className="mx-auto [@media(max-height:500px)]:hidden" />
        <h2 id="levelup-title" className="toon-text mt-4 text-6xl tracking-wide text-zooa-lime md:text-7xl [@media(max-height:500px)]:mt-0 [@media(max-height:500px)]:!text-4xl">
          LEVEL {level}
        </h2>
        {unlocks.length > 0 ? (
          <ul className="font-body mt-5 space-y-2 text-left text-sm [@media(max-height:500px)]:mt-3 [@media(max-height:500px)]:space-y-1.5">
            {unlocks.map((u) => (
              <li key={u} className="flex items-start gap-2 rounded-xl border-2 border-black bg-white/[0.06] px-3 py-2 text-white/85">
                <span className="text-zooa-lime" aria-hidden>
                  ✓
                </span>
                {u}
              </li>
            ))}
          </ul>
        ) : (
          <p className="font-body mt-4 text-sm text-white/70">Keep raiding: your rank on the Level board just went up.</p>
        )}
        <button ref={ok} type="button" onClick={onClose} className="toon-btn mt-6 min-h-12 w-full text-xl tracking-wide [@media(max-height:500px)]:mt-3">
          <span className="optical-center">Nice!</span>
        </button>
        {onRewards && (
          <button type="button" onClick={onRewards} className="toon-btn-ghost mt-2 min-h-11 w-full text-base tracking-wide">
            <span className="optical-center">{unlocks.some((u) => /^(Title|Name colour|Badge frame):/.test(u)) ? "Wear rewards" : "All rewards"}</span>
          </button>
        )}
      </div>
    </div>
  );
}
