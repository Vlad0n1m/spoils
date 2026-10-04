"use client";

import { useEffect, useRef, useState } from "react";
import clsx from "clsx";
import type { WorldStatusDto } from "@extract/shared";
import { playUi } from "@/game/audio/ui-sounds";

function BossFace({ down = false, small = false }: { down?: boolean; small?: boolean }) {
  return (
    <span
      className={clsx(
        "relative grid shrink-0 place-items-center overflow-hidden rounded-full border-[3px] border-black bg-[#2a1216] shadow-[0_3px_0_#000]",
        small ? "h-9 w-9" : "h-10 w-10",
      )}
      aria-hidden
    >
      {/* eslint-disable-next-line @next/next/no-img-element -- static sprite until boss portraits exist */}
      <img src="/sprites/boss.png" alt="" draggable={false} className={clsx("h-[115%] w-[115%] max-w-none object-contain", down && "opacity-60 grayscale")} />
      {down && <span className="absolute inset-x-0 top-1/2 h-1 -translate-y-1/2 -rotate-45 bg-rose-500" />}
    </span>
  );
}

/**
 * Boss line of the world card (WORLD v6 spec §6.4), compact for the event card. Alive → rose banner "BOSS EVENT · {name}
 * holds the {zone}" with tier and guards; killed → grey "{name} is down — killed by {nick}"; no boss →
 * one thin line; plus "Next map: {NAME} at {zone}" once the next boss is revealed. A boss that
 * appears while the menu is open drops in once with a shake. Only a status of the current map
 * (`fresh`) is shown: a stale one would announce the previous map's boss. Phones get one line
 * (tier, guards and the next-map line from md up).
 */
export function BossBanner({ status, fresh }: { status: WorldStatusDto | null; fresh: boolean }) {
  const boss = fresh ? (status?.boss ?? null) : null;
  const next = fresh ? status?.next.boss : undefined;
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

  // Next map's boss: tall desktop screens only (the card stays compact elsewhere).
  const nextLine =
    next === undefined ? null : next === null ? (
      <p className="font-body hidden text-xs lg:text-[0.8125rem] font-semibold text-white/70 [@media(min-width:1024px)_and_(min-height:760px)]:block">Next map: no boss</p>
    ) : (
      <p className="font-body hidden text-xs lg:text-[0.8125rem] font-semibold text-rose-200 [@media(min-width:1024px)_and_(min-height:760px)]:block">
        Next map: <span className="uppercase tracking-wide">{next.name}</span> at the {next.zoneName}
      </p>
    );

  if (!boss) {
    return (
      <div className="flex flex-col gap-1 border-t-2 border-black/40 pt-1.5">
        <p className="font-body text-xs lg:text-[0.8125rem] font-semibold text-white/70">No boss this map · about 1 map in 3</p>
        {nextLine}
      </div>
    );
  }

  if (boss.status === "killed") {
    return (
      <div className="flex flex-col gap-1">
        <div className="flex items-center gap-2 rounded-xl border-[3px] border-black bg-zinc-600/90 px-2 py-1 shadow-[0_3px_0_#000]">
          <BossFace down small />
          <p className="font-body min-w-0 text-xs lg:text-[0.8125rem] font-bold leading-tight text-white">
            {boss.name} is down{boss.killedBy ? <> — by <span className="text-zooa-lime">{boss.killedBy}</span></> : null}
          </p>
        </div>
        {nextLine}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1">
      <div
        key={drop}
        className={clsx(
          "flex items-center gap-2 rounded-xl border-[3px] border-black bg-[linear-gradient(180deg,#fb7185,#e11d48)] px-2 py-1 text-black shadow-[inset_0_2px_0_rgba(255,255,255,0.35),0_3px_0_#000]",
          drop > 0 && "animate-banner-drop motion-reduce:animate-none",
        )}
      >
        <span className={clsx("contents", drop > 0 && "[&>*]:animate-shake-once motion-reduce:[&>*]:animate-none")}>
          <BossFace small />
          <span className="min-w-0">
            <span className="block text-xs lg:text-[0.8125rem] leading-none tracking-[0.12em] text-black/75">
              BOSS EVENT · TIER {boss.tier} · {boss.guards} {boss.guards === 1 ? "GUARD" : "GUARDS"}
            </span>
            <span className="menu-label mt-1 block truncate text-sm leading-none tracking-wide text-white [text-shadow:none]">
              {boss.name} · {boss.zoneName}
            </span>
          </span>
        </span>
      </div>
      {nextLine}
    </div>
  );
}
