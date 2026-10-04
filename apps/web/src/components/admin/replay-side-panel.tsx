"use client";

import { memo, useEffect, useMemo, useRef, useState } from "react";
import {
  EVENT_CATS,
  eventCat,
  fmtClock,
  lastAtOrBefore,
  playerCss,
  playerStatus,
  wallTime,
  type EventCat,
  type NotableEvent,
  type PlayerInfo,
} from "@/lib/admin/replay-view";
import { CAT_COLOR } from "./replay-timeline";

export const CAT_LABEL: Record<EventCat, string> = {
  kill: "Убийства",
  exit: "Выходы",
  spawn: "Входы",
  boss: "Босс",
  loot: "Лут",
  wipe: "Вайп",
};

const CAT_HINT: Partial<Record<EventCat, string>> = {
  loot: "Открытые контейнеры и обыски — только у выбранного игрока",
  boss: "Смены состояния мозга босса",
};

const LEAVE_LABEL = { dead: "погиб", extract: "вышел", mia: "MIA", timeout: "время вышло" } as const;

export interface SubjectOption {
  key: string;
  name: string;
}

/**
 * Right column of the admin replay viewer: who to watch (everyone, one player — all their entries
 * this cycle — or a boss), that subject's card, and two tabs: the events list (category chips;
 * a click jumps the timeline there) and the players on this shard with their state at the playhead.
 */
