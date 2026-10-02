"use client";

import { useEffect, useState } from "react";
import clsx from "clsx";
import { Reveal } from "@/components/reveal";
import type { RecentRaidRow } from "@/lib/recent-raids";
import { ItemTile } from "./item-tile";

const EXIT_LABEL = {
  extract: { text: "Extracted", cls: "bg-zooa-lime text-black" },
  dead: { text: "KIA", cls: "bg-rose-500 text-white" },
  timeout: { text: "Lost", cls: "bg-amber-400 text-black" },
} as const;

function timeAgo(ms: number): string {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  return `${Math.round(h / 24)} d ago`;
}

/** Lobby board of the latest human results (GET /api/matches/recent). */
export function PlayLeaderboard() {
  const [rows, setRows] = useState<RecentRaidRow[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/matches/recent", { cache: "no-store" })
      .then((r) => r.json() as Promise<{ rows?: RecentRaidRow[] }>)
      .then((d) => {
        if (!cancelled) setRows(Array.isArray(d.rows) ? d.rows : []);
      })
      .catch(() => {
        if (!cancelled) setRows([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <section className="toon-panel bg-[#161b28]/95 p-6 md:p-8" aria-label="Recent raids">
      <Reveal as="h2" delay={40} className="toon-text text-3xl tracking-wide text-white md:text-4xl">
        Recent raids
      </Reveal>
      <p className="font-body mt-3 text-base leading-relaxed text-white/65">Who made it out — and with what.</p>

      {rows === null ? (
        <ul className="mt-6 space-y-2" aria-hidden>
          {[0, 1, 2].map((i) => (
            <li key={i} className="h-14 animate-pulse rounded-2xl bg-white/[0.05]" />
          ))}
        </ul>
      ) : rows.length === 0 ? (
        <p className="font-body mt-6 rounded-2xl border-2 border-dashed border-white/15 px-4 py-8 text-center text-base text-white/60">
          No raids yet. Be the first to extract.
        </p>
      ) : (
        <ul className="mt-6 space-y-2">
          {rows.map((r) => {
            const exit = EXIT_LABEL[r.exitType];
            return (
              <li
                key={`${r.matchId}:${r.nickname}`}
                className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-2xl border-2 border-black/70 bg-white/[0.04] px-3 py-2.5"
              >
                <span className={clsx("rounded-full border-2 border-black px-2.5 py-1 text-[0.7rem] tracking-wide", exit.cls)}>
                  {exit.text}
                </span>
                <span className="min-w-0 flex-1 truncate text-base tracking-wide text-white">{r.nickname}</span>
                {r.extracted.length > 0 && (
                  <span className="flex gap-1.5">
                    {r.extracted.slice(0, 4).map((it) => (
                      <ItemTile key={it.uid} item={it} size="sm" showName={false} />
                    ))}
                  </span>
                )}
                <span className="w-16 text-right text-sm tabular-nums text-white/75">
                  {r.kills} {r.kills === 1 ? "kill" : "kills"}
                </span>
                <span className="font-body w-20 text-right text-xs text-white/50">{timeAgo(r.endedAt)}</span>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
