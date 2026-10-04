"use client";

import { useState } from "react";
import clsx from "clsx";
import { ALPHA_SURVEY, PASS, cosmeticDef, type PassDto, type PassTierDto, type TesterTaskDto, type WearableKind } from "@extract/shared";
import { useLobby, useNow } from "@/lib/lobby/lobby-context";
import { playUi } from "@/game/audio/ui-sounds";
import { LevelBadge } from "./level-badge";
import { usePass } from "./pass-context";
import { useQuests } from "./quests-context";
import { fmtUntil } from "./quests-sheet";
import { fmtInt } from "./xp-bar";

const KIND_WORD: Readonly<Record<string, string>> = { title: "Title", color: "Name colour", frame: "Badge frame", skin: "Skin", badge: "Leaderboard badge" };
const MINT = "#5cf2c6";

/**
 * Alpha Pass tab of the tasks sheet (GAME_DESIGN §18e): AP and the next tier, the 10-tier track with
 * claim / wear, the week's three weekly tasks, the tester tasks (with the bug report form and the
 * survey). Everything is cosmetic and permanent: the alpha wipe keeps it.
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
  return (
    <div className="flex flex-col gap-4">
      <Summary data={data} />
      <Track data={data} />
      <Weekly data={data} />
      <Tester data={data} />
      <p className="font-body text-xs lg:text-[0.8125rem] leading-snug text-white/70">
        Alpha Points come only from tasks finished in real raids and tester tasks. Rewards are cosmetic, can&apos;t be bought or traded, and{" "}
        <span className="font-semibold text-white/90">stay after the alpha wipe</span>.
      </p>
    </div>
  );
}

function Summary({ data }: { data: PassDto }) {
  const prev = data.tier > 0 ? data.tiers[data.tier - 1]!.ap : 0;
  const next = data.next;
  const pct = next ? Math.min(100, ((data.ap - prev) / Math.max(1, next.ap - prev)) * 100) : 100;
  return (
    <section className="rounded-2xl border-[3px] border-black bg-[#1d2333]/90 p-3" aria-label="Alpha Pass progress">
      <div className="flex items-center gap-3">
        <span
          className="grid h-14 w-14 shrink-0 place-items-center rounded-2xl border-[3px] border-black text-2xl text-black shadow-[0_3px_0_#000]"
          style={{ background: MINT }}
          aria-label={`Tier ${data.tier}`}
        >
          {data.tier}
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-xs leading-snug lg:text-[0.8125rem] tracking-[0.12em] text-white/70">ALPHA PASS · TIER {data.tier}/10</p>
          <p className="toon-text-thin text-2xl tabular-nums text-white">
            {fmtInt(data.ap)} <span className="text-base text-white/70">AP</span>
          </p>
        </div>
      </div>
      <div className="mt-2.5">
        <span
          className="block h-3 overflow-hidden rounded-full border-2 border-black bg-black/55"
          role="progressbar"
          aria-label="To the next tier"
          aria-valuemin={prev}
          aria-valuemax={next?.ap ?? data.ap}
          aria-valuenow={data.ap}
        >
          <span className="block h-full rounded-full" style={{ width: `${pct}%`, background: MINT }} />
        </span>
        <p className="font-body mt-1.5 text-sm text-white/85">
          {next ? (
            <>
              <span className="tabular-nums">{fmtInt(next.ap - data.ap)} AP</span> to tier {next.tier} · <span className="font-semibold text-white">{next.name}</span>
            </>
          ) : (
            <span className="font-semibold" style={{ color: MINT }}>
              Pass complete — thank you, Founder.
            </span>
          )}
        </p>
      </div>
      <ul className="font-body mt-2.5 grid grid-cols-3 gap-2 border-t-2 border-black/40 pt-2.5 text-xs leading-snug lg:text-[0.8125rem] text-white/75">
        <li className="leading-snug">
          <span className="mb-1 block text-sm leading-tight font-semibold text-white tabular-nums">+{data.daily.apEach} AP</span>
          daily task · {data.daily.doneToday}/{data.daily.max} today
        </li>
        <li className="leading-snug">
          <span className="mb-1 block text-sm leading-tight font-semibold text-white tabular-nums">+{data.weekly.apEach} AP</span>
          weekly task
        </li>
        <li className="leading-snug">
          <span className="mb-1 block text-sm leading-tight font-semibold text-white tabular-nums">+30–50 AP</span>
          tester task, once
        </li>
      </ul>
    </section>
  );
}

function Track({ data }: { data: PassDto }) {
  return (
    <section aria-label="Tiers">
      <h3 className="text-xs lg:text-[0.8125rem] tracking-[0.12em] text-white/70">REWARDS</h3>
      <ol className="mt-2 flex flex-col gap-1.5">
        {data.tiers.map((t) => (
          <TierRow key={t.tier} t={t} data={data} />
        ))}
      </ol>
    </section>
  );
}

function Swatch({ t }: { t: PassTierDto }) {
  const d = cosmeticDef(t.reward);
  if (t.kind === "color" && d?.hex) return <span className="h-4 w-4 shrink-0 rounded-full border-2 border-black" style={{ background: d.hex }} aria-hidden />;
  if (t.kind === "frame") return <LevelBadge level={1} size="sm" frame={t.reward} className="!h-7 !w-6 shrink-0" />;
  if (t.kind === "skin") return <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full border-2 border-black text-xs text-black" style={{ background: MINT }} aria-hidden>☻</span>;
  if (t.kind === "badge") return <FounderBadge />;
  return <span className="grid h-6 w-6 shrink-0 place-items-center rounded-md border-2 border-black bg-white/10 text-[0.75rem] text-white" aria-hidden>T</span>;
}

/** The tier-10 "Founder" leaderboard badge. */
export function FounderBadge({ className }: { className?: string }) {
  return (
    <span
      className={clsx("inline-grid h-6 w-6 shrink-0 place-items-center rounded-full border-2 border-black text-[0.75rem] font-bold text-black shadow-[0_2px_0_#000]", className)}
      style={{ background: `radial-gradient(circle at 35% 30%, #c9fff0, ${MINT})` }}
      title="Founder · Alpha Pass"
      aria-label="Founder"
    >
      ★
    </span>
  );
}