export function ReplaySidePanel({
  t,
  playing,
  startedAtMs,
  players,
  bosses,
  subjectKey,
  onSubject,
  follow,
  onFollow,
  events,
  catCounts,
  cats,
  onToggleCat,
  describe,
  onEvent,
  killerName,
}: {
  t: number;
  playing: boolean;
  startedAtMs: number;
  players: readonly PlayerInfo[];
  bosses: readonly SubjectOption[];
  subjectKey: string | null;
  onSubject: (key: string | null) => void;
  follow: boolean;
  onFollow: (v: boolean) => void;
  events: readonly NotableEvent[];
  catCounts: Readonly<Record<EventCat, number>>;
  cats: ReadonlySet<EventCat>;
  onToggleCat: (c: EventCat) => void;
  describe: (e: NotableEvent) => string;
  onEvent: (e: NotableEvent) => void;
  killerName: (r: number) => string | null;
}) {
  const [tab, setTab] = useState<"events" | "players">("events");
  const subjectPlayer = subjectKey ? (players.find((p) => p.key === subjectKey) ?? null) : null;
  const subjectBoss = subjectKey ? (bosses.find((b) => b.key === subjectKey) ?? null) : null;
  const known = subjectPlayer !== null || subjectBoss !== null;
  const mates = subjectPlayer?.partyId ? players.filter((p) => p.partyId === subjectPlayer.partyId && p.key !== subjectPlayer.key) : [];

  return (
    <aside className="flex min-h-[480px] flex-col gap-3 rounded-xl border border-white/10 bg-[#141925] p-3 lg:h-[calc(100dvh-12.5rem)]">
      <label className="block">
        <span className="text-[0.7rem] uppercase tracking-wider text-white/50">Кого смотреть</span>
        <select
          value={subjectKey ?? ""}
          onChange={(e) => onSubject(e.target.value || null)}
          className="mt-1 min-h-[40px] w-full rounded-lg border border-white/15 bg-black/30 px-2 text-sm text-white outline-none focus:border-zooa-lime/60"
        >
          <option value="">Все на карте</option>
          {players.length > 0 ? (
            <optgroup label="Игроки">
              {players.map((p) => (
                <option key={p.key} value={p.key}>
                  {p.name}
                  {p.guest ? " (гость)" : ""}
                  {p.runs.length > 1 ? ` · заходов ${p.runs.length}` : ""}
                </option>
              ))}
            </optgroup>
          ) : null}
          {bosses.length > 0 ? (
            <optgroup label="Боссы">
              {bosses.map((b) => (
                <option key={b.key} value={b.key}>
                  {b.name}
                </option>
              ))}
            </optgroup>
          ) : null}
          {subjectKey && !known ? <option value={subjectKey}>Выбранный NPC</option> : null}
        </select>
      </label>

      {subjectKey ? (
        <div className="rounded-lg border border-white/10 bg-black/20 p-2.5 text-sm">
          <div className="flex items-center gap-2">
            <span
              className="h-3 w-3 shrink-0 rounded-full border border-black/50"
              style={{ background: subjectPlayer ? playerCss(subjectPlayer.color) : subjectBoss ? "#ff3b3b" : "#a3a9b0" }}
            />
            <span className="truncate font-bold">{subjectPlayer?.name ?? subjectBoss?.name ?? "NPC"}</span>
            {subjectPlayer ? (
              <span className="ml-auto shrink-0 text-xs text-white/50">
                ур. {subjectPlayer.level}
                {subjectPlayer.guest ? " · гость" : ""}
              </span>
            ) : null}
          </div>
          {subjectPlayer ? <p className="mt-1.5 text-xs leading-snug text-white/70">{statusText(subjectPlayer, t, killerName)}</p> : null}
          {mates.length > 0 ? <p className="mt-1 text-xs leading-snug text-white/50">Пати: {mates.map((m) => m.name).join(", ")}</p> : null}
          <div className="mt-2 flex gap-2">
            <button
              type="button"
              onClick={() => onFollow(!follow)}
              aria-pressed={follow}
              className={`min-h-[34px] flex-1 rounded-md px-2 text-xs font-semibold ${follow ? "bg-zooa-lime text-black" : "bg-white/10 text-white hover:bg-white/15"}`}
            >
              {follow ? "Камера следит" : "Следить камерой"}
            </button>
            <button type="button" onClick={() => onSubject(null)} className="min-h-[34px] rounded-md px-2 text-xs text-white/70 hover:bg-white/5">
              Показать всех
            </button>
          </div>
        </div>
      ) : null}

      <div className="flex gap-1 rounded-lg bg-black/25 p-1" role="tablist">
        {(
          [
            ["events", `События · ${events.length}`],
            ["players", `Игроки · ${players.length}`],
          ] as const
        ).map(([k, text]) => (
          <button
            key={k}
            type="button"
            role="tab"
            aria-selected={tab === k}
            onClick={() => setTab(k)}
            className={`min-h-[32px] flex-1 rounded-md text-xs font-semibold ${tab === k ? "bg-white/10 text-white" : "text-white/55 hover:text-white"}`}
          >
            {text}
          </button>
        ))}
      </div>

      {tab === "events" ? (
        <>
          <div className="flex flex-wrap gap-1">
            {EVENT_CATS.map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => onToggleCat(c)}
                aria-pressed={cats.has(c)}
                title={CAT_HINT[c]}
                className={`inline-flex min-h-[28px] items-center gap-1.5 rounded-full border px-2 text-[0.7rem] font-semibold ${
                  cats.has(c) ? "border-white/20 bg-white/10 text-white" : "border-white/10 text-white/40"
                }`}
              >
                <span className="h-2 w-2 rounded-full" style={{ background: CAT_COLOR[c], opacity: cats.has(c) ? 1 : 0.35 }} />
                {CAT_LABEL[c]}
                <span className="tabular-nums text-white/45">{catCounts[c]}</span>
              </button>
            ))}
          </div>
          <EventList events={events} t={t} playing={playing} startedAtMs={startedAtMs} describe={describe} onEvent={onEvent} />
        </>
      ) : (
        <ul className="-mx-1 min-h-0 flex-1 overflow-y-auto">
          {players.length === 0 ? <li className="px-2 py-3 text-xs leading-snug text-white/45">Игроков пока не видно (загружаются куски).</li> : null}
          {players.map((p) => (
            <li key={p.key}>
              <button
                type="button"
                onClick={() => onSubject(p.key === subjectKey ? null : p.key)}
                className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-white/5 ${p.key === subjectKey ? "bg-white/10" : ""}`}
              >
                <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: playerCss(p.color) }} />
                <span className="min-w-0 flex-1 space-y-1">
                  <span className="block truncate font-semibold leading-snug">
                    {p.name}
                    <span className="font-normal text-white/45">
                      {" "}
                      · {p.level}
                      {p.guest ? " · гость" : ""}
                      {p.partyId ? " · пати" : ""}
                    </span>
                  </span>
                  <span className="block truncate text-xs leading-snug text-white/50">{statusText(p, t, killerName)}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </aside>
  );
}

function statusText(p: PlayerInfo, t: number, killerName: (r: number) => string | null): string {
  const s = playerStatus(p, t);
  const runs = p.runs.length > 1 ? ` · заходов ${p.runs.length}` : "";
  if (s.kind === "before") return `ещё не вошёл${runs}`;
  if (s.kind === "on") return `на карте${s.since !== null ? ` с ${fmtClock(s.since)}` : ""}${runs}`;
  let text = `${LEAVE_LABEL[s.how]} в ${fmtClock(s.at)}`;
  if (s.how === "dead") {
    const run = p.runs.find((r) => r.leaveT === s.at);
    const k = run ? killerName(run.r) : null;
    if (k) text += ` · убийца: ${k}`;
  }
  return text + runs;
}

const EventRow = memo(function EventRow({
  e,
  text,
  active,
  startedAtMs,
  onEvent,
}: {
  e: NotableEvent;
  text: string;
  active: boolean;
  startedAtMs: number;
  onEvent: (e: NotableEvent) => void;
}) {
  const cat = eventCat(e) ?? "wipe";
  return (
    <li data-active={active || undefined}>
      <button
        type="button"
        onClick={() => onEvent(e)}
        title={`${wallTime(startedAtMs, e.t)} — перейти`}
        className={`flex w-full gap-2 rounded-md border-l-2 px-2 py-1.5 text-left text-[0.8rem] leading-snug hover:bg-white/5 ${active ? "bg-white/10" : ""}`}
        style={{ borderColor: CAT_COLOR[cat] }}
      >
        <span className="w-10 shrink-0 tabular-nums leading-snug text-white/50">{fmtClock(e.t)}</span>
        <span className="min-w-0 flex-1 break-words leading-snug text-white/85">{text}</span>
      </button>
    </li>
  );
});

function EventList({
  events,
  t,
  playing,
  startedAtMs,
  describe,
  onEvent,
}: {
  events: readonly NotableEvent[];
  t: number;
  playing: boolean;
  startedAtMs: number;
  describe: (e: NotableEvent) => string;
  onEvent: (e: NotableEvent) => void;
}) {
  const ref = useRef<HTMLUListElement>(null);
  const times = useMemo(() => events.map((e) => e.t), [events]);
  const texts = useMemo(() => events.map(describe), [events, describe]);
  const current = lastAtOrBefore(times, t);
  // While playing, keep the latest event in view.
  useEffect(() => {
    if (!playing || current < 0) return;
    const ul = ref.current;
    const el = ul?.querySelector<HTMLElement>("[data-active]");
    if (!ul || !el) return;
    // Scroll the list only (scrollIntoView would also move the page).
    if (el.offsetTop < ul.scrollTop) ul.scrollTop = el.offsetTop;
    else if (el.offsetTop + el.offsetHeight > ul.scrollTop + ul.clientHeight) ul.scrollTop = el.offsetTop + el.offsetHeight - ul.clientHeight;
  }, [current, playing]);
  if (events.length === 0) {
    return <p className="px-1 text-xs leading-snug text-white/45">Нет событий под этот фильтр (или куски ещё грузятся).</p>;
  }
  return (
    <ul ref={ref} className="relative -mx-1 min-h-0 flex-1 space-y-0.5 overflow-y-auto">
      {events.map((e, i) => (
        <EventRow key={`${e.t}-${i}`} e={e} text={texts[i]!} active={i === current} startedAtMs={startedAtMs} onEvent={onEvent} />
      ))}
    </ul>
  );
}
