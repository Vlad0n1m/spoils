"use client";

import { useEffect, useRef, useState } from "react";
import clsx from "clsx";
import type { HudStore } from "@/game/hud";
import type { HudSnapshot } from "@/game/types";
import { TUTORIAL_STEPS, advanceTutorial, initialTutorial, tutorialHint, type TutorialSignals, type TutorialState, type TutorialStep } from "@/game/tutorial";
import { playUi } from "@/game/audio/ui-sounds";

const SKIP_KEY = "spoils.tutorialSkipped";
/** The steps shown as dots (done is the closing card). */
const DOTS = TUTORIAL_STEPS.filter((s) => s !== "done");

function signalsOf(s: HudSnapshot, now: number): TutorialSignals {
  const me = s.self;
  return {
    now,
    pose: s.pose ?? null,
    alive: Boolean(me?.alive) && (me?.extractedAt ?? 0) === 0,
    searching: Boolean(me?.search),
    npcKills: (s.killTally?.npcs ?? 0) + (s.killTally?.bosses ?? 0),
    hp: me?.hp ?? 0,
    maxHp: me?.maxHp ?? 100,
    healing: Boolean(me?.healing),
    meds: (me?.bandages ?? 0) + (me?.medkits ?? 0),
    extracting: Boolean(me?.extracting) || (me?.extractedAt ?? 0) > 0,
  };
}

function readSkipped(): boolean {
  try {
    return window.localStorage.getItem(SKIP_KEY) === "1";
  } catch {
    return false;
  }
}

/**
 * First-raid hints (alpha, GAME_DESIGN §18f): shown when the join ticket carries `tutorial` (the
 * server spawned this raider at a quiet T1 crate with a marauder post nearby). One card at a time:
 * move → aim → search → kill → heal → extract, each completing on the real event (tutorial.ts),
 * with touch wording on phones. "Skip — I know how to play" hides it for good on this device.
 * `force` (screenshots only) pins a step.
 */
export function TutorialOverlay({ store, touch, force }: { store: HudStore; touch: boolean; force?: TutorialStep }) {
  const [state, setState] = useState<TutorialState>(() => (force ? { ...initialTutorial(), step: force } : initialTutorial()));
  const [hidden, setHidden] = useState(false);
  const [flash, setFlash] = useState(false);
  const [unhurt, setUnhurt] = useState(false);
  const stateRef = useRef(state);

  useEffect(() => {
    if (!force && readSkipped()) setHidden(true);
  }, [force]);

  useEffect(() => {
    if (force || hidden) return;
    const tick = () => {
      const prev = stateRef.current;
      const snap = store.getSnapshot();
      const sig = signalsOf(snap, performance.now());
      const next = advanceTutorial(prev, sig);
      setUnhurt(next.step === "heal" && (sig.hp >= sig.maxHp || sig.meds <= 0));
      if (next !== prev) {
        stateRef.current = next;
        setState(next);
        if (next.step !== prev.step) {
          setFlash(true);
          playUi("click");
          window.setTimeout(() => setFlash(false), 900);
        }
      }
    };
    const id = window.setInterval(tick, 150);
    return () => window.clearInterval(id);
  }, [store, force, hidden]);

  // The closing card stays a few seconds, then the overlay goes.
  useEffect(() => {
    if (force || state.step !== "done") return;
    const t = window.setTimeout(() => setHidden(true), 5_000);
    return () => window.clearTimeout(t);
  }, [state.step, force]);

  if (hidden) return null;
  const step = state.step;
  const hint = tutorialHint(step, touch, step === "heal" && unhurt);
  const idx = DOTS.indexOf(step as (typeof DOTS)[number]);

  const skip = () => {
    try {
      window.localStorage.setItem(SKIP_KEY, "1");
    } catch {
      /* private mode: hidden for this raid only */
    }
    playUi("click");
    setHidden(true);
  };

  return (
    <div
      className={clsx(
        "pointer-events-none absolute z-20",
        touch ? "left-2 top-[7rem] w-[15.5rem]" : "left-3 top-[32%] w-[20rem]",
      )}
      role="status"
      aria-live="polite"
      data-testid="tutorial-overlay"
    >
      <div
        className={clsx(
          "pointer-events-auto rounded-2xl border-[3px] border-black bg-[#121826]/95 shadow-[0_4px_0_#000] transition-colors",
          touch ? "px-3 py-2.5" : "px-4 py-3",
          flash && "bg-[#173326]/95",
        )}
      >
        <div className="flex items-center justify-between gap-2">
          <p className={clsx("font-body font-bold uppercase tracking-[0.14em] text-zooa-lime", touch ? "text-xs" : "text-[0.8125rem]")}>
            {step === "done" ? "First raid" : `First raid · ${idx + 1}/${DOTS.length}`}
          </p>
          <ol className="flex gap-1" aria-hidden>
            {DOTS.map((d, i) => (
              <li
                key={d}
                className={clsx(
                  "h-2 w-2 rounded-full border border-black",
                  step === "done" || i < idx ? "bg-zooa-lime" : i === idx ? "bg-white" : "bg-white/25",
                )}
              />
            ))}
          </ol>
        </div>
        <p className={clsx("toon-text-thin mt-1 tracking-wide text-white", touch ? "text-lg leading-tight" : "text-xl")}>
          {flash && step !== "done" ? <span className="mr-1.5 text-zooa-lime">✓</span> : null}
          {hint.title}
        </p>
        <p className={clsx("font-body mt-1 leading-snug text-white/90", touch ? "text-[0.8125rem]" : "text-sm")}>{hint.text}</p>
        {step !== "done" && (
          <button
            type="button"
            onClick={skip}
            className={clsx(
              "font-body mt-2 inline-flex min-h-9 items-center rounded-lg px-2 -mx-2 font-semibold text-white/80 underline decoration-white/40 underline-offset-2 hover:text-white focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-zooa-lime/70",
              touch ? "text-xs" : "text-[0.8125rem]",
            )}
          >
            Skip — I know how to play
          </button>
        )}
      </div>
    </div>
  );
}
