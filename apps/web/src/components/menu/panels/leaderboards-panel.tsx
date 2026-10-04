"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import clsx from "clsx";
import type { CosmeticBadgesDto, EquippedCosmetics, LeaderboardBoard, LeaderboardDto, LeaderboardMeDto } from "@extract/shared";
import { useLobby } from "@/lib/lobby/lobby-context";
import { nameColorHex, titleName } from "@/lib/lobby/levels";
import { LB_PERIODS, type LbPeriod } from "@/lib/lobby/panels";
import { LevelBadge } from "../level-badge";
import { fmtInt } from "../xp-bar";

const REFRESH_MS = 30_000;
const PERIOD_LABEL: Record<LbPeriod, string> = { map: "This map", week: "This week", all: "All time" };
const MEDAL = ["#ffc93c", "#cbd5e1", "#d97706"] as const;

function valueText(board: LeaderboardBoard, v: number): string {
  if (board === "level") return `${fmtInt(v)} XP`;
  if (board === "kills") return `${fmtInt(v)} ${v === 1 ? "kill" : "kills"}`;
  return `${fmtInt(v)} ${v === 1 ? "NPC" : "NPCs"}`;
}

function emptyText(board: LeaderboardBoard, period: LbPeriod): string {
  if (board === "level") return "Nobody has earned XP yet. Be the first.";
  const where = period === "map" ? "on this map" : period === "week" ? "this week" : "yet";
  return board === "kills" ? `No raider kills ${where}. Be the first.` : `No NPC kills ${where}. Be the first.`;
}

function Rank({ rank }: { rank: number }) {
  const medal = rank <= 3 ? MEDAL[rank - 1] : undefined;
  return (
    <span
      className={clsx(
        "grid h-9 min-w-9 shrink-0 place-items-center rounded-full border-[3px] border-black px-1 text-sm tabular-nums",
        medal ? "text-black shadow-[0_2px_0_#000]" : "border-transparent text-white/70",
      )}
      style={medal ? { background: medal } : undefined}
    >
      {rank}
    </span>
  );
}

type Badges = Record<string, Partial<EquippedCosmetics>>;

/** Equipped titles / name colours / badge frames of the board's players (/api/quests/badges); {} on failure. */
async function loadBadges(nicks: readonly string[]): Promise<Badges> {
  if (nicks.length === 0) return {};
  const q = new URLSearchParams();
  for (const n of nicks.slice(0, 100)) q.append("n", n);
  try {
    const res = await fetch(`/api/quests/badges?${q.toString()}`, { credentials: "omit" });
    const body = (await res.json().catch(() => null)) as CosmeticBadgesDto | null;
    return res.ok && body && typeof body.badges === "object" && body.badges ? body.badges : {};
  } catch {
    return {};
  }
}

/**
 * Leaderboards (WORLD v6 spec §6.3, D25): Level (all time), Raider kills and NPC kills for this
 * map / this week / all time. Public top 100 from /api/leaderboards; the caller's own rank from
 * /api/leaderboards/me, pinned at the bottom when outside the list. Refreshes every 30 s while open
 * and visible. Guests are not ranked. Rows show each player's equipped title, name colour and badge
 * frame (earn-only rewards) from /api/quests/badges.
 */