function TierRow({ t, data }: { t: PassTierDto; data: PassDto }) {
  const { claim } = usePass();
  const quests = useQuests();
  const { toast } = useLobby();
  const [busy, setBusy] = useState(false);
  const wearable = t.kind !== "badge";
  const eq = quests.data?.equipped;
  const worn = wearable && eq ? eq[t.kind as WearableKind] === t.reward : false;

  const doClaim = async () => {
    setBusy(true);
    const r = await claim(t.tier);
    setBusy(false);
    playUi(r.ok ? "coin" : "error");
    toast(r.message);
    if (r.ok) void quests.reload();
  };
  const doWear = async () => {
    setBusy(true);
    const r = await quests.equip(t.kind as WearableKind, worn ? null : t.reward);
    setBusy(false);
    playUi(r.ok ? "click" : "error");
    if (!r.ok) toast(r.message);
  };

  return (
    <li
      className={clsx(
        "flex items-center gap-2.5 rounded-xl border-[3px] px-2.5 py-2",
        t.claimed ? "border-black bg-[#173326]/80" : t.reached ? "border-black bg-white/[0.08]" : "border-transparent bg-white/[0.03]",
      )}
    >
      <span
        className={clsx(
          "grid h-8 w-8 shrink-0 place-items-center rounded-full border-[3px] border-black text-sm tabular-nums",
          t.reached ? "text-black" : "bg-white/10 text-white/75",
        )}
        style={t.reached ? { background: MINT } : undefined}
      >
        {t.tier}
      </span>
      <Swatch t={t} />
      <div className="min-w-0 flex-1">
        <p className={clsx("truncate text-base leading-tight tracking-wide", t.reached ? "text-white" : "text-white/80")}>{t.name}</p>
        <p className="font-body mt-0.5 text-xs leading-snug lg:text-[0.8125rem] text-white/70">
          {KIND_WORD[t.kind] ?? t.kind} · {fmtInt(t.ap)} AP
        </p>
      </div>
      {t.claimed ? (
        wearable ? (
          <button
            type="button"
            disabled={busy || !quests.data}
            onClick={() => void doWear()}
            aria-pressed={worn}
            className={clsx(
              "font-body min-h-11 shrink-0 rounded-xl border-[3px] border-black px-3 text-xs lg:text-[0.8125rem] font-bold focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-zooa-lime/70 disabled:opacity-60",
              worn ? "bg-zooa-lime text-black shadow-[0_3px_0_#000]" : "bg-white/10 text-white hover:bg-white/15",
            )}
          >
            {worn ? "Wearing" : "Wear"}
          </button>
        ) : (
          <span className="font-body shrink-0 text-xs lg:text-[0.8125rem] font-bold" style={{ color: MINT }}>
            On boards ✓
          </span>
        )
      ) : t.reached ? (
        <button type="button" disabled={busy} onClick={() => void doClaim()} className="toon-btn min-h-11 shrink-0 px-4 text-sm disabled:opacity-60">
          <span className="optical-center">{busy ? "…" : "Claim"}</span>
        </button>
      ) : (
        <span className="font-body shrink-0 text-xs lg:text-[0.8125rem] font-semibold tabular-nums text-white/70">{fmtInt(Math.max(0, t.ap - data.ap))} to go</span>
      )}
    </li>
  );
}

