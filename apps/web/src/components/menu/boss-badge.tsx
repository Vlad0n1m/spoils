"use client";

import { useEffect, useRef, useState } from "react";
import clsx from "clsx";
import type { WorldStatusDto } from "@extract/shared";
import { playUi } from "@/game/audio/ui-sounds";

function Skull({ crossed = false }: { crossed?: boolean }) {
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4 shrink-0 short:h-3.5 short:w-3.5" aria-hidden>
      <path
        d="M12 2.5c-4.7 0-8 3.2-8 7.6 0 2.6 1.2 4.4 3 5.5V19a1.5 1.5 0 0 0 1.5 1.5h7A1.5 1.5 0 0 0 17 19v-3.4c1.8-1.1 3-2.9 3-5.5 0-4.4-3.3-7.6-8-7.6z"
        fill="currentColor"
        stroke="#000"
        strokeWidth="2"
        strokeLinejoin="round"
      />
      <circle cx="8.9" cy="10.6" r="2" fill="#000" />
      <circle cx="15.1" cy="10.6" r="2" fill="#000" />
      <path d="M12 13.4l-1.1 2h2.2z" fill="#000" />
      <path d="M10 20.5v-2.2M14 20.5v-2.2" stroke="#000" strokeWidth="1.6" />
      {crossed && <path d="M3.5 21L20.5 3" stroke="#000" strokeWidth="2.6" strokeLinecap="round" />}
    </svg>
  );
}

const BADGE =
  "menu-label inline-flex h-8 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-xl border-[3px] border-black px-2 text-sm leading-none tracking-wider short:h-7 short:px-1.5 short:text-xs";

/**
 * Boss badge of the world card (WORLD v6 spec §6.4): a yes / no answer at a glance. Alive → a rose
 * "BOSS" badge with a skull (name, zone, tier and guards in the tooltip and the screen-reader label);
 * killed → a grey "BOSS DOWN"; no boss → a muted "No boss". Overlapping maps: the next map's boss is
 * revealed when that map opens, so it shows up here as the open map's own boss. A boss that appears
 * while the menu is open drops in once with a shake. Only a status of the current map (`fresh`)
 * counts: a stale one would announce the previous map's boss.
 */
export function BossBadge({ status, fresh }: { status: WorldStatusDto | null; fresh: boolean }) {
  const boss = fresh ? (status?.boss ?? null) : null;
  const key = fresh && status ? `${status.cycle}:${boss?.kind ?? "-"}` : null;

  // Drop-in only for a change seen while the menu is open (not on the first status).
  const seen = useRef<string | null>(null);
  const [drop, setDrop] = useState(0);
  useEffect(() => {
    if (key === null) return;
    const before = seen.current;
    seen.current = key;
    if (before !== null && before !== key && boss?.status === "alive") {
      setDrop((d) => d + 1);
      playUi("equip");
    }
  }, [key, boss?.status]);

  if (!fresh || !status) return null;

  if (!boss) {
    return (
      <span className={clsx(BADGE, "border-white/15 bg-black/30 text-white/55 [text-shadow:none]")} aria-label="No boss on this map">
        <Skull crossed />
        <span className="optical-center">No boss</span>
      </span>
    );
  }

  if (boss.status === "killed") {
    const who = boss.killedBy ? ` by ${boss.killedBy}` : "";
    return (
      <span className={clsx(BADGE, "bg-zinc-500 text-black [text-shadow:none]")} title={`${boss.name} is down${who}`} aria-label={`Boss ${boss.name} is down${who}`}>
        <Skull crossed />
        <span className="optical-center">Boss down</span>
      </span>
    );
  }

  const about = `${boss.name} holds ${boss.zoneName} · tier ${boss.tier} · ${boss.guards} ${boss.guards === 1 ? "guard" : "guards"}`;
  return (
    <span
      key={drop}
      title={about}
      aria-label={`Boss on this map: ${about}`}
      className={clsx(
        BADGE,
        "bg-[linear-gradient(180deg,#f43f5e,#be123c)] text-white shadow-[inset_0_2px_0_rgba(255,255,255,0.35),0_3px_0_#000]",
        drop > 0 && "animate-banner-drop motion-reduce:animate-none",
      )}
    >
      <Skull />
      <span className="optical-center">Boss</span>
    </span>
  );
}
