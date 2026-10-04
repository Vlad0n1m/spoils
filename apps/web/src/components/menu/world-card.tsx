"use client";

import clsx from "clsx";
import { WORLD } from "@extract/shared";
import { BRAND } from "@/lib/brand";
import { useLobby, useNow } from "@/lib/lobby/lobby-context";
import { SHORT_RAID_MS } from "@/lib/lobby/play-state";
import { fmtClockS, fmtLocalHm, mapLabel, secsUntil, worldView } from "@/lib/lobby/world-clock";
import { BossBanner } from "./boss-banner";

type Chip = { label: string; band: string };

/**
 * How long after the map opens an empty map still reads "loot is untouched": nobody can have carried
 * anything out before their extract arms.
 */
const UNTOUCHED_MS = WORLD.EXTRACT_ARM_MS;

/**
 * World card (Brawl Stars "event" card above PLAY): a band coloured by the phase (OPEN lime /
 * ENTRY CLOSED amber / NEW MAP… white / OFFLINE grey) with the map number, the map name, the big
 * countdown, raiders on the map with the local wipe time, the cycle bar (tall screens) and the boss
 * line. Public: everyone sees it, signed in or not. Without a status the phase and countdown still
 * run from the cycle clock.
 */
export function WorldCard({ className }: { className?: string }) {
  const { status, statusError, reloadStatus } = useLobby();
  const now = useNow();
  const v = worldView(status, now);
  const offline = (statusError && !status) || v.online === false;
  const loading = !status && !statusError;

  const chip: Chip = offline
    ? { label: "OFFLINE", band: "bg-[linear-gradient(180deg,#d4d4d8,#a1a1aa)] text-black" }
    : v.phase === "open"
      ? { label: "OPEN", band: "bg-[linear-gradient(180deg,#f0ff7a,#ccff00_55%,#a6d400)] text-black" }
      : v.phase === "closing"
        ? { label: "ENTRY CLOSED", band: "bg-[linear-gradient(180deg,#fde68a,#fbbf24)] text-black" }
        : { label: "NEW MAP…", band: "bg-[linear-gradient(180deg,#ffffff,#d4d4d8)] text-black" };

  const short = v.phase === "open" && v.wipeAt - now < SHORT_RAID_MS;
  const what = v.phase === "open" ? "Wipe in" : v.phase === "closing" ? "Next map in" : "New map in";
  const clock = fmtClockS(secsUntil(v.phase === "open" ? v.wipeAt : v.entryOpensAt, now));
  const side = v.phase === "open" ? `wipes at ${fmtLocalHm(v.wipeAt)}` : `opens at ${fmtLocalHm(v.entryOpensAt)}`;

  // "Loot is untouched" only holds early: later an empty map may already have been looted by raiders
  // who left (the status counts who is on the map now, not who was).
  const fresh = now - v.openAt < UNTOUCHED_MS;
  const raiders =
    v.humans === null
      ? null
      : v.humans === 0
        ? fresh
          ? "Empty · loot untouched"
          : "Nobody on the map"
        : `${v.humans} on the map`;

  return (
    <section
      aria-label={`${BRAND.mapName}, ${mapLabel(v.mapNumber)}`}
      className={clsx("menu-chip w-full flex-col items-stretch overflow-hidden bg-[#141a29]/95", className)}
    >
      <div className={clsx("flex items-center justify-between gap-2 border-b-[3px] border-black px-3 py-1.5 short:py-1", chip.band)}>
        <span className="flex items-center gap-1.5 text-sm leading-none tracking-wider short:text-xs">
          <span className={clsx("h-2.5 w-2.5 rounded-full border-2 border-black bg-black/80", v.phase === "open" && !offline && "animate-pulse motion-reduce:animate-none")} aria-hidden />
          <span className="optical-center">{chip.label}</span>
        </span>
        <span className="text-xs lg:text-[0.8125rem] leading-none tracking-wider text-black/70">
          <span className="optical-center">{mapLabel(v.mapNumber).toUpperCase()}</span>
        </span>
      </div>

      <div className="flex flex-col gap-1 px-3 pb-2.5 pt-2 short:gap-0.5 short:pb-1.5 short:pt-1.5">
        <h2 className="menu-label truncate text-xl leading-none tracking-wide text-white md:text-2xl short:!text-lg">
          <span className="optical-center">{BRAND.mapName.toUpperCase()}</span>
        </h2>
        <p role="timer" aria-live="off" className="flex items-baseline gap-2 whitespace-nowrap">
          <span className="font-body text-xs lg:text-[0.8125rem] font-bold uppercase tracking-wider text-white/75">{what}</span>
          <span
            className={clsx(
              "menu-label text-[1.7rem] leading-none tabular-nums tracking-wide md:text-[2rem] short:!text-[1.45rem]",
              v.phase === "open" ? (short ? "text-amber-300" : "text-white") : "text-amber-200",
            )}
          >
            <span className="optical-center">{clock}</span>
          </span>
        </p>

        <div className="relative mt-1 h-2.5 overflow-hidden rounded-full border-2 border-black bg-black/55 short:hidden [@media(max-height:620px)]:hidden" aria-hidden>
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

        <div className="font-body flex min-h-5 flex-wrap items-center justify-between gap-x-2 gap-y-0.5 text-xs lg:text-[0.8125rem] font-bold text-white/75">
          {offline ? (
            <span className="flex items-center gap-2">
              Server unreachable
              <button
                type="button"
                onClick={() => void reloadStatus()}
                className="min-h-8 rounded-lg px-1 text-zooa-lime underline underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zooa-lime"
              >
                Retry
              </button>
            </span>
          ) : loading ? (
            <span className="h-3.5 w-28 animate-pulse rounded bg-white/10 motion-reduce:animate-none" aria-hidden />
          ) : raiders ? (
            <span className="flex min-w-0 items-center gap-1.5">
              <span className={clsx("h-2.5 w-2.5 shrink-0 rounded-full border-2 border-black", v.humans ? "bg-zooa-lime" : "bg-white/40")} aria-hidden />
              <span className="truncate">{raiders}</span>
              {v.humans !== null && v.humans >= v.capacity && <span className="text-amber-300">· full</span>}
            </span>
          ) : (
            <span />
          )}
          <span className="shrink-0 tabular-nums text-white/70">{side}</span>
        </div>

        <div className="mt-1 empty:hidden">
          <BossBanner status={status} fresh={v.fresh} />
        </div>
      </div>
    </section>
  );
}
