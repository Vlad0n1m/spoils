"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import clsx from "clsx";
import Link from "next/link";
import type { WorldEventDto, WorldEventsDto } from "@extract/shared";
import { NEWS_POSTS } from "@/content/news";
import { fmtLocalHm, mapLabel } from "@/lib/lobby/world-clock";
import { timeAgo } from "@/components/lobby/use-lobby";
import { Paged } from "@/components/paged";

const FEED_LIMIT = 20;

/** One feed line: what happened, in the lobby's words. */
export function eventText(e: WorldEventDto): string {
  if (e.kind === "boss_spawned") return e.boss ? `${e.boss.name} took the ${e.boss.zoneName}` : "A boss appeared";
  if (e.kind === "boss_killed") {
    const name = e.boss?.name ?? "The boss";
    return e.by ? `${name} killed by ${e.by}` : `${name} is down`;
  }
  const s = e.stats;
  if (!s) return `${mapLabel(e.mapNumber)} wiped`;
  const parts = [`${s.extracted} extracted`, `${s.died} died`];
  if (s.mia > 0) parts.push(`${s.mia} caught in the wipe`);
  return `${mapLabel(e.mapNumber)} wiped · ${parts.join(", ")}`;
}

const TAG: Record<WorldEventDto["kind"], { label: string; tone: string }> = {
  boss_spawned: { label: "BOSS EVENT", tone: "bg-rose-500 text-black" },
  boss_killed: { label: "BOSS DOWN", tone: "bg-zinc-300 text-black" },
  wiped: { label: "WIPE", tone: "bg-amber-300 text-black" },
};

function Feed() {
  const [events, setEvents] = useState<WorldEventDto[] | null>(null);
  const [error, setError] = useState(false);
  const seq = useRef(0);
  const load = useCallback(async () => {
    const my = ++seq.current;
    setError(false);
    try {
      const res = await fetch(`/api/world/events?limit=${FEED_LIMIT}`, { credentials: "omit" });
      const body = (await res.json().catch(() => null)) as WorldEventsDto | null;
      if (my !== seq.current) return;
      if (!res.ok || !body || !Array.isArray(body.events)) throw new Error("bad");
      setEvents(body.events);
    } catch {
      if (my === seq.current) setError(true);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  if (error && !events) {
    return (
      <div className="toon-panel bg-[#161b28]/95 p-6 text-center">
        <p className="font-body text-white/75">Couldn&apos;t load the world feed.</p>
        <button type="button" onClick={() => void load()} className="toon-btn-ghost mt-4 min-h-11 px-5 text-sm">
          <span className="optical-center">Retry</span>
        </button>
      </div>
    );
  }
  if (!events) {
    return (
      <ul className="flex min-h-0 flex-1 flex-col gap-2 overflow-hidden" aria-busy="true" aria-label="Loading the world feed">
        {Array.from({ length: 5 }, (_, i) => (
          <li key={i} className="h-16 animate-pulse rounded-2xl border-[3px] border-black/50 bg-white/[0.06] motion-reduce:animate-none" />
        ))}
      </ul>
    );
  }
  if (events.length === 0) {
    return <p className="font-body rounded-2xl border-[3px] border-black bg-[#161b28]/95 p-6 text-center text-white/75">Quiet on the Outskirts. No events yet.</p>;
  }
  return (
    <Paged as="ul" minCol={320} maxCols={2} label="World feed pages">
      {events.map((e) => (
        <li key={e.id} className="flex items-start gap-3 rounded-2xl border-[3px] border-black bg-[#161b28]/95 p-3 shadow-[0_3px_0_#000]">
          <span className={clsx("mt-0.5 shrink-0 rounded-md border-2 border-black px-1.5 py-1 text-xs lg:text-[0.8125rem] tracking-[0.15em]", TAG[e.kind].tone)}>{TAG[e.kind].label}</span>
          <div className="min-w-0">
            <p className="font-body text-sm font-semibold text-white">{eventText(e)}</p>
            <p className="font-body mt-0.5 text-xs lg:text-[0.8125rem] text-white/75">
              {mapLabel(e.mapNumber)} · {fmtLocalHm(e.at)} · {timeAgo(e.at)}
            </p>
          </div>
        </li>
      ))}
    </Paged>
  );
}

function PatchNotes() {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <Paged gap={12} minCol={340} maxCols={2} label="Patch note pages">
      {NEWS_POSTS.map((p) => (
        <article key={p.id} className="paged-split toon-panel bg-[#161b28]/95 p-4 md:p-5">
          <p className="flex items-center gap-2 text-xs lg:text-[0.8125rem] tracking-[0.12em] text-white/75">
            <span className="rounded-md border-2 border-black bg-zooa-lime px-1.5 py-0.5 text-black">{p.tag.toUpperCase()}</span>
            {p.date}
          </p>
          <h3 className="toon-text-thin mt-2 text-xl leading-tight tracking-wide text-white">{p.title}</h3>
          <ul className="font-body mt-3 list-disc space-y-3 pl-5 text-[0.95rem] leading-snug text-white/80">
            {p.body.map((b) => (
              <li key={b}>{b}</li>
            ))}
          </ul>
        </article>
      ))}
      </Paged>
      <Link href="/news" className="font-body mt-1 shrink-0 self-end text-sm font-semibold text-zooa-lime underline-offset-4 hover:underline">
        All patch notes →
      </Link>
    </div>
  );
}

/** News (WORLD v6 spec §6.3, D27): the world feed from /api/world/events and the static patch notes, both paged. */
export function NewsPanel({ tab }: { tab: string }) {
  return <div className="flex min-h-0 flex-1 flex-col">{tab === "patch" ? <PatchNotes /> : <Feed />}</div>;
}
