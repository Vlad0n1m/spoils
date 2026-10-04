"use client";

import clsx from "clsx";
import { WORLD } from "@extract/shared";
import { BRAND } from "@/lib/brand";
import { useLobby, useNow } from "@/lib/lobby/lobby-context";
import { SHORT_RAID_MS } from "@/lib/lobby/play-state";
import { fmtClockS, fmtLocalHm, secsUntil, worldView } from "@/lib/lobby/world-clock";
import { BossBanner } from "./boss-banner";

type Chip = { label: string; tone: string };

/**
 * How long after the map opens an empty map still reads "loot is untouched": nobody can have carried
 * anything out before their extract arms.
 */
const UNTOUCHED_MS = WORLD.EXTRACT_ARM_MS;

/**
 * World card (WORLD v6 spec §6.4): map name and number, phase chip (OPEN / ENTRY CLOSED / NEW MAP…
 * / OFFLINE), the countdown with the local wipe time, the cycle bar, raiders on the map and the boss
 * banner. Public: everyone sees it, signed in or not. Without a status the phase and countdown
 * still run from the cycle clock.
 */
export function WorldCard() {
  const { status, statusError, reloadStatus } = useLobby();
  const now = useNow();
  const v = worldView(status, now);
  const offline = (statusError && !status) || v.online === false;
  const loading = !status && !statusError;

  const chip: Chip = offline
    ? { label: "OFFLINE", tone: "bg-zinc-400 text-black" }
    : v.phase === "open"
      ? { label: "OPEN", tone: "bg-zooa-lime text-black" }
      : v.phase === "closing"
        ? { label: "ENTRY CLOSED", tone: "bg-amber-300 text-black" }
        : { label: "NEW MAP…", tone: "bg-white text-black" };

  const short = v.phase === "open" && v.wipeAt - now < SHORT_RAID_MS;
  const main =
    v.phase === "open"
      ? `Wipe in ${fmtClockS(secsUntil(v.wipeAt, now))}`
      : v.phase === "closing"
        ? `Next map in ${fmtClockS(secsUntil(v.entryOpensAt, now))}`
        : `New map in ${fmtClockS(secsUntil(v.entryOpensAt, now))}`;
  const side = v.phase === "open" ? `wipes at ${fmtLocalHm(v.wipeAt)}` : `opens at ${fmtLocalHm(v.entryOpensAt)}`;

  // "Loot is untouched" only holds early: later an empty map may already have been looted by raiders
  // who left (the status counts who is on the map now, not who was).
  const fresh = now - v.openAt < UNTOUCHED_MS;
  const raiders =
    v.humans === null
      ? null
      : v.humans === 0
        ? fresh
          ? "Map is empty — loot is untouched"
          : "Nobody on the map right now"
        : `${v.humans} ${v.humans === 1 ? "raider" : "raiders"} on the map`;

  return (
    <section
      aria-label={`${BRAND.mapName}, map ${v.mapNumber}`}
      className="toon-panel mx-auto w-full max-w-xl bg-[#121722]/90 p-3 backdrop-blur-sm md:p-4"
    >
      <div className="flex items-center justify-between gap-3">
        <h2 className="min-w-0 truncate text-base tracking-wide text-white md:text-lg">
          <span className="optical-center">
            {BRAND.mapName.toUpperCase()} <span className="text-white/50">·</span> Map #{v.mapNumber}
          </span>
        </h2>
        <span className={clsx("inline-flex shrink-0 items-center gap-1.5 rounded-full border-[3px] border-black px-2.5 py-1 text-[0.7rem] tracking-[0.12em] shadow-[0_2px_0_#000]", chip.tone)}>
          <span className={clsx("h-2 w-2 rounded-full bg-black", v.phase === "open" && !offline && "animate-pulse motion-reduce:animate-none")} aria-hidden />
          {chip.label}
        </span>
      </div>

      <div className="mt-2 flex items-baseline justify-between gap-3">
        <p
          role="timer"
          aria-live="off"
          className={clsx(
            "toon-text-thin text-2xl tabular-nums tracking-wide md:text-[2rem]",
            v.phase === "open" ? (short ? "text-amber-300" : "text-white") : "text-amber-200",
          )}
        >
          {main}
        </p>
        <p className="font-body shrink-0 text-xs font-semibold tabular-nums text-white/60">{side}</p>
      </div>

      <div className="relative mt-2.5 hidden h-3 overflow-hidden rounded-full border-2 border-black bg-black/55 md:block [@media(max-height:640px)]:hidden" aria-hidden>
        <span
          className={clsx(
            "absolute inset-y-0 left-0",
            offline ? "bg-zinc-500" : v.phase === "closing" ? "bg-amber-300" : short ? "bg-amber-300" : v.phase === "resetting" ? "bg-white/50" : "bg-zooa-lime",
          )}
          style={{ width: `${v.elapsed * 100}%` }}
        />
        <span
          className="absolute inset-y-0 right-0 bg-[repeating-linear-gradient(-45deg,rgba(251,191,36,0.45)_0_4px,transparent_4px_8px)]"
          style={{ left: `${v.closeMark * 100}%` }}
        />
        <span className="absolute inset-y-0 w-0.5 bg-black" style={{ left: `${v.closeMark * 100}%` }} />
      </div>

      <div className="mt-2 flex min-h-5 items-center justify-between gap-3">
        {offline ? (
          <p className="font-body flex items-center gap-2 text-sm text-white/75">
            World server unreachable.
            <button
              type="button"
              onClick={() => void reloadStatus()}
              className="min-h-8 rounded-lg px-1 text-zooa-lime underline underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zooa-lime"
            >
              Retry
            </button>
          </p>
        ) : loading ? (
          <span className="h-4 w-44 animate-pulse rounded bg-white/10 motion-reduce:animate-none" aria-hidden />
        ) : raiders ? (
          <p className="font-body flex items-center gap-2 text-sm font-semibold text-white/80">
            <span className={clsx("h-2.5 w-2.5 rounded-full border-2 border-black", v.humans ? "bg-zooa-lime" : "bg-white/40")} aria-hidden />
            {raiders}
            {v.humans !== null && v.humans >= v.capacity && <span className="text-amber-300">· full</span>}
          </p>
        ) : (
          <span />
        )}
      </div>

      <div className="mt-2.5 empty:hidden">
        <BossBanner status={status} fresh={v.fresh} />
      </div>
    </section>
  );
}
