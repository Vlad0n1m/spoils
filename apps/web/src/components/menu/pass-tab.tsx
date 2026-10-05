"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import clsx from "clsx";
import { ALPHA_SKIN, ALPHA_SURVEY, FOUNDER_BADGE, PASS, type PassDto, type PassTierDto, type TesterTaskDto, type WearableKind } from "@extract/shared";
import { useLobby, useNow } from "@/lib/lobby/lobby-context";
import { cosmeticItem, type RewardItem } from "@/lib/lobby/levels";
import { playUi } from "@/game/audio/ui-sounds";
import { usePass } from "./pass-context";
import { useQuests } from "./quests-context";
import { fmtUntil } from "./quests-sheet";
import { CardStatus, LockIcon, MINT, ProfilePlate, RailStep, RewardArt, RewardCard, WearButton, type RewardState } from "./reward-art";
import { fmtInt } from "./xp-bar";
import { PagerArrow, Paged, Segmented, useCarousel } from "@/components/paged";

/**
 * Alpha Pass screen of the tasks sheet (GAME_DESIGN §18e): a banner with AP, the tier bar and your
 * plate; the 10-tier track of drawn reward cards (claim with a glow, shine and confetti, the reward
 * flies into the plate; wear); the week's three weekly tasks and the tester tasks (with the bug report
 * form and the survey). Everything is cosmetic and permanent: the alpha wipe keeps it. Cards enter
 * staggered; every animation stops under prefers-reduced-motion.
 */
export function PassTab() {
  const { data, error, reload } = usePass();
  if (!data) {
    return error ? (
      <div className="toon-panel bg-[#161b28]/95 p-6 text-center">
        <p className="font-body text-white/75">Couldn&apos;t load the Alpha Pass.</p>
        <button type="button" onClick={() => void reload()} className="toon-btn-ghost mt-4 min-h-11 px-5 text-sm">
          <span className="optical-center">Retry</span>
        </button>
      </div>
    ) : (
      <ul className="flex flex-col gap-2" aria-busy="true" aria-label="Loading">
        {[0, 1, 2].map((i) => (
          <li key={i} className="h-24 animate-pulse rounded-2xl bg-white/[0.06] motion-reduce:animate-none" />
        ))}
      </ul>
    );
  }
  return <PassBody data={data} />;
}

export function PassBody({ data }: { data: PassDto }) {
  const quests = useQuests();
  const { user } = useLobby();
  const plate = useRef<HTMLDivElement>(null);
  const [pop, setPop] = useState(0);
  const [fly, setFly] = useState<{
    item: RewardItem;
    from: DOMRect;
    key: number;
  } | null>(null);
  const nick = user?.nickname ?? "You";
  const level = quests.data?.level ?? 1;
  const owned = new Set(data.owned);
  const [view, setView] = useState<"tiers" | "tasks" | "pass">("tiers");

  // A claimed reward flies from its card into the plate (skipped under reduced motion).
  const flyFrom = useCallback((item: RewardItem, from: DOMRect) => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setPop((n) => n + 1);
      return;
    }
    setFly({ item, from, key: Date.now() });
  }, []);

  const claimable = data.tiers.some((t) => t.reached && !t.claimed);
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 short:gap-2">
      {/* Sub-pages instead of one long screen: the tier track, the tasks, the banner with the plate. */}
      <div className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2">
        <Segmented
          options={[
            { id: "tiers", label: "Tiers", dot: claimable },
            { id: "tasks", label: "Tasks" },
            { id: "pass", label: "My pass" },
          ]}
          value={view}
          onChange={setView}
          label="Alpha Pass sections"
        />
        {view !== "pass" && <PassStrip data={data} badgeRef={plate} />}
      </div>
      {view === "tiers" ? (
        <Track data={data} nick={nick} level={level} onClaimed={flyFrom} />
      ) : view === "tasks" ? (
        <Paged gap={10} colGap={16} minCol={320} maxCols={2} label="Task pages">
          <Weekly data={data} />
          <Tester data={data} />
          <p className="font-body text-xs leading-snug text-white/75 lg:text-[0.8125rem]">
            Alpha Points come only from tasks finished in real raids and tester tasks. Rewards are cosmetic, can&apos;t be bought or traded, and{" "}
            <span className="font-semibold text-white/90">stay after the alpha wipe</span>.
          </p>
        </Paged>
      ) : (
        <>
          <Header data={data} nick={nick} level={level} plateRef={plate} pop={pop} founder={owned.has(FOUNDER_BADGE)} skinOwned={owned.has(ALPHA_SKIN)} />
          <ApSources data={data} className="hidden shrink-0 short:flex" />
        </>
      )}
      {fly && (
        <FlyToPlate
          key={fly.key}
          item={fly.item}
          from={fly.from}
          to={plate}
          nick={nick}
          level={level}
          onDone={() => {
            setFly(null);
            setPop((n) => n + 1);
          }}
        />
      )}
    </div>
  );
}

