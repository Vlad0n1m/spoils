"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import clsx from "clsx";
import { QUEST, nextMarkReward, type QuestSlotDto } from "@extract/shared";
import { useLobby, useNow } from "@/lib/lobby/lobby-context";
import { cosmeticLabel } from "@/lib/lobby/levels";
import { playUi } from "@/game/audio/ui-sounds";
import { Panel } from "./panel";
import { usePass } from "./pass-context";
import { PassTab } from "./pass-tab";
import { useQuests } from "./quests-context";
import { RewardsTab } from "./rewards-tab";
import { fmtInt } from "./xp-bar";
import { Paged } from "@/components/paged";

/** "5h 12m", "12m", "<1m" until `at`. */
export function fmtUntil(at: number, now: number): string {
  const mins = Math.max(0, Math.floor((at - now) / 60_000));
  if (mins < 1) return "<1m";
  const h = Math.floor(mins / 60);
  return h > 0 ? `${h}h ${mins % 60}m` : `${mins}m`;
}

export type QuestsTab = "today" | "rewards" | "pass";
const TABS: readonly QuestsTab[] = ["today", "rewards", "pass"];
const TAB_LABELS: Readonly<Record<QuestsTab, string>> = { today: "Today", rewards: "Rewards", pass: "Alpha Pass" };
const SHEET_TITLE: Readonly<Record<QuestsTab, string>> = { today: "Daily tasks", rewards: "Rewards", pass: "Alpha Pass" };

/**
 * Daily tasks, level rewards and the Alpha Pass (RETENTION.md §3, §5; GAME_DESIGN §18e): a drawer
 * from the left with three tabs; Rewards (rewards-tab.tsx) and the Alpha Pass (pass-tab.tsx) open as
 * full game screens.
 * Today: the three tasks with progress, the day's free swap, task XP today, marks. Rewards: the next
 * reward, what to wear (title, name colour, badge frame — unlocked ones only, the server checks
 * again) and every reward by level and by task marks. Not a URL panel: opened by the tasks strip,
 * the Tasks button, the top-bar badge, the LEVEL N window and the phone's More sheet.
 */
export function QuestsSheet({ tab, onTab, onClose }: { tab: QuestsTab; onTab: (t: QuestsTab) => void; onClose: () => void }) {
  const { sessionKind } = useLobby();
  const { reload, markSeen } = useQuests();
  const pass = usePass();
  // Fresh numbers on open (the last raid may have settled since the menu loaded); the dot goes.
  useEffect(() => {
    void reload();
    void pass.reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reload]);
  useEffect(() => {
    markSeen();
  }, [markSeen]);

  return (
    <Panel
      title={SHEET_TITLE[tab]}
      variant={tab === "today" ? "drawer-left" : "screen"}
      tabs={TABS}
      tab={tab}
      onTab={(t) => onTab(t as QuestsTab)}
      onClose={onClose}
      tabLabels={TAB_LABELS}
    >
      {sessionKind !== "user" ? (
        <RegisterHint />
      ) : tab === "pass" ? (
        <PassTab />
      ) : tab === "rewards" ? (
        <RewardsTab loading={<Skeleton />} error={<LoadError />} />
      ) : (
        <TodayTab onRewards={() => onTab("rewards")} />
      )}
    </Panel>
  );
}

function RegisterHint() {
  return (
    <div className="toon-panel bg-[#161b28]/95 p-6 text-center">
      <p className="font-body text-white/80">
        Registered raiders get 3 daily tasks for bonus XP, the Alpha Pass with founder cosmetics, and unlock titles, name colours and badge
        frames as they level up.
      </p>
      <Link href="/auth/register?next=/play" className="toon-btn mt-4 inline-flex min-h-11 items-center px-5 text-base">
        <span className="optical-center">Register</span>
      </Link>
    </div>
  );
}

function Skeleton() {
  return (
    <ul className="flex min-h-0 flex-1 flex-col gap-2 overflow-hidden" aria-busy="true" aria-label="Loading">
      {[0, 1, 2].map((i) => (
        <li key={i} className="h-24 animate-pulse rounded-2xl bg-white/[0.06] motion-reduce:animate-none" />
      ))}
    </ul>
  );
}

