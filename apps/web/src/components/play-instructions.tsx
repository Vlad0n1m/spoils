"use client";

import { Reveal } from "@/components/reveal";

const STEPS: { title: string; body: string }[] = [
  {
    title: "Movement",
    body: "Your snake follows the cursor. Hold left click to boost (it spends mass).",
  },
  {
    title: "Orbs and money",
    body: "Collect orbs on the arena. The mass readout maps to dollars in the current match—higher buy-ins mean higher stakes per round.",
  },
  {
    title: "Lock-in and open phase",
    body: "The round starts with lock-in, then opens. During the open phase, watch the timer and do not get caught in the shrinking zone.",
  },
  {
    title: "Extraction (E)",
    body: "While the round is open, press E to start a cash-out and finish the channel—only a successful extract pays. If the round ends or the ring closes on you, you lose the stake like on any other elimination.",
  },
  {
    title: "Matchmaking",
    body: "Your buy-in is fixed when you start searching. You can cancel matchmaking and return to pick a different entry. In battle, the forfeit control in the HUD ends the session per server rules.",
  },
];

export function PlayerInstructions() {
  return (
    <aside
      className="rounded-[2rem] border border-white/10 bg-zooa-dark/80 p-6 shadow-[inset_0_1px_0_rgba(255,255,255,0.1),0_20px_40px_-15px_rgba(0,0,0,0.35)] backdrop-blur md:p-8"
      aria-label="Quick guide for players"
    >
      <Reveal as="h2" delay={0} className="font-display text-2xl tracking-wide text-[#c4f07a] md:text-3xl">
        How to play
      </Reveal>
      <p className="mt-3 text-base  text-white/60">
        PvP battle royale: grow, fight, and extract before the zone closes in.
      </p>
      <ol className="mt-8 list-none space-y-5 border-t border-white/10 pt-8">
        {STEPS.map((s, i) => (
          <li key={s.title}>
            <Reveal as="div" delay={80 + i * 50} className="block">
              <div className="grid grid-cols-[2rem_1fr] gap-3 sm:grid-cols-[2.5rem_1fr] sm:gap-4">
                <span className="font-mono text-sm tabular-nums text-zooa-lime/90">
                  {(i + 1).toString().padStart(2, "0")}
                </span>
                <div>
                  <h3 className="font-display text-base tracking-wide text-white md:text-lg mb-4">{s.title}</h3>
                  <p className="mt-1.5 text-sm  text-white/60">{s.body}</p>
                </div>
              </div>
            </Reveal>
          </li>
        ))}
      </ol>
    </aside>
  );
}
