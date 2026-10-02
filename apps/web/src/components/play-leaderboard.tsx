"use client";

import { Reveal } from "@/components/reveal";

type Row = {
  rank: number;
  nick: string;
  netUsd: string;
  winrate: string;
  avgExtractUsd: string;
  reward: string;
};

const DEMO_ROWS: Row[] = [
  {
    rank: 1,
    nick: "vex.null",
    netUsd: "+$4,281.40",
    winrate: "61.2%",
    avgExtractUsd: "$187.40",
    reward: "Apex shard",
  },
  {
    rank: 2,
    nick: "rio_kestrel",
    netUsd: "+$3,904.15",
    winrate: "58.4%",
    avgExtractUsd: "$164.08",
    reward: "Gold coil",
  },
  {
    rank: 3,
    nick: "mara.ink",
    netUsd: "+$3,412.90",
    winrate: "55.7%",
    avgExtractUsd: "$151.22",
    reward: "Gold coil",
  },
  {
    rank: 4,
    nick: "coldframe",
    netUsd: "+$2,887.05",
    winrate: "52.1%",
    avgExtractUsd: "$138.65",
    reward: "Silver thread",
  },
  {
    rank: 5,
    nick: "9leaf",
    netUsd: "+$2,441.33",
    winrate: "49.8%",
    avgExtractUsd: "$121.90",
    reward: "Silver thread",
  },
  {
    rank: 6,
    nick: "halcyon drift",
    netUsd: "+$2,108.77",
    winrate: "47.3%",
    avgExtractUsd: "$109.44",
    reward: "Bronze tag",
  },
  {
    rank: 7,
    nick: "kite_runner_02",
    netUsd: "+$1,756.20",
    winrate: "44.6%",
    avgExtractUsd: "$96.08",
    reward: "Bronze tag",
  },
  {
    rank: 8,
    nick: "siltwave",
    netUsd: "+$1,429.88",
    winrate: "41.9%",
    avgExtractUsd: "$88.33",
    reward: "Bronze tag",
  },
];

export function PlayLeaderboard() {
  return (
    <section
      className="rounded-[2rem] border border-white/10 bg-zooa-dark/80 p-6 shadow-[inset_0_1px_0_rgba(255,255,255,0.1),0_20px_40px_-15px_rgba(0,0,0,0.35)] backdrop-blur md:p-8"
      aria-label="Leaderboard preview"
    >
      <Reveal as="h2" delay={40} className="font-display text-2xl tracking-wide text-[#c4f07a] md:text-3xl">
        Leaderboard
      </Reveal>
      <p className="mt-2 text-sm leading-relaxed text-white/55">
        Demo standings for UI only. Net is session-style profit; avg extract is mean successful cash-out.
      </p>
      <div className="mt-6 -mx-1 overflow-x-auto px-1 pb-1 [scrollbar-gutter:stable]">
        <table className="w-full min-w-[36rem] border-collapse text-left text-sm">
          <thead>
            <tr className="border-b border-white/10">
              <th scope="col" className="pb-3 pr-3 font-display text-xs font-normal uppercase tracking-[0.14em] text-white/45">
                #
              </th>
              <th scope="col" className="pb-3 pr-3 font-display text-xs font-normal uppercase tracking-[0.14em] text-white/45">
                Rider
              </th>
              <th scope="col" className="pb-3 pr-3 font-display text-xs font-normal uppercase tracking-[0.14em] text-white/45">
                Net
              </th>
              <th scope="col" className="pb-3 pr-3 font-display text-xs font-normal uppercase tracking-[0.14em] text-white/45">
                Win rate
              </th>
              <th scope="col" className="pb-3 pr-3 font-display text-xs font-normal uppercase tracking-[0.14em] text-white/45">
                Avg extract
              </th>
              <th scope="col" className="pb-3 font-display text-xs font-normal uppercase tracking-[0.14em] text-white/45">
                Reward
              </th>
            </tr>
          </thead>
          <tbody className="font-mono tabular-nums text-white/85">
            {DEMO_ROWS.map((row) => (
              <tr
                key={row.nick}
                className="border-b border-white/[0.06] transition-colors last:border-0 hover:bg-white/[0.03]"
              >
                <td className="py-3 pr-3 align-middle text-zooa-lime/90">{row.rank}</td>
                <td className="py-3 pr-3 align-middle text-white/90">{row.nick}</td>
                <td className="py-3 pr-3 align-middle text-zooa-lime/95">{row.netUsd}</td>
                <td className="py-3 pr-3 align-middle">{row.winrate}</td>
                <td className="py-3 pr-3 align-middle">{row.avgExtractUsd}</td>
                <td className="py-3 align-middle text-white/70">{row.reward}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
