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

const LOOK: Record<Look, string> = {
  lime: "toon-btn",
  armed: "toon-btn play-stripes animate-stripes motion-reduce:animate-none",
  ghost: "toon-btn-ghost",
  grey: "inline-flex items-center justify-center rounded-2xl border-[3px] border-black bg-zinc-400 px-6 text-black shadow-[0_5px_0_#000]",
};

/**
 * The big PLAY (WORLD v6 spec §6.5): bottom centre, every PlayState of lib/lobby/play-state.ts. An
 * error keeps the base state's face and adds a red line with its fix (Fix loadout / Sign in / Try
 * again). Armed shows a Cancel under the button.
 */
export function PlayButton({ onFixInventory }: { onFixInventory: () => void }) {
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

  return (
    <div className="relative mx-auto flex w-full flex-col items-center md:w-[min(26rem,90%)]">
      {v.pulse && (
        <span
          className="pointer-events-none absolute -inset-x-3 -top-3 h-[calc(100%+1.5rem)] max-h-[7rem] rounded-[2rem] bg-zooa-lime/45 blur-xl animate-soft-glow motion-reduce:animate-none"
          aria-hidden
        />
      )}
      <button
        type="button"
        onClick={press}
        disabled={action === null}
        aria-describedby={subId}
        className={clsx(
          LOOK[v.look],
          "relative min-h-[4.5rem] w-full flex-col gap-1 py-2 md:min-h-[5.5rem]",
          // Landscape phones (≤ 500 px tall): 4 rem so the world card, gear strip and PLAY all fit.
          "[@media(max-height:500px)]:min-h-16 [@media(max-height:500px)]:gap-0 [@media(max-height:500px)]:py-1",
          "focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-zooa-lime/70 focus-visible:ring-offset-2 focus-visible:ring-offset-black",
          action === null && "cursor-default disabled:opacity-100",
          base.kind === "loading" && "opacity-60",
        )}
      >
        {/* One line always: long labels (DROPPING IN…, READY ✓ 4:59, GEAR IN RAID) get a smaller size. */}
        <span
          className={clsx(
            "flex items-center gap-3 whitespace-nowrap tabular-nums tracking-wide",
            v.label.length > 8 ? "text-3xl md:text-4xl" : "text-4xl md:text-5xl",
            "[@media(max-height:500px)]:text-3xl",
          )}
        >
          {v.spinner && <span className="h-7 w-7 animate-spin rounded-full border-4 border-black border-t-transparent motion-reduce:animate-none" aria-hidden />}
          <span className="optical-center">{v.label}</span>
        </span>
        <span id={subId} className={clsx("font-body text-sm font-bold tabular-nums [@media(max-height:500px)]:text-xs", v.amber ? "text-amber-700" : "text-black/75")}>
          {v.sub}
        </span>
      </button>

      {state.kind === "error" && (
        <p role="alert" className="font-body mt-2 flex max-w-full flex-wrap items-center justify-center gap-x-2 gap-y-1 text-center text-sm font-semibold text-rose-300">
          <span>{state.message}</span>
          {state.fix === "inventory" && (
            <button type="button" onClick={onFixInventory} className="min-h-8 rounded-lg px-1 text-zooa-lime underline underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zooa-lime">
              Fix loadout
            </button>
          )}
          {state.fix === "signin" && (
            <Link href="/auth/login?next=/play" className="min-h-8 rounded-lg px-1 text-zooa-lime underline underline-offset-4">
              Sign in
            </Link>
          )}
          {state.fix === "retry" && (
            <button type="button" onClick={join} className="min-h-8 rounded-lg px-1 text-zooa-lime underline underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zooa-lime">
              Try again
            </button>
          )}
        </p>
      )}
      {base.kind === "armed" && (
        <button type="button" onClick={disarm} className="toon-btn-ghost mt-2 min-h-10 px-5 text-sm">
          <span className="optical-center">Cancel</span>
        </button>
      )}
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
        "hidden min-h-10 items-center gap-2 whitespace-nowrap rounded-full border-[3px] border-black px-3.5 text-sm tabular-nums shadow-[0_3px_0_#000] focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-zooa-lime/70 sm:inline-flex",
        v.look === "ghost" ? "bg-white text-black" : v.look === "grey" ? "bg-zinc-400 text-black" : "bg-zooa-lime text-black",
        v.look === "armed" && "play-stripes",
      )}
    >
      <span className="optical-center">{v.label}</span>
    </button>
  );
}
