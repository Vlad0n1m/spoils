"use client";

import { useEffect, useId, useRef, useState } from "react";
import Link from "next/link";
import clsx from "clsx";
import { usePlay } from "@/lib/lobby/lobby-context";
import { playAction, type PlayState } from "@/lib/lobby/play-state";
import { fmtClockS } from "@/lib/lobby/world-clock";

type Look = "lime" | "ghost" | "grey" | "armed";

interface View {
  label: string;
  sub: string;
  look: Look;
  pulse: boolean;
  amber?: boolean;
  spinner?: boolean;
}

/** Label, sub-line and look of a PLAY state (spec §6.5 table; UI copy is English). */
export function playView(s: Exclude<PlayState, { kind: "error" }>): View {
  switch (s.kind) {
    case "loading":
      return { label: "PLAY", sub: "…", look: "grey", pulse: false };
    case "signed_out":
      return { label: "PLAY", sub: "Sign in or play as guest", look: "lime", pulse: false };
    case "offline":
      return { label: "OFFLINE", sub: "World server unreachable · press to retry", look: "grey", pulse: false };
    case "ready":
      return { label: "PLAY", sub: s.sub, look: "lime", pulse: true, amber: s.tone === "amber" };
    case "joining":
      return { label: "DROPPING IN…", sub: "Locking your loadout", look: "lime", pulse: false, spinner: true };
    case "closed":
      return { label: `${s.label} ${fmtClockS(s.nextInS)}`, sub: "Press to drop in when it opens", look: "ghost", pulse: false };
    case "armed":
      return {
        label: s.nextInS > 0 ? `READY ✓ ${fmtClockS(s.nextInS)}` : "READY ✓",
        sub: s.nextInS > 0 ? "You'll drop in when the new map opens" : "The map is open — dropping in",
        look: "armed",
        pulse: false,
      };
    case "rejoin":
      return { label: "REJOIN", sub: "Your raider is still on the map", look: "lime", pulse: true };
    case "gear_in_raid":
      return {
        label: "GEAR IN RAID",
        sub: s.settlesAtLocal ? `Comes back when the raid settles · by ${s.settlesAtLocal}` : "Comes back when the raid settles",
        look: "grey",
        pulse: false,
      };
  }
}

/** One sentence for the menu's polite live region when the PLAY state changes kind. */
function announceOf(s: PlayState): string {
  const b = s.kind === "error" ? s.base : s;
  const extra = s.kind === "error" ? ` ${s.message}` : "";
  switch (b.kind) {
    case "ready":
      return `The map is open.${extra}`;
    case "closed":
      return `${b.label === "NEW MAP" ? "A new map is starting." : "Entry closed."} Next map in ${Math.max(1, Math.round(b.nextInS / 60))} minutes.${extra}`;
    case "armed":
      return "Ready. You'll drop in when the new map opens.";
    case "rejoin":
      return "Your raider is still on the map.";
    case "gear_in_raid":
      return "Your gear is still in a raid.";
    case "offline":
      return "World server unreachable.";
    case "joining":
      return "Dropping in.";
    default:
      return extra.trim();
  }
}

/**
 * The big PLAY (Brawl Stars layout): bottom right, a huge bevelled yellow button (sky blue to arm for
 * the next map, lime stripes once armed, grey when nothing can be done; globals.css `.play-btn`) with
 * the state's sub-line inside it. Every PlayState of lib/lobby/play-state.ts. An error keeps the base
 * state's face and adds a red bubble above with its fix (Fix loadout / Sign in / Try again). Armed
 * shows a Cancel tab on the button's top edge.
 */
