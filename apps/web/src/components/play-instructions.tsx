"use client";

import { BREAK_CHANCE_ON_DEATH, MATCH, PLAYER } from "@extract/shared";
import { Reveal } from "@/components/reveal";
import { fmtClock } from "@/lib/items-ui";

const STEPS: { title: string; body: string; icon: string }[] = [
  {
    title: "Drop in",
    icon: "/sprites/pistol.png",
    body: `Everyone starts with the free kit: a pistol, light ammo and a bandage. ${PLAYER.MAX_HP} HP, no armor. The free pistol never breaks and never drops.`,
  },
  {
    title: "Loot",
    icon: "/sprites/chest_rare.png",
    body: "Open chests with F — the rarer the chest, the better the guns and armor inside. Ammo, bandages and medkits are picked up just by walking over them.",
  },
  {
    title: "Fight or sneak",
    icon: "/sprites/shotgun.png",
    body: "Two weapon slots (1 / 2), reload with R, heal with 3 (bandage) or 4 (medkit). Bushes hide you. Rarer weapons hit harder; armor soaks part of every hit.",
  },
  {
    title: "Extract",
    icon: "/sprites/backpack.png",
    body: `Extraction points open at ${fmtClock(MATCH.EXTRACT_OPEN_AT_MS)}. Stand in one for ${MATCH.EXTRACT_CHANNEL_MS / 1000} s to get out with everything you carry. Taking damage restarts the countdown, and some points close early.`,
  },
  {
    title: "Don't get caught",
    icon: "/sprites/armor_2.png",
    body: `Die and each item breaks with a ${Math.round(BREAK_CHANCE_ON_DEATH * 100)}% chance — the rest drops for whoever finds your body. Still on the map after ${Math.round(MATCH.DURATION_MS / 60_000)} minutes? You lose everything.`,
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
