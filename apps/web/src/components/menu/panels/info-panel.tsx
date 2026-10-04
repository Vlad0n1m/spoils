"use client";

import { QUEST } from "@extract/shared";
import { ControlsSection, PlayerInstructions, RulesSection } from "@/components/play-instructions";
import { useLobby } from "@/lib/lobby/lobby-context";
import { markRewardTable, rewardTable } from "@/lib/lobby/levels";

/** Info (WORLD v6 spec §6.3): How to play, Rules (currencies, risk, XP table, levels and tasks), Controls. */
export function InfoPanel({ tab }: { tab: string }) {
  if (tab === "rules") {
    return (
      <>
        <RulesSection />
        <LevelsInfo />
      </>
    );
  }
  if (tab === "controls") return <ControlsSection />;
  return <PlayerInstructions />;
}

/** Rules · Levels and daily tasks (RETENTION.md §3, §5): what each level gives and how tasks pay. */
function LevelsInfo() {
  const { stash } = useLobby();
  const sell = stash.data?.market.sellUnlockLevel;
  return (
    // The same card as the Rules blocks above it (play-instructions Block), not a bare heading.
    <section aria-labelledby="info-levels" className="toon-panel mt-4 flex flex-col gap-3 bg-[#161b28]/95 p-4 md:p-5">
      <h3 id="info-levels" className="toon-text-thin text-xl tracking-wide text-white">
        Levels and daily tasks
      </h3>
      <ul className="font-body list-disc space-y-2.5 pl-5 text-sm leading-snug text-white/75">
        <li>
          Every registered raider gets {QUEST.SLOTS} daily tasks. Each pays {QUEST.XP} XP, up to {QUEST.DAILY_XP_MAX} a day, on top of
          the daily raid XP limit. New tasks at 00:00 UTC; unfinished ones carry over. One free swap a day.
        </li>
        <li>Tasks count only from your raids: extracts after 8+ minutes on the map, containers and bodies searched, marauders killed.</li>
        <li>
          Levels and task marks unlock titles, name colours and badge frames. Wear them from the Rewards sheet (tap your level badge).
          They are earned only by playing — never sold, never traded — and change nothing in a raid.
        </li>
      </ul>
      <div className="overflow-hidden rounded-2xl border-[3px] border-black">
        <table className="font-body w-full text-left text-sm">
          <thead className="bg-black/40 text-xs lg:text-[0.8125rem] uppercase tracking-wider text-white/70">
            <tr>
              <th scope="col" className="px-3 py-2">
                Level
              </th>
              <th scope="col" className="px-3 py-2">
                Unlocks
              </th>
            </tr>
          </thead>
          <tbody>
            {rewardTable(sell).map((r) => (
              <tr key={r.level} className="border-t-2 border-black/40 align-top">
                <td className="px-3 py-1.5 tabular-nums text-white/85">{r.level}</td>
                <td className="px-3 py-1.5 text-white/75">{r.items.map((i) => i.label).join(" · ")}</td>
              </tr>
            ))}
            {markRewardTable().map((r) => (
              <tr key={`m${r.marks}`} className="border-t-2 border-black/40 align-top">
                <td className="whitespace-nowrap px-3 py-1.5 tabular-nums text-sky-300">{r.marks} marks</td>
                <td className="px-3 py-1.5 text-white/75">{r.items.map((i) => i.label).join(" · ")}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
