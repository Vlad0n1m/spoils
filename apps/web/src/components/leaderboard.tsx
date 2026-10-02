"use client";

import { memo } from "react";
import { formatMassUnitsAsUsd } from "@/lib/format-money";

interface Entry {
  nickname: string;
  mass: string;
  alive: boolean;
}

export const Leaderboard = memo(function Leaderboard({
  entries,
}: {
  entries: Entry[];
}) {
  return (
    <div className="pointer-events-auto absolute right-4 top-24 w-60 card bg-ink-800/85 p-3 text-xs">
      <div className="text-white/60 uppercase tracking-wide mb-2">Leaderboard</div>
      <ol className="space-y-1">
        {entries.slice(0, 10).map((e, i) => (
          <li
            key={e.nickname + i}
            className={`flex items-center justify-between gap-2 ${
              !e.alive ? "opacity-40 line-through" : ""
            }`}
          >
            <span className="truncate">
              <span className="text-white/40 mono mr-1">{i + 1}.</span>
              {e.nickname}
            </span>
            <span className="mono text-emerald-400/90">
              {formatMassUnitsAsUsd(e.mass)}
            </span>
          </li>
        ))}
        {entries.length === 0 && (
          <li className="text-white/40">awaiting players...</li>
        )}
      </ol>
    </div>
  );
});
