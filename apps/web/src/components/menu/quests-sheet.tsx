"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import clsx from "clsx";
import {
  QUEST,
  cosmeticDef,
  levelProgress,
  nextMarkReward,
  unlockedCosmetics,
  xpToNext,
  type CosmeticKind,
  type QuestSlotDto,
  type QuestsDto,
} from "@extract/shared";
import { useLobby, useNow } from "@/lib/lobby/lobby-context";
import { cosmeticLabel, markRewardTable, nameColorHex, nextReward, rewardTable, titleName, type RewardItem } from "@/lib/lobby/levels";
import { playUi } from "@/game/audio/ui-sounds";
import { LevelBadge } from "./level-badge";
import { Panel } from "./panel";
import { useQuests } from "./quests-context";
import { fmtInt } from "./xp-bar";

/** "5h 12m", "12m", "<1m" until `at`. */
export function fmtUntil(at: number, now: number): string {
  const mins = Math.max(0, Math.floor((at - now) / 60_000));
  if (mins < 1) return "<1m";
  const h = Math.floor(mins / 60);
  return h > 0 ? `${h}h ${mins % 60}m` : `${mins}m`;
}

export type QuestsTab = "today" | "rewards";
const TABS: readonly QuestsTab[] = ["today", "rewards"];
const TAB_LABELS: Readonly<Record<QuestsTab, string>> = { today: "Today", rewards: "Rewards" };

/**
 * Daily tasks and level rewards (RETENTION.md §3, §5): a drawer from the left with two tabs.
 * Today: the three tasks with progress, the day's free swap, task XP today, marks. Rewards: the next
 * reward, what to wear (title, name colour, badge frame — unlocked ones only, the server checks
 * again) and every reward by level and by task marks. Not a URL panel: opened by the tasks strip,
 * the Tasks button, the top-bar badge, the LEVEL N window and the phone's More sheet.
 */
export function QuestsSheet({ tab, onTab, onClose }: { tab: QuestsTab; onTab: (t: QuestsTab) => void; onClose: () => void }) {
  const { sessionKind } = useLobby();
  const { reload, markSeen } = useQuests();
  // Fresh numbers on open (the last raid may have settled since the menu loaded); the dot goes.
  useEffect(() => {
    void reload();
  }, [reload]);
  useEffect(() => {
    markSeen();
  }, [markSeen]);

  return (
    <Panel
      title={tab === "rewards" ? "Rewards" : "Daily tasks"}
      variant="drawer-left"
      tabs={TABS}
      tab={tab}
      onTab={(t) => onTab(t as QuestsTab)}
      onClose={onClose}
      tabLabels={TAB_LABELS}
    >
      {sessionKind !== "user" ? <RegisterHint /> : tab === "rewards" ? <RewardsTab /> : <TodayTab onRewards={() => onTab("rewards")} />}
    </Panel>
  );
}

function RegisterHint() {
  return (
    <div className="toon-panel bg-[#161b28]/95 p-6 text-center">
      <p className="font-body text-white/80">Registered raiders get 3 daily tasks for bonus XP, and unlock titles, name colours and badge frames as they level up.</p>
      <Link href="/auth/register?next=/play" className="toon-btn mt-4 inline-flex min-h-11 items-center px-5 text-base">
        <span className="optical-center">Register</span>
      </Link>
    </div>
  );
}

