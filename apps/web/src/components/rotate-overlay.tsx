"use client";

import { useSyncExternalStore } from "react";
import { isPortraitViewport } from "@/game/orientation";

function subscribe(cb: () => void): () => void {
  window.addEventListener("resize", cb);
  window.addEventListener("orientationchange", cb);
  return () => {
    window.removeEventListener("resize", cb);
    window.removeEventListener("orientationchange", cb);
  };
}
const portraitNow = () => isPortraitViewport(window.innerWidth, window.innerHeight);
const serverValue = () => false;

/** The viewport is taller than wide right now (live). */
export function usePortrait(): boolean {
  return useSyncExternalStore(subscribe, portraitNow, serverValue);
}

/**
 * "Rotate your phone": covers the raid on a touch device held upright. It sits above the HUD and
 * the panels and swallows every touch, while the renderer hides the sticks and blocks input
 * (renderer.ts `portrait`); turning back to landscape removes it and the controls re-lay.
 */
export function RotateOverlay() {
  return (
    <div
      className="absolute inset-0 z-[70] grid touch-none select-none place-items-center bg-[#0b0f0a]/95 p-6 text-center text-white"
      role="alertdialog"
      aria-label="Rotate your phone"
      data-rotate-overlay=""
      onPointerDown={(e) => e.preventDefault()}
    >
      <div className="flex flex-col items-center gap-5">
        <style>{`@keyframes spoils-turn{0%,25%{transform:rotate(0)}65%,100%{transform:rotate(-90deg)}}.spoils-turn{animation:spoils-turn 2.2s ease-in-out infinite}@media (prefers-reduced-motion:reduce){.spoils-turn{animation:none;transform:rotate(-90deg)}}`}</style>
        <svg viewBox="0 0 64 64" className="spoils-turn h-24 w-24" aria-hidden>
          <rect x="20" y="8" width="24" height="44" rx="5" fill="none" stroke="#000" strokeWidth="7" />
          <rect x="20" y="8" width="24" height="44" rx="5" fill="none" stroke="#fff" strokeWidth="3.5" />
          <path d="M28 46h8" stroke="#ccff00" strokeWidth="3.5" strokeLinecap="round" />
        </svg>
        <div>
          <p className="toon-text text-3xl tracking-wide text-zooa-lime">Rotate your phone</p>
          <p className="font-body mt-2 text-base text-white/75">SPOILS plays in landscape. The raid goes on — turn your phone sideways.</p>
        </div>
      </div>
    </div>
  );
}