export function LeaderboardsPanel({ board, period, onPeriod }: { board: LeaderboardBoard; period: LbPeriod; onPeriod: (p: LbPeriod) => void }) {
  const { user, sessionKind, visible } = useLobby();
  const effPeriod: LbPeriod = board === "level" ? "all" : period;
  const [data, setData] = useState<LeaderboardDto | null>(null);
  /** undefined = loading, null = not on this board, "error" = the own-rank request failed. */
  const [me, setMe] = useState<LeaderboardMeDto | "error" | undefined>(undefined);
  const [error, setError] = useState(false);
  const [badges, setBadges] = useState<Badges>({});
  const seq = useRef(0);

  const load = useCallback(async () => {
    const my = ++seq.current;
    setError(false);
    const q = `board=${board}&period=${effPeriod}`;
    try {
      const [res, meRes] = await Promise.all([
        fetch(`/api/leaderboards?${q}`, { credentials: "omit" }),
        sessionKind === "user"
          ? fetch(`/api/leaderboards/me?${q}`, { credentials: "include", cache: "no-store" }).catch(() => "error" as const)
          : Promise.resolve(null),
      ]);
      const body = (await res.json().catch(() => null)) as LeaderboardDto | null;
      // A failed own-rank request is not "not on this board" (that is a 200 with null).
      let meBody: LeaderboardMeDto | "error" = null;
      if (meRes === "error" || (meRes && !meRes.ok)) meBody = "error";
      else if (meRes) meBody = (await meRes.json().catch(() => "error" as const)) as LeaderboardMeDto | "error";
      if (my !== seq.current) return;
      if (!res.ok || !body || !Array.isArray(body.rows)) throw new Error("bad");
      setData(body);
      setMe(meBody);
      const b = await loadBadges(body.rows.map((r) => r.nickname));
      if (my === seq.current) setBadges(b);
    } catch {
      if (my === seq.current) setError(true);
    }
  }, [board, effPeriod, sessionKind]);

  // New board / period: start from the skeleton.
  useEffect(() => {
    setData(null);
    setMe(undefined);
  }, [board, effPeriod]);

  useEffect(() => {
    if (!visible) return;
    void load();
    const id = window.setInterval(() => void load(), REFRESH_MS);
    return () => window.clearInterval(id);
  }, [load, visible]);

  const myNick = sessionKind === "user" ? (user?.nickname ?? null) : null;
  const rows = data?.rows ?? [];
  const meListed = myNick !== null && rows.some((r) => r.nickname === myNick);

  return (
    <div className="flex flex-col gap-4">
      {board === "level" ? (
        <p className="font-body text-sm text-white/75">Total XP, all time.</p>
      ) : (
        <div role="group" aria-label="Period" className="flex gap-1.5">
          {LB_PERIODS.map((p) => (
            <button
              key={p}
              type="button"
              onClick={() => onPeriod(p)}
              aria-pressed={p === period}
              className={clsx(
                "font-body min-h-10 rounded-xl border-[3px] border-black px-3 text-sm font-bold focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-zooa-lime/70",
                p === period ? "bg-white text-black shadow-[0_3px_0_#000]" : "bg-[#1d2333]/90 text-white/75 hover:text-white",
              )}
            >
              {PERIOD_LABEL[p]}
            </button>
          ))}
        </div>
      )}

      {error && !data ? (
        <div className="toon-panel bg-[#161b28]/95 p-6 text-center">
          <p className="font-body text-white/75">Couldn&apos;t load the board.</p>
          <button type="button" onClick={() => void load()} className="toon-btn-ghost mt-4 min-h-11 px-5 text-sm">
            <span className="optical-center">Retry</span>
          </button>
        </div>
      ) : !data ? (
        <ul className="flex flex-col gap-1.5" aria-busy="true" aria-label="Loading the board">
          {Array.from({ length: 8 }, (_, i) => (
            <li key={i} className="h-12 animate-pulse rounded-xl bg-white/[0.06] motion-reduce:animate-none" />
          ))}
        </ul>
      ) : rows.length === 0 ? (
        <p className="font-body rounded-2xl border-[3px] border-black bg-[#161b28]/95 p-6 text-center text-white/75">{emptyText(board, effPeriod)}</p>
      ) : (
        <ol className="flex flex-col gap-1.5">
          {rows.map((r) => {
            const mine = myNick !== null && r.nickname === myNick;
            const worn = badges[r.nickname];
            const color = mine ? undefined : nameColorHex(worn?.color);
            const title = titleName(worn?.title);
            return (
              <li
                key={`${r.rank}-${r.nickname}`}
                className={clsx(
                  "flex min-h-12 items-center gap-3 rounded-xl border-[3px] px-2 py-1",
                  mine ? "border-black bg-zooa-lime/90 text-black shadow-[0_3px_0_#000]" : "border-transparent bg-white/[0.04] text-white",
                )}
                aria-current={mine ? "true" : undefined}
              >
                <Rank rank={r.rank} />
                <LevelBadge level={r.level} size="sm" frame={worn?.frame} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-base tracking-wide" style={color ? { color } : undefined}>
                    {r.nickname}
                  </span>
                  {title && (
                    <span className={clsx("font-body block truncate text-xs lg:text-[0.8125rem] font-bold uppercase tracking-wider", mine ? "text-black/65" : "text-white/70")}>
                      {title}
                    </span>
                  )}
                </span>
                <span className={clsx("font-body shrink-0 text-sm font-bold tabular-nums", mine ? "text-black" : "text-white/85")}>{valueText(board, r.value)}</span>
              </li>
            );
          })}
        </ol>
      )}

      {data && sessionKind === "user" && !meListed && (
        <p className="font-body sticky bottom-0 rounded-xl border-[3px] border-black bg-zooa-lime px-3 py-2.5 text-sm font-bold text-black shadow-[0_3px_0_#000]">
          {me === "error"
            ? "Couldn't load your rank."
            : me
              ? `You · #${fmtInt(me.rank)} · ${valueText(board, me.value)}`
              : me === null
                ? "You're not on this board yet."
                : "Finding your rank…"}
        </p>
      )}
      {sessionKind === "guest" && (
        <p className="font-body text-sm text-white/75">
          Guests aren&apos;t ranked —{" "}
          <Link href={`/auth/register?next=${encodeURIComponent("/play?panel=leaderboards")}`} className="font-semibold text-zooa-lime underline-offset-4 hover:underline">
            register to get on the board
          </Link>
          .
        </p>
      )}
      {sessionKind === "anon" && (
        <p className="font-body text-sm text-white/75">
          <Link href={`/auth/register?next=${encodeURIComponent("/play?panel=leaderboards")}`} className="font-semibold text-zooa-lime underline-offset-4 hover:underline">
            Register to get ranked
          </Link>
          .
        </p>
      )}
    </div>
  );
}