function Skeleton() {
  return (
    <ul className="flex flex-col gap-2" aria-busy="true" aria-label="Loading">
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
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <p className="font-body text-sm text-white/70">Finish tasks in your raids for bonus XP.</p>
        <p className="font-body text-xs lg:text-[0.8125rem] font-semibold tabular-nums text-white/70">New tasks in {fmtUntil(data.resetAt, now)}</p>
      </div>
      <ul className="flex flex-col gap-2">
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
      <ul className="font-body list-disc space-y-1 pl-5 text-xs lg:text-[0.8125rem] leading-relaxed text-white/75">
        <li>Tasks count only in raids: an extract after 8+ minutes on the map, containers and bodies once each, real kills.</li>
        <li>Unfinished tasks carry over with their progress. One free swap a day.</li>
        <li>Each task pays {QUEST.XP} XP, up to {QUEST.DAILY_XP_MAX} a day, on top of the daily raid XP limit. No CR, no items.</li>
        <li>Each finished task is a mark toward cosmetic rewards.</li>
      </ul>
    </div>
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

// ---------------------------------------------------------------------------- Rewards

const WEAR: ReadonlyArray<{ kind: CosmeticKind; label: string }> = [
  { kind: "title", label: "Title" },
  { kind: "color", label: "Name colour" },
  { kind: "frame", label: "Badge frame" },
];

function RewardsTab() {
  const { data, error } = useQuests();
  const { stash, user } = useLobby();
  const sell = stash.data?.market.sellUnlockLevel;
  if (!data) return error ? <LoadError /> : <Skeleton />;
  const xp = stash.data?.xp ?? null;
  const p = xp !== null ? levelProgress(xp) : null;
  const level = p?.level ?? data.level;
  const next = nextReward(level, sell);
  // XP from now to the next reward level.
  let toGo: number | null = null;
  if (p && next) {
    toGo = p.need - p.into;
    for (let l = p.level + 1; l < next.level; l++) toGo += xpToNext(l);
  }
  const owned = new Set(unlockedCosmetics(level, data.marks));
  const nick = user?.nickname ?? "You";

  return (
    <div className="flex flex-col gap-4">
      {/* Preview + next reward */}
      <section className="rounded-2xl border-[3px] border-black bg-[#1d2333]/90 p-3">
        <div className="flex items-center gap-3">
          <LevelBadge level={level} size="md" frame={data.equipped.frame} />
          <div className="min-w-0 flex-1">
            <p className="truncate text-lg tracking-wide" style={{ color: nameColorHex(data.equipped.color) ?? "#fff" }}>
              {nick}
            </p>
            <p className="font-body truncate text-xs lg:text-[0.8125rem] font-semibold uppercase tracking-wider text-white/75">
              {titleName(data.equipped.title) ?? "No title"}
            </p>
          </div>
        </div>
        {next ? (
          <div className="mt-3 border-t-2 border-black/40 pt-2.5">
            <p className="text-xs lg:text-[0.8125rem] tracking-[0.12em] text-white/70">
              NEXT · LEVEL {next.level}
              {toGo !== null && <span className="font-body ml-2 tracking-normal text-white/75">{fmtInt(toGo)} XP to go</span>}
            </p>
            <ul className="mt-1 space-y-0.5">
              {next.items.map((it) => (
                <RewardLine key={it.label} item={it} reached={false} />
              ))}
            </ul>
          </div>
        ) : (
          <p className="font-body mt-3 border-t-2 border-black/40 pt-2.5 text-sm text-zooa-lime">Every level reward unlocked.</p>
        )}
      </section>

      {/* What to wear */}
      <section aria-label="Wear" className="flex flex-col gap-3">
        {WEAR.map((w) => (
          <WearRow key={w.kind} kind={w.kind} label={w.label} owned={owned} data={data} />
        ))}
        <p className="font-body text-xs lg:text-[0.8125rem] text-white/70">Rewards are earned only by playing — they can&apos;t be bought or traded, and they change nothing in a raid.</p>
      </section>

      {/* All rewards by level */}
      <section>
        <h3 className="text-xs lg:text-[0.8125rem] tracking-[0.12em] text-white/70">BY LEVEL</h3>
        <ol className="mt-2 flex flex-col gap-1.5">
          {rewardTable(sell).map((r) => {
            const reached = level >= r.level;
            return (
              <li
                key={r.level}
                className={clsx(
                  "flex gap-3 rounded-xl border-[3px] px-2.5 py-2",
                  reached ? "border-black bg-white/[0.06]" : "border-transparent bg-white/[0.025]",
                )}
              >
                <LevelBadge level={r.level} size="sm" className={clsx(!reached && "opacity-50 grayscale")} />
                <ul className="min-w-0 flex-1 space-y-0.5 self-center">
                  {r.items.map((it) => (
                    <RewardLine key={it.label} item={it} reached={reached} />
                  ))}
                </ul>
              </li>
            );
          })}
        </ol>
      </section>

      <section>
        <h3 className="text-xs lg:text-[0.8125rem] tracking-[0.12em] text-white/70">BY TASK MARKS · YOU HAVE {fmtInt(data.marks)}</h3>
        <ol className="mt-2 flex flex-col gap-1.5">
          {markRewardTable().map((r) => {
            const reached = data.marks >= r.marks;
            return (
              <li
                key={r.marks}
                className={clsx(
                  "flex items-center gap-3 rounded-xl border-[3px] px-2.5 py-2",
                  reached ? "border-black bg-white/[0.06]" : "border-transparent bg-white/[0.025]",
                )}
              >
                <span
                  className={clsx(
                    "grid h-8 min-w-8 shrink-0 place-items-center rounded-full border-[3px] border-black px-1 text-xs lg:text-[0.8125rem] tabular-nums",
                    reached ? "bg-sky-300 text-black" : "bg-white/10 text-white/75",
                  )}
                >
                  {r.marks}
                </span>
                <ul className="min-w-0 flex-1">
                  {r.items.map((it) => (
                    <RewardLine key={it.label} item={it} reached={reached} />
                  ))}
                </ul>
              </li>
            );
          })}
        </ol>
      </section>
    </div>
  );
}

function RewardLine({ item, reached }: { item: RewardItem; reached: boolean }) {
  return (
    <li className={clsx("font-body flex items-center gap-2 text-sm", reached ? "text-white/90" : "text-white/70")}>
      {item.kind === "color" && item.hex ? (
        <span className="h-3 w-3 shrink-0 rounded-full border-2 border-black" style={{ background: item.hex }} aria-hidden />
      ) : item.kind === "frame" && item.hex ? (
        <span className="h-3 w-3 shrink-0 rounded-sm border-2" style={{ borderColor: item.hex }} aria-hidden />
      ) : (
        <span className={clsx("w-3 shrink-0 text-center text-xs lg:text-[0.8125rem]", reached ? "text-zooa-lime" : "text-white/70")} aria-hidden>
          {reached ? "✓" : "•"}
        </span>
      )}
      <span className="min-w-0">{item.label}</span>
    </li>
  );
}

function WearRow({ kind, label, owned, data }: { kind: CosmeticKind; label: string; owned: ReadonlySet<string>; data: QuestsDto }) {
  const { equip } = useQuests();
  const { toast } = useLobby();
  const [busy, setBusy] = useState<string | null>(null);
  const current = data.equipped[kind];
  const ids = [...owned].filter((id) => cosmeticDef(id)?.kind === kind);

  const pick = async (id: string | null) => {
    if (id === current || busy) return;
    setBusy(id ?? "none");
    const r = await equip(kind, id);
    setBusy(null);
    playUi(r.ok ? "click" : "error");
    if (!r.ok) toast(r.message);
  };

  const chip = (on: boolean) =>
    clsx(
      "font-body inline-flex min-h-11 items-center gap-1.5 rounded-xl border-[3px] border-black px-3 text-sm font-semibold focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-zooa-lime/70 disabled:opacity-60",
      on ? "bg-zooa-lime text-black shadow-[0_3px_0_#000]" : "bg-[#1d2333]/90 text-white/85 hover:text-white",
    );

  return (
    <div>
      <h3 className="text-xs lg:text-[0.8125rem] tracking-[0.12em] text-white/70">{label.toUpperCase()}</h3>
      {ids.length === 0 ? (
        <p className="font-body mt-1 text-sm text-white/70">Nothing unlocked yet — see the list below.</p>
      ) : (
        <div role="group" aria-label={label} className="mt-1.5 flex flex-wrap gap-1.5">
          <button type="button" aria-pressed={current === null} disabled={busy !== null} onClick={() => void pick(null)} className={chip(current === null)}>
            None
          </button>
          {ids.map((id) => {
            const d = cosmeticDef(id)!;
            const on = current === id;
            return (
              <button
                key={id}
                type="button"
                aria-pressed={on}
                disabled={busy !== null}
                onClick={() => void pick(id)}
                className={chip(on)}
              >
                {kind === "color" && d.hex && (
                  <span className="h-3.5 w-3.5 rounded-full border-2 border-black" style={{ background: d.hex }} aria-hidden />
                )}
                {kind === "frame" && <LevelBadge level={data.level} size="sm" frame={id} className="!h-6 !w-5" />}
                {busy === id ? "…" : d.name}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
