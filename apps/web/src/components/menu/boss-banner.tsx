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
        small ? "h-9 w-9" : "h-9 w-9 md:h-14 md:w-14",
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
 * Boss line of the world card (WORLD v6 spec §6.4). Alive → rose banner "BOSS EVENT · {name}
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

  const nextLine =
    next === undefined ? null : next === null ? (
      <p className="font-body hidden text-xs font-semibold text-white/65 md:block">Next map: no boss</p>
    ) : (
      <p className="font-body hidden text-xs font-semibold text-rose-200 md:block">
        Next map: <span className="uppercase tracking-wide">{next.name}</span> at the {next.zoneName}
      </p>
    );

  if (!boss) {
    return (
      <div className="flex flex-col gap-1">
        <p className="font-body text-xs text-white/60">No boss on this map · bosses show up about 1 map in 3</p>
        {nextLine}
      </div>
    );
  }

  if (boss.status === "killed") {
    return (
      <div className="flex flex-col gap-1.5">
        <div className="flex items-center gap-3 rounded-2xl border-[3px] border-black bg-zinc-600/80 px-3 py-2 shadow-[0_3px_0_#000]">
          <BossFace down small />
          <p className="font-body min-w-0 text-sm font-bold text-white">
            {boss.name} is down{boss.killedBy ? <> — killed by <span className="text-zooa-lime">{boss.killedBy}</span></> : null}
          </p>
        </div>
        {nextLine}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1.5">
      <div
        key={drop}
        className={clsx(
          "flex items-center gap-3 rounded-2xl border-[3px] border-black bg-rose-500 px-3 py-2 text-black shadow-[0_4px_0_#000]",
          drop > 0 && "animate-banner-drop motion-reduce:animate-none",
        )}
      >
        <span className={clsx("contents", drop > 0 && "[&>*]:animate-shake-once motion-reduce:[&>*]:animate-none")}>
          <BossFace />
          <span className="min-w-0">
            <span className="block text-[0.7rem] tracking-[0.2em] text-black/75">BOSS EVENT</span>
            <span className="mt-0.5 block text-sm leading-tight tracking-wide md:text-lg">
              {boss.name} holds the {boss.zoneName}
            </span>
            <span className="font-body mt-0.5 hidden text-xs font-bold text-black/75 md:block">
              T{boss.tier} · {boss.guards} {boss.guards === 1 ? "guard" : "guards"}
            </span>
          </span>
        </span>
      </div>
      {nextLine}
    </div>
  );
}
