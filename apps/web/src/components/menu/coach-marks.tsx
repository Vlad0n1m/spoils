"use client";

import { useCallback, useEffect, useLayoutEffect, useState } from "react";
import { playUi } from "@/game/audio/ui-sounds";

const DONE_KEY = "spoils.coachDone";

interface CoachStep {
  /** data-coach value of the target (the first visible one wins: tile grid or phone dock). */
  id: "play" | "inventory" | "shop";
  title: string;
  text: string;
}

export const COACH_STEPS: readonly CoachStep[] = [
  { id: "play", title: "Drop in", text: "PLAY drops you onto the live map. Loot, fight, and reach an extract before the wipe to keep what you carry." },
  { id: "inventory", title: "Your gear", text: "Pick what you take into the raid here. Anything you bring in can be lost if you die." },
  { id: "shop", title: "Shop", text: "Traders sell gear for CR, and the market is where raiders trade what they extract." },
];

function readDone(): boolean {
  try {
    return window.localStorage.getItem(DONE_KEY) === "1";
  } catch {
    return false;
  }
}

function targetOf(id: string): HTMLElement | null {
  for (const el of document.querySelectorAll<HTMLElement>(`[data-coach="${id}"]`)) {
    const r = el.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) return el;
  }
  return null;
}

type Box = { x: number; y: number; w: number; h: number };

/**
 * First-visit coach marks of the main menu (alpha, GAME_DESIGN §18f): PLAY, then Inventory, then
 * Shop — a lit ring around the real control and a short bubble next to it. "Next" walks on, "Skip
 * tips" or the last "Got it" ends it for good on this device (localStorage). Paused while a panel,
 * sheet or modal is open (`paused`). Clicks go through to the menu: nothing is blocked.
 */
export function CoachMarks({ paused }: { paused: boolean }) {
  const [step, setStep] = useState<number | null>(null);
  const [box, setBox] = useState<Box | null>(null);
  const [vw, setVw] = useState(0);
  const [vh, setVh] = useState(0);

  useEffect(() => {
    if (!readDone()) setStep(0);
  }, []);

  const measure = useCallback(() => {
    if (step === null) return;
    const el = targetOf(COACH_STEPS[step]!.id);
    setVw(window.innerWidth);
    setVh(window.innerHeight);
    if (!el) {
      setBox(null);
      return;
    }
    const r = el.getBoundingClientRect();
    setBox({ x: r.left, y: r.top, w: r.width, h: r.height });
  }, [step]);

  useLayoutEffect(() => {
    measure();
    if (step === null) return;
    // The menu settles (fonts, art, the world card) in the first second: re-measure a few times.
    const ts = [150, 600, 1500].map((ms) => window.setTimeout(measure, ms));
    window.addEventListener("resize", measure);
    return () => {
      ts.forEach((t) => window.clearTimeout(t));
      window.removeEventListener("resize", measure);
    };
  }, [measure, step, paused]);

  const finish = useCallback(() => {
    try {
      window.localStorage.setItem(DONE_KEY, "1");
    } catch {
      /* private mode: tips come back next visit */
    }
    setStep(null);
  }, []);

  if (step === null || paused || !box) return null;
  const s = COACH_STEPS[step]!;
  const last = step === COACH_STEPS.length - 1;
  const pad = 6;
  const ring = { left: box.x - pad, top: box.y - pad, width: box.w + 2 * pad, height: box.h + 2 * pad };

  // Bubble: beside the target on the side with more room, clamped to the screen.
  const bw = Math.min(288, vw - 24);
  const right = box.x + box.w / 2 < vw / 2;
  let left = right ? ring.left + ring.width + 12 : ring.left - bw - 12;
  let top = ring.top;
  if (left < 12 || left + bw > vw - 12) {
    // No room beside it (portrait phones): above or below instead.
    left = Math.max(12, Math.min(vw - bw - 12, box.x + box.w / 2 - bw / 2));
    top = box.y > vh / 2 ? ring.top - 160 : ring.top + ring.height + 12;
  }
  top = Math.max(12, Math.min(vh - 172, top));

  return (
    <div className="pointer-events-none fixed inset-0 z-40" aria-live="polite">
      <div
        className="absolute rounded-2xl border-[3px] border-zooa-lime shadow-[0_0_0_9999px_rgba(4,6,10,0.55),0_0_24px_rgba(204,255,0,0.6)]"
        style={ring}
        aria-hidden
      />
      <div
        role="dialog"
        aria-label={`Tip ${step + 1} of ${COACH_STEPS.length}: ${s.title}`}
        className="toon-panel pointer-events-auto absolute bg-[#121826] p-3 animate-pop-in motion-reduce:animate-none"
        style={{ left, top, width: bw }}
      >
        <p className="font-body text-xs font-bold uppercase tracking-[0.14em] text-zooa-lime">
          Tip {step + 1}/{COACH_STEPS.length}
        </p>
        <p className="toon-text-thin mt-0.5 text-xl tracking-wide text-white">{s.title}</p>
        <p className="font-body mt-1 text-sm leading-snug text-white/90">{s.text}</p>
        <div className="mt-2.5 flex items-center justify-between gap-2">
          <button
            type="button"
            onClick={() => {
              playUi("click");
              finish();
            }}
            className="font-body min-h-11 rounded-lg px-2 -mx-2 text-sm font-semibold text-white/80 underline decoration-white/40 underline-offset-2 hover:text-white focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-zooa-lime/70"
          >
            Skip tips
          </button>
          <button
            type="button"
            autoFocus
            onClick={() => {
              playUi("click");
              if (last) finish();
              else setStep(step + 1);
            }}
            className="toon-btn min-h-11 px-5 text-base"
          >
            <span className="optical-center">{last ? "Got it" : "Next"}</span>
          </button>
        </div>
      </div>
    </div>
  );
}
