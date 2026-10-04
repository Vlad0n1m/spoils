"use client";

/**
 * Rewards tab of the tasks sheet (RETENTION.md §3, §5): the level road as a game screen. Your plate
 * and the XP bar to the next level, the next reward up front, then a horizontal road of level nodes
 * with a card per reward (drawn: nameplates, your nick in each colour, frames on your shield, trader
 * and market icons) — locked, next (pulsing) or unlocked with Wear — the task-mark road, and the
 * locker with everything owned. Presentation only: levels, marks and owned cosmetics come from
 * /api/quests and the stash, wearing goes through quests.equip.
 */
import { useEffect, useRef, useState } from "react";
import clsx from "clsx";
import { cosmeticDef, levelProgress, unlockedCosmetics, xpToNext, type QuestsDto, type WearableKind } from "@extract/shared";
import { useLobby } from "@/lib/lobby/lobby-context";
import { markRewardTable, nextReward, rewardTable, type RewardItem } from "@/lib/lobby/levels";
import { playUi } from "@/game/audio/ui-sounds";
import { LevelBadge } from "./level-badge";
import { useQuests } from "./quests-context";
import { CardStatus, LockIcon, ProfilePlate, RailStep, RewardCard, TitlePlate, WearButton, type RewardState } from "./reward-art";
import { fmtInt } from "./xp-bar";

const WEARABLE = new Set<string>(["title", "color", "frame", "skin"]);

export function RewardsTab({ loading, error }: { loading: React.ReactNode; error: React.ReactNode }) {
  const { data, error: failed } = useQuests();
  const { stash, user } = useLobby();
  const sell = stash.data?.market.sellUnlockLevel;
  if (!data) return <>{failed ? error : loading}</>;
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
  const owned = new Set(unlockedCosmetics(level, data.marks, data.granted ?? []));
  const nick = user?.nickname ?? "You";
  const pct = p ? Math.min(100, (p.into / Math.max(1, p.need)) * 100) : 0;

  const stateOf = (it: RewardItem, reached: boolean, isNext: boolean): RewardState => {
    if (!reached) return isNext ? "next" : "locked";
    if (it.id && WEARABLE.has(it.kind) && data.equipped[it.kind as WearableKind] === it.id) return "wearing";
    return "owned";
  };
  const footerOf = (it: RewardItem, reached: boolean, need: string) =>
    !reached ? (
      <CardStatus>
        <LockIcon className="!h-3.5 !w-3.5" /> {need}
      </CardStatus>
    ) : it.id && WEARABLE.has(it.kind) ? (
      <WearButton kind={it.kind as WearableKind} id={it.id} />
    ) : (
      <CardStatus tone="lime">Unlocked ✓</CardStatus>
    );

  const levels = rewardTable(sell);
  const marks = markRewardTable();
  const nextMark = marks.find((m) => m.marks > data.marks)?.marks ?? null;

  return (
    <div className="flex flex-col gap-5">
      {/* Plate + XP bar | next reward */}
      <section className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.25fr)] short:grid-cols-1">
        <ProfilePlate nick={nick} level={level} equipped={data.equipped} founder={(data.granted ?? []).includes("b-founder")}>
          <div className="mt-2">
            <div className="flex items-baseline justify-between gap-2">
              <span className="text-sm tracking-wide text-white">Level {level}</span>
              {p && (
                <span className="font-body text-xs font-semibold tabular-nums text-white/80">
                  {fmtInt(p.into)} / {fmtInt(p.need)} XP
                </span>
              )}
            </div>
            <span
              className="mt-1 block h-3.5 overflow-hidden rounded-full border-2 border-black bg-black/55"
              role="progressbar"
              aria-label={`XP to level ${level + 1}`}
              aria-valuemin={0}
              aria-valuemax={p?.need ?? 1}
              aria-valuenow={p?.into ?? 0}
            >
              <span className="block h-full rounded-full bg-[linear-gradient(180deg,#e9ff7a,#ccff00)]" style={{ width: `${pct}%` }} />
            </span>
          </div>
          {next && (
            <p className="font-body mt-1 hidden text-xs font-semibold text-white/85 short:block">
              Next: <span className="text-zooa-lime">Level {next.level}</span>
              {toGo !== null && <span className="tabular-nums"> · {fmtInt(toGo)} XP to go</span>} · pulsing on the road
            </p>
          )}
        </ProfilePlate>
        <div className="short:hidden [&>*]:h-full">
          <NextUp next={next} toGo={toGo} nick={nick} level={level} xpPct={pct} />
        </div>
      </section>

      <Road
        title="Level road"
        sub="Every level reward is yours the moment you reach it."
        groups={levels.map((g) => ({
          key: g.level,
          at: g.level,
          items: g.items,
        }))}
        current={level + (p ? p.into / Math.max(1, p.need) : 0)}
        node={(at, reached) => <LevelBadge level={at} size="md" className={clsx(!reached && "opacity-60 grayscale")} />}
        label={(at) => `Level ${at}`}
        renderCard={(it, at, reached, isNext, i) => (
          <RewardCard
            key={it.label}
            item={it}
            state={stateOf(it, reached, isNext)}
            nick={nick}
            level={level}
            footer={footerOf(it, reached, `Level ${at}`)}
            className="rw-card-in"
            style={{ animationDelay: `${Math.min(i, 12) * 45}ms` }}
          />
        )}
        you={`Lv ${level}`}
      />

      <Road
        title="Task marks"
        sub={`Each finished daily task is a mark. You have ${fmtInt(data.marks)}${nextMark ? ` — ${fmtInt(nextMark - data.marks)} to the next reward` : ""}.`}
        groups={marks.map((g) => ({
          key: g.marks,
          at: g.marks,
          items: g.items,
        }))}
        current={data.marks}
        node={(at, reached) => (
          <span
            className={clsx(
              "grid h-11 min-w-11 place-items-center rounded-full border-[3px] border-black px-1.5 text-sm tabular-nums shadow-[0_3px_0_#000]",
              reached ? "bg-sky-300 text-black" : "bg-[#2a3350] text-white/85",
            )}
          >
            <span className="optical-center">{at}</span>
          </span>
        )}
        label={(at) => `${at} marks`}
        renderCard={(it, at, reached, isNext) => (
          <RewardCard key={it.label} item={it} state={stateOf(it, reached, isNext)} nick={nick} level={level} footer={footerOf(it, reached, `${at} marks`)} />
        )}
        you={`${fmtInt(data.marks)} ✓`}
      />

      <Locker owned={owned} data={data} level={level} nick={nick} />
      <p className="font-body text-xs leading-snug text-white/75 lg:text-[0.8125rem]">
        Rewards are earned only by playing — they can&apos;t be bought or traded, and they change nothing in a raid.
      </p>
    </div>
  );
}