function LoadError() {
  const { reload } = useQuests();
  return (
    <div className="toon-panel bg-[#161b28]/95 p-6 text-center">
      <p className="font-body text-white/75">Couldn&apos;t load your tasks.</p>
      <button type="button" onClick={() => void reload()} className="toon-btn-ghost mt-4 min-h-11 px-5 text-sm">
        <span className="optical-center">Retry</span>
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------- Today

function TodayTab({ onRewards }: { onRewards: () => void }) {
  const { data, error } = useQuests();
  const now = useNow();
  if (!data) return error ? <LoadError /> : <Skeleton />;
  const nextMark = nextMarkReward(data.marks);
  return (
    <Paged gap={10} minCol={300} maxCols={2} label="Task pages">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <p className="font-body text-sm text-white/70">Finish tasks in your raids for bonus XP.</p>
        <p className="font-body text-xs lg:text-[0.8125rem] font-semibold tabular-nums text-white/70">New tasks in {fmtUntil(data.resetAt, now)}</p>
      </div>
      <ul className="paged-group">
        {data.slots.map((s) => (
          <TaskCard key={s.slot} slot={s} canSwap={data.rerollAvailable} />
        ))}
      </ul>
      <div className="grid gap-2 sm:grid-cols-2">
        <div className="rounded-2xl border-[3px] border-black bg-white/[0.05] px-3 py-2.5">
          <p className="text-xs lg:text-[0.8125rem] tracking-[0.12em] text-white/70">TASK XP TODAY</p>
          <p className="toon-text-thin mt-0.5 text-2xl tabular-nums text-sky-300">
            {fmtInt(data.xpToday)} <span className="text-base text-white/70">/ {fmtInt(data.xpMax)}</span>
          </p>
        </div>
        <button
          type="button"
          onClick={onRewards}
          className="rounded-2xl border-[3px] border-black bg-white/[0.05] px-3 py-2.5 text-left hover:bg-white/[0.08] focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-zooa-lime/70"
        >
          <p className="text-xs lg:text-[0.8125rem] tracking-[0.12em] text-white/70">TASK MARKS</p>
          <p className="toon-text-thin mt-0.5 text-2xl tabular-nums text-white">{fmtInt(data.marks)}</p>
          <p className="font-body text-xs lg:text-[0.8125rem] text-white/75">
            {nextMark ? `${nextMark.marks} for ${cosmeticLabel(nextMark.ids[0]!)}` : "Every mark reward unlocked"}
          </p>
        </button>
      </div>
      {/* The rules fold away: one tap instead of a block of text to scroll past. */}
      <details className="font-body group rounded-2xl border-[3px] border-black bg-white/[0.05] px-3 text-xs leading-snug text-white/75 lg:text-[0.8125rem]">
        <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 text-sm font-bold text-white/85 [&::-webkit-details-marker]:hidden">
          How tasks work
          <span aria-hidden className="text-base transition-transform group-open:rotate-90">›</span>
        </summary>
      <ul className="list-disc space-y-2.5 pb-3 pl-5">
        <li>Tasks count only in raids: an extract after 8+ minutes on the map, containers and bodies once each, real kills.</li>
        <li>Unfinished tasks carry over with their progress. One free swap a day.</li>
        <li>Each task pays {QUEST.XP} XP, up to {QUEST.DAILY_XP_MAX} a day, on top of the daily raid XP limit. No CR, no items.</li>
        <li>Each finished task is a mark toward cosmetic rewards.</li>
      </ul>
      </details>
    </Paged>
  );
}

function TaskCard({ slot: s, canSwap }: { slot: QuestSlotDto; canSwap: boolean }) {
  const { reroll } = useQuests();
  const { toast } = useLobby();
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const pct = s.need > 0 ? Math.min(100, (s.progress / s.need) * 100) : 0;

  const swap = async () => {
    setBusy(true);
    const r = await reroll(s.slot);
    setBusy(false);
    setConfirm(false);
    playUi(r.ok ? "click" : "error");
    toast(r.message);
  };

  return (
    <li
      className={clsx(
        "rounded-2xl border-[3px] border-black px-3 py-2.5",
        s.done ? "bg-zooa-lime/15" : "bg-[#1d2333]/90",
      )}
    >
      <div className="flex items-start gap-3">
        <span
          className={clsx(
            "mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-full border-[3px] border-black text-sm",
            s.done ? "bg-zooa-lime text-black" : "bg-white/10 text-white/70",
          )}
          aria-hidden
        >
          {s.done ? "✓" : s.slot + 1}
        </span>
        <div className="min-w-0 flex-1">
          <p className={clsx("text-base tracking-wide", s.done ? "text-zooa-lime" : "text-white")}>{s.label}</p>
          <p className="font-body mt-0.5 text-xs lg:text-[0.8125rem] leading-snug text-white/70">{s.hint}</p>
          {s.carried && <p className="font-body mt-1 text-xs lg:text-[0.8125rem] font-bold uppercase tracking-wider text-amber-300">Carried over</p>}
        </div>
        <span
          className={clsx(
            "font-body shrink-0 rounded-full border-2 border-black px-2 py-0.5 text-xs lg:text-[0.8125rem] font-bold tabular-nums",
            s.done ? "bg-zooa-lime text-black" : "bg-sky-300 text-black",
          )}
        >
          {s.done ? "Done" : `+${s.xp} XP`}
        </span>
      </div>
      <div className="mt-2 flex items-center gap-3">
        <span
          className="block h-3 min-w-0 flex-1 overflow-hidden rounded-full border-2 border-black bg-black/55"
          role="progressbar"
          aria-label={s.label}
          aria-valuemin={0}
          aria-valuemax={s.need}
          aria-valuenow={s.progress}
        >
          <span className="block h-full rounded-full bg-zooa-lime" style={{ width: `${pct}%` }} />
        </span>
        <span className="font-body shrink-0 text-sm font-semibold tabular-nums text-white/80">
          {s.progress}/{s.need}
        </span>
        {!s.done && canSwap && !confirm && (
          <button
            type="button"
            onClick={() => setConfirm(true)}
            className="font-body min-h-11 shrink-0 rounded-xl border-[3px] border-black bg-white/10 px-3 text-xs lg:text-[0.8125rem] font-bold text-white/85 hover:bg-white/15 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-zooa-lime/70"
          >
            Swap
          </button>
        )}
      </div>
      {confirm && (
        <div className="font-body mt-2 flex flex-wrap items-center gap-2 rounded-xl border-2 border-black bg-black/30 px-3 py-2 text-sm">
          <span className="min-w-0 flex-1 text-white/80">
            Swap for a new task?{s.progress > 0 ? " Its progress resets." : ""} One free swap a day.
          </span>
          <button
            type="button"
            disabled={busy}
            onClick={() => void swap()}
            className="toon-btn min-h-11 px-4 text-sm disabled:opacity-60"
          >
            <span className="optical-center">{busy ? "Swapping…" : "Swap"}</span>
          </button>
          <button type="button" disabled={busy} onClick={() => setConfirm(false)} className="toon-btn-ghost min-h-11 px-4 text-sm">
            <span className="optical-center">Keep</span>
          </button>
        </div>
      )}
    </li>
  );
}
