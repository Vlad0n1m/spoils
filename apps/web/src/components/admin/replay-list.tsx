"use client";

import Link from "next/link";
import { useState } from "react";
import type { AdminReplay } from "@/lib/admin/replay";
import { REPLAY } from "@extract/shared";
import { STATUS_LABEL, fmtBytes, fmtClock, fmtUtc, replayStatus } from "@/lib/admin/replay-view";

export type ReplayCursor = { before: string; beforeId: string } | null;

const STATUS_CLS = {
  done: "bg-white/[0.07] text-white/60",
  live: "bg-emerald-400/15 text-emerald-300",
  cut: "bg-amber-400/15 text-amber-300",
} as const;

/** Recorded shard-cycles, newest first; "Ещё" pages through GET /api/admin/replays with its cursor. */
export function ReplayList({ initial, next: next0, now }: { initial: AdminReplay[]; next: ReplayCursor; now: number }) {
  const [rows, setRows] = useState(initial);
  const [next, setNext] = useState(next0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const more = async () => {
    if (!next || busy) return;
    setBusy(true);
    setError(null);
    try {
      const q = new URLSearchParams({ limit: "50", before: next.before, beforeId: next.beforeId });
      const res = await fetch(`/api/admin/replays?${q}`, { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as { replays: AdminReplay[]; next: ReplayCursor };
      setRows((r) => [...r, ...body.replays.filter((x) => !r.some((y) => y.matchId === x.matchId))]);
      setNext(body.next);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  if (rows.length === 0) {
    return (
      <section className="rounded-xl border border-dashed border-white/20 bg-[#141925] p-5 text-sm leading-relaxed text-white/60">
        Повторов пока нет. Игровой сервер присылает кусок записи примерно раз в минуту, как только на шарде начинается цикл.
      </section>
    );
  }

  return (
    <section className="rounded-xl border border-white/10 bg-[#141925] p-4 md:p-5">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[44rem] text-sm">
          <thead>
            <tr className="text-left text-xs text-white/45">
              <th className="py-1.5 pr-3 font-normal">Карта</th>
              <th className="py-1.5 pr-3 font-normal">Начало</th>
              <th className="py-1.5 pr-3 font-normal">Записано</th>
              <th className="py-1.5 pr-3 text-right font-normal">Входов</th>
              <th className="py-1.5 pr-3 text-right font-normal">Кусков</th>
              <th className="py-1.5 pr-3 text-right font-normal">Размер</th>
              <th className="py-1.5 font-normal" />
            </tr>
          </thead>
          <tbody className="divide-y divide-white/10">
            {rows.map((r) => {
              const st = replayStatus(r, now);
              return (
                <tr key={r.matchId} className="align-middle">
                  <td className="whitespace-nowrap py-2 pr-3">
                    <Link href={`/admin/replays/${r.matchId}`} className="font-semibold hover:text-zooa-lime">
                      №{r.mapNumber}
                    </Link>
                    <span className="text-white/45"> · шард {r.shard}</span>
                  </td>
                  <td className="whitespace-nowrap py-2 pr-3 tabular-nums text-white/75">{fmtUtc(Date.parse(r.startedAt))}</td>
                  <td className="whitespace-nowrap py-2 pr-3 tabular-nums">
                    {fmtClock(r.lastMs)}
                    <span className={`ml-2 rounded-full px-2 py-0.5 text-[0.7rem] font-semibold ${STATUS_CLS[st]}`}>{STATUS_LABEL[st]}</span>
                  </td>
                  <td className="py-2 pr-3 text-right tabular-nums">{r.entries}</td>
                  <td className="py-2 pr-3 text-right tabular-nums text-white/70">{r.chunks}</td>
                  <td className="whitespace-nowrap py-2 pr-3 text-right tabular-nums text-white/70">{fmtBytes(r.bytes)}</td>
                  <td className="py-2 text-right">
                    <Link
                      href={`/admin/replays/${r.matchId}`}
                      // A block (flex + ml-auto), not inline-flex: inside the text-box-trimmed cell an inline
                      // button stuck out of its ~20 px line box and the buttons of adjacent rows overlapped.
                      className="ml-auto flex min-h-[36px] w-max items-center rounded-lg bg-white/10 px-3 text-xs font-semibold text-white hover:bg-white/15"
                    >
                      Смотреть
                    </Link>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="mt-3 flex items-center gap-3">
        {next ? (
          <button
            type="button"
            onClick={more}
            disabled={busy}
            className="min-h-[40px] rounded-lg border border-white/15 px-4 text-sm text-white/80 hover:bg-white/5 disabled:opacity-50"
          >
            {busy ? "Загружаю…" : "Ещё"}
          </button>
        ) : (
          <span className="text-xs text-white/40">Это все повторы за последние {REPLAY.RETENTION_DAYS} дней.</span>
        )}
        {error ? <span className="text-xs text-red-300">Не загрузилось: {error}</span> : null}
      </div>
    </section>
  );
}