function Weekly({ data }: { data: PassDto }) {
  const now = useNow();
  return (
    <section aria-label="Weekly tasks">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3">
        <h3 className="text-xs lg:text-[0.8125rem] tracking-[0.12em] text-white/70">WEEKLY · +{data.weekly.apEach} AP EACH</h3>
        <p className="font-body text-xs lg:text-[0.8125rem] font-semibold tabular-nums text-white/70">New in {fmtUntil(data.weekly.resetAt, now)}</p>
      </div>
      <ul className="mt-2 flex flex-col gap-1.5">
        {data.weekly.slots.map((s) => {
          const pct = s.need > 0 ? Math.min(100, (s.progress / s.need) * 100) : 0;
          return (
            <li key={s.slot} className={clsx("rounded-xl border-[3px] border-black px-3 py-2", s.done ? "bg-[#173326]/80" : "bg-[#1d2333]/90")}>
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className={clsx("text-base leading-tight tracking-wide", s.done ? "text-zooa-lime" : "text-white")}>{s.label}</p>
                  <p className="font-body mt-0.5 text-xs lg:text-[0.8125rem] leading-snug text-white/70">{s.hint}</p>
                </div>
                <span className="font-body shrink-0 text-sm font-semibold tabular-nums text-white/85">{s.done ? "Done ✓" : `${s.progress}/${s.need}`}</span>
              </div>
              {!s.done && (
                <span className="mt-1.5 block h-2 overflow-hidden rounded-full border-2 border-black bg-black/55" aria-hidden>
                  <span className="block h-full rounded-full bg-zooa-lime" style={{ width: `${pct}%` }} />
                </span>
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
    <section aria-label="Tester tasks">
      <h3 className="text-xs lg:text-[0.8125rem] tracking-[0.12em] text-white/70">TESTER TASKS · ONCE EACH</h3>
      <ul className="mt-2 flex flex-col gap-1.5">
        {data.tester.map((t) => (
          <TesterRow key={t.id} t={t} open={open === t.id} onOpen={() => setOpen(open === t.id ? null : (t.id as "bug" | "survey"))} />
        ))}
      </ul>
    </section>
  );
}

function TesterRow({ t, open, onOpen }: { t: TesterTaskDto; open: boolean; onOpen: () => void }) {
  const action = !t.done && (t.id === "bug" || t.id === "survey");
  return (
    <li className={clsx("rounded-xl border-[3px] border-black px-3 py-2", t.done ? "bg-[#173326]/80" : "bg-[#1d2333]/90")}>
      <div className="flex items-center gap-2.5">
        <span
          className={clsx(
            "grid h-7 w-7 shrink-0 place-items-center rounded-full border-[3px] border-black text-sm",
            t.done ? "bg-zooa-lime text-black" : "bg-white/10 text-white/70",
          )}
          aria-hidden
        >
          {t.done ? "✓" : "•"}
        </span>
        <div className="min-w-0 flex-1">
          <p className={clsx("text-base leading-tight tracking-wide", t.done ? "text-zooa-lime" : "text-white")}>{t.label}</p>
          <p className="font-body mt-0.5 text-xs lg:text-[0.8125rem] leading-snug text-white/70">
            {t.pending ? "Waiting for review — thanks for the report!" : t.hint}
          </p>
        </div>
        {action ? (
          <button
            type="button"
            onClick={onOpen}
            aria-expanded={open}
            className="font-body min-h-11 shrink-0 rounded-xl border-[3px] border-black bg-white/10 px-3 text-xs lg:text-[0.8125rem] font-bold text-white hover:bg-white/15 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-zooa-lime/70"
          >
            {t.id === "bug" ? (t.pending ? "Another" : "Report") : "Answer"}
          </button>
        ) : (
          <span className="font-body shrink-0 rounded-full border-2 border-black px-2 py-0.5 text-xs lg:text-[0.8125rem] font-bold tabular-nums text-black" style={{ background: t.done ? "#ccff00" : MINT }}>
            {t.done ? "Done" : `+${t.ap} AP`}
          </span>
        )}
      </div>
      {open && t.id === "bug" && <BugForm onDone={onOpen} />}
      {open && t.id === "survey" && <SurveyForm onDone={onOpen} />}
    </li>
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