/** The flying copy of a claimed reward: from the card's art to the plate, shrinking (Web Animations, portal to body). */
function FlyToPlate({
  item,
  from,
  to,
  nick,
  level,
  onDone,
}: {
  item: RewardItem;
  from: DOMRect;
  to: React.RefObject<HTMLDivElement | null>;
  nick: string;
  level: number;
  onDone: () => void;
}) {
  const el = useRef<HTMLDivElement>(null);
  const done = useRef(onDone);
  done.current = onDone;
  useLayoutEffect(() => {
    const node = el.current;
    const target = to.current?.getBoundingClientRect();
    if (!node || !target) {
      done.current();
      return;
    }
    const dx = target.left + 44 - (from.left + from.width / 2);
    const dy = target.top + target.height / 2 - (from.top + from.height / 2);
    const a = node.animate(
      [
        { transform: "translate(0,0) scale(1)", opacity: 1 },
        {
          transform: `translate(${dx * 0.35}px, ${dy * 0.35 - 70}px) scale(1.15)`,
          opacity: 1,
          offset: 0.35,
        },
        { transform: `translate(${dx}px, ${dy}px) scale(0.3)`, opacity: 0.2 },
      ],
      {
        duration: 900,
        delay: 350,
        easing: "cubic-bezier(0.5,0,0.3,1)",
        fill: "both",
      },
    );
    a.onfinish = () => done.current();
    return () => a.cancel();
  }, [from, to]);
  return createPortal(
    <div
      ref={el}
      className="pointer-events-none fixed z-[90] grid place-items-center overflow-hidden rounded-xl border-[3px] border-black bg-[#1b2239] shadow-[0_0_30px_#5cf2c6]"
      style={{
        left: from.left,
        top: from.top,
        width: from.width,
        height: from.height,
      }}
      aria-hidden
    >
      <RewardArt item={item} nick={nick} level={level} big />
    </div>,
    document.body,
  );
}

/** One row under the switch: tier, AP, the bar to the next tier (the claim fly-in lands on the tier box). */
function PassStrip({ data, badgeRef }: { data: PassDto; badgeRef: React.Ref<HTMLDivElement> }) {
  const prev = data.tier > 0 ? data.tiers[data.tier - 1]!.ap : 0;
  const next = data.next;
  const pct = next ? Math.min(100, ((data.ap - prev) / Math.max(1, next.ap - prev)) * 100) : 100;
  return (
    <div className="flex min-w-[15rem] flex-1 items-center gap-3">
      <div
        ref={badgeRef}
        className="grid h-11 w-11 shrink-0 place-items-center rounded-xl border-[3px] border-black text-xl text-black shadow-[0_3px_0_#000] short:h-9 short:w-9 short:text-lg"
        style={{ background: `linear-gradient(180deg,#b8ffe9,${MINT})` }}
        aria-label={`Tier ${data.tier} of 10`}
      >
        <span className="optical-center">{data.tier}</span>
      </div>
      <div className="min-w-0 flex-1">
        <p className="font-body truncate text-xs font-semibold text-white/85 lg:text-[0.8125rem]">
          {next ? (
            <>
              <span className="tabular-nums">{fmtInt(next.ap - data.ap)} AP</span> to tier {next.tier} ·{" "}
              <span style={{ color: MINT }}>{next.name}</span>
            </>
          ) : (
            <span style={{ color: MINT }}>Pass complete</span>
          )}
        </p>
        <span className="mt-1 block h-3 overflow-hidden rounded-full border-2 border-black bg-black/60" aria-hidden>
          <span className="block h-full rounded-full" style={{ width: `${pct}%`, background: `linear-gradient(180deg,#b8ffe9,${MINT})` }} />
        </span>
      </div>
      <p className="toon-text-thin shrink-0 text-2xl tabular-nums text-white short:text-xl">
        {fmtInt(data.ap)} <span className="text-base text-white/80">AP</span>
      </p>
    </div>
  );
}