function NextUp({
  next,
  toGo,
  nick,
  level,
  xpPct,
}: {
  next: { level: number; items: RewardItem[] } | null;
  toGo: number | null;
  nick: string;
  level: number;
  xpPct: number;
}) {
  if (!next)
    return (
      <div className="grid place-items-center rounded-2xl border-[3px] border-black bg-[#173326]/90 p-4 text-center shadow-[0_4px_0_#000]">
        <p className="toon-text-thin text-2xl text-zooa-lime">Every level reward unlocked</p>
      </div>
    );
  return (
    <div className="relative flex min-w-0 flex-wrap items-center gap-x-4 gap-y-2 overflow-hidden rounded-2xl border-[3px] border-black bg-[radial-gradient(circle_at_85%_40%,rgba(204,255,0,0.18),transparent_60%),linear-gradient(180deg,#2a3553,#1a2138)] p-3 shadow-[0_4px_0_#000]">
      <div className="min-w-[9rem] flex-1">
        <p className="toon-text-thin text-xl tracking-wide text-zooa-lime">Next reward</p>
        <p className="toon-text mt-0.5 text-4xl leading-none tracking-wide text-white short:text-3xl">
          <span className="optical-center">Level {next.level}</span>
        </p>
        {toGo !== null && (
          <p className="font-body mt-1.5 text-sm font-semibold tabular-nums text-white/85">
            {fmtInt(toGo)} XP to go
            {next.level > level + 1 ? ` · ${next.level - level} levels` : ""}
          </p>
        )}
        {next.level === level + 1 && (
          <span className="mt-1.5 block h-2.5 overflow-hidden rounded-full border-2 border-black bg-black/55" aria-hidden>
            <span className="block h-full rounded-full bg-zooa-lime" style={{ width: `${xpPct}%` }} />
          </span>
        )}
      </div>
      <div className="rw-track -my-1 flex max-w-full gap-3 overflow-x-auto px-2 py-2.5">
        {next.items.map((it) => (
          <RewardCard key={it.label} item={it} state="next" nick={nick} level={level} />
        ))}
      </div>
    </div>
  );
}

