"use client";

import { useEffect, useRef } from "react";
import { playUi } from "@/game/audio/ui-sounds";
import { LevelBadge } from "./level-badge";

const CONFETTI = ["#CCFF00", "#fbbf24", "#4cc9ff", "#f43f5e", "#b07bff", "#ffffff"];

/**
 * New level (WORLD v6 spec §6.6): "LEVEL 8" with what it unlocks (`unlocksBetween` from
 * lib/lobby/levels.ts), CSS-only confetti, the coin sound once. Escape or "Nice!" closes it.
 */
export function LevelUpModal({ level, unlocks, onClose }: { level: number; unlocks: string[]; onClose: () => void }) {
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
      <div className="toon-panel relative w-full max-w-sm overflow-hidden bg-[#161b28] p-7 text-center animate-pop-in motion-reduce:animate-none">
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
        <LevelBadge level={level} size="lg" className="mx-auto" />
        <h2 id="levelup-title" className="toon-text mt-4 text-6xl tracking-wide text-zooa-lime md:text-7xl">
          LEVEL {level}
        </h2>
        {unlocks.length > 0 ? (
          <ul className="font-body mt-5 space-y-2 text-left text-sm">
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
        <button ref={ok} type="button" onClick={onClose} className="toon-btn mt-6 min-h-12 w-full text-xl tracking-wide">
          <span className="optical-center">Nice!</span>
        </button>
      </div>
    </div>
  );
}