function Header({
  data,
  nick,
  level,
  plateRef,
  pop,
  founder,
  skinOwned,
}: {
  data: PassDto;
  nick: string;
  level: number;
  plateRef: React.Ref<HTMLDivElement>;
  pop: number;
  founder: boolean;
  skinOwned: boolean;
}) {
  const quests = useQuests();
  const prev = data.tier > 0 ? data.tiers[data.tier - 1]!.ap : 0;
  const next = data.next;
  const pct = next ? Math.min(100, ((data.ap - prev) / Math.max(1, next.ap - prev)) * 100) : 100;
  const top = data.tiers[data.tiers.length - 1]?.ap ?? 1;
  return (
    <section
      className="relative overflow-hidden rounded-2xl border-[3px] border-black shadow-[0_4px_0_#000]"
      aria-label="Alpha Pass progress"
      style={{
        background: "#0d1626 url(/lobby/pass_banner.webp) 70% 35% / cover no-repeat",
      }}
    >
      <div className="absolute inset-0 bg-[linear-gradient(90deg,rgba(8,12,22,0.94)_0%,rgba(8,12,22,0.82)_45%,rgba(8,12,22,0.35)_100%)]" aria-hidden />
      <div className="relative grid gap-4 p-4 md:grid-cols-[minmax(0,1fr)_minmax(0,22rem)] md:p-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,20rem)_10rem] lg:pb-0 short:grid-cols-[minmax(0,1fr)_minmax(0,17rem)] short:gap-3 short:p-3">
        <div className="min-w-0">
          <div className="flex items-center gap-3">
            <span
              className="rw-card-in relative grid h-16 w-16 shrink-0 place-items-center rounded-2xl border-[3px] border-black text-3xl text-black shadow-[0_4px_0_#000,inset_0_3px_0_rgba(255,255,255,0.55)] short:h-14 short:w-14"
              style={{ background: `linear-gradient(180deg,#b8ffe9,${MINT})` }}
              aria-label={`Tier ${data.tier} of 10`}
            >
              <span className="optical-center">{data.tier}</span>
            </span>
            <div className="min-w-0">
              <h3 className="toon-text text-4xl leading-none tracking-wide md:text-5xl short:!text-3xl" style={{ color: MINT }}>
                <span className="optical-center">Alpha Pass</span>
              </h3>
              <p className="font-body mt-1 text-sm font-semibold text-white/85">Tier {data.tier} of 10 · rewards stay after the wipe</p>
            </div>
            <p className="toon-text-thin ml-auto shrink-0 self-end text-right text-3xl tabular-nums text-white short:text-2xl">
              {fmtInt(data.ap)} <span className="text-lg text-white/80">AP</span>
            </p>
          </div>
          {/* The whole track as one bar with a diamond per tier. */}
          <div className="relative mt-3 short:mt-2">
            <span
              className="block h-4 overflow-hidden rounded-full border-[3px] border-black bg-black/60"
              role="progressbar"
              aria-label="Alpha Points on the track"
              aria-valuemin={0}
              aria-valuemax={top}
              aria-valuenow={Math.min(data.ap, top)}
            >
              <span
                className="block h-full rounded-full"
                style={{
                  width: `${Math.min(100, (data.ap / top) * 100)}%`,
                  background: `linear-gradient(180deg,#b8ffe9,${MINT})`,
                }}
              />
            </span>
            {data.tiers.map((t) => (
              <span
                key={t.tier}
                className={clsx(
                  "absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rotate-45 border-2 border-black",
                  t.reached ? "bg-white" : "bg-[#2a3350]",
                )}
                style={{ left: `${(t.ap / top) * 100}%` }}
                aria-hidden
              />
            ))}
          </div>
          <p className="font-body mt-2 text-sm text-white/90">
            {next ? (
              <>
                <span className="font-bold tabular-nums">{fmtInt(next.ap - data.ap)} AP</span> to tier {next.tier} ·{" "}
                <span className="font-bold" style={{ color: MINT }}>
                  {next.name}
                </span>
                <span className="sr-only"> ({Math.round(pct)}% of this tier)</span>
              </>
            ) : (
              <span className="font-bold" style={{ color: MINT }}>
                Pass complete — thank you, Founder.
              </span>
            )}
          </p>
          <ApSources data={data} className="mt-3 short:hidden" />
        </div>
        <div className="flex min-w-0 flex-col justify-end gap-2">
          <ProfilePlate
            nick={nick}
            level={quests.data ? level : null}
            equipped={quests.data?.equipped ?? null}
            founder={founder}
            plateRef={plateRef}
            pop={pop}
            className="bg-[linear-gradient(180deg,rgba(44,55,88,0.92),rgba(27,34,57,0.92))] lg:mb-5"
          />
        </div>
        {/* The tier-8 skin standing in the banner: lit once claimed, a dark silhouette with its tier until then. */}
        <div className="relative hidden self-end lg:block" aria-label={`Alpha Veteran skin, tier 8${skinOwned ? ", yours" : ""}`} role="img">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/lobby/hero_alpha.png"
            alt=""
            draggable={false}
            className={clsx("rw-float mx-auto h-56 w-auto select-none object-contain drop-shadow-[0_6px_0_rgba(0,0,0,0.6)]", !skinOwned && "brightness-[0.35] saturate-50")}
          />
          <span
            className="font-body absolute bottom-3 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-full border-2 border-black px-2 py-0.5 text-xs font-bold text-black shadow-[0_2px_0_#000]"
            style={{ background: skinOwned ? MINT : "#e5e7eb" }}
          >
            {skinOwned ? "Alpha Veteran ✓" : "Tier 8 skin"}
          </span>
        </div>
      </div>
    </section>
  );
}

