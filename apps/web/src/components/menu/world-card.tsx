"use client";

import clsx from "clsx";
import { BRAND } from "@/lib/brand";
import { useLobby, useNow } from "@/lib/lobby/lobby-context";
import { SHORT_RAID_MS } from "@/lib/lobby/play-state";
import { fmtClockS, mapLabel, secsUntil, worldView } from "@/lib/lobby/world-clock";
import { BossBadge } from "./boss-badge";

type Status = { label: string; tone: string; dot: string };

/**
 * World card (Brawl Stars "event" card above PLAY), kept to what decides a drop: the map name with its
 * number small, a status chip (OPEN lime / OFFLINE grey; ENTRY CLOSED amber and NEW MAP… white are
 * only a fallback for a wrong clock, overlapping maps keep one map open), the big wipe countdown and a
 * boss yes / no badge. Public: everyone sees it, signed in or not. Without a status the phase and
 * countdown still run from the cycle clock.
 */
export function WorldCard({ className }: { className?: string }) {
  const { status, statusError, reloadStatus } = useLobby();
  const now = useNow();
  const v = worldView(status, now);
  const offline = (statusError && !status) || v.online === false;

  const st: Status = offline
    ? { label: "OFFLINE", tone: "bg-zinc-400 text-black", dot: "bg-black/70" }
    : v.phase === "open"
      ? { label: "OPEN", tone: "bg-zooa-lime text-black", dot: "bg-black/80 animate-pulse motion-reduce:animate-none" }
      : v.phase === "closing"
        ? { label: "ENTRY CLOSED", tone: "bg-amber-300 text-black", dot: "bg-black/70" }
        : { label: "NEW MAP…", tone: "bg-white text-black", dot: "bg-black/70" };

  const open = !offline && v.phase === "open";
  const short = v.phase === "open" && v.wipeAt - now < SHORT_RAID_MS;
  const what = v.phase === "open" ? "Wipe in" : v.phase === "closing" ? "Next map in" : "New map in";
  const clock = fmtClockS(secsUntil(v.phase === "open" ? v.wipeAt : v.entryOpensAt, now));

  return (
    <section
      aria-label={`${BRAND.mapName}, ${mapLabel(v.mapNumber)}, ${st.label.toLowerCase()}`}
      className={clsx("menu-chip w-full flex-col items-stretch gap-1.5 bg-[#141a29]/95 px-3 pb-2.5 pt-2 short:gap-1 short:px-2.5 short:pb-1.5 short:pt-1.5", className)}
    >
      <div className="flex min-w-0 items-center gap-2">
        <h2 className="menu-label flex min-w-0 flex-1 items-baseline gap-1.5 text-xl leading-none tracking-wide text-white md:text-2xl short:!text-lg">
          <span className="optical-center truncate">{BRAND.mapName.toUpperCase()}</span>
          <span className="font-body shrink-0 text-xs font-bold tracking-normal text-white/55 [text-shadow:none] short:text-[0.6875rem]">
            #{v.mapNumber}
          </span>
        </h2>
        {/* OPEN is the normal case: a pulsing lime dot on phones, the word from lg up. Any other state
            always spells itself out (it changes whether PLAY drops you in). */}
        <span
          title={st.label}
          className={clsx(
            "font-body inline-flex h-6 shrink-0 items-center gap-1 rounded-full border-2 border-black text-[0.6875rem] font-extrabold uppercase leading-none tracking-wider short:h-5",
            st.tone,
            open ? "w-6 justify-center lg:w-auto lg:px-2 short:w-5" : "px-2 short:px-1.5",
          )}
        >
          <span className={clsx("h-2 w-2 shrink-0 rounded-full", st.dot)} aria-hidden />
          <span className={clsx(open && "sr-only lg:not-sr-only")}>{st.label}</span>
        </span>
      </div>

      <div className="flex items-center justify-between gap-2">
        <p role="timer" aria-live="off" className="flex min-w-0 items-baseline gap-2 whitespace-nowrap">
          <span className="font-body text-xs font-bold uppercase tracking-wider text-white/70 lg:text-[0.8125rem]">{what}</span>
          <span
            className={clsx(
              "menu-label text-[1.9rem] leading-none tabular-nums tracking-wide md:text-[2.2rem] short:!text-[1.6rem]",
              v.phase === "open" ? (short ? "text-amber-300" : "text-white") : "text-amber-200",
            )}
          >
            <span className="optical-center">{clock}</span>
          </span>
        </p>
        {!offline && <BossBadge status={status} fresh={v.fresh} />}
      </div>

      {offline && (
        <p className="font-body flex items-center gap-2 text-xs font-bold text-white/75 lg:text-[0.8125rem]">
          Server unreachable
          <button
            type="button"
            onClick={() => void reloadStatus()}
            className="min-h-8 rounded-lg px-1 text-zooa-lime underline underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zooa-lime"
          >
            Retry
          </button>
        </p>
      )}
    </section>
  );
}
