"use client";

import {
  BACKPACK_SLOTS,
  BREAK_CHANCE_ON_DEATH,
  INPUT_DT_MS,
  MATCH,
  PLAYER,
  POCKET_SLOTS,
  ROLL,
} from "@extract/shared";
import { Reveal } from "@/components/reveal";
import { fmtClock } from "@/lib/items-ui";

const RAID_MIN = Math.round(MATCH.DURATION_MS / 60_000);
const ROLL_CD_S = Math.round((ROLL.COOLDOWN_TICKS * INPUT_DT_MS) / 1000);
const BAGS = BACKPACK_SLOTS.filter((n) => n > 0).join(" / ");
const BREAK_PCT = Math.round(BREAK_CHANCE_ON_DEATH * 100);

/** v2 rules, short enough to read in the lobby. Numbers come from the shared constants. */
const STEPS: { title: string; body: string; icon: string }[] = [
  {
    title: "Drop in",
    icon: "/sprites/pistol.png",
    body: `A raid lasts ${RAID_MIN} minutes. You drop with your loadout, or with the free kit: a pistol, light ammo and a bandage. ${PLAYER.MAX_HP} HP. The free pistol never breaks and never drops.`,
  },
  {
    title: "Search",
    icon: "/sprites/crate.png",
    body: "Walk up to a crate, safe or body and press F. It takes a moment to open, then items reveal one by one — rarer ones take longer. Click an item to take it or press T to take all; Tab opens your inventory.",
  },
  {
    title: "Move quietly",
    icon: "/sprites/shotgun.png",
    body: `Space rolls (${ROLL_CD_S} s cooldown). Shift walks quietly: half speed, short footstep range. Sounds you hear show up as markers around you — steps, shots, looting, extracts — with an arrow when it is behind you.`,
  },
  {
    title: "Carry",
    icon: "/sprites/backpack_2.png",
    body: `${POCKET_SLOTS} pockets plus a backpack (${BAGS} slots); ammo, meds and junk stack in a slot. Heal with 3 (bandage) or 4 (medkit), switch guns with 1 / 2. Junk you bring out is auto-sold for CR.`,
  },
  {
    title: "Extract",
    icon: "/sprites/backpack.png",
    body: `Extracts open at ${fmtClock(MATCH.EXTRACT_OPEN_AT_MS)}. Stand in one for ${MATCH.EXTRACT_CHANNEL_MS / 1000} s to get out with everything you carry; taking damage restarts the countdown, and some close early. Still on the map after ${RAID_MIN} minutes? You lose it all.`,
  },
  {
    title: "Don't get caught",
    icon: "/sprites/corpse.png",
    body: `Die and you leave a corpse with your gear. Each item on it has a ${BREAK_PCT}% chance to break; the rest is loot for whoever searches you.`,
  },
];

export function PlayerInstructions() {
  return (
    <aside className="toon-panel bg-[#161b28]/95 p-6 md:p-8" aria-label="How to play">
      <Reveal as="h2" delay={0} className="toon-text text-3xl tracking-wide text-zooa-lime md:text-4xl">
        How to play
      </Reveal>
      <p className="font-body mt-3 text-base leading-relaxed text-white/70">
        Top-down extraction shooter: loot up, survive, get out alive.
      </p>
      <ol className="mt-6 list-none space-y-4 border-t-[3px] border-black/50 pt-6">
        {STEPS.map((s, i) => (
          <li key={s.title}>
            <Reveal as="div" delay={80 + i * 50} className="flex gap-4">
              <span className="relative grid h-14 w-14 shrink-0 place-items-center rounded-2xl border-[3px] border-black bg-white/[0.07] shadow-[0_3px_0_#000]">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={s.icon} alt="" className="h-11 w-11 object-contain" draggable={false} />
                <span className="toon-key absolute -left-2 -top-2 h-5 min-w-5 bg-zooa-lime text-[0.65rem]">{i + 1}</span>
              </span>
              <div className="min-w-0">
                <h3 className="text-lg tracking-wide text-white">{s.title}</h3>
                <p className="font-body mt-1.5 text-[0.95rem] leading-relaxed text-white/70">{s.body}</p>
              </div>
            </Reveal>
          </li>
        ))}
      </ol>
    </aside>
  );
}