/**
 * A horizontal road: a rail with a node per step (level or marks), filled up to `current`, the
 * reward cards of each step under its node, and a YOU marker. Opens scrolled to the next step;
 * ‹ › scroll it with a mouse, a finger drags it.
 */
function Road({
  title,
  sub,
  groups,
  current,
  node,
  label,
  renderCard,
  you,
}: {
  title: string;
  sub: string;
  groups: Array<{ key: number; at: number; items: RewardItem[] }>;
  current: number;
  node: (at: number, reached: boolean) => React.ReactNode;
  label: (at: number) => string;
  renderCard: (it: RewardItem, at: number, reached: boolean, isNext: boolean, index: number) => React.ReactNode;
  you: string;
}) {
  const track = useRef<HTMLDivElement>(null);
  const nextRef = useRef<HTMLLIElement>(null);
  const [edge, setEdge] = useState({ start: true, end: false });
  const nextAt = groups.find((g) => g.at > current)?.at ?? null;

  useEffect(() => {
    const el = track.current;
    const n = nextRef.current;
    // Open with the last unlocked step at the left edge and the next one beside it.
    const prev = n?.previousElementSibling as HTMLElement | null;
    if (el && n) el.scrollLeft = Math.max(0, prev && prev.offsetWidth < el.clientWidth * 0.5 ? prev.offsetLeft - 8 : n.offsetLeft - 48);
    onScroll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const onScroll = () => {
    const el = track.current;
    if (!el) return;
    setEdge({
      start: el.scrollLeft < 8,
      end: el.scrollLeft + el.clientWidth > el.scrollWidth - 8,
    });
  };
  const by = (dir: 1 | -1) => {
    const el = track.current;
    if (!el) return;
    playUi("click");
    el.scrollBy({
      left: dir * el.clientWidth * 0.8,
      behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
    });
  };

  let idx = 0;
  const steps = groups.map((g, i) => {
    const prevAt = i > 0 ? groups[i - 1]!.at : Math.min(g.at - 1, Math.floor(current));
    const nextG = groups[i + 1];
    return {
      g,
      progIn: (current - prevAt) / Math.max(1e-6, g.at - prevAt),
      progOut: nextG ? (current - g.at) / Math.max(1e-6, nextG.at - g.at) : 0,
    };
  });
  return (
    <section aria-label={title}>
      <div className="flex items-end justify-between gap-3">
        <div className="min-w-0">
          <h3 className="toon-text-thin text-2xl tracking-wide text-white">{title}</h3>
          <p className="font-body text-sm text-white/80">{sub}</p>
        </div>
        <div className="flex shrink-0 gap-2">
          {([-1, 1] as const).map((d) => (
            <button
              key={d}
              type="button"
              onClick={() => by(d)}
              disabled={d < 0 ? edge.start : edge.end}
              aria-label={d < 0 ? "Scroll back" : "Scroll on"}
              className="menu-chip grid h-11 w-11 place-items-center bg-white text-black disabled:opacity-40"
            >
              <svg viewBox="0 0 20 20" className="h-5 w-5" aria-hidden>
                <path
                  d={d < 0 ? "M12.5 4 6.5 10l6 6" : "M7.5 4l6 6-6 6"}
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.8"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </button>
          ))}
        </div>
      </div>
      <div
        ref={track}
        onScroll={onScroll}
        className="rw-track mt-2 overflow-x-auto overscroll-x-contain rounded-2xl border-[3px] border-black bg-[linear-gradient(180deg,rgba(9,12,20,0.55),rgba(20,26,42,0.55))] shadow-[inset_0_3px_0_rgba(0,0,0,0.35)]"
      >
        <ol className="flex w-max px-2 pb-4 pt-2">
          {steps.map(({ g, progIn, progOut }, i) => {
            const reached = current >= g.at;
            const isNext = g.at === nextAt;
            return (
              <li key={g.key} ref={isNext ? nextRef : undefined} className="flex flex-col" aria-label={`${label(g.at)}${reached ? ", unlocked" : ""}`}>
                <RailStep progIn={progIn} progOut={progOut} node={node(g.at, reached)} you={you} first={i === 0} last={i === steps.length - 1} float={isNext} />
                <p className={clsx("mb-2 mt-0.5 text-center text-sm tracking-wide", reached ? "text-zooa-lime" : isNext ? "text-white" : "text-white/75")}>
                  {reached ? `${label(g.at)} ✓` : label(g.at)}
                </p>
                <div className="flex justify-center gap-3 px-2">{g.items.map((it) => renderCard(it, g.at, reached, isNext, idx++))}</div>
              </li>
            );
          })}
        </ol>
      </div>
    </section>
  );
}

const LOCKER: ReadonlyArray<{ kind: WearableKind; label: string }> = [
  { kind: "title", label: "Titles" },
  { kind: "color", label: "Name colours" },
  { kind: "frame", label: "Badge frames" },
  { kind: "skin", label: "Skins" },
];

/** Everything owned, by kind, to wear in one tap (level, marks and Alpha Pass rewards). */
function Locker({ owned, data, level, nick }: { owned: ReadonlySet<string>; data: QuestsDto; level: number; nick: string }) {
  return (
    <section aria-label="Locker">
      <h3 className="toon-text-thin text-2xl tracking-wide text-white">Locker</h3>
      <p className="font-body text-sm text-white/80">Everything you own. Tap to wear it, tap again to take it off.</p>
      <div className="mt-2 grid gap-3 md:grid-cols-2">
        {LOCKER.map((w) => (
          <LockerRow key={w.kind} kind={w.kind} label={w.label} owned={owned} data={data} level={level} nick={nick} />
        ))}
      </div>
    </section>
  );
}

function LockerRow({
  kind,
  label,
  owned,
  data,
  level,
  nick,
}: {
  kind: WearableKind;
  label: string;
  owned: ReadonlySet<string>;
  data: QuestsDto;
  level: number;
  nick: string;
}) {
  const { equip } = useQuests();
  const { toast } = useLobby();
  const [busy, setBusy] = useState<string | null>(null);
  const current = data.equipped[kind] ?? null;
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
      "font-body inline-flex min-h-11 items-center gap-2 rounded-xl border-[3px] border-black px-2.5 text-sm font-semibold focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-zooa-lime/70 disabled:opacity-60",
      on ? "bg-zooa-lime/25 text-white shadow-[0_0_0_3px_#ccff00]" : "bg-[#1d2333] text-white/85 hover:bg-[#252d43] hover:text-white",
    );

  return (
    <div className="rounded-2xl border-[3px] border-black bg-[#1a2033]/90 p-2.5">
      <p className="font-body text-xs font-bold uppercase tracking-wider text-white/75">{label}</p>
      {ids.length === 0 ? (
        <p className="font-body mt-1 text-sm text-white/75">Nothing yet — follow the road above.</p>
      ) : (
        <div role="group" aria-label={label} className="mt-1.5 flex flex-wrap gap-1.5">
          <button type="button" aria-pressed={current === null} disabled={busy !== null} onClick={() => void pick(null)} className={chip(current === null)}>
            None
          </button>
          {ids.map((id) => {
            const d = cosmeticDef(id)!;
            const on = current === id;
            return (
              <button key={id} type="button" aria-pressed={on} aria-label={d.name} disabled={busy !== null} onClick={() => void pick(id)} className={chip(on)}>
                {kind === "title" ? (
                  <TitlePlate name={d.name} tone={d.grant === "pass" ? "mint" : "amber"} size="sm" />
                ) : kind === "color" && d.hex ? (
                  <span className="toon-text-thin max-w-[9rem] truncate text-base" style={{ color: d.hex }}>
                    {nick}
                  </span>
                ) : kind === "frame" ? (
                  <>
                    <LevelBadge level={level} size="sm" frame={id} className="!h-8 !w-7" />
                    {d.name}
                  </>
                ) : (
                  <>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src="/lobby/hero_alpha.png" alt="" className="h-9 w-9 rounded-md border-2 border-black object-cover object-top" />
                    {d.name}
                  </>
                )}
                {busy === id && "…"}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