/** Where AP comes from: daily, weekly and tester tasks. */
function ApSources({ data, className }: { data: PassDto; className?: string }) {
  return (
    <ul className={clsx("font-body flex flex-wrap gap-2 text-xs leading-snug text-white/85", className)} aria-label="How to earn AP">
      <li className="rounded-xl border-2 border-black bg-black/45 px-2.5 py-1.5">
        <span className="font-bold tabular-nums" style={{ color: MINT }}>
          +{data.daily.apEach} AP
        </span>{" "}
        daily task · {data.daily.doneToday}/{data.daily.max} today
      </li>
      <li className="rounded-xl border-2 border-black bg-black/45 px-2.5 py-1.5">
        <span className="font-bold tabular-nums" style={{ color: MINT }}>
          +{data.weekly.apEach} AP
        </span>{" "}
        weekly task
      </li>
      <li className="rounded-xl border-2 border-black bg-black/45 px-2.5 py-1.5">
        <span className="font-bold tabular-nums" style={{ color: MINT }}>
          +30–50 AP
        </span>{" "}
        tester task, once
      </li>
    </ul>
  );
}

function Track({ data, nick, level, onClaimed }: { data: PassDto; nick: string; level: number; onClaimed: (item: RewardItem, from: DOMRect) => void }) {
  const { ref: track, edge, by, handlers } = useCarousel<HTMLDivElement>();
  const focus = useRef<HTMLLIElement>(null);
  const firstOpen = data.tiers.find((t) => t.reached && !t.claimed)?.tier ?? data.next?.tier ?? null;
  useEffect(() => {
    const el = track.current;
    const n = focus.current;
    if (el && n && n.offsetLeft + n.offsetWidth > el.clientWidth) el.scrollLeft = Math.max(0, n.offsetLeft - 60);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <section aria-label="Tiers" className="flex min-h-0 flex-1 flex-col">
      <h3 className="sr-only">Rewards</h3>
      <div className="relative">
      {/* Big side arrows over the track (hidden at its ends), like a game's reward carousel. */}
      <PagerArrow dir={-1} disabled={edge.start} onClick={() => by(-1)} className="absolute left-1 top-1/2 z-[3] -translate-y-1/2 shadow-[0_4px_0_#000] disabled:invisible" />
      <PagerArrow dir={1} disabled={edge.end} onClick={() => by(1)} className="absolute right-1 top-1/2 z-[3] -translate-y-1/2 shadow-[0_4px_0_#000] disabled:invisible" />
      <div
        ref={track}
        {...handlers}
        className="rw-track mt-2 overflow-hidden [touch-action:pan-y] rounded-2xl short:mt-1.5 border-[3px] border-black bg-[linear-gradient(180deg,rgba(9,12,20,0.55),rgba(20,26,42,0.55))] shadow-[inset_0_3px_0_rgba(0,0,0,0.35)]"
      >
        <ol className="flex w-max px-2 pb-4 pt-2 short:pb-2 short:pt-1">
          {data.tiers.map((t, i) => (
            <TierCard
              key={t.tier}
              t={t}
              data={data}
              nick={nick}
              level={level}
              index={i}
              liRef={t.tier === firstOpen ? focus : undefined}
              onClaimed={onClaimed}
            />
          ))}
        </ol>
      </div>
      </div>
    </section>
  );
}

/** The tier-10 "Founder" leaderboard badge. */
export function FounderBadge({ className }: { className?: string }) {
  return (
    <span
      className={clsx(
        "inline-grid h-6 w-6 shrink-0 place-items-center rounded-full border-2 border-black text-[0.75rem] font-bold text-black shadow-[0_2px_0_#000]",
        className,
      )}
      style={{
        background: `radial-gradient(circle at 35% 30%, #c9fff0, ${MINT})`,
      }}
      title="Founder · Alpha Pass"
      aria-label="Founder"
    >
      ★
    </span>
  );
}

function TierCard({
  t,
  data,
  nick,
  level,
  index,
  liRef,
  onClaimed,
}: {
  t: PassTierDto;
  data: PassDto;
  nick: string;
  level: number;
  index: number;
  liRef?: React.Ref<HTMLLIElement>;
  onClaimed: (item: RewardItem, from: DOMRect) => void;
}) {
  const { claim } = usePass();
  const quests = useQuests();
  const { toast } = useLobby();
  const [busy, setBusy] = useState(false);
  const [celebrate, setCelebrate] = useState(false);
  const art = useRef<HTMLDivElement>(null);
  const item = cosmeticItem(t.reward) ?? {
    kind: "title" as const,
    label: t.name,
  };
  const wearable = t.kind !== "badge";
  const worn = wearable && quests.data?.equipped[t.kind as WearableKind] === t.reward;
  const isNext = data.next?.tier === t.tier;
  const prevAp = t.tier > 1 ? data.tiers[t.tier - 2]!.ap : 0;
  const nextTier = data.tiers[t.tier] ?? null;

  useEffect(() => {
    if (!celebrate) return;
    const id = window.setTimeout(() => setCelebrate(false), 1600);
    return () => window.clearTimeout(id);
  }, [celebrate]);

  const doClaim = async () => {
    setBusy(true);
    const r = await claim(t.tier);
    setBusy(false);
    playUi(r.ok ? "coin" : "error");
    toast(r.message);
    if (r.ok) {
      setCelebrate(true);
      const rect = art.current?.getBoundingClientRect();
      if (rect) onClaimed(item, rect);
      void quests.reload();
    }
  };

  const state: RewardState = t.claimed ? (worn ? "wearing" : "claimed") : t.reached ? "claimable" : isNext ? "next" : "locked";
  const footer = t.claimed ? (
    wearable ? (
      <WearButton kind={t.kind as WearableKind} id={t.reward} />
    ) : (
      <CardStatus tone="mint">On the boards ✓</CardStatus>
    )
  ) : t.reached ? (
    <button type="button" disabled={busy} onClick={() => void doClaim()} className="toon-btn min-h-11 w-full px-2 text-base disabled:opacity-60">
      <span className="optical-center">{busy ? "…" : "Claim!"}</span>
    </button>
  ) : (
    <CardStatus>
      <LockIcon className="!h-3.5 !w-3.5" /> {fmtInt(Math.max(0, t.ap - data.ap))} AP to go
    </CardStatus>
  );

  return (
    <li
      ref={liRef}
      className="flex flex-col items-stretch"
      aria-label={`Tier ${t.tier}, ${t.name}${t.claimed ? ", claimed" : t.reached ? ", ready to claim" : ", locked"}`}
    >
      {/* Landscape phones: no rail (the strip above shows the AP bar); the card's ribbon names the tier. */}
      <div className="short:hidden">
      <RailStep
        progIn={(data.ap - prevAp) / Math.max(1, t.ap - prevAp)}
        progOut={nextTier ? (data.ap - t.ap) / Math.max(1, nextTier.ap - t.ap) : 0}
        first={t.tier === 1}
        last={!nextTier}
        you={`${fmtInt(data.ap)} AP`}
        fill={`linear-gradient(180deg,#b8ffe9,${MINT})`}
        chip={MINT}
        float={isNext}
        node={
          <span
            className={clsx(
              "grid h-11 w-11 place-items-center rounded-full border-[3px] border-black text-lg shadow-[0_3px_0_#000]",
              t.reached ? "text-black" : "bg-[#2a3350] text-white",
            )}
            style={t.reached ? { background: `linear-gradient(180deg,#b8ffe9,${MINT})` } : undefined}
          >
            <span className="optical-center">{t.tier}</span>
          </span>
        }
      />
      <p className="font-body mb-2 text-center text-xs font-bold tabular-nums text-white/80">{fmtInt(t.ap)} AP</p>
      </div>
      <div className="flex justify-center px-2 short:pt-2.5">
        <RewardCard
          ribbon={
            <span
              className="font-body absolute -top-3 left-1/2 z-[2] hidden -translate-x-1/2 whitespace-nowrap rounded-full border-2 border-black px-2 py-0.5 text-[0.7rem] font-bold tabular-nums text-black shadow-[0_2px_0_#000] short:block"
              style={{ background: t.reached ? MINT : "#e5e7eb" }}
            >
              Tier {t.tier} · {fmtInt(t.ap)} AP
            </span>
          }
          item={item}
          state={state}
          nick={nick}
          level={level}
          big
          celebrate={celebrate}
          artRef={art}
          footer={footer}
          className="rw-card-in"
          style={{ animationDelay: `${80 + index * 70}ms` }}
        />
      </div>
    </li>
  );
}

function Weekly({ data }: { data: PassDto }) {
  const now = useNow();
  return (
    <section aria-label="Weekly tasks" className="paged-group">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3">
        <h3 className="toon-text-thin text-2xl tracking-wide text-white">Weekly tasks</h3>
        <p className="font-body text-sm font-semibold tabular-nums text-white/80">New in {fmtUntil(data.weekly.resetAt, now)}</p>
      </div>
      <ul className="paged-group">
        {data.weekly.slots.map((s, i) => {
          const pct = s.need > 0 ? Math.min(100, (s.progress / s.need) * 100) : 0;
          return (
            <li
              key={s.slot}
              className={clsx(
                "rw-card-in relative overflow-hidden rounded-2xl border-[3px] border-black px-3 py-2.5 shadow-[0_4px_0_#000]",
                s.done ? "bg-[linear-gradient(180deg,#1f4a37,#173326)]" : "bg-[linear-gradient(180deg,#2c3758,#1b2239)]",
              )}
              style={{ animationDelay: `${300 + i * 70}ms` }}
            >
              <div className="flex items-start gap-3">
                <span
                  className={clsx(
                    "grid h-11 w-11 shrink-0 place-items-center rounded-xl border-[3px] border-black text-lg shadow-[0_3px_0_#000]",
                    s.done ? "bg-zooa-lime text-black" : "bg-[#121826] text-white",
                  )}
                  aria-hidden
                >
                  <span className="optical-center">{s.done ? "✓" : s.slot + 1}</span>
                </span>
                <div className="min-w-0 flex-1">
                  <p className={clsx("text-base leading-tight tracking-wide", s.done ? "text-zooa-lime" : "text-white")}>{s.label}</p>
                  <p className="font-body mt-0.5 text-xs leading-snug text-white/75 lg:text-[0.8125rem]">{s.hint}</p>
                </div>
                <span
                  className="font-body shrink-0 rounded-full border-2 border-black px-2 py-0.5 text-xs font-bold tabular-nums text-black"
                  style={{ background: s.done ? "#ccff00" : MINT }}
                >
                  {s.done ? "Done" : `+${data.weekly.apEach} AP`}
                </span>
              </div>
              {!s.done && (
                <div className="mt-2 flex items-center gap-2">
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
                  <span className="font-body shrink-0 text-sm font-semibold tabular-nums text-white/85">
                    {s.progress}/{s.need}
                  </span>
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function Tester({ data }: { data: PassDto }) {
  const [open, setOpen] = useState<"bug" | "survey" | null>(null);
  return (
    <section aria-label="Tester tasks" className="paged-group">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3">
        <h3 className="toon-text-thin text-2xl tracking-wide text-white">Tester tasks</h3>
        <p className="font-body text-sm font-semibold text-white/80">Once each</p>
      </div>
      <ul className="paged-group">
        {data.tester.map((t, i) => (
          <TesterRow key={t.id} t={t} index={i} open={open === t.id} onOpen={() => setOpen(open === t.id ? null : (t.id as "bug" | "survey"))} />
        ))}
      </ul>
    </section>
  );
}

function TesterRow({ t, index, open, onOpen }: { t: TesterTaskDto; index: number; open: boolean; onOpen: () => void }) {
  const action = !t.done && (t.id === "bug" || t.id === "survey");
  return (
    <li
      className={clsx(
        "rw-card-in rounded-2xl border-[3px] border-black px-3 py-2.5 shadow-[0_4px_0_#000]",
        t.done ? "bg-[linear-gradient(180deg,#1f4a37,#173326)]" : "bg-[linear-gradient(180deg,#2c3758,#1b2239)]",
      )}
      style={{ animationDelay: `${360 + index * 60}ms` }}
    >
      <div className="flex items-center gap-3">
        <span
          className={clsx(
            "grid h-11 w-11 shrink-0 place-items-center rounded-xl border-[3px] border-black text-lg shadow-[0_3px_0_#000]",
            t.done ? "bg-zooa-lime text-black" : "bg-[#121826] text-white",
          )}
          aria-hidden
        >
          {t.done ? <span className="optical-center">✓</span> : <TesterGlyph id={t.id} />}
        </span>
        <div className="min-w-0 flex-1">
          <p className={clsx("text-base leading-tight tracking-wide", t.done ? "text-zooa-lime" : "text-white")}>{t.label}</p>
          <p className="font-body mt-0.5 text-xs leading-snug text-white/75 lg:text-[0.8125rem]">
            {t.pending ? "Waiting for review — thanks for the report!" : t.hint}
          </p>
        </div>
        {action ? (
          <button
            type="button"
            onClick={onOpen}
            aria-expanded={open}
            className="font-body min-h-11 shrink-0 rounded-xl border-[3px] border-black bg-white px-3 text-sm font-bold text-black shadow-[0_3px_0_#000] hover:bg-zinc-100 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-zooa-lime/70"
          >
            {t.id === "bug" ? (t.pending ? "Another" : "Report") : "Answer"} · +{t.ap}
          </button>
        ) : (
          <span
            className="font-body shrink-0 rounded-full border-2 border-black px-2 py-0.5 text-xs font-bold tabular-nums text-black"
            style={{ background: t.done ? "#ccff00" : MINT }}
          >
            {t.done ? "Done" : `+${t.ap} AP`}
          </span>
        )}
      </div>
      {open && t.id === "bug" && <BugForm onDone={onOpen} />}
      {open && t.id === "survey" && <SurveyForm onDone={onOpen} />}
    </li>
  );
}

/** Simple line glyphs of the tester tasks (white on the dark chip). */
function TesterGlyph({ id }: { id: string }) {
  const p = {
    tutorial: "M6 3v15M6 4h9l-2 3 2 3H6",
    party:
      "M7.5 9a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5zM13.5 9a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5zM3 17c0-3 2-5 4.5-5s4.5 2 4.5 5M10 13.2c1-.8 2.2-1.2 3.5-1.2 2.5 0 4.5 2 4.5 5",
    touch: "M7 2.5h7a1.5 1.5 0 0 1 1.5 1.5v13a1.5 1.5 0 0 1-1.5 1.5H7A1.5 1.5 0 0 1 5.5 17V4A1.5 1.5 0 0 1 7 2.5zM9.5 15.5h2",
    bug: "M10.5 6a3.5 3.5 0 0 1 3.5 3.5V13a3.5 3.5 0 0 1-7 0V9.5A3.5 3.5 0 0 1 10.5 6zM8.5 4.5 7 3M12.5 4.5 14 3M7 10H4M14 10h3M7 14H4.5M14 14h2.5M10.5 9v7",
    survey: "M13.5 3.5l3 3-9 9H4.5v-3zM11.5 5.5l3 3",
  }[id];
  if (!p) return <span>•</span>;
  return (
    <svg viewBox="0 0 21 21" className="h-6 w-6" aria-hidden>
      <path d={p} fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function BugForm({ onDone }: { onDone: () => void }) {
  const { reportBug } = usePass();
  const { toast } = useLobby();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const short = text.trim().length < PASS.BUG_MIN;
  const send = async () => {
    setBusy(true);
    const ua = typeof navigator !== "undefined" ? navigator.userAgent : "";
    const r = await reportBug(text, `menu · ${window.innerWidth}x${window.innerHeight} · ${/Mobi|Android/i.test(ua) ? "phone" : "desktop"}`);
    setBusy(false);
    playUi(r.ok ? "click" : "error");
    toast(r.message);
    if (r.ok) {
      setText("");
      onDone();
    }
  };
  return (
    <div className="mt-2 flex flex-col gap-2">
      <label className="font-body text-xs lg:text-[0.8125rem] text-white/80" htmlFor="bug-text">
        What happened, and what did you expect?
      </label>
      <textarea
        id="bug-text"
        value={text}
        maxLength={PASS.BUG_MAX}
        onChange={(e) => setText(e.target.value)}
        rows={3}
        className="font-body w-full resize-y rounded-xl border-[3px] border-black bg-black/40 px-3 py-2 text-sm text-white placeholder:text-white/50 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-zooa-lime/70"
        placeholder="The extract arrow pointed at a closed gate…"
      />
      <div className="flex items-center justify-between gap-2">
        <span className="font-body text-xs text-white/70 tabular-nums">
          {text.length}/{PASS.BUG_MAX}
        </span>
        <button type="button" disabled={busy || short} onClick={() => void send()} className="toon-btn min-h-11 px-4 text-sm disabled:opacity-60">
          <span className="optical-center">{busy ? "Sending…" : "Send report"}</span>
        </button>
      </div>
    </div>
  );
}

function SurveyForm({ onDone }: { onDone: () => void }) {
  const { answerSurvey } = usePass();
  const { toast } = useLobby();
  const [a, setA] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const ready = ALPHA_SURVEY.every((q) => q.choices.length === 0 || q.choices.includes(a[q.id] ?? ""));
  const send = async () => {
    setBusy(true);
    const r = await answerSurvey(a);
    setBusy(false);
    playUi(r.ok ? "coin" : "error");
    toast(r.message);
    if (r.ok) onDone();
  };
  return (
    <div className="mt-2 flex flex-col gap-2.5">
      {ALPHA_SURVEY.map((q) => (
        <fieldset key={q.id} className="min-w-0">
          <legend className="font-body text-sm text-white/90">{q.text}</legend>
          {q.choices.length > 0 ? (
            <div className="mt-1 flex flex-wrap gap-1.5">
              {q.choices.map((c) => {
                const on = a[q.id] === c;
                return (
                  <button
                    key={c}
                    type="button"
                    aria-pressed={on}
                    onClick={() => setA((x) => ({ ...x, [q.id]: c }))}
                    className={clsx(
                      "font-body inline-flex min-h-11 min-w-11 items-center justify-center rounded-xl border-[3px] border-black px-3 text-sm font-semibold focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-zooa-lime/70",
                      on ? "bg-zooa-lime text-black shadow-[0_3px_0_#000]" : "bg-[#121826] text-white/85 hover:text-white",
                    )}
                  >
                    {c}
                  </button>
                );
              })}
            </div>
          ) : (
            <input
              type="text"
              maxLength={300}
              value={a[q.id] ?? ""}
              onChange={(e) => setA((x) => ({ ...x, [q.id]: e.target.value }))}
              className="font-body mt-1 min-h-11 w-full rounded-xl border-[3px] border-black bg-black/40 px-3 text-sm text-white focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-zooa-lime/70"
            />
          )}
        </fieldset>
      ))}
      <div className="flex justify-end">
        <button type="button" disabled={busy || !ready} onClick={() => void send()} className="toon-btn min-h-11 px-4 text-sm disabled:opacity-60">
          <span className="optical-center">{busy ? "Sending…" : "Send answers"}</span>
        </button>
      </div>
    </div>
  );
}