export function PlayButton({ onFixInventory, className }: { onFixInventory: () => void; className?: string }) {
  const { state, press, disarm, join } = usePlay();
  const base = state.kind === "error" ? state.base : state;
  const v = playView(base);
  const action = playAction(state);
  const subId = useId();

  const [said, setSaid] = useState("");
  const lastKind = useRef<string>("");
  const kindKey = state.kind === "error" ? `error:${state.base.kind}:${state.message}` : state.kind;
  useEffect(() => {
    if (lastKind.current === kindKey) return;
    const first = lastKind.current === "";
    lastKind.current = kindKey;
    if (!first) setSaid(announceOf(state));
    // Announce kind changes only, never the per-second countdown.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kindKey]);

  const long = v.label.length > 8;
  return (
    <div className={clsx("relative flex w-full flex-col items-stretch", className)}>
      {state.kind === "error" && (
        <p
          role="alert"
          className="font-body mb-3 flex max-w-full flex-wrap items-center justify-center gap-x-2 gap-y-1 rounded-2xl border-[3px] border-black bg-rose-500 px-3 py-1.5 text-center text-sm font-bold text-white shadow-[0_3px_0_#000] short:mb-2 short:py-1 short:text-xs"
        >
          <span>{state.message}</span>
          {state.fix === "inventory" && (
            <button type="button" onClick={onFixInventory} className="min-h-8 rounded-lg px-1 text-black underline underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white">
              Fix loadout
            </button>
          )}
          {state.fix === "signin" && (
            <Link href="/auth/login?next=/play" className="min-h-8 rounded-lg px-1 text-black underline underline-offset-4">
              Sign in
            </Link>
          )}
          {state.fix === "retry" && (
            <button type="button" onClick={join} className="min-h-8 rounded-lg px-1 text-black underline underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white">
              Try again
            </button>
          )}
        </p>
      )}
      <div className="relative">
        {v.pulse && (
          <span className="pointer-events-none absolute -inset-3 rounded-[2.2rem] bg-amber-300/50 blur-xl animate-soft-glow motion-reduce:animate-none" aria-hidden />
        )}
        <button
          type="button"
          onClick={press}
          disabled={action === null}
          aria-describedby={subId}
          data-look={v.look}
          className={clsx(
            "play-btn h-[6.75rem] w-full gap-1.5 px-4 md:h-[7.5rem] short:!h-[5.6rem] short:gap-1 tiny:!h-[5rem]",
            "focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-white focus-visible:ring-offset-2 focus-visible:ring-offset-black",
            v.look === "armed" && "animate-stripes motion-reduce:animate-none",
            action === null && "cursor-default",
            base.kind === "loading" && "opacity-70",
          )}
        >
          {/* One line always: long labels (DROPPING IN…, READY ✓ 4:59, GEAR IN RAID) get a smaller size. */}
          <span
            className={clsx(
              "toon-text flex items-center gap-3 whitespace-nowrap leading-none tabular-nums tracking-wide text-white [text-shadow:0_0.08em_0_#000]",
              long ? "text-[2.1rem] md:text-[2.5rem] short:!text-[1.9rem] tiny:!text-[1.7rem]" : "text-[3.2rem] md:text-[3.8rem] short:!text-[2.8rem] tiny:!text-[2.5rem]",
            )}
          >
            {v.spinner && <span className="h-7 w-7 animate-spin rounded-full border-4 border-black border-t-transparent motion-reduce:animate-none" aria-hidden />}
            <span className="optical-center">{v.label}</span>
          </span>
          <span
            id={subId}
            className={clsx(
              "font-body line-clamp-2 max-w-full px-1 text-center text-sm font-extrabold leading-tight tabular-nums short:text-xs",
              v.amber ? "text-red-800" : "text-black/75",
            )}
          >
            {v.sub}
          </span>
        </button>
        {base.kind === "armed" && (
          <button
            type="button"
            onClick={disarm}
            className="menu-chip absolute -top-4 right-3 h-9 bg-white px-3 text-sm text-black focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-zooa-lime/70"
          >
            <span className="optical-center">✕ Cancel</span>
          </button>
        )}
      </div>
      <p className="sr-only" aria-live="polite">
        {said}
      </p>
    </div>
  );
}

/**
 * Small PLAY state chip for panel headers: someone armed for the next map and reading the
 * leaderboard still sees the countdown, and can press it like the big button.
 */
export function PlayMiniChip() {
  const { state, press } = usePlay();
  const base = state.kind === "error" ? state.base : state;
  if (base.kind === "loading" || base.kind === "signed_out") return null;
  const v = playView(base);
  const action = playAction(state);
  return (
    <button
      type="button"
      onClick={press}
      disabled={action === null}
      title={v.sub}
      className={clsx(
        "menu-chip hidden min-h-11 gap-2 whitespace-nowrap px-4 text-base tabular-nums focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-zooa-lime/70 sm:inline-flex",
        v.look === "ghost"
          ? "bg-[linear-gradient(180deg,#d4f1ff,#55b8f0)] text-black"
          : v.look === "grey"
            ? "bg-zinc-400 text-black"
            : v.look === "armed"
              ? "play-stripes bg-zooa-lime text-black"
              : "bg-[linear-gradient(180deg,#fff27a,#ffd91f_45%,#ffb800)] text-black",
      )}
    >
      <span className="optical-center">{v.label}</span>
    </button>
  );
}
