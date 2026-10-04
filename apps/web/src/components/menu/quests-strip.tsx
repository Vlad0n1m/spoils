"use client";

import Link from "next/link";
import clsx from "clsx";
import type { QuestSlotDto } from "@extract/shared";
import { useLobby, useNow } from "@/lib/lobby/lobby-context";
import { useQuests } from "./quests-context";

/** "5h 12m", "12m", "<1m" until `at`. */
export function fmtUntil(at: number, now: number): string {
  const mins = Math.max(0, Math.floor((at - now) / 60_000));
  if (mins < 1) return "<1m";
  const h = Math.floor(mins / 60);
  return h > 0 ? `${h}h ${mins % 60}m` : `${mins}m`;
}

/** Three pips: done = lime, started = half, open = empty. */
function Pips({ slots }: { slots: readonly QuestSlotDto[] }) {
  return (
    <span className="flex shrink-0 gap-1" aria-hidden>
      {slots.map((s) => (
        <span
          key={s.slot}
          className={clsx(
            "h-3 w-3 rounded-full border-2 border-black",
            s.done ? "bg-zooa-lime" : s.progress > 0 ? "bg-[linear-gradient(90deg,#ccff00_50%,rgba(255,255,255,0.15)_50%)]" : "bg-white/15",
          )}
        />
      ))}
    </span>
  );
}

/**
 * Daily tasks strip under the world card (RETENTION.md §5): "DAILY TASKS ●●○ Search 10 containers
 * 4/10 +100 XP ›". Opens the tasks sheet. Guests get a register hint; signed-out viewers see nothing.
 * Hidden on landscape phones (≤ 500 px tall), where the Tasks side button takes its place.
 */
export function QuestsStrip({ onOpen, className }: { onOpen: () => void; className?: string }) {
  const { sessionKind, sessionLoading } = useLobby();
  const { data, error, unseen } = useQuests();
  const now = useNow();
  const shell = clsx(
    "toon-panel mx-auto flex min-h-12 w-full max-w-xl items-center gap-2.5 bg-[#121722]/90 px-3 py-2 text-left backdrop-blur-sm",
    className,
  );

  if (sessionLoading || sessionKind === "anon") return null;
  if (sessionKind === "guest") {
    return (
      <Link href="/auth/register?next=/play" className={clsx(shell, "focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-zooa-lime/70")}>
        <span className="text-xs tracking-[0.18em] text-white/60">DAILY TASKS</span>
        <span className="font-body min-w-0 flex-1 truncate text-sm text-white/75">Register to get 3 tasks a day for bonus XP</span>
        <span className="text-zooa-lime" aria-hidden>
          ›
        </span>
      </Link>
    );
  }
  if (!data) {
    if (error) {
      return (
        <button type="button" onClick={onOpen} className={shell}>
          <span className="text-xs tracking-[0.18em] text-white/60">DAILY TASKS</span>
          <span className="font-body min-w-0 flex-1 truncate text-sm text-white/65">Couldn&apos;t load your tasks</span>
        </button>
      );
    }
    return <span className={clsx(shell, "animate-pulse motion-reduce:animate-none")} aria-hidden />;
  }

  const done = data.slots.filter((s) => s.done).length;
  const next = data.slots.find((s) => !s.done) ?? null;
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-haspopup="dialog"
      aria-label={`Daily tasks, ${done} of ${data.slots.length} done${unseen ? ", new" : ""}`}
      className={clsx(
        shell,
        "transition-transform focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-zooa-lime/70 active:translate-y-[2px]",
      )}
    >
      <span className="relative shrink-0 text-xs tracking-[0.18em] text-white/60">
        DAILY TASKS
        {unseen && <span className="absolute -right-3 -top-1.5 h-2.5 w-2.5 rounded-full border-2 border-black bg-rose-500" aria-hidden />}
      </span>
      <Pips slots={data.slots} />
      {next ? (
        <>
          <span className="font-body min-w-0 flex-1 truncate text-sm font-semibold text-white/85">
            <span className="sm:hidden">{next.short}</span>
            <span className="hidden sm:inline">{next.label}</span>
            <span className="ml-1.5 tabular-nums text-white/55">
              {next.progress}/{next.need}
            </span>
          </span>
          <span className="font-body shrink-0 rounded-full border-2 border-black bg-sky-300 px-2 py-0.5 text-xs font-bold tabular-nums text-black">
            +{next.xp} XP
          </span>
        </>
      ) : (
        <span className="font-body min-w-0 flex-1 truncate text-sm font-semibold text-zooa-lime">
          All done · new tasks in {fmtUntil(data.resetAt, now)}
        </span>
      )}
      <span className="shrink-0 text-lg text-white/60" aria-hidden>
        ›
      </span>
    </button>
  );
}
