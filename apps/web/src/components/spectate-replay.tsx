"use client";

/**
 * After-death screens over the canvas:
 * - ReplayOverlay: the "REPLAY" vignette, progress and Skip while the death replay plays
 *   (game/killcam.ts draws it on the canvas from this client's own record).
 * - SpectateBar: "SPECTATING" chip with the watched party mate's name and bars, Next mate,
 *   Results and Back to lobby (the server mirrors the mate's view, sim/spectate.ts).
 * Both read throttled slices of the HUD store; nothing here touches the room.
 */

import { useEffect } from "react";
import clsx from "clsx";
import { shallowEqual, type HudStore } from "@/game/hud";
import type { HudSnapshot } from "@/game/types";
import { useHud } from "./hud";

export { nextMateKey, spectateEndedLine } from "@/game/spectate-ui";

const replayProgressSlice = (s: HudSnapshot) => s.replay?.progress ?? 0;

export function ReplayOverlay({ store, onSkip }: { store: HudStore; onSkip: () => void }) {
  const progress = useHud(store, replayProgressSlice);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" || e.key === " " || e.key === "Enter") {
        e.preventDefault();
        onSkip();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onSkip]);
  return (
    <div className="pointer-events-none fixed inset-0 z-[90] select-none text-white" aria-live="polite">
      {/* Vignette and thin film bars: it reads as a recording, not the live raid. */}
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_center,transparent_52%,rgba(4,6,10,0.72))]" aria-hidden />
      <div className="absolute inset-x-0 top-0 h-[6vh] max-h-12 bg-black/85" aria-hidden />
      <div className="absolute inset-x-0 bottom-0 h-[6vh] max-h-12 bg-black/85" aria-hidden />
      <div className="absolute left-4 top-[calc(min(6vh,3rem)+0.75rem)] flex items-center gap-2 short:top-[calc(min(6vh,3rem)+0.4rem)]">
        <span className="toon-chip flex items-center gap-2 px-3 py-1">
          <span className="h-2.5 w-2.5 animate-pulse rounded-full bg-rose-500" aria-hidden />
          <span className="toon-text-thin text-lg tracking-[0.3em]">REPLAY</span>
        </span>
        <span className="font-body text-sm font-semibold text-white/75 short:hidden">Your last moments</span>
      </div>
      <div className="absolute inset-x-0 bottom-[calc(min(6vh,3rem)+0.75rem)] flex items-center justify-center gap-3 px-4 short:bottom-[calc(min(6vh,3rem)+0.4rem)]">
        <div className="h-2 w-48 overflow-hidden rounded-full border-2 border-black bg-black/60 sm:w-72" aria-hidden>
          <div className="h-full rounded-full bg-rose-400" style={{ width: `${Math.round(progress * 100)}%` }} />
        </div>
        <button
          type="button"
          onClick={onSkip}
          className="toon-btn-ghost pointer-events-auto min-h-10 px-4 text-base tracking-wide"
        >
          Skip <span className="ml-1.5 hidden text-xs text-black/50 sm:inline">Space</span>
        </button>
      </div>
    </div>
  );
}

function watchSlice(s: HudSnapshot) {
  const sp = s.spectate;
  const w = sp?.watching;
  return {
    key: w?.key ?? null,
    name: w?.name ?? "",
    alive: w?.alive ?? true,
    hp: w?.hp ?? 0,
    maxHp: w?.maxHp ?? 100,
    armor: w?.armor ?? 0,
    armorDur: w?.armorDur ?? 0,
    armorMax: w?.armorMax ?? 0,
    pending: sp?.pending ?? false,
    mates: sp?.mates.length ?? 0,
  };
}

export function SpectateBar({
  store,
  touch,
  onNext,
  onStop,
  onLeave,
}: {
  store: HudStore;
  touch: boolean;
  onNext: () => void;
  onStop: () => void;
  onLeave: () => void;
}) {
  const w = useHud(store, watchSlice, shallowEqual);
  const hpPct = w.maxHp > 0 ? Math.max(0, Math.min(100, (w.hp / w.maxHp) * 100)) : 0;
  const arPct = w.armorMax > 0 ? Math.max(0, Math.min(100, (w.armorDur / w.armorMax) * 100)) : 0;
  return (
    <div className="pointer-events-none fixed inset-0 z-[90] select-none text-white">
      <div className={clsx("absolute left-1/2 flex -translate-x-1/2 flex-col items-center", touch ? "top-12 origin-top scale-[0.85]" : "top-16")}>
        <div className="toon-panel flex min-w-[15rem] items-center gap-3 px-3 py-2" aria-live="polite">
          <span className="rounded-lg border-2 border-black bg-sky-400 px-2 py-0.5 text-xs font-bold tracking-[0.2em] text-black">
            SPECTATING
          </span>
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <p className="toon-text-thin truncate text-lg leading-none tracking-wide">
              {w.key ? w.name : w.pending ? "Connecting…" : "—"}
            </p>
            {w.key && (
              <div className="flex items-center gap-2" title={`${w.hp} / ${w.maxHp} HP`}>
                <div className="h-2.5 w-28 overflow-hidden rounded-full border-2 border-black bg-black/60">
                  <div
                    className={clsx("h-full rounded-full", hpPct > 35 ? "bg-zooa-lime" : "bg-rose-500")}
                    style={{ width: `${hpPct}%` }}
                  />
                </div>
                <span className="font-body text-xs font-semibold tabular-nums text-white/80">{w.hp}</span>
                {w.armor > 0 && (
                  <div className="h-2 w-12 overflow-hidden rounded-full border-2 border-black bg-black/60" title={`Armor ${w.armor}`}>
                    <div className="h-full rounded-full bg-sky-300" style={{ width: `${arPct}%` }} />
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
      <div className={clsx("absolute inset-x-0 flex items-center justify-center gap-2 px-4", touch ? "bottom-2" : "bottom-5")}>
        {w.mates > 1 && (
          <button type="button" onClick={onNext} className="toon-btn-ghost pointer-events-auto min-h-11 px-4 text-base tracking-wide">
            Next mate ›
          </button>
        )}
        <button type="button" onClick={onStop} className="toon-btn-ghost pointer-events-auto min-h-11 px-4 text-base tracking-wide">
          Results
        </button>
        <button type="button" onClick={onLeave} className="toon-btn pointer-events-auto min-h-11 px-5 text-base tracking-wide">
          Back to lobby
        </button>
      </div>
    </div>
  );
}
